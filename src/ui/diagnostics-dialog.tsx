"use client";
/**
 * The diagnostics window. It runs its checks when it opens and on "Check again": the server and the
 * recorder, download speed, refusals, test connections over WebRTC (UDP and TCP separately) and HLS,
 * what this browser can decode and whether it lets video start on its own, and what every live tile is doing. Its own requests are not added to
 * the problem log (they report in their own rows), and everything a test opens is released, also when
 * the window closes mid-test.
 *
 * Technical terms (WebRTC, HLS, UDP, TCP, HTTP 429, codec names) are allowed in this window only.
 */
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { testAutoplay, type Autoplay } from "./autoplay-probe";
import { iceSettings, rtcConfiguration } from "./ice";
import { api, ApiError, fmtShort, previewToken, type Camera } from "./api";
import { useApp } from "./app";
import {
  browserRow, camerasFor, routeLabel, transportLabel, viaRelay, clockOffset, codecName, filterCandidates, fmtMbps, fmtMs, formatReport, groupRefusals, inboundVideo,
  liveTiles, mayReleaseHls, relayRow, median, MIN_STREAM_MBPS, perStreamMbps, parsePlaylist, pickTestStream, problemLog, refusalsSince, refusalText, REFUSAL_WINDOW_MS, selectedPair, statList,
  verdict, versionRow, type CheckRow, type Pair, type ProblemEntry, type RelayProbe, type ProblemId, type Section, type Stat, type Status, type TestStream, type TileInfo, type UpdateInfo,
} from "./diagnostics";
import { resumeWebrtc, webrtcPause } from "./live";

// ---- what the checks find ----------------------------------------------------------------------
interface Info {
  serverTime: number; version: string; commit: string | null; update: UpdateInfo; recorder: "connected" | "connecting" | "down"; relay: boolean;
  /** The TURN relay, when one is set up. */
  turn: { answering: boolean; relayOnly: boolean } | null;
  streams: { limit: number; open: number; webrtc: number; hls: number; held: { cameraId: string; quality: "wall" | "focus"; kinds: string[] }[] };
  rate: { class: string; used: number; limit: number; resetSeconds: number }[];
}
type Failed = { failed: true; status: number; code?: string; requestId?: string | null };
type WebrtcResult =
  | { ok: true; connectMs: number; signallingMs: number; pair: Pair | null; ports: number[] }
  | { ok: false; reason: "refused" | "blocked" | "no_candidates" | "error" | "skipped"; status?: number; code?: string; requestId?: string; iceState?: string; waitedMs?: number; ports?: number[]; message?: string };
interface Timed { status: number; ok: boolean; ms: number; text: string; bytes: number; code?: string; requestId: string | null }
type HlsResult =
  | { ok: true; totalMs: number; steps: { name: string; t: Timed }[] }
  | { ok: false; step: string; t: Timed; steps: { name: string; t: Timed }[] };
interface Codecs { webrtc: { h264: boolean; h265: boolean }; mse: { h264: boolean; h265: boolean }; nativeHls: boolean; native265: boolean; efficient: { h264?: boolean; h265?: boolean } }
interface Playing { tileId: number; cameraId: string; status: Status; value: string; detail?: string; tech: string[]; mbps?: number }
interface Results {
  info?: Info | Failed; clockMs?: number;
  rtt?: { ms: number[]; failures: number; protocol?: string };
  cameras?: Camera[];
  download?: { mbps: number; bytes: number; ms: number } | Failed;
  stream?: TestStream | null;
  udp?: WebrtcResult; tcp?: WebrtcResult; hls?: HlsResult;
  /** Getting an address on the relay, once per relay address. Null: no relay set up, or no login for this person. */
  relay?: RelayProbe[] | null;
  codecs?: Codecs; autoplay?: Autoplay; playing?: Playing[]; problems?: readonly ProblemEntry[];
}
interface Run { started: number; finished?: number; r: Results }

// ---- network helpers -----------------------------------------------------------------------------
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done) => { const t = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); });
/** A GET straight to the API, timed, without the problem log or the sign-in redirect of `api()`. */
async function timed(path: string, signal: AbortSignal, read: "text" | "bytes" | "none" = "none", timeoutMs = 10_000): Promise<Timed> {
  const ctl = new AbortController(), stop = () => ctl.abort();
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs), headers: Record<string, string> = {}, pv = previewToken();
  if (pv) headers["x-unifeye-preview"] = pv;
  const t0 = performance.now();
  try {
    const res = await fetch(`/api${path}`, { headers, cache: "no-store", credentials: "same-origin", signal: ctl.signal });
    let text = "", bytes = 0, code: string | undefined;
    if (res.ok) { if (read === "text") text = await res.text(); else if (read === "bytes") bytes = (await res.arrayBuffer()).byteLength; else await res.body?.cancel(); }
    else code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    return { status: res.status, ok: res.ok, ms: performance.now() - t0, text, bytes, code, requestId: res.headers.get("x-request-id") };
  } catch {
    return { status: 0, ok: false, ms: performance.now() - t0, text: "", bytes: 0, code: signal.aborted ? "stopped" : ctl.signal.aborted ? "timed_out" : "no_answer", requestId: null };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}
const release = (path: string) => void api(path, { method: "DELETE", keepalive: true, record: false }).catch(() => {});

