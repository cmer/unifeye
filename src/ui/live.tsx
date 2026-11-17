"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, mediaUrl, previewToken } from "./api";
import { applySound, watchAudio } from "./sound";

type State = "idle" | "connecting" | "playing" | "unavailable" | "error";

/** How long WebRTC may take to connect once signalling is done. On a reachable network it takes well under a second. */
const WEBRTC_CONNECT_MS = 4000;
/** After WebRTC media could not get through, use HLS straight away for this long before trying WebRTC again. */
const WEBRTC_SKIP_MS = 10 * 60_000;
const SKIP_KEY = "unifeye.webrtc-unreachable-until";
/**
 * The server refused for now (429): this session holds as many streams as it may, or sent too many
 * requests. Streams are released as tiles stop, so wait and try again. Not counted as a failed attempt.
 */
const BUSY_RETRY_MS = 5000;
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
/** How live video is reaching the browser: WebRTC (real-time) or the HLS fallback (a few seconds behind). */
export type Transport = "webrtc" | "hls";

export function LiveVideo({ cameraId, quality, active, online, className = "", onGone, onTransport, sound = false, onAudio, onMedia }: {
  cameraId: string; quality: "wall" | "focus"; active: boolean; online: boolean; className?: string; onGone?: () => void;
  /** Reports the transport while video is playing, null otherwise. */ onTransport?: (t: Transport | null) => void;
  /** Play this camera's sound. Off by default; see `sound.tsx`. */ sound?: boolean;
  /** Reports whether the playing stream carries sound, null while unknown or not playing. */ onAudio?: (has: boolean | null) => void;
  /** The video element, for the level meter. */ onMedia?: (el: HTMLVideoElement | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [audio, setAudio] = useState<boolean | null>(null);
  const [raw, setState] = useState<State>("idle");
  const [attempt, setAttempt] = useState(0);
  const [wake, setWake] = useState(0);
  const [still, setStill] = useState(0);
  const [via, setVia] = useState<Transport>("webrtc");

  const playingNow = active && online && raw === "playing";
  useEffect(() => {
    if (playingNow) return;
    const t = setInterval(() => setStill((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [playingNow]);

  useEffect(() => {
    if (!active || !online) return;
    const el = video.current!;
    let closed = false, unwatch: (() => void) | undefined, pc: RTCPeerConnection | undefined, resource: string | null = null, hls: { destroy(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined, timer2: ReturnType<typeof setTimeout> | undefined;
    const retry = () => { if (closed) return; setState("connecting"); timer = setTimeout(() => setAttempt((n) => n + 1), Math.min(3000 * (attempt + 1), 15000)); };
    const busy = () => { if (closed) return; setState("connecting"); timer = setTimeout(() => setWake((n) => n + 1), BUSY_RETRY_MS); };
    const stream = `/media/live/${cameraId}/hls/${quality}`;
    let hlsOpen = false;
    const viaHls = async () => {
      if (closed) return;
      hlsOpen = true;
      // Ask once ourselves: the browser's own HLS player hides the status, and a refusal for now must wait, not fail.
      try { await api(`${stream}/index.m3u8`); } catch (e) { if (closed) return; if (e instanceof ApiError && e.status === 429) return busy(); }
      if (closed) return;
      const src = mediaUrl(`/api${stream}/index.m3u8`);
      try {
        if (el.canPlayType("application/vnd.apple.mpegurl")) {
          // The browser's own HLS player (Safari, recent Chrome): same retry rule as hls.js below.
          el.onerror = () => { if (closed) return; el.onerror = null; if (attempt < 4) retry(); else setState("error"); };
          el.src = src;
        }
        else {
          const { default: Hls } = await import("hls.js");
          if (closed || !Hls.isSupported()) return setState("error");
          const h = new Hls({ lowLatencyMode: true, xhrSetup: (xhr) => { const t = previewToken(); if (t) xhr.setRequestHeader("x-unifeye-preview", t); } });
          h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { h.destroy(); if (d.response?.code === 429) busy(); else if (attempt < 4) retry(); else setState("error"); } });
          // The playlist names its codecs, so whether there is sound is known before anything plays.
          h.on(Hls.Events.MANIFEST_PARSED, (_e, d) => { if (!closed) setAudio(d.audioTracks.length > 0 || d.levels.some((l) => !!l.audioCodec)); });
          h.loadSource(src); h.attachMedia(el); hls = h;
        }
        if (!hls) unwatch = watchAudio(el, (has) => { if (!closed) setAudio(has); });
        el.onplaying = () => { if (!closed) { setVia("hls"); setState("playing"); } };
        void el.play().catch(() => {});
      } catch { setState("error"); }
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reflects the connection this effect is opening
    setState("connecting");
    setAudio(null);
    el.muted = true; // every connection starts muted, so autoplay is always allowed; the sound effect below unmutes once playing
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
        // A camera without sound WebRTC can carry still gets an audio track: MediaMTX answers with a
        // silent placeholder that never sends a packet. So sound counts only once packets arrive
        // (the track unmutes); still muted a few seconds after connecting means no audio.
        let audioTrack: MediaStreamTrack | undefined;
        const decideAudio = () => {
          if (!audioTrack) return setAudio(false);
          if (!audioTrack.muted) return setAudio(true);
          audioTrack.onunmute = () => { if (!closed) setAudio(true); };
          timer2 = setTimeout(() => { if (!closed && audioTrack!.muted) setAudio(false); }, 3000);
        };
        pc.ontrack = (e) => { if (e.track.kind === "audio") audioTrack = e.track; if (!closed && el.srcObject !== e.streams[0]) el.srcObject = e.streams[0]; };
        pc.onconnectionstatechange = () => {
          if (closed || !pc) return;
          if (pc.connectionState === "connected") { connected = true; clearTimeout(timer); setVia("webrtc"); decideAudio(); setState("playing"); }
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
        // The tile stopped while the offer was on its way, so cleanup had nothing to release yet.
        // Release it now: otherwise the session holds one of this tab's stream slots until it times out.
        if (closed) { if (resource) void api(resource.replace(/^\/api/, ""), { method: "DELETE" }).catch(() => {}); return; }
        await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
        if (!connected) timer = setTimeout(unreachable, WEBRTC_CONNECT_MS);
      } catch (e) {
        if (closed) return;
        if (e instanceof ApiError && e.status === 404) onGone?.(); // access was removed: let the page refresh what it shows
        if (e instanceof ApiError && [404, 409, 401, 403].includes(e.status)) setState("unavailable");
        else if (e instanceof ApiError && e.status === 429) busy();
        else void viaHls();
      }
    })();
    function cleanup() {
      closed = true;
      unwatch?.();
      clearTimeout(timer); clearTimeout(timer2);
      pc?.close();
      hls?.destroy();
      // HLS has no teardown of its own: without this the server holds the stream's slot for up to a minute.
      if (hlsOpen) void api(stream, { method: "DELETE", keepalive: true }).catch(() => {});
      if (resource) void api(resource.replace(/^\/api/, ""), { method: "DELETE" }).catch(() => {});
      el.onplaying = null; el.onerror = null; el.srcObject = null; el.removeAttribute("src"); el.load();
    }
    return cleanup;
  }, [cameraId, quality, active, online, attempt, wake]); // eslint-disable-line react-hooks/exhaustive-deps

  const state: State = active && online ? raw : "idle";
  const shown = state === "playing" ? via : null;
  useEffect(() => { onTransport?.(shown); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onTransport?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const hasAudio = state === "playing" ? audio : null;
  useEffect(() => { onAudio?.(hasAudio); }, [hasAudio]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onAudio?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (video.current) applySound(video.current, sound && hasAudio === true); }, [sound, hasAudio]);
  useEffect(() => { onMedia?.(video.current); return () => onMedia?.(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = quality === "focus" ? "object-contain" : "object-cover"; // enlarged view letterboxes so the whole frame is always visible
  return (
    <div className={`absolute inset-0 bg-black ${className}`}>
      {/* Placeholder until video plays; hidden after, or it shows through the video's letterbox bars when the two differ in shape. */}
      {online && <img alt="" src={mediaUrl(`/api/cameras/${cameraId}/snapshot?w=${quality === "focus" ? 1280 : 640}&n=${still}`)} className={`absolute inset-0 size-full ${fit} ${state === "playing" ? "opacity-0" : ""}`} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} onLoad={(e) => { e.currentTarget.style.visibility = "visible"; }} />}
      <video ref={video} autoPlay muted playsInline className={`absolute inset-0 size-full ${fit} transition-opacity ${state === "playing" ? "opacity-100" : "opacity-0"}`} />
      {(!online || state === "unavailable" || state === "error") && (
        <div className="absolute inset-0 grid place-items-center bg-zinc-900 p-4 text-center text-sm text-zinc-400">
          <div><div className="font-medium text-zinc-50">{!online ? "Camera offline" : state === "unavailable" ? "No live video" : "Can't connect"}</div>{state === "error" && online && "Check your connection."}</div>
        </div>
      )}
    </div>
  );
}
