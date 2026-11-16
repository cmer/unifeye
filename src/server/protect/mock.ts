import { ffmpeg } from "./ffmpeg";
import { MOCK_CAMERAS, type MockCamera } from "./mock-data";
import { NoRecordingError, type AdapterHealth, type EventQuery, type EventType, type LiveSource, type ProtectAdapter, type ProtectCamera, type ProtectEvent, type RecordingRanges } from "./types";

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
   * Their exports start 2 s early, like a recorder starting on a keyframe, and carry audio that
   * depends only on wall-clock time. Seconds 12 to 21 of every half minute count as motion: a
   * channel 0 ("focus") export containing any motion holds only those stretches, joined, as a real
   * recorder does; otherwise it, like the low channel ("wall"), holds the whole range in low resolution.
   */
  adaptive = new Set((process.env.MOCK_ADAPTIVE ?? "").split(",").filter(Boolean));
  cameras: MockCamera[] = MOCK_CAMERAS.map((c) => ({ ...c }));

  constructor(readonly nvrId = "default", private opts: { rtspPublishUrl?: (path: string) => string; liveEvents?: boolean } = {}) {}

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
    return this.cameras.map((c) => ({ protectId: c.protectId, name: c.name, online: c.online, model: "Mock G5", eventTypes: this.typesFor(c), streams: [{ quality: "high", width: 1280, height: 720, codec: "h264" }, { quality: "low", width: 640, height: 360, codec: "h264" }], recordingStartMs: Date.now() - RETENTION, recordingEndMs: c.online ? Date.now() : this.t0 - 3 * 36e5 }));
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
   * A calm, slowly drifting gradient, different for every camera. Set MOCK_PATTERN=clock to get
   * FFmpeg's test card with a running clock instead, which is useful for checking seek accuracy.
   */
  private source(c: MockCamera, w: number, h: number, fps: number) {
    if (process.env.MOCK_PATTERN === "clock") return `testsrc2=s=${w}x${h}:r=${fps},hue=h=${c.hue}`;
    return `gradients=s=${w}x${h}:r=${fps}:seed=${this.n(c) * 97}:speed=0.015:n=3,hue=s=0.45:b=-1.5`;
  }
  /** In clock mode the test card starts at the matching second of the minute, so a seek can be checked by eye. */
  private offset(ms: number): string[] {
    return process.env.MOCK_PATTERN === "clock" ? ["-ss", String(Math.floor(ms / 1000) % 60)] : [];
  }
  /** Quiet pink noise, like a room microphone, so the sound controls and the level meter have something to show. */
  private static readonly ROOM = "anoisesrc=c=pink:a=0.08:r=48000";
  async snapshot(id: string, opts: { width?: number; atMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    this.guard();
    const c = this.cam(id), w = Math.min(Math.max(opts.width ?? 640, 160), 1280), h = Math.round((w * 9) / 16 / 2) * 2;
    if (opts.atMs != null && !this.ranges(c, opts.atMs, opts.atMs + 1).length) throw new NoRecordingError();
    if (opts.atMs == null && !c.online) throw new Error("camera offline");
    return ffmpeg(["-f", "lavfi", ...this.offset(opts.atMs ?? Date.now()), "-i", this.source(c, w, h, 1), "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], opts.signal);
  }
  async liveSource(id: string, quality: "wall" | "focus"): Promise<LiveSource | null> {
    this.guard();
    const c = this.cam(id);
    if (!c.online || !this.opts.rtspPublishUrl) return null;
    const [w, h, fps] = quality === "focus" ? [1280, 720, 15] : [640, 360, 10];
    // Like Protect, a camera with a microphone sends its sound twice: AAC (for HLS) and Opus (for WebRTC).
    const audio = c.mic ? `-re -f lavfi -i ${MockProtectAdapter.ROOM} -map 0:v -map 1:a -map 1:a -c:a:0 aac -b:a:0 32k -c:a:1 libopus -b:a:1 32k` : "";
    return { kind: "command", command: `ffmpeg -hide_banner -loglevel error -re -f lavfi -i ${this.source(c, w, h, fps)} ${audio} -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g ${fps * 2} -bf 0 -f rtsp -rtsp_transport tcp ${this.opts.rtspPublishUrl("$MTX_PATH")}`.replace(/ {2,}/g, " ") };
  }
  async exportClip(id: string, startMs: number, endMs: number, destPath: string, opts: { quality?: "wall" | "focus"; signal?: AbortSignal } = {}) {
    this.guard();
    const c = this.cam(id), r = this.ranges(c, startMs, endMs);
    if (!r.length) throw new NoRecordingError();
    if (this.adaptive.has(id)) return this.adaptiveClip(c, r[0][0] - 2000, r[r.length - 1][1], destPath, opts);
    // Like a real recorder, the clip covers what exists inside the window. Keyframe every second.
    const [a, b] = [r[0][0], r[r.length - 1][1]], [w, h] = opts.quality === "focus" ? [1280, 720] : [640, 360];
    const len = ((b - a) / 1000).toFixed(3), audio = c.mic ? ["-f", "lavfi", "-t", len, "-i", MockProtectAdapter.ROOM, "-c:a", "aac", "-b:a", "32k"] : [];
    await ffmpeg(["-f", "lavfi", ...this.offset(a), "-t", len, "-i", this.source(c, w, h, 10), ...audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "10", "-movflags", "+faststart", "-y", "-f", "mp4", destPath], opts.signal);
  }

  /** Motion stretches inside [a, b) for an adaptive camera: seconds 12 to 21 of every half minute. */
  static motion(a: number, b: number): [number, number][] {
    const out: [number, number][] = [];
    for (let m = Math.floor(a / 30_000) * 30_000; m < b; m += 30_000) { const s = Math.max(a, m + 12_000), e = Math.min(b, m + 21_000); if (s < e) out.push([s, e]); }
    return out;
  }
  private async adaptiveClip(c: MockCamera, a: number, b: number, destPath: string, opts: { quality?: "wall" | "focus"; signal?: AbortSignal }) {
    const hi = opts.quality === "focus" ? MockProtectAdapter.motion(a, b) : [];
    const parts: [number, number][] = hi.length ? hi : [[a, b]], [w, h] = hi.length ? [1280, 720] : [640, 360];
    const dur = parts.reduce((n, [s, e]) => n + (e - s), 0) / 1000;
    // Wall-clock seconds (within the day) at media time t, across the joined parts.
    let clock = "", done = 0;
    const pieces = parts.map(([s, e]) => { const p = { from: done, start: (s % 86_400_000) / 1000 }; done += (e - s) / 1000; return p; });
    for (let i = pieces.length - 1; i >= 0; i--) { const at = `(${pieces[i].start}+t-${pieces[i].from})`; clock = clock ? `if(lt(t\\,${pieces[i + 1].from})\\,${at}\\,${clock})` : at; }
    const amp = `mod(abs(sin(floor(${clock}*20)*12.9898)*43758.5453)\\,1)`;
    await ffmpeg(["-f", "lavfi", ...this.offset(a), "-t", dur.toFixed(3), "-i", this.source(c, w, h, 10), "-f", "lavfi", "-t", dur.toFixed(3), "-i", `aevalsrc=exprs=${amp}*sin(2*PI*440*t):s=8000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac", "-movflags", "+faststart", "-y", "-f", "mp4", destPath], opts.signal);
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