/** Five small requests to a route that does no work, one after the other. */
async function roundTrips(signal: AbortSignal) {
  const ms: number[] = [];
  let failures = 0;
  for (let i = 0; i < 5 && !signal.aborted; i++) { const t = await timed("/health", signal, "none", 5000); if (t.ok) ms.push(t.ms); else failures++; }
  const entries = performance.getEntriesByName(new URL("/api/health", location.href).href) as PerformanceResourceTiming[];
  return { ms, failures, protocol: entries.at(-1)?.nextHopProtocol || undefined };
}

/** A sample of random bytes; a larger one when the first came back quickly, so fast links are not under-measured. */
async function download(signal: AbortSignal): Promise<Results["download"]> {
  let last: Timed | null = null, size = 1024 * 1024;
  for (let i = 0; i < 2 && !signal.aborted; i++) {
    last = await timed(`/diagnostics/download?bytes=${size}`, signal, "bytes", 20_000);
    if (!last.ok) return { failed: true, status: last.status, code: last.code, requestId: last.requestId };
    if (last.ms > 500) break;
    size = 4 * 1024 * 1024;
  }
  return last ? { mbps: (last.bytes * 8) / (last.ms * 1000), bytes: last.bytes, ms: last.ms } : { failed: true, status: 0, code: "stopped" };
}

/** How long a test connection may take once signalling is done. Tiles give up after 4 s; a little more here. */
const TEST_CONNECT_MS = 5000;
/**
 * A real WebRTC connection to one camera, like a tile makes (src/ui/live.tsx), with the answer's
 * ICE candidates limited to one transport so that transport is tested on its own. The WHEP session
 * is always released afterwards, including on failure and when the window closes.
 */
async function webrtcTest(s: TestStream, protocol: "udp" | "tcp", signal: AbortSignal): Promise<WebrtcResult> {
  let pc: RTCPeerConnection | undefined, resource: string | null = null;
  try {
    pc = new RTCPeerConnection((await rtcConfiguration()) ?? {});
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((done) => {
      if (pc!.iceGatheringState === "complete") return done();
      const t = setTimeout(done, 1500);
      pc!.onicegatheringstatechange = () => { if (pc!.iceGatheringState === "complete") { clearTimeout(t); done(); } };
    });
    if (signal.aborted) return { ok: false, reason: "error", message: "stopped" };
    const t0 = performance.now();
    let ans: { sdp: string; location: string | null };
    // Not aborted from here: an answer that arrives after the window closed is still released below.
    try { ans = await api(`/media/live/${s.cameraId}/whep?q=${s.quality}`, { method: "POST", raw: pc.localDescription!.sdp, record: false }); }
    catch (e) { if (e instanceof ApiError) return { ok: false, reason: e.status === 429 ? "refused" : "error", status: e.status, code: e.code, requestId: e.requestId, message: e.message }; throw e; }
    resource = ans.location;
    const signallingMs = performance.now() - t0;
    const f = filterCandidates(ans.sdp, protocol);
    if (!f.kept) return { ok: false, reason: "no_candidates" };
    if (signal.aborted) return { ok: false, reason: "error", message: "stopped" };
    const answered = performance.now();
    await pc.setRemoteDescription({ type: "answer", sdp: f.sdp });
    const state = await new Promise<"connected" | "failed" | "timeout" | "stopped">((done) => {
      const check = () => { if (pc!.connectionState === "connected") finish("connected"); else if (pc!.connectionState === "failed") finish("failed"); };
      const t = setTimeout(() => finish("timeout"), TEST_CONNECT_MS);
      const onAbort = () => finish("stopped");
      function finish(v: "connected" | "failed" | "timeout" | "stopped") { clearTimeout(t); signal.removeEventListener("abort", onAbort); pc!.onconnectionstatechange = null; done(v); }
      signal.addEventListener("abort", onAbort, { once: true });
      pc!.onconnectionstatechange = check;
      check();
    });
    if (state === "stopped") return { ok: false, reason: "error", message: "stopped" };
    if (state !== "connected") return { ok: false, reason: "blocked", iceState: pc.iceConnectionState, waitedMs: performance.now() - answered, ports: f.ports };
    const connectMs = performance.now() - t0;
    const pair = selectedPair(statList(await pc.getStats()));
    return { ok: true, connectMs, signallingMs, pair, ports: f.ports };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    pc?.close();
    if (resource) release(resource.replace(/^\/api/, ""));
  }
}

/** How long the browser may take to get an address on the relay. TLS through a slow network takes the longest. */
const RELAY_PROBE_MS = 5000;
/**
 * Asks the relay for an address through one of its URLs, with nothing else allowed, the way a tile
 * does before it connects. No camera and no stream: this tests only the path from this browser to
 * the relay, and that the login works.
 */
