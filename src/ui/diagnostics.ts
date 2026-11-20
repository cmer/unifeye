/**
 * Diagnostics for this tab: what went wrong recently, which requests the server refused, and which
 * live tiles are playing. Everything lives in memory and is gone when the tab closes. The pure
 * helpers below (candidate filtering, playlist parsing, verdict, report, user agent) have no browser
 * dependencies, so the tests run them directly.
 */

// ---- the problem log and refusals ------------------------------------------------------
export type ProblemKind = "request" | "webrtc" | "hls" | "tile";
export interface ProblemEntry {
  at: number; kind: ProblemKind; title: string; detail?: string; cameraId?: string;
  method?: string; path?: string; status?: number; code?: string; requestId?: string;
}
export interface Refusal { at: number; code: string; path: string }

const MAX_PROBLEMS = 50;
/** 429s are counted over this window. */
export const REFUSAL_WINDOW_MS = 10 * 60_000;
const problems: ProblemEntry[] = [];
const refusals: Refusal[] = [];

export function recordProblem(e: Omit<ProblemEntry, "at"> & { at?: number }) {
  problems.unshift({ ...e, at: e.at ?? Date.now() });
  if (problems.length > MAX_PROBLEMS) problems.length = MAX_PROBLEMS;
}
/** A request the server answered with an error, or one that never got an answer (status 0). */
export function recordRequestFailure(r: { method: string; path: string; status: number; code?: string; requestId?: string | null; cameraId?: string }) {
  const at = Date.now(), path = shortenPath(r.path);
  if (r.status === 429) {
    refusals.push({ at, code: r.code || "unknown", path });
    while (refusals.length && refusals[0].at < at - REFUSAL_WINDOW_MS) refusals.shift();
  }
  const what = r.status === 0 ? "No answer from the server" : `HTTP ${r.status}${r.code && r.code !== "error" ? ` ${r.code}` : ""}`;
  recordProblem({ at, kind: "request", title: what, method: r.method, path, status: r.status, code: r.code, requestId: r.requestId ?? undefined, cameraId: r.cameraId ?? cameraIdIn(r.path) });
}
export const problemLog = (): readonly ProblemEntry[] => problems.slice();
export const refusalsSince = (since: number): readonly Refusal[] => refusals.filter((r) => r.at >= since);
/** For tests. */
export function clearDiagnostics() { problems.length = 0; refusals.length = 0; tiles.clear(); }

// ---- the registry of live tiles -----------------------------------------------------------
/** The parts of an hls.js player the diagnostics read. */
export interface HlsLike { levels: { bitrate: number; width: number; height: number; videoCodec?: string }[]; currentLevel: number; latency: number }
export interface TileInfo {
  id: number; cameraId: string; quality: "wall" | "focus"; since: number;
  state: string; transport: "webrtc" | "hls" | null; source: string | null;
  attempts: number; refusals: number; stalls: number; lastError: string | null;
  pc: RTCPeerConnection | null; hls: HlsLike | null; nativeHls: boolean; video: HTMLVideoElement;
}
export type TileUpdate = Partial<Pick<TileInfo, "state" | "transport" | "source" | "attempts" | "lastError" | "pc" | "hls" | "nativeHls">>;
export interface TileHandle { update(u: TileUpdate): void; refused(): void; done(): void }
const tiles = new Map<number, TileInfo>();
let nextTile = 0;
/** A live tile that is trying to play. `done` when it stops. Counts the video element's stalls itself. */
export function registerTile(cameraId: string, quality: "wall" | "focus", video: HTMLVideoElement): TileHandle {
  const t: TileInfo = { id: ++nextTile, cameraId, quality, since: Date.now(), state: "connecting", transport: null, source: null, attempts: 0, refusals: 0, stalls: 0, lastError: null, pc: null, hls: null, nativeHls: false, video };
  tiles.set(t.id, t);
  // "waiting" fires on every stall, and also once while a fresh stream starts: count only after it played.
  const stalled = () => { if (t.state === "playing") t.stalls++; };
  video.addEventListener("waiting", stalled);
  return {
    update: (u) => { Object.assign(t, u); },
    refused: () => { t.refusals++; },
    done: () => { tiles.delete(t.id); video.removeEventListener("waiting", stalled); },
  };
}
export const liveTiles = (): readonly TileInfo[] => [...tiles.values()];

