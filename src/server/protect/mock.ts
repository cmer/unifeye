import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ffmpeg } from "./ffmpeg";
import { MOCK_CAMERAS, MOCK_DIRECT, type MockCamera } from "./mock-data";
import { NoRecordingError, type AdapterHealth, type CameraLogin, type DirectCheck, type EventQuery, type EventType, type LiveSource, type ProtectAdapter, type ProtectCamera, type ProtectEvent, type RecordingRanges } from "./types";

const DAY = 864e5, RETENTION = 7 * DAY;
function rng(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Simulated recorder for mock mode and automated tests. It produces real media with FFmpeg test
 * patterns (each camera has its own tint; the pattern carries a running clock) so the live relay,
 * playback windows and clip export are exercised through the same code paths as a real UNVR.
 * Nothing here is presented to users as real footage: the UI labels mock mode.
 */
export class MockProtectAdapter implements ProtectAdapter {
  readonly mode = "mock" as const;
  private listeners = new Set<(e: ProtectEvent) => void>();
  private timer?: NodeJS.Timeout;
  private live: ProtectEvent[] = [];
  private t0 = Date.now();
  /** Tests flip this to simulate an NVR outage. */
  down = false;
  /**
   * Cameras (Protect ids) that simulate adaptive recording, also settable with MOCK_ADAPTIVE=mock-06,...
   * Like a real recorder, they keep two channels with gaps in both (see `channelParts`): high
   * resolution ("focus") only in seconds 12.5 to 21.5 of every half minute, and low resolution ("wall")
   * everywhere except seconds 15.5 to 18.5 of every half minute. An export of one channel holds that
   * channel's GOPs (one second each, starting half a second past each whole second, see `keys`)
   * joined, starting with the last one before the requested start. The picture and sound depend only on wall-clock time, so both channels show the
   * same moment alike, as real ones do.
   */
  adaptive = new Set((process.env.MOCK_ADAPTIVE ?? "").split(",").filter(Boolean));
  cameras: MockCamera[] = MOCK_CAMERAS.map((c) => ({ ...c }));

  constructor(readonly nvrId = "default", private opts: { publishUrl?: string; liveEvents?: boolean } = {}) {}

  async connect() {
    if (this.opts.liveEvents !== false && !this.timer) {
      this.timer = setInterval(() => {
        const on = this.cameras.filter((c) => c.online);
        if (this.down || !on.length) return;
        const c = on[Math.floor(Math.random() * on.length)], t = Date.now() - 8000;
        const e: ProtectEvent = { id: `${c.protectId}.live.${t}`, protectCameraId: c.protectId, type: Math.random() < 0.5 ? "motion" : "person", startMs: t, endMs: t + 6000, hasThumbnail: true };
        this.live.push(e);
        if (this.live.length > 500) this.live.shift();
        for (const l of this.listeners) l(e);
      }, 20_000);
      this.timer.unref();
    }
  }
  async close() { clearInterval(this.timer); this.timer = undefined; }
  health(): AdapterHealth {
    return { mode: "mock", state: this.down ? "down" : "connected", lastOkAt: this.down ? null : Date.now(), lastError: this.down ? "simulated outage" : null, protectVersion: "mock" };
  }
  private guard() { if (this.down) throw new Error("NVR unavailable (simulated)"); }
  private cam(id: string) { const c = this.cameras.find((x) => x.protectId === id); if (!c) throw new Error("unknown camera"); return c; }
  private n(c: MockCamera) { return Number(c.protectId.slice(-2)); }
  private typesFor(c: MockCamera): EventType[] {
    const t: EventType[] = ["motion", "person"];
    if (c.tags.includes("outdoors")) t.push("vehicle", "animal");
    if (c.tags.includes("deliveries") || c.tags.includes("entrance")) t.push("package");
    return t;
  }

  /** Simulated: the first camera records continuously, the rest in motion-like bursts. Offline cameras never record. */
  async recordingNow(): Promise<string[]> {
    this.guard();
    const slice = Math.floor(Date.now() / 20_000);
    return this.cameras.filter((c) => c.online && (this.n(c) === 1 || (this.n(c) * 7 + slice * 3) % 5 < 2)).map((c) => c.protectId);
  }

  async listCameras(): Promise<ProtectCamera[]> {
    this.guard();
    return this.cameras.map((c) => ({ protectId: c.protectId, name: c.name, online: c.online, model: "Mock G5", eventTypes: this.typesFor(c), streams: [{ quality: "high", width: 1280, height: 720, codec: "h264" }, { quality: "low", width: 640, height: 360, codec: "h264" }], recordingStartMs: Date.now() - RETENTION, recordingEndMs: c.online ? Date.now() : this.t0 - 3 * 36e5, ...(MOCK_DIRECT.has(c.protectId) ? { direct: true } : {}) }));
  }

  private gaps(c: MockCamera, a: number, b: number): [number, number][] {
    const g: [number, number][] = [[-Infinity, Date.now() - RETENTION], [Date.now(), Infinity]];
    if (!c.online) g.push([this.t0 - 3 * 36e5, Infinity]);
    for (let d = Math.floor(a / DAY) - 1; d <= Math.floor(b / DAY); d++) {
      const r = rng(this.n(c) * 7919 + d * 13), k = Math.floor(r() * 3);
      for (let i = 0; i < k; i++) { const s = d * DAY + r() * DAY; g.push([s, s + (4 + r() * 36) * 6e4]); }
    }
    return g.sort((x, y) => x[0] - y[0]);
  }
  private ranges(c: MockCamera, a: number, b: number): [number, number][] {
    const out: [number, number][] = []; let p = a;
    for (const [s, e] of this.gaps(c, a, b)) { if (e <= p) continue; if (s >= b) break; if (s > p) out.push([Math.round(p), Math.round(s)]); p = Math.max(p, e); }
    if (p < b) out.push([Math.round(p), Math.round(b)]);
    return out;
  }
  async recordingRanges(id: string, fromMs: number, toMs: number): Promise<RecordingRanges> {
    this.guard();
    return { ranges: this.ranges(this.cam(id), fromMs, toMs), precision: "exact" };
  }

  /**
   * FFmpeg input arguments for a camera's picture, plus any output filter it needs. By default a
   * calm, slowly drifting gradient, different for every camera. MOCK_PATTERN=clock gives FFmpeg's
   * test card with a running clock instead (it starts at the matching second of the minute, so a
   * seek can be checked by eye). MOCK_PHOTOS names a folder of `<protectId>.jpg` stills, such as
   * assets/demo-cameras, shown with light sensor noise; cameras without a still keep the gradient.
   * Live commands are a single string, so that folder's path must not contain spaces.
   */
  private video(c: MockCamera, w: number, h: number, fps: number, at: { ms?: number; len?: string } = {}): { input: string[]; vf: string[] } {
    const t = at.len ? ["-t", at.len] : [];
    if (process.env.MOCK_PATTERN === "clock") return { input: ["-f", "lavfi", ...(at.ms == null ? [] : ["-ss", String(Math.floor(at.ms / 1000) % 60)]), ...t, "-i", `testsrc2=s=${w}x${h}:r=${fps},hue=h=${c.hue}`], vf: [] };
    const photo = process.env.MOCK_PHOTOS && resolve(process.env.MOCK_PHOTOS, `${c.protectId}.jpg`);
    if (photo && existsSync(photo)) return { input: ["-loop", "1", "-framerate", String(fps), ...t, "-i", photo], vf: ["-vf", `scale=${w}:${h},noise=alls=5:allf=t`] };
    return { input: ["-f", "lavfi", ...t, "-i", `gradients=s=${w}x${h}:r=${fps}:seed=${this.n(c) * 97}:speed=0.015:n=3,hue=s=0.45:b=-1.5`], vf: [] };
  }
  /** Quiet pink noise, like a room microphone, so the sound controls and the level meter have something to show. */
  private static readonly ROOM = "anoisesrc=c=pink:a=0.08:r=48000";
  async snapshot(id: string, opts: { width?: number; atMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    this.guard();
    const c = this.cam(id), w = Math.min(Math.max(opts.width ?? 640, 160), 1280), h = Math.round((w * 9) / 16 / 2) * 2;
    if (opts.atMs != null && !this.ranges(c, opts.atMs, opts.atMs + 1).length) throw new NoRecordingError();
    if (opts.atMs == null && !c.online) throw new Error("camera offline");
    const v = this.video(c, w, h, 1, { ms: opts.atMs ?? Date.now() });
    return ffmpeg([...v.input, ...v.vf, "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], opts.signal);
  }
  async liveSource(id: string, quality: "wall" | "focus"): Promise<LiveSource | null> {
    this.guard();
    const c = this.cam(id);
    if (!c.online || !this.opts.publishUrl) return null;
    const [w, h, fps] = quality === "focus" ? [1280, 720, 15] : [640, 360, 10];
    // Like Protect, a camera with a microphone sends its sound twice: AAC (for HLS) and Opus (for WebRTC).
    const audio = c.mic ? `-re -f lavfi -i ${MockProtectAdapter.ROOM} -map 0:v -map 1:a -map 1:a -c:a:0 aac -b:a:0 32k -c:a:1 libopus -b:a:1 32k` : "";
    const v = this.video(c, w, h, fps);
    return { kind: "command", command: `ffmpeg -hide_banner -loglevel error -re ${v.input.join(" ")} ${audio} ${v.vf.join(" ")} -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g ${fps * 2} -bf 0 -f rtsp -rtsp_transport tcp ${this.opts.publishUrl}`.replace(/ {2,}/g, " ") };
  }
  /** Simulated: the same test picture as the recorder's stream. Any login works except the password "wrong". */
  async directSource(id: string, quality: "wall" | "focus", login: CameraLogin): Promise<LiveSource | null> {
    if (!MOCK_DIRECT.has(id) || login.password === "wrong") return null;
    return this.liveSource(id, quality);
  }
  async checkDirect(id: string, login: CameraLogin): Promise<DirectCheck> {
    this.guard();
    const c = this.cam(id);
    if (!MOCK_DIRECT.has(id)) return { ok: false, reason: "unsupported" };
    if (!c.online) return { ok: false, reason: "unreachable" };
    if (login.password === "wrong") return { ok: false, reason: "login" };
    return { ok: true, video: "H264", audio: c.mic ? "MPEG4-GENERIC" : null };
  }
  async recordedSegments(id: string, fromMs: number, toMs: number, quality: "wall" | "focus"): Promise<[number, number][] | null> {
    this.guard();
    const c = this.cam(id), r = this.ranges(c, fromMs - 30 * 60_000, toMs);
    // A segment runs from its first keyframe to its last.
    if (this.adaptive.has(id)) {
      const parts = MockProtectAdapter.channelParts(this.ranges(c, fromMs - 30 * 60_000, toMs + 1000), quality);
      return parts.map(([a, b]) => MockProtectAdapter.keys(a, b).filter((k) => k < toMs)).filter((k) => k.length).map((k) => [k[0], k[k.length - 1]]);
    }
    const parts = quality === "focus" ? r : [];
    return parts.map(([a, b]) => [Math.ceil(a / 1000) * 1000, Math.max(Math.ceil(a / 1000) * 1000, Math.ceil(b / 1000) * 1000 - 1000)]);
  }
  async exportClip(id: string, startMs: number, endMs: number, destPath: string, opts: { quality?: "wall" | "focus"; signal?: AbortSignal } = {}) {
    this.guard();
    const c = this.cam(id);
    if (this.adaptive.has(id)) return this.adaptiveClip(c, startMs, endMs, destPath, opts);
    const r = this.ranges(c, startMs, endMs);
    if (!r.length) throw new NoRecordingError();
    // Like a real recorder, the clip covers what exists inside the window. Keyframe every second.
    const [a, b] = [r[0][0], r[r.length - 1][1]], [w, h] = opts.quality === "focus" ? [1280, 720] : [640, 360];
    const len = ((b - a) / 1000).toFixed(3), audio = c.mic ? ["-f", "lavfi", "-t", len, "-i", MockProtectAdapter.ROOM, "-c:a", "aac", "-b:a", "32k"] : [];
    const v = this.video(c, w, h, 10, { ms: a, len });
    await ffmpeg([...v.input, ...audio, ...v.vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "10", "-movflags", "+faststart", "-y", "-f", "mp4", destPath], opts.signal);
  }

  /** Motion stretches inside [a, b): seconds 12.5 to 21.5 of every half minute. */
  static motion(a: number, b: number): [number, number][] {
    return MockProtectAdapter.every(a, b, 12_500, 21_500);
  }
  /** [from, to) of every half minute, inside [a, b). */
  private static every(a: number, b: number, from: number, to: number): [number, number][] {
    const out: [number, number][] = [];
    for (let m = Math.floor(a / 30_000) * 30_000; m < b; m += 30_000) { const s = Math.max(a, m + from), e = Math.min(b, m + to); if (s < e) out.push([s, e]); }
    return out;
  }
  /** What an adaptive camera's channel holds inside recorded `ranges`: high in the motion stretches, low everywhere but their middle. */
  static channelParts(ranges: [number, number][], quality: "wall" | "focus"): [number, number][] {
    const out: [number, number][] = [];
    for (const [a, b] of ranges) {
      if (quality === "focus") { out.push(...MockProtectAdapter.motion(a, b)); continue; }
      let p = a;
      for (const [s, e] of MockProtectAdapter.every(a, b, 15_500, 18_500)) { if (s > p) out.push([p, s]); p = e; }
      if (p < b) out.push([p, b]);
    }
    return out;
  }
  /**
   * Keyframe times of an adaptive camera's channel recorded over [a, b): one-second GOPs starting half
   * a second past each whole second, so a playback window's first GOP starts before the window and
   * runs into it, as a real recorder's do. The low channel's last GOP before its gap (14.5 to 15.5 s
   * of a half minute) is one the placement can date that way too (see `tests/playback.test.ts`).
   */
  static keys(a: number, b: number): number[] {
    const out: number[] = [];
    for (let k = Math.ceil((a - 500) / 1000) * 1000 + 500; k + 1000 <= b; k += 1000) out.push(k);
    return out;
  }
  private async adaptiveClip(c: MockCamera, startMs: number, endMs: number, destPath: string, opts: { quality?: "wall" | "focus"; signal?: AbortSignal }) {
    const quality = opts.quality ?? "wall", parts = MockProtectAdapter.channelParts(this.ranges(c, startMs - 10 * 60_000, endMs + 1000), quality);
    // The last GOP starting before the start, then every one before the end.
    const keys = parts.flatMap(([a, b]) => MockProtectAdapter.keys(a, b));
    const first = keys.findLastIndex((k) => k < startMs), picked = keys.slice(Math.max(0, first)).filter((k) => k < endMs);
    if (!picked.length || (first < 0 && picked[0] >= endMs)) throw new NoRecordingError();
    // Like the recorder, every export holds the same GOP byte for byte. x264 numbers its keyframes 0, 1,
    // 0, 1… in encode order and stamps the first with its settings, so the picture is encoded with each
    // GOP at a place of the same parity as its second (a filler GOP goes in where needed and is cut out
    // after), without the settings; the sound is made for the GOPs kept.
    const enc: number[] = [], kept: number[] = [];
    for (const k of picked) { if (enc.length % 2 !== Math.floor(k / 1000) % 2) enc.push(k - 1000); kept.push(enc.length); enc.push(k); }
    const [w, h] = quality === "focus" ? [1280, 720] : [640, 480];
    /** Wall-clock seconds (within the day) at media time t, for GOPs starting at `ks`, one second each. */
    const clockOf = (ks: number[]) => {
      const runs: { from: number; start: number }[] = [];
      ks.forEach((k, i) => { if (!i || ks[i - 1] !== k - 1000) runs.push({ from: i, start: (k % 86_400_000) / 1000 }); });
      let clock = "";
      for (let i = runs.length - 1; i >= 0; i--) { const at = `(${runs[i].start}+t-${runs[i].from})`; clock = clock ? `if(lt(t\\,${runs[i + 1].from})\\,${at}\\,${clock})` : at; }
      return clock;
    };
    const clock = clockOf(enc);
    // Boxes over a tinted background, placed by wall-clock time: one bouncing at a steady speed (so no
    // two frames look alike), two jumping to new places every second (so no two seconds do).
    const rnd = (k: number) => `mod(abs(sin(floor(${clock})*${k}.9898)*43758.5453)\\,1)`;
    const at = (k: number, x: string, y: string) => `[v${k}][b${k}]overlay=x=(W-w)*${x}:y=(H-h)*${y}[v${k + 1}]`;
    const sz = (fw: number, fh: number) => `s=${Math.round(w / fw / 2) * 2}x${Math.round(h / fh / 2) * 2}:r=10:d=${enc.length}`;
    const graph = [
      `color=c=0x${((c.hue * 0x10101) & 0x7f7f7f).toString(16).padStart(6, "0")}:${sz(1, 1)}[v0]`, `color=c=white:${sz(5, 5)}[b0]`, `color=c=black:${sz(8, 4)}[b1]`, `color=c=0xc0c0c0:${sz(6, 8)}[b2]`,
      at(0, `abs(mod(${clock}*0.37\\,2)-1)`, `abs(mod(${clock}*0.29\\,2)-1)`), at(1, rnd(12), rnd(78)), at(2, rnd(37), rnd(53)),
    ].join(";");
    const sound = clockOf(picked), amp = `mod(abs(sin(floor(${sound}*20)*12.9898)*43758.5453)\\,1)`;
    // The kept GOPs, as stretches of the encode.
    const keep: [number, number][] = [];
    for (const i of kept) { const r = keep[keep.length - 1]; if (r && r[1] === i) r[1] = i + 1; else keep.push([i, i + 1]); }
    const video = `${destPath}.v.mp4`, list = `${destPath}.txt`;
    try {
      await ffmpeg(["-filter_complex", graph, "-map", "[v3]", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "30", "-pix_fmt", "yuv420p", "-g", "10", "-sc_threshold", "0", "-bsf:v", "filter_units=remove_types=6", "-y", "-f", "mp4", video], opts.signal);
      await writeFile(list, keep.map(([a, b]) => `file '${basename(video).replace(/'/g, "'\\''")}'\ninpoint ${a}\noutpoint ${b}\n`).join(""));
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-f", "lavfi", "-t", String(picked.length), "-i", `aevalsrc=exprs=${amp}*sin(2*PI*440*t):s=8000`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-y", "-f", "mp4", destPath], opts.signal);
    } finally {
      await Promise.all([video, list].map((p) => rm(p, { force: true })));
    }
  }

  private generated(c: MockCamera, fromMs: number, toMs: number): ProtectEvent[] {
    const out: ProtectEvent[] = [], types = this.typesFor(c).filter((t) => t !== "motion"), now = Date.now();
    for (let d = Math.floor(fromMs / DAY); d <= Math.floor(toMs / DAY); d++) {
      const r = rng(this.n(c) * 1009 + d * 31), n = 5 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) {
        const t = Math.floor(d * DAY + r() * DAY), type = r() < 0.45 ? "motion" : types[Math.floor(r() * types.length)], dur = 5 + Math.floor(r() * 40);
        if (t >= fromMs && t < toMs && t < now - 6e4 && t > now - RETENTION && this.ranges(c, t, t + 1).length) out.push({ id: `${c.protectId}.${d}.${i}`, protectCameraId: c.protectId, type, startMs: t, endMs: t + dur * 1000, hasThumbnail: true });
      }
    }
    return out;
  }
  async listEvents(q: EventQuery): Promise<ProtectEvent[]> {
    this.guard();
    const ids = new Set(q.protectCameraIds);
    const all = [...this.cameras.filter((c) => ids.has(c.protectId)).flatMap((c) => this.generated(c, q.fromMs, q.toMs)), ...this.live.filter((e) => ids.has(e.protectCameraId) && e.startMs >= q.fromMs && e.startMs < q.toMs)];
    return all.filter((e) => !q.types?.length || q.types.includes(e.type)).sort((a, b) => b.startMs - a.startMs || a.id.localeCompare(b.id)).slice(0, q.limit);
  }
  async getEvent(id: string): Promise<ProtectEvent | null> {
    this.guard();
    const live = this.live.find((e) => e.id === id);
    if (live) return live;
    const [camId, d, i] = id.split(".");
    const c = this.cameras.find((x) => x.protectId === camId);
    if (!c || !/^\d+$/.test(d ?? "") || !/^\d+$/.test(i ?? "")) return null;
    return this.generated(c, Number(d) * DAY, (Number(d) + 1) * DAY).find((e) => e.id === id) ?? null;
  }
  async eventThumbnail(id: string, signal?: AbortSignal): Promise<Buffer | null> {
    const e = await this.getEvent(id);
    return e ? this.snapshot(e.protectCameraId, { width: 480, atMs: e.startMs, signal }).catch(() => null) : null;
  }
  subscribeEvents(cb: (e: ProtectEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  /** Test helper: push a live event to subscribers. */
  emit(e: ProtectEvent) { this.live.push(e); for (const l of this.listeners) l(e); }
}