async function relayProbe(server: RTCIceServer, url: string, signal: AbortSignal): Promise<RelayProbe> {
  const t0 = performance.now();
  let pc: RTCPeerConnection | undefined, error: string | undefined;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: url, username: server.username, credential: server.credential }], iceTransportPolicy: "relay" });
    pc.createDataChannel("probe"); // something to gather candidates for
    const found = new Promise<boolean>((done) => {
      const t = setTimeout(() => done(false), RELAY_PROBE_MS);
      const end = (ok: boolean) => { clearTimeout(t); done(ok); };
      pc!.onicecandidate = (e) => { if (!e.candidate) end(false); else if (e.candidate.type === "relay" || / typ relay\b/.test(e.candidate.candidate)) end(true); };
      pc!.onicecandidateerror = (e) => { const x = e as RTCPeerConnectionIceErrorEvent; error = `${x.errorCode} ${x.errorText}`.trim(); };
      signal.addEventListener("abort", () => end(false), { once: true });
    });
    await pc.setLocalDescription(await pc.createOffer());
    const ok = await found;
    return { url, ok, ms: performance.now() - t0, ...(!ok && error ? { error } : {}) };
  } catch (e) {
    return { url, ok: false, ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) };
  } finally { pc?.close(); }
}
/** Every relay address at once, or null when there is no relay for this person. */
async function relayCheck(signal: AbortSignal): Promise<RelayProbe[] | null> {
  const cfg = await iceSettings().catch(() => null);
  const server = cfg?.iceServers[0];
  if (!server) return null;
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return Promise.all(urls.map((u) => relayProbe(server, u, signal)));
}

/** The playlist file a URI in a playlist names, with its query, as the HLS route takes it. */
const fileOf = (uri: string) => { const u = new URL(uri, "http://x/hls/q/"); return u.pathname.split("/").pop()! + u.search; };
/**
 * The top playlist, the first video playlist and its newest segment, through the same routes the
 * player uses. A stream a tile holds is shared, never released; one the test opened is released.
 */
async function hlsTest(s: TestStream, signal: AbortSignal): Promise<HlsResult> {
  const base = `/media/live/${s.cameraId}/hls/${s.quality}`, steps: { name: string; t: Timed }[] = [], t0 = performance.now();
  let opened = false;
  const step = async (name: string, file: string, read: "text" | "bytes") => { const t = await timed(`${base}/${file}`, signal, read, 15_000); steps.push({ name, t }); return t; };
  try {
    const top = await step("Playlist", "index.m3u8", "text");
    opened = top.status !== 429 && top.status !== 404 && top.status !== 401;
    if (!top.ok) return { ok: false, step: "Playlist", t: top, steps };
    let pl = parsePlaylist(top.text);
    if (pl.variants.length) {
      const media = await step("Video playlist", fileOf(pl.variants[0]), "text");
      if (!media.ok) return { ok: false, step: "Video playlist", t: media, steps };
      pl = parsePlaylist(media.text);
    }
    const seg = pl.segments.at(-1);
    if (!seg) return { ok: false, step: "Segment", t: { status: 200, ok: false, ms: 0, text: "", bytes: 0, code: "no_segments", requestId: null }, steps };
    const sg = await step("Segment", fileOf(seg), "bytes");
    if (!sg.ok) return { ok: false, step: "Segment", t: sg, steps };
    return { ok: true, totalMs: performance.now() - t0, steps };
  } finally {
    if (opened && mayReleaseHls(s, liveTiles())) release(base);
  }
}

async function codecs(): Promise<Codecs> {
  const rtc = (typeof RTCRtpReceiver !== "undefined" && RTCRtpReceiver.getCapabilities?.("video")?.codecs.map((c) => c.mimeType.toLowerCase())) || [];
  const types = { h264: 'video/mp4; codecs="avc1.640028"', h265: 'video/mp4; codecs="hvc1.1.6.L120.90"' };
  const MS = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? (typeof MediaSource !== "undefined" ? MediaSource : undefined);
  const v = document.createElement("video");
  const efficient: Codecs["efficient"] = {};
  for (const k of ["h264", "h265"] as const) {
    try {
      const r = await navigator.mediaCapabilities?.decodingInfo({ type: MS ? "media-source" : "file", video: { contentType: types[k], width: 1920, height: 1080, bitrate: 4_000_000, framerate: 25 } });
      if (r?.supported) efficient[k] = r.powerEfficient;
    } catch { /* not reported */ }
  }
  return {
    webrtc: { h264: rtc.includes("video/h264"), h265: rtc.includes("video/h265") },
    mse: { h264: !!MS?.isTypeSupported(types.h264), h265: !!MS?.isTypeSupported(types.h265) },
    nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "", native265: v.canPlayType(types.h265) !== "", efficient,
  };
}

