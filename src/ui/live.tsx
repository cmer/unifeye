"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, mediaUrl, previewToken } from "./api";

type State = "idle" | "connecting" | "playing" | "unavailable" | "error";

/** How long WebRTC may take to connect once signalling is done. On a reachable network it takes well under a second. */
const WEBRTC_CONNECT_MS = 4000;
/** After WebRTC media could not get through, use HLS straight away for this long before trying WebRTC again. */
const WEBRTC_SKIP_MS = 10 * 60_000;
const SKIP_KEY = "vantage.webrtc-unreachable-until";
/**
 * WebRTC media goes to port 8189 directly, which is not reachable from every network (for example
 * through a tunnel that only carries HTTPS). Once one tile finds that out, the others, and this tab
 * after a reload, skip straight to HLS instead of each waiting for the same timeout.
 */
let skipUntil = 0;
const webrtcSkipped = () => {
  if (!skipUntil) try { skipUntil = Number(sessionStorage.getItem(SKIP_KEY)) || 0; } catch { /* storage unavailable */ }
  return Date.now() < skipUntil;
};
const skipWebrtc = () => {
  skipUntil = Date.now() + WEBRTC_SKIP_MS;
  try { sessionStorage.setItem(SKIP_KEY, String(skipUntil)); } catch { /* storage unavailable */ }
};

/**
 * Live video for one camera. WebRTC (WHEP) first, for low latency; if that cannot connect, HLS
 * through the same authorized gateway. A failed WebRTC connection is remembered for a while (see
 * `skipWebrtc`) so the next tiles go to HLS directly. While `active` is false nothing is connected and the last
 * still image is shown, which is how the wall keeps the number of open streams bounded.
 * Everything is torn down when the tile leaves the screen or the page changes.
 */
export function LiveVideo({ cameraId, quality, active, online, className = "", onGone }: { cameraId: string; quality: "wall" | "focus"; active: boolean; online: boolean; className?: string; onGone?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [raw, setState] = useState<State>("idle");
  const [attempt, setAttempt] = useState(0);
  const [still, setStill] = useState(0);

  const playingNow = active && online && raw === "playing";
  useEffect(() => {
    if (playingNow) return;
    const t = setInterval(() => setStill((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [playingNow]);

  useEffect(() => {
    if (!active || !online) return;
    const el = video.current!;
    let closed = false, pc: RTCPeerConnection | undefined, resource: string | null = null, hls: { destroy(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => { if (closed) return; setState("connecting"); timer = setTimeout(() => setAttempt((n) => n + 1), Math.min(3000 * (attempt + 1), 15000)); };
    const viaHls = async () => {
      if (closed) return;
      const src = mediaUrl(`/api/media/live/${cameraId}/hls/${quality}/index.m3u8`);
      try {
        if (el.canPlayType("application/vnd.apple.mpegurl")) {
          // The browser's own HLS player (Safari, recent Chrome): same retry rule as hls.js below.
          el.onerror = () => { if (closed) return; el.onerror = null; if (attempt < 4) retry(); else setState("error"); };
          el.src = src;
        }
        else {
          const { default: Hls } = await import("hls.js");
          if (closed || !Hls.isSupported()) return setState("error");
          const h = new Hls({ lowLatencyMode: true, xhrSetup: (xhr) => { const t = previewToken(); if (t) xhr.setRequestHeader("x-vantage-preview", t); } });
          h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { h.destroy(); if (attempt < 4) retry(); else setState("error"); } });
          h.loadSource(src); h.attachMedia(el); hls = h;
        }
        el.onplaying = () => !closed && setState("playing");
        void el.play().catch(() => {});
      } catch { setState("error"); }
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reflects the connection this effect is opening
    setState("connecting");
    if (webrtcSkipped()) { void viaHls(); return cleanup; }
    // Media never arrived: this network cannot reach the WebRTC port. Switch transport and remember it.
    const unreachable = () => {
      if (closed || !pc) return;
      clearTimeout(timer); pc.close(); pc = undefined;
      el.srcObject = null; // a media stream outranks `src`: left attached, it would hide the HLS video
      skipWebrtc();
      // Release the WebRTC session first: until then it still counts against this session's stream limit.
      const r = resource; resource = null;
      if (r) void api(r.replace(/^\/api/, ""), { method: "DELETE" }).catch(() => {}).finally(() => void viaHls());
      else void viaHls();
    };
    let connected = false;
    (async () => {
      try {
        pc = new RTCPeerConnection();
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = (e) => { if (!closed && el.srcObject !== e.streams[0]) el.srcObject = e.streams[0]; };
        pc.onconnectionstatechange = () => {
          if (closed || !pc) return;
          if (pc.connectionState === "connected") { connected = true; clearTimeout(timer); setState("playing"); }
          else if (pc.connectionState === "failed" && !connected) unreachable();
          // Also fires when the server ends the stream because access was removed; the retry then gets a clean "not available".
          else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") retry();
        };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((done) => {
          if (pc!.iceGatheringState === "complete") return done();
          const t = setTimeout(done, 1500);
          pc!.onicegatheringstatechange = () => { if (pc!.iceGatheringState === "complete") { clearTimeout(t); done(); } };
        });
        const ans = await api<{ sdp: string; location: string | null }>(`/media/live/${cameraId}/whep?q=${quality}`, { method: "POST", raw: pc.localDescription!.sdp });
        resource = ans.location;
        if (closed) return;
        await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
        if (!connected) timer = setTimeout(unreachable, WEBRTC_CONNECT_MS);
      } catch (e) {
        if (closed) return;
        if (e instanceof ApiError && e.status === 404) onGone?.(); // access was removed: let the page refresh what it shows
        if (e instanceof ApiError && [404, 409, 401, 403].includes(e.status)) setState("unavailable");
        else if (e instanceof ApiError && e.status === 429) setState("idle");
        else void viaHls();
      }
    })();
    function cleanup() {
      closed = true;
      clearTimeout(timer);
      pc?.close();
      hls?.destroy();
      if (resource) void api(resource.replace(/^\/api/, ""), { method: "DELETE" }).catch(() => {});
      el.onplaying = null; el.onerror = null; el.srcObject = null; el.removeAttribute("src"); el.load();
    }
    return cleanup;
  }, [cameraId, quality, active, online, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const state: State = active && online ? raw : "idle";
  return (
    <div className={`absolute inset-0 bg-black ${className}`}>
      {online && <img alt="" src={mediaUrl(`/api/cameras/${cameraId}/snapshot?w=${quality === "focus" ? 1280 : 640}&n=${still}`)} className="absolute inset-0 size-full object-cover" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} onLoad={(e) => { e.currentTarget.style.visibility = "visible"; }} />}
      <video ref={video} autoPlay muted playsInline className={`absolute inset-0 size-full object-cover transition-opacity ${state === "playing" ? "opacity-100" : "opacity-0"}`} />
      {(!online || state === "unavailable" || state === "error") && (
        <div className="absolute inset-0 grid place-items-center bg-zinc-900 p-4 text-center text-sm text-zinc-400">
          <div><div className="font-medium text-zinc-50">{!online ? "Camera offline" : state === "unavailable" ? "No live video" : "Can't connect"}</div>{state === "error" && online && "Check your connection."}</div>
        </div>
      )}
    </div>
  );
}