// ---- small pure helpers ---------------------------------------------------------------------
/** Ids (camera ids, WHEP resources) make paths long and say nothing to a reader: shown as "…". The query is dropped. */
export function shortenPath(path: string) {
  return path.split("?")[0].split("/").map((seg) => (seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg) ? "…" : seg)).join("/");
}
/** The camera a media or camera path is about, if any. */
export function cameraIdIn(path: string): string | undefined {
  return /^\/(?:api\/)?(?:media\/live|cameras)\/(?!whep\/)([^/?]+)\//.exec(path)?.[1];
}

/**
 * Keeps only the answer's ICE candidates of one transport, so a test connection can use nothing
 * else. Other lines are untouched. `kept` is how many candidates were left.
 */
export function filterCandidates(sdp: string, protocol: "udp" | "tcp"): { sdp: string; kept: number; ports: number[] } {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const ports: number[] = [];
  const lines = sdp.split(/\r?\n/).filter((l) => {
    // a=candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
    const m = /^a=candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+\S+\s+(\d+)/i.exec(l);
    if (!m) return !/^a=candidate:/i.test(l);
    const keep = m[1].toLowerCase() === protocol;
    if (keep && !ports.includes(Number(m[2]))) ports.push(Number(m[2]));
    return keep;
  });
  return { sdp: lines.join(eol), kept: lines.filter((l) => /^a=candidate:/i.test(l)).length, ports };
}

/** The URIs in an HLS playlist: variant playlists, segments (and parts), and the init section. */
export function parsePlaylist(text: string) {
  const variants: string[] = [], segments: string[] = [];
  let init: string | null = null, nextIsVariant = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#EXT-X-STREAM-INF")) { nextIsVariant = true; continue; }
    if (l.startsWith("#EXT-X-MEDIA:") && /TYPE=VIDEO/.test(l)) { const u = /URI="([^"]+)"/.exec(l)?.[1]; if (u) variants.push(u); continue; }
    if (l.startsWith("#EXT-X-MAP:")) { init ??= /URI="([^"]+)"/.exec(l)?.[1] ?? null; continue; }
    if (l.startsWith("#")) continue;
    (nextIsVariant ? variants : segments).push(l);
    nextIsVariant = false;
  }
  return { variants, segments, init };
}