// ---- live tiles ----------------------------------------------------------------------------------
const SOURCE: Record<string, string> = { camera: "from camera", recorder: "from recorder", fallback: "from recorder (camera unavailable)" };
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
/** Two samples of every playing WebRTC tile's statistics, a second apart, for bitrates. */
async function samplePlaying(signal: AbortSignal): Promise<Playing[]> {
  const list = liveTiles();
  const snap = () => Promise.all(list.map((t) => (t.pc && t.state === "playing" && t.transport === "webrtc" ? t.pc.getStats().then(statList).catch(() => null) : Promise.resolve(null))));
  const first = await snap();
  if (first.some(Boolean)) await sleep(1000, signal);
  const second = await snap();
  return list.map((t, i) => describeTile(t, first[i], second[i]));
}
function describeTile(t: TileInfo, before: Stat[] | null, now: Stat[] | null): Playing {
  const tech = [`quality ${t.quality}`, `state ${t.state}`, `attempt ${t.attempts + 1}`, ...(t.refusals ? [`refused ${t.refusals}`] : []), ...(t.lastError ? [`last error ${t.lastError}`] : [])];
  const extra = [t.attempts ? `retried ${times(t.attempts)}` : null, t.refusals ? `refused ${times(t.refusals)}` : null].filter(Boolean) as string[];
  const base = { tileId: t.id, cameraId: t.cameraId };
  if (t.state === "error") return { ...base, status: "bad", value: "Can't connect", detail: [t.lastError, `gave up after ${t.attempts + 1} tries`].filter(Boolean).join(" · "), tech };
  if (t.state === "unavailable") return { ...base, status: "warn", value: "No live video", detail: "The recorder has no live stream for this camera.", tech };
  if (t.state !== "playing") return { ...base, status: t.refusals ? "warn" : "pending", value: t.refusals ? "Waiting to retry" : "Connecting", detail: extra.join(" · ") || undefined, tech };
  const src = t.source ? ` · ${SOURCE[t.source] ?? t.source}` : "";
  if (t.transport === "webrtc" && now) {
    const v = inboundVideo(now, before), pair = selectedPair(now);
    const bits = [
      [v?.codec, v?.width && v?.height ? `${v.width}×${v.height}` : null].filter(Boolean).join(" ") || null,
      v?.fps != null ? `${Math.round(v.fps)} fps` : null, v?.mbps != null ? fmtMbps(v.mbps) : null,
      v?.lossPct != null ? `${v.lossPct < 0.1 ? 0 : v.lossPct.toFixed(1)}% lost` : null, v?.jitterMs != null ? `jitter ${Math.round(v.jitterMs)} ms` : null, v?.heldMs != null ? `held ${fmtMs(v.heldMs)}` : null, ...extra,
    ].filter(Boolean);
    if (pair) tech.push(`route ${pair.protocol ?? "?"} ${pair.localType ?? "?"}→${pair.remoteType ?? "?"}${pair.relayProtocol ? ` relay over ${pair.relayProtocol}` : ""} port ${pair.port ?? "?"}${pair.rttMs != null ? ` rtt ${Math.round(pair.rttMs)} ms` : ""}`);
    const lossy = (v?.lossPct ?? 0) > 2;
    return { ...base, status: lossy ? "warn" : "ok", value: `WebRTC${transportLabel(pair) ? ` · ${transportLabel(pair)}` : ""}${src}`, detail: bits.join(" · ") || undefined, tech, mbps: v?.mbps };
  }
  const el = t.video, lvl = t.hls && t.hls.currentLevel >= 0 ? t.hls.levels[t.hls.currentLevel] : undefined;
  let behind: number | undefined;
  if (t.hls && Number.isFinite(t.hls.latency) && t.hls.latency > 0) behind = t.hls.latency;
  else if (el.seekable.length) behind = el.seekable.end(el.seekable.length - 1) - el.currentTime;
  const mbps = lvl?.bitrate ? lvl.bitrate / 1e6 : undefined;
  const bits = [
    [codecName(lvl?.videoCodec), el.videoWidth ? `${el.videoWidth}×${el.videoHeight}` : null].filter(Boolean).join(" ") || null,
    mbps ? fmtMbps(mbps) : null, behind != null && behind >= 0 ? `${Math.round(behind)} s behind` : null, t.stalls ? `stalled ${times(t.stalls)}` : null, ...extra,
  ].filter(Boolean);
  if (t.nativeHls) tech.push("browser's own HLS player (no detail available)");
  return { ...base, status: t.stalls > 1 ? "warn" : "ok", value: `${t.transport === "webrtc" ? "WebRTC" : "HLS"}${src}`, detail: bits.join(" · ") || undefined, tech, mbps };
}

// ---- rows ------------------------------------------------------------------------------------------
const pending = (id: string, label: string): CheckRow => ({ id, label, status: "pending", value: "Checking…" });
const failedRow = (id: string, label: string, f: Failed, what = "Couldn't check"): CheckRow => ({ id, label, status: "warn", value: what, detail: f.status === 429 ? "Checked too often. Try again in a minute." : f.status === 0 ? "No answer from the server." : `HTTP ${f.status}${f.code ? ` ${f.code}` : ""}`, tech: [`status ${f.status}${f.code ? ` ${f.code}` : ""}${f.requestId ? ` request ${f.requestId}` : ""}`] });
const isFailed = (x: unknown): x is Failed => !!x && typeof x === "object" && "failed" in x;
const n = (x: number) => x.toLocaleString("en-US");

function webrtcRow(id: "udp" | "tcp", r: WebrtcResult | undefined, label = `WebRTC over ${id.toUpperCase()}`): CheckRow {
  if (!r) return pending(id, label);
  if (r.ok) {
    const port = r.pair?.port ?? r.ports[0];
    const parts = [port && !viaRelay(r.pair) ? `Port ${port}` : null, routeLabel(r.pair), r.pair?.rttMs != null ? `round trip ${Math.round(r.pair.rttMs)} ms` : null, id === "tcp" ? "used only when UDP is blocked" : null].filter(Boolean);
    return { id, label, status: "ok", value: `Connected in ${fmtMs(r.connectMs)}`, detail: parts.join(" · "), tech: [`signalling ${Math.round(r.signallingMs)} ms`, `pair ${JSON.stringify(r.pair)}`] };
  }
  const tech = [`reason ${r.reason}`, ...(r.status ? [`status ${r.status} ${r.code ?? ""}`.trim()] : []), ...(r.requestId ? [`request ${r.requestId}`] : []), ...(r.message ? [`message ${r.message}`] : []), ...(r.iceState ? [`ICE ${r.iceState}`] : [])];
  if (r.reason === "skipped") return { id, label, status: "info", value: "Not tried", detail: "Live video uses HLS until the relay is back.", tech };
  if (r.reason === "refused") return { id, label, status: "warn", value: "Refused (HTTP 429)", detail: `${r.code ?? "rate_limited"} · not tested. Try again in a minute.`, tech };
  if (r.reason === "no_candidates") return { id, label, status: id === "tcp" ? "warn" : "bad", value: "Not offered", detail: `The server offered no ${id.toUpperCase()} address.`, tech };
  if (r.reason === "blocked") return { id, label, status: "bad", value: "Blocked", detail: `No reply${r.ports?.[0] ? ` from port ${r.ports[0]}` : ""} after ${fmtMs(r.waitedMs ?? 0)} · ICE ${r.iceState}`, tech };
  return { id, label, status: "warn", value: "Couldn't test", detail: r.status ? `HTTP ${r.status} ${r.code ?? ""}`.trim() : r.message, tech };
}

function hlsRow(r: HlsResult | undefined): CheckRow {
  const label = "HLS";
  if (!r) return pending("hls", label);
  const tech = r.steps.map((s) => `${s.name}: ${s.t.status} in ${Math.round(s.t.ms)} ms${s.t.bytes ? `, ${n(s.t.bytes)} bytes` : ""}${s.t.code ? ` ${s.t.code}` : ""}${s.t.requestId ? ` request ${s.t.requestId}` : ""}`);
  const short = r.steps.filter((s) => s.name !== "Video playlist").map((s) => `${s.name} ${s.t.status || "no answer"} in ${fmtMs(s.t.ms)}`).join(" · ");
  if (r.ok) return { id: "hls", label, status: "ok", value: `Working · ready in ${fmtMs(r.totalMs)}`, detail: short, tech };
  if (r.t.status === 429) return { id: "hls", label, status: "warn", value: "Refused (HTTP 429)", detail: `${r.t.code ?? "rate_limited"} · not tested. Try again in a minute.`, tech };
  return { id: "hls", label, status: "bad", value: `${r.step} failed`, detail: r.t.status ? `HTTP ${r.t.status}${r.t.code ? ` ${r.t.code}` : ""} after ${fmtMs(r.t.ms)}` : `${r.t.code === "timed_out" ? "Timed out" : "No answer"} after ${fmtMs(r.t.ms)}`, tech };
}

function codecRow(c: Codecs | undefined): CheckRow {
  if (!c) return pending("codecs", "Codecs");
  const h264 = c.webrtc.h264 || c.mse.h264 || c.nativeHls, h265 = c.webrtc.h265 || c.mse.h265 || c.native265;
  const value = h264 && h265 ? "H.264 and H.265" : h264 ? "H.264 only" : "No H.264";
  const hw = c.efficient.h264 && c.efficient.h265 && h265 ? "Both decode with hardware in this browser" : c.efficient.h264 ? "H.264 decodes with hardware in this browser" : c.efficient.h264 === false ? "H.264 decodes in software, which uses more power" : "This browser doesn't say how it decodes";
  const detail = [hw, !h265 && h264 ? "cameras sending H.265 won't play here" : null].filter(Boolean).join(" · ");
  const yn = (b: boolean | undefined) => (b === undefined ? "unknown" : b ? "yes" : "no");
  return { id: "codecs", label: "Codecs", status: h264 ? "ok" : "bad", value, detail, tech: [`WebRTC: H.264 ${yn(c.webrtc.h264)}, H.265 ${yn(c.webrtc.h265)}`, `HLS (MSE): H.264 ${yn(c.mse.h264)}, H.265 ${yn(c.mse.h265)}`, `native HLS: ${yn(c.nativeHls)}, H.265 ${yn(c.native265)}`, `power-efficient decode: H.264 ${yn(c.efficient.h264)}, H.265 ${yn(c.efficient.h265)}`] };
}