/** Groups refusals by error code, and says "(HLS)" for those that came from the HLS player's requests. */
export function groupRefusals(list: readonly Refusal[]) {
  const m = new Map<string, { code: string; hls: boolean; count: number }>();
  for (const r of list) {
    const hls = r.path.includes("/hls/"), k = `${r.code}|${hls}`;
    const g = m.get(k) ?? { code: r.code, hls, count: 0 };
    g.count++; m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
export const refusalText = (groups: ReturnType<typeof groupRefusals>) => groups.map((g) => `${g.count} × ${g.code}${g.hls ? " (HLS)" : ""}`).join(" · ");

export const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
/**
 * How far this device's clock is ahead of the server's (negative: behind), from one request sent
 * at `sent` and answered at `received` (both local), assuming the server stamped it halfway.
 */
export const clockOffset = (serverTime: number, sent: number, received: number) => (sent + received) / 2 - serverTime;

/**
 * Bitrate for one live stream when nothing is playing to measure. Protect's low ("wall") streams at
 * 720p run about 1 to 1.5 Mbps; 2 Mbps leaves room for busy scenes and the occasional high stream.
 */
export const DEFAULT_STREAM_MBPS = 2;
/**
 * Measured bitrates count for no less than this: a one-second sample of a quiet scene (or the
 * simulated cameras) can be a few kbps, which would promise room for thousands of cameras.
 */
export const MIN_STREAM_MBPS = 1;
/** Per-stream bitrate for the estimate: the mean of what is playing, or the typical value when nothing is. */
export const perStreamMbps = (measured: readonly number[]) => (measured.length ? Math.max(MIN_STREAM_MBPS, measured.reduce((a, b) => a + b, 0) / measured.length) : DEFAULT_STREAM_MBPS);
/** How many streams fit in a measured download speed, keeping a quarter spare for everything else. */
export const camerasFor = (mbps: number, perStreamMbps: number) => (perStreamMbps > 0 && mbps > 0 ? Math.max(0, Math.floor((mbps * 0.75) / perStreamMbps)) : 0);

/** Browser and system from a user agent. Conservative: anything it does not recognise is left out. */
export function parseUserAgent(ua: string): { browser: string | null; os: string | null } {
  const v = (re: RegExp) => re.exec(ua)?.[1];
  let browser: string | null = null;
  const major = (s: string | undefined) => s?.split(".")[0];
  if (v(/Edg(?:e|A|iOS)?\/([\d.]+)/)) browser = `Edge ${major(v(/Edg(?:e|A|iOS)?\/([\d.]+)/))}`;
  else if (v(/OPR\/([\d.]+)/)) browser = `Opera ${major(v(/OPR\/([\d.]+)/))}`;
  else if (v(/(?:Firefox|FxiOS)\/([\d.]+)/)) browser = `Firefox ${major(v(/(?:Firefox|FxiOS)\/([\d.]+)/))}`;
  else if (v(/(?:Chrome|CriOS)\/([\d.]+)/)) browser = `Chrome ${major(v(/(?:Chrome|CriOS)\/([\d.]+)/))}`;
  else if (/Safari\//.test(ua) && v(/Version\/([\d.]+)/)) browser = `Safari ${v(/Version\/(\d+(?:\.\d+)?)/)}`;
  let os: string | null = null;
  const ios = v(/(?:iPhone|iPad|iPod).*? OS (\d+(?:_\d+)?)/);
  if (ios) os = `${/iPad/.test(ua) ? "iPadOS" : "iOS"} ${ios.replace("_", ".")}`;
  else if (/Android/.test(ua)) os = `Android${v(/Android (\d+(?:\.\d+)?)/) ? ` ${v(/Android (\d+(?:\.\d+)?)/)}` : ""}`;
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  // Browsers freeze the macOS and Windows versions in the user agent, so only the name is reliable.
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  return { browser, os };
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtMbps = (mbps: number) => (mbps < 1 ? `${Math.round(mbps * 1000)} kbps` : `${mbps >= 10 ? Math.round(mbps).toLocaleString("en-US") : mbps.toFixed(1)} Mbps`);

// ---- results, verdict and report ------------------------------------------------------------
export type Status = "ok" | "warn" | "bad" | "info" | "pending";
/** One line in the window: a plain value, a muted detail line, and technical lines kept for the report. */
export interface CheckRow { id: string; label: string; status: Status; value: string; detail?: string; tech?: string[]; action?: { label: string; run: () => void } }
export interface Section { title: string; rows: CheckRow[] }

/** What the server says about newer versions (`src/server/version.ts`). */
export interface UpdateInfo { state: "current" | "behind" | "unknown" | "off"; latest: string | null; behindBy: number | null; checkedAt: number | null }
/**
 * The Version row: green when this is the newest, amber when something newer exists, and no colour
 * when nobody knows (the check is off or has not worked), which is not a reason for concern.
 */
export function versionRow(v: { version: string; commit: string | null; update: UpdateInfo }): Pick<CheckRow, "status" | "value" | "detail" | "tech"> {
  const u = v.update, n = u.behindBy ?? 0;
  const value = `Unifeye ${v.version}${v.commit ? ` \u00b7 ${v.commit.slice(0, 7)}` : ""}`;
  const latest = u.latest?.replace(/^v/, "");
  const tech = [`commit ${v.commit ?? "unknown"}`, `update check: ${u.state}${u.latest ? `, latest release ${u.latest}` : ""}${u.behindBy != null ? `, ${u.behindBy} commits behind` : ""}${u.checkedAt ? `, checked ${new Date(u.checkedAt).toISOString()}` : ""}`];
  if (u.state === "current") return { status: "ok", value, detail: "Up to date", tech };
  if (u.state === "behind") return { status: "warn", value, detail: [latest ? `Version ${latest} is available` : "A newer version is available", n > 0 ? `${n} ${n === 1 ? "change" : "changes"} behind` : null].filter(Boolean).join(" \u00b7 "), tech };
  return { status: "info", value, detail: u.state === "unknown" ? "Couldn\u2019t check for a newer version" : undefined, tech };
}

/** Problems the verdict can name, most important first. */
export const PROBLEMS = {
  server_unreachable: { title: "Can't reach Unifeye", hint: "Check this device's internet connection, then check again.", short: "the server can't be reached", severe: true },
  recorder_down: { title: "The recorder isn't connected", hint: "Video and activity are unavailable until it's back. Your administrator can check the recorder.", short: "the recorder isn't connected", severe: true },
  relay_down: { title: "Live video isn't available right now", hint: "The live video service isn't answering. Recordings still work. Let your administrator know.", short: "the live video service isn't answering", severe: true },
  no_live_video: { title: "Live video can't get through on this network", hint: "Neither WebRTC nor HLS worked. Try another network, or let your administrator know.", short: "live video can't get through", severe: true },
  streams_full: { title: "This browser has too many streams open", hint: "Close other Unifeye tabs or windows to free some up.", short: "this browser has too many streams open", severe: true },
  no_h264: { title: "This browser can't play H.264 video", hint: "Try a current version of Chrome, Edge, Firefox or Safari.", short: "this browser can't play H.264", severe: true },
  tiles_failing: { title: "Some cameras can't connect", hint: "They keep trying on their own. Check again in a minute.", short: "some cameras can't connect", severe: true },
  refused: { title: "The server turned some requests away", hint: "This usually clears within a minute. If it keeps happening, close other Unifeye tabs.", short: "some requests were turned away", severe: false },
  webrtc_blocked: { title: "WebRTC can't get through on this network", hint: "Cameras still play over HLS, a few seconds behind.", short: "WebRTC is blocked", severe: false },
  hls_failed: { title: "HLS isn't working", hint: "WebRTC works, so video still plays here. Let your administrator know.", short: "HLS isn't working", severe: false },
  slow_download: { title: "This connection is slow for live video", hint: "Fewer cameras at once will play more smoothly.", short: "the connection is slow", severe: false },
  webrtc_tcp_only: { title: "WebRTC only works over TCP here", hint: "Video plays, but may lag a little on a busy network.", short: "WebRTC only works over TCP", severe: false },
  webrtc_paused: { title: "WebRTC works again", hint: "Choose Try now to switch back to real-time video.", short: "WebRTC is paused but works", severe: false },
  clock_off: { title: "This device's clock is off", hint: "Times may not match the recordings. Set the clock to update automatically.", short: "the device clock is off", severe: false },
} as const;
export type ProblemId = keyof typeof PROBLEMS;
const ORDER = Object.keys(PROBLEMS) as ProblemId[];

export interface Verdict { status: Status; title: string; text: string }
/** One sentence for the top of the window: the most important problem first, then a word on the others. */
export function verdict(found: readonly ProblemId[], o: { running: boolean; tookMs?: number }): Verdict {
  const list = ORDER.filter((id) => found.includes(id));
  if (o.running && !list.length) return { status: "pending", title: "Checking…", text: "This takes a few seconds." };
  if (!list.length) return { status: "ok", title: "Everything looks good", text: `Checked just now.${o.tookMs ? ` Took ${Math.max(1, Math.round(o.tookMs / 1000))} seconds.` : ""}` };
  const top = PROBLEMS[list[0]], rest = list.slice(1, 3).map((id) => PROBLEMS[id].short);
  const also = rest.length ? ` Also, ${rest.length === 2 ? `${rest[0]} and ${rest[1]}` : rest[0]}.` : "";
  return { status: top.severe ? "bad" : "warn", title: top.title, text: `${top.hint}${also}` };
}

export interface ReportInput {
  at: number; verdict: Verdict; sections: Section[];
  playing: { name: string; value: string; detail?: string; tech?: string[] }[];
  problems: readonly ProblemEntry[]; cameraName: (id: string) => string | undefined;
  device: { userAgent: string; extra?: string[] };
}
const MARK: Record<Status, string> = { ok: "ok", warn: "warning", bad: "problem", info: "info", pending: "not finished" };
/** The plain-text report "Copy report" puts on the clipboard: everything shown plus the technical detail. */
export function formatReport(r: ReportInput) {
  const out: string[] = ["Unifeye diagnostics", `Checked: ${new Date(r.at).toISOString()}`, "", `${r.verdict.title}. ${r.verdict.text}`];
  for (const s of r.sections) {
    out.push("", `== ${s.title} ==`);
    for (const row of s.rows) {
      out.push(`${row.label}: ${row.value} [${MARK[row.status]}]`);
      if (row.detail) out.push(`  ${row.detail}`);
      for (const t of row.tech ?? []) out.push(`  ${t}`);
    }
  }
  out.push("", "== Playing now ==");
  if (!r.playing.length) out.push("Nothing is playing.");
  for (const p of r.playing) { out.push(`${p.name}: ${p.value}`); if (p.detail) out.push(`  ${p.detail}`); for (const t of p.tech ?? []) out.push(`  ${t}`); }
  out.push("", "== Recent problems ==");
  if (!r.problems.length) out.push("None.");
  for (const p of r.problems) {
    const cam = p.cameraId ? r.cameraName(p.cameraId) : undefined;
    out.push(`${new Date(p.at).toISOString()} ${cam ? `${cam}: ` : ""}${p.title}`);
    const bits = [p.method && p.path ? `${p.method} ${p.path}` : p.path, p.requestId ? `request ${p.requestId}` : null, p.detail].filter(Boolean);
    if (bits.length) out.push(`  ${bits.join(" · ")}`);
  }
  out.push("", "== Device ==", `User agent: ${r.device.userAgent}`, ...(r.device.extra ?? []));
  return out.join("\n") + "\n";
}

// ---- WebRTC statistics (from RTCPeerConnection.getStats, as plain objects) -----------------
export interface Stat { type: string; id: string; [k: string]: unknown }
export const statList = (r: { forEach(cb: (s: unknown) => void): void }) => { const out: Stat[] = []; r.forEach((s) => out.push(s as Stat)); return out; };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The candidate pair carrying media: the transport's selected pair, or the nominated, succeeded one (Firefox). */
export function selectedPair(stats: readonly Stat[]) {
  const byId = new Map(stats.map((s) => [s.id, s]));
  const tr = stats.find((s) => s.type === "transport" && str(s.selectedCandidatePairId));
  const pair = (tr && byId.get(str(tr.selectedCandidatePairId)!)) ?? stats.find((s) => s.type === "candidate-pair" && (s.selected === true || (s.nominated === true && s.state === "succeeded")));
  if (!pair) return null;
  const local = byId.get(str(pair.localCandidateId) ?? ""), remote = byId.get(str(pair.remoteCandidateId) ?? "");
  const rtt = num(pair.currentRoundTripTime);
  return {
    protocol: (str(local?.protocol) ?? str(remote?.protocol))?.toLowerCase() as "udp" | "tcp" | undefined,
    localType: str(local?.candidateType), remoteType: str(remote?.candidateType), relayProtocol: str(local?.relayProtocol),
    port: num(remote?.port), address: str(remote?.address) ?? str(remote?.ip), rttMs: rtt == null ? undefined : rtt * 1000,
  };
}
export type Pair = NonNullable<ReturnType<typeof selectedPair>>;
const CANDIDATE: Record<string, string> = { host: "direct (host)", srflx: "through NAT (srflx)", prflx: "direct (prflx)", relay: "relayed (relay)" };
export const candidateLabel = (type: string | undefined) => (type ? CANDIDATE[type] ?? type : "unknown route");

/** Codec names people recognise, from a WebRTC mime type or an HLS codecs string. */
export function codecName(s: string | undefined) {
  if (!s) return undefined;
  if (/h264|avc1|avc3/i.test(s)) return "H.264";
  if (/h265|hevc|hvc1|hev1/i.test(s)) return "H.265";
  if (/vp8/i.test(s)) return "VP8";
  if (/vp9|vp09/i.test(s)) return "VP9";
  if (/av1|av01/i.test(s)) return "AV1";
  return s.replace(/^video\//i, "");
}

/**
 * The incoming video stream: codec, size and frame rate from the latest sample; bitrate from the
 * bytes between two samples; loss as a share of all packets; jitter in milliseconds; and how long
 * frames wait in the browser before they are shown (`LIVE_BUFFER_MS` or more), between the two
 * samples when there are two, else since the stream started.
 */
export function inboundVideo(now: readonly Stat[], before: readonly Stat[] | null) {
  const v = now.find((s) => s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video"));
  if (!v) return null;
  const prev = before?.find((s) => s.id === v.id);
  const bytes = num(v.bytesReceived), t = num(v.timestamp), pb = num(prev?.bytesReceived), pt = num(prev?.timestamp);
  const mbps = bytes != null && t != null && pb != null && pt != null && t > pt ? ((bytes - pb) * 8) / ((t - pt) * 1000) : undefined;
  const lost = num(v.packetsLost) ?? 0, got = num(v.packetsReceived) ?? 0, jitter = num(v.jitter);
  const codec = now.find((s) => s.id === str(v.codecId));
  const waited = num(v.jitterBufferDelay), shown = num(v.jitterBufferEmittedCount), pw = num(prev?.jitterBufferDelay) ?? 0, ps = num(prev?.jitterBufferEmittedCount) ?? 0;
  const heldMs = waited != null && shown != null && shown > ps ? ((waited - pw) / (shown - ps)) * 1000 : undefined;
  return {
    heldMs,
    codec: codecName(str(codec?.mimeType)), width: num(v.frameWidth), height: num(v.frameHeight), fps: num(v.framesPerSecond),
    mbps, lossPct: got + lost > 0 ? (Math.max(0, lost) / (got + Math.max(0, lost))) * 100 : undefined, jitterMs: jitter == null ? undefined : jitter * 1000,
  };
}

// ---- which stream the live tests use --------------------------------------------------------
export interface TestStream { cameraId: string; quality: "wall" | "focus"; alreadyOpen: boolean }
/**
 * A stream for the WebRTC and HLS tests. One this session already holds comes first, so the test
 * takes no extra slot from the stream limit; then one a tile here is starting; then any online camera.
 */
export function pickTestStream(cams: readonly { id: string; online: boolean; hasLive: boolean }[], held: readonly { cameraId: string; quality: "wall" | "focus" }[], tilesHere: readonly { cameraId: string; quality: "wall" | "focus" }[]): TestStream | null {
  const ok = new Set(cams.filter((c) => c.online && c.hasLive).map((c) => c.id));
  const from = (l: readonly { cameraId: string; quality: "wall" | "focus" }[]) => l.find((x) => ok.has(x.cameraId) && x.quality === "wall") ?? l.find((x) => ok.has(x.cameraId));
  const h = from(held) ?? from(tilesHere);
  if (h) return { cameraId: h.cameraId, quality: h.quality, alreadyOpen: true };
  const c = cams.find((x) => ok.has(x.id));
  return c ? { cameraId: c.id, quality: "wall", alreadyOpen: false } : null;
}
/**
 * Whether the HLS test may release its stream afterwards. Releasing ends every HLS reader this
 * session has for that stream, so only a stream the test opened itself, and that no tile here has
 * started since, is released.
 */
export const mayReleaseHls = (s: TestStream, tilesNow: readonly { cameraId: string; quality: string }[]) => !s.alreadyOpen && !tilesNow.some((t) => t.cameraId === s.cameraId && t.quality === s.quality);