/** Builds every section from what the checks found so far, and the problems the verdict can name. */
function build(r: Results, running: boolean, tz: string, onTryNow: () => void) {
  const problems = new Set<ProblemId>();
  const info = r.info && !isFailed(r.info) ? r.info : undefined;
  const connection: CheckRow[] = [], live: CheckRow[] = [], device: CheckRow[] = [];

  // Server
  if (!r.rtt) connection.push(pending("server", "Server"));
  else if (!r.rtt.ms.length) { problems.add("server_unreachable"); connection.push({ id: "server", label: "Server", status: "bad", value: "Can't reach the server", detail: `${location.host} didn't answer.` }); }
  else {
    const m = median(r.rtt.ms);
    const proto = r.rtt.protocol ? ({ h2: "HTTP/2", h3: "HTTP/3", "http/1.1": "HTTP/1.1" } as Record<string, string>)[r.rtt.protocol] ?? r.rtt.protocol : null;
    connection.push({ id: "server", label: "Server", status: m > 500 || r.rtt.failures ? "warn" : "ok", value: `Reachable · ${Math.round(m)} ms`, detail: [`Median of ${r.rtt.ms.length} requests`, proto, location.host].filter(Boolean).join(" · "), tech: [`round trips ${r.rtt.ms.map((x) => Math.round(x)).join(", ")} ms`, ...(r.rtt.failures ? [`${r.rtt.failures} failed`] : [])] });
  }
  // Recorder and relay
  if (!r.info) connection.push(pending("recorder", "Recorder"));
  else if (!info) connection.push(failedRow("recorder", "Recorder", r.info as Failed));
  else {
    if (info.recorder === "down") problems.add("recorder_down");
    connection.push({ id: "recorder", label: "Recorder", status: info.recorder === "connected" ? "ok" : info.recorder === "down" ? "bad" : "warn", value: info.recorder === "connected" ? "Connected" : info.recorder === "down" ? "Not connected" : "Connecting…", detail: info.recorder === "down" ? "Video and activity are unavailable until it's back." : undefined });
    if (!info.relay) { problems.add("relay_down"); connection.push({ id: "relay", label: "Live video service", status: "bad", value: "Not answering", detail: "Live video can't start. Recordings still work." }); }
  }
  // Download speed
  const measured = (r.playing ?? []).map((p) => p.mbps).filter((x): x is number => !!x && x > 0.05);
  const perStream = perStreamMbps(measured);
  if (!r.download) connection.push(pending("download", "Download speed"));
  else if (isFailed(r.download)) connection.push(failedRow("download", "Download speed", r.download, "Couldn't measure"));
  else {
    const fits = camerasFor(r.download.mbps, perStream), want = Math.max(4, liveTiles().length);
    if (fits < want) problems.add("slow_download");
    connection.push({ id: "download", label: "Download speed", status: fits < 1 ? "bad" : fits < want ? "warn" : "ok", value: fmtMbps(r.download.mbps), detail: fits < 1 ? "Not enough for one camera" : info && fits >= info.streams.limit ? `Enough for a full wall of ${info.streams.limit} cameras` : `Enough for about ${fits} camera${fits === 1 ? "" : "s"} at once`, tech: [`${n(r.download.bytes)} bytes in ${Math.round(r.download.ms)} ms`, `per camera ${perStream.toFixed(2)} Mbps (${measured.length ? `measured on ${measured.length} playing, at least ${MIN_STREAM_MBPS}` : "typical, nothing measured"})`] });
  }
  // Refusals
  const ref = refusalsSince(Date.now() - REFUSAL_WINDOW_MS), groups = groupRefusals(ref);
  if (ref.length) problems.add("refused");
  const usage = info?.rate.filter((x) => x.used > 0 || x.class === "read") ?? [];
  const near = usage.some((x) => x.used >= x.limit * 0.9);
  connection.push({
    id: "refused", label: "Refused (HTTP 429)", status: ref.length || near ? "warn" : !info && !r.info ? "pending" : "ok",
    value: ref.length ? `${ref.length} in the last 10 minutes` : "None in the last 10 minutes",
    detail: [refusalText(groups), usage.length ? `Requests this minute: ${usage.map((x) => `${x.class === "hls" ? "HLS" : x.class} ${n(x.used)} of ${n(x.limit)}`).join(" · ")}` : null].filter(Boolean).join("\n") || undefined,
    tech: [...(info?.rate.map((x) => `${x.class}: ${x.used}/${x.limit}, resets in ${x.resetSeconds} s`) ?? []), ...ref.map((x) => `${new Date(x.at).toISOString()} ${x.code} ${x.path}`)],
  });

  // Live video tests
  const pause = webrtcPause();
  // With relay only, tiles never try a direct connection, so the direct TCP test would only report a false failure.
  const relayOnly = !!info?.turn?.relayOnly;
  const relay = relayRow(r.relay, info?.turn);
  if (relay) { live.push(relay.row); relay.problems.forEach((p) => problems.add(p)); }
  if (r.stream === null) live.push({ id: "live-test", label: "Live video test", status: "info", value: "No camera to test with", detail: "None of your cameras is online right now." });
  else {
    if (relayOnly) live.push(webrtcRow("udp", r.udp, "WebRTC"));
    else live.push(webrtcRow("udp", r.udp), webrtcRow("tcp", r.tcp));
    const udpOk = r.udp?.ok, tcpOk = r.tcp?.ok;
    const blocked = (x?: WebrtcResult) => !!x && !x.ok && (x.reason === "blocked" || x.reason === "no_candidates");
    const webrtcDown = blocked(r.udp) && (relayOnly || blocked(r.tcp));
    if (webrtcDown) problems.add("webrtc_blocked");
    else if (blocked(r.udp) && tcpOk) problems.add("webrtc_tcp_only");
    if (pause && (udpOk || tcpOk)) problems.add("webrtc_paused");
    if (pause) {
      const left = Math.max(1, Math.ceil((pause.until - Date.now()) / 60_000));
      live.push({ id: "paused", label: "WebRTC paused", status: "warn", value: `Using HLS for ${left} more minute${left === 1 ? "" : "s"}`, detail: `Set after a connection failed at ${fmtShort(pause.until - pause.lengthMs, tz)}`, action: { label: "Try now", run: onTryNow } });
    }
    live.push(hlsRow(r.hls));
    const hlsBad = !!r.hls && !r.hls.ok && r.hls.t.status !== 429;
    if (hlsBad && webrtcDown) { problems.delete("webrtc_blocked"); problems.add("no_live_video"); }
    else if (hlsBad && (udpOk || tcpOk)) problems.add("hls_failed");
  }
  const codec = codecRow(r.codecs);
  if (codec.status === "bad") problems.add("no_h264");
  live.push(codec);
  if (!info) live.push(r.info ? failedRow("streams", "Open streams", r.info as Failed) : pending("streams", "Open streams"));
  else {
    const s = info.streams, full = s.open >= s.limit;
    if (full) problems.add("streams_full");
    live.push({ id: "streams", label: "Open streams", status: full ? "bad" : s.open >= s.limit * 0.8 ? "warn" : "ok", value: `${s.open} of ${s.limit}`, detail: `${s.webrtc} WebRTC · ${s.hls} HLS${full ? " · close other Unifeye tabs to free some up" : ""}`, tech: ["counted for this sign-in across all its tabs"] });
  }

  // This device
  const conn = (navigator as unknown as { connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  const net = conn ? (conn.type && conn.type !== "unknown" ? ({ wifi: "Wi-Fi", ethernet: "Ethernet", cellular: "Mobile data" } as Record<string, string>)[conn.type] ?? conn.type : conn.effectiveType ? `network like ${conn.effectiveType}` : null) : null;
  const MS = (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource ?? (typeof MediaSource !== "undefined" ? MediaSource : undefined);
  const { problems: browserProblems, ...browser } = browserRow({ ua: navigator.userAgent, network: net, webrtc: typeof RTCPeerConnection !== "undefined", mse: !!MS, nativeHls: r.codecs ? r.codecs.nativeHls : true, autoplay: r.autoplay });
  for (const id of browserProblems) problems.add(id);
  device.push({ id: "browser", label: "Browser", ...browser, tech: [...(browser.tech ?? []), ...(conn ? [`connection ${JSON.stringify({ type: conn.type, effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt })}`] : [])] });
  if (r.clockMs == null) device.push(info || r.info ? { id: "clock", label: "Clock", status: "info", value: "Couldn't check" } : pending("clock", "Clock"));
  else {
    const off = Math.abs(r.clockMs) / 1000;
    if (off > 60) problems.add("clock_off");
    device.push({ id: "clock", label: "Clock", status: off > 60 ? "warn" : "ok", value: off < 2 ? "Matches the server" : `${off < 120 ? `${Math.round(off)} s` : `${Math.round(off / 60)} minutes`} ${r.clockMs > 0 ? "ahead of" : "behind"} the server`, detail: off < 2 ? `Off by ${off.toFixed(1)} s` : undefined, tech: [`offset ${Math.round(r.clockMs)} ms`] });
  }
  device.push(info ? { id: "version", label: "Version", ...versionRow(info) } : { id: "version", label: "Version", status: "info", value: "Unifeye" });

  // Tiles failing on their own
  if ((r.playing ?? []).some((x) => x.status === "bad")) problems.add("tiles_failing");

  const sections: Section[] = [{ title: "Connection", rows: connection }, { title: "Live video", rows: live }, { title: "This device", rows: device }];
  return { sections, problems: [...problems], running };
}

// ---- the window ----------------------------------------------------------------------------------
const DOT: Record<Status, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-destructive", info: "bg-border", pending: "" };
function Dot({ status, big = false }: { status: Status; big?: boolean }) {
  if (status === "pending") return <Loader2 className={`${big ? "mt-0.5 size-3.5" : "size-3"} shrink-0 animate-spin text-muted-foreground`} aria-label="Checking" />;
  return <i aria-hidden className={`inline-block ${big ? "mt-1.5 size-2.5" : "size-2"} shrink-0 rounded-full ${DOT[status]}`} />;
}
function Row({ label, status, value, detail, action }: { label: string; status: Status; value: string; detail?: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b py-2 last:border-b-0">
      <span className="relative -top-px self-baseline"><Dot status={status} /></span>
      <span className="w-28 shrink-0 sm:w-36">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}{detail && <small className="block text-xs whitespace-pre-line text-muted-foreground">{detail}</small>}</span>
      {action && <Button size="sm" variant="outline" className="self-center" onClick={action.run}>{action.label}</Button>}
    </div>
  );
}
const SectionTitle = ({ children }: { children: React.ReactNode }) => <h3 className="mt-4 mb-0.5 text-xs font-semibold text-muted-foreground">{children}</h3>;

export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const { tz } = useApp();
  const [run, setRun] = useState<Run>(() => ({ started: Date.now(), r: {} }));
  const [, setTick] = useState(0);
  const ctl = useRef<AbortController | null>(null);

  const execute = (c: AbortController) => {
    const signal = c.signal;
    const apply = (patch: Partial<Results>) => { if (ctl.current === c) setRun((cur) => ({ ...cur, r: { ...cur.r, ...patch } })); };
    void (async () => {
      apply({ problems: problemLog() });
      const sent = Date.now();
      const infoP = api<Info>("/diagnostics", { record: false }).then((info) => { apply({ info, clockMs: clockOffset(info.serverTime, sent, Date.now()) }); return info; }, (e) => { apply({ info: { failed: true, status: e instanceof ApiError ? e.status : 0, code: e instanceof ApiError ? e.code : undefined, requestId: e instanceof ApiError ? e.requestId : undefined } }); return null; });
      const camsP = api<{ cameras: Camera[] }>("/cameras", { record: false }).then((x) => { apply({ cameras: x.cameras }); return x.cameras; }, () => [] as Camera[]);
      const [info, cams] = await Promise.all([
        infoP, camsP,
        roundTrips(signal).then((rtt) => apply({ rtt })),
        codecs().then((c) => apply({ codecs: c }), () => {}),
        testAutoplay().then((autoplay) => apply({ autoplay }), () => apply({ autoplay: "unknown" })),
        samplePlaying(signal).then((playing) => apply({ playing }), () => apply({ playing: [] })),
        relayCheck(signal).then((relay) => apply({ relay }), () => apply({ relay: null })),
      ]);
      if (signal.aborted) return;
      apply({ download: await download(signal) });
      if (signal.aborted) return;
      const stream = pickTestStream(cams, info?.streams.held ?? [], liveTiles());
      apply({ stream });
      if (stream) {
        // Relay only, and the relay is down: tiles don't try WebRTC, so neither does the test.
        const relayDown = !!info?.turn?.relayOnly && !info.turn.answering;
        apply({ udp: relayDown ? { ok: false, reason: "skipped" } : await webrtcTest(stream, "udp", signal) });
        if (signal.aborted) return;
        if (!info?.turn?.relayOnly) apply({ tcp: await webrtcTest(stream, "tcp", signal) });
        if (signal.aborted) return;
        apply({ hls: await hlsTest(stream, signal) });
      }
      if (signal.aborted) return;
      // The tiles again: a test may have changed what they show, and the log may have grown.
      const playing = await samplePlaying(signal).catch(() => [] as Playing[]);
      if (ctl.current === c) setRun((cur) => ({ ...cur, finished: Date.now(), r: { ...cur.r, playing, problems: problemLog() } }));
    })();
  };
  const start = () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setRun({ started: Date.now(), r: {} });
    execute(c);
  };
  useEffect(() => {
    const c = new AbortController();
    ctl.current = c;
    execute(c);
    return () => { c.abort(); if (ctl.current === c) ctl.current = null; };
  }, []);

  const tryNow = () => { resumeWebrtc(); setTick((x) => x + 1); toast.success("Cameras will try WebRTC again when they next connect."); };
  const running = !run.finished;
  const { sections, problems } = build(run.r, running, tz, tryNow);
  const v = verdict(problems, { running, tookMs: run.finished ? run.finished - run.started : undefined });
  const names = new Map((run.r.cameras ?? []).map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? "Camera";
  const playing = run.r.playing;
  const log = run.r.problems ?? [];

  const copy = async () => {
    const text = formatReport({
      at: run.finished ?? run.started, verdict: v, sections,
      playing: (playing ?? []).map((p) => ({ name: nameOf(p.cameraId), value: p.value, detail: p.detail, tech: p.tech })),
      problems: log, cameraName: (id) => names.get(id),
      device: { userAgent: navigator.userAgent, extra: [`Page: ${location.host}`, `Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x`, `Language: ${navigator.language}`, `Time zone: ${tz}`, ...(run.r.stream ? [`Tested camera: ${nameOf(run.r.stream.cameraId)} (${run.r.stream.quality}${run.r.stream.alreadyOpen ? ", already open" : ""})`] : [])] },
    });
    try { await navigator.clipboard.writeText(text); toast.success("Report copied"); }
    catch {
      // Clipboard access can be refused (no permission, not a secure page): fall back to a selection copy.
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) toast.success("Report copied"); else toast.error("Couldn't copy the report. Try again.");
    }
  };

  const verdictTone = v.status === "bad" ? "bg-destructive/10" : v.status === "warn" ? "bg-amber-500/10" : "bg-muted";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-xl">
        <div className="px-4 pt-4">
          <DialogTitle>Diagnostics</DialogTitle>
          <DialogDescription className="sr-only">Checks how live video reaches this browser.</DialogDescription>
          <div className={`mt-3 flex items-start gap-2.5 rounded-lg p-3 ${verdictTone}`} role="status" aria-live="polite">
            <Dot status={v.status} big />
            <div><b className="block font-semibold">{v.title}</b><span className="text-muted-foreground">{v.text}</span></div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {sections.slice(0, 2).map((s) => (
            <section key={s.title}><SectionTitle>{s.title}</SectionTitle>{s.rows.map((r) => <Row key={r.id} {...r} />)}</section>
          ))}
          <section>
            <SectionTitle>Playing now</SectionTitle>
            {!playing ? <Row label="Live tiles" status="pending" value="Checking…" />
              : !playing.length ? <p className="py-2 text-muted-foreground">Nothing is playing right now.</p>
              : playing.map((p) => <Row key={p.tileId} label={nameOf(p.cameraId)} status={p.status} value={p.value} detail={p.detail} />)}
          </section>
          {log.length > 0 && (
            <section>
              <SectionTitle>Recent problems</SectionTitle>
              {log.map((e, i) => (
                <div key={i} className="flex gap-3 border-b py-1.5 last:border-b-0">
                  <time className="w-16 shrink-0 text-muted-foreground tabular-nums">{fmtShort(e.at, tz)}</time>
                  <span className="min-w-0 flex-1 break-words">{e.cameraId ? `${nameOf(e.cameraId)}: ` : ""}{e.title}
                    {(e.path || e.detail || e.requestId) && <small className="block text-xs text-muted-foreground">{[e.method && e.path ? `${e.method} ${e.path}` : e.path, e.requestId ? `request ${e.requestId.slice(0, 8)}` : null, e.detail].filter(Boolean).join(" · ")}</small>}
                  </span>
                </div>
              ))}
            </section>
          )}
          {sections.slice(2).map((s) => (
            <section key={s.title}><SectionTitle>{s.title}</SectionTitle>{s.rows.map((r) => <Row key={r.id} {...r} />)}</section>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted/50 p-4">
          <Button variant="outline" onClick={copy}>Copy report</Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={start} disabled={running}>{running ? "Checking…" : "Check again"}</Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
