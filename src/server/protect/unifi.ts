import { writeFile } from "node:fs/promises";
import { ProtectClient } from "unifi-protect";
import { log } from "../util";
import { retimeVideoToAudio } from "./ffmpeg";
import { NoRecordingError, ProtectUnavailableError, type AdapterHealth, type EventQuery, type EventType, type LiveSource, type ProtectAdapter, type ProtectCamera, type ProtectEvent, type RecordingRanges } from "./types";

interface RawEvent { id: string; type: string; start: number; end?: number | null; camera?: string; cameraId?: string; smartDetectTypes?: string[]; thumbnailId?: string; modelKey?: string }
const SMART: Record<string, EventType> = { person: "person", vehicle: "vehicle", package: "package", animal: "animal", licensePlate: "licensePlate" };

/**
 * UniFi Protect through the `unifi-protect` library (v5), using a dedicated local Protect account.
 *
 * READ-ONLY BY CONSTRUCTION: this file issues GET requests only and never calls the library's
 * mutating methods (`update`, `reboot`, `unlock`, talkback, ...). Use a view-only Protect role as
 * defence in depth.
 *
 * What the library covers: login/relogin, bootstrap, camera state, live snapshots, realtime packets.
 * What it does not: historical events, thumbnails and recorded video. Those use Protect's private
 * HTTP API through the library's authenticated transport. They are not officially documented and
 * MUST be verified against the target UNVR/Protect version before the integration is called complete:
 *   GET /proxy/protect/api/events?start&end&limit&orderDirection&types
 *   GET /proxy/protect/api/events/{id}  and  /events/{id}/thumbnail
 *   GET /proxy/protect/api/video/export?camera&start&end&channel        (MP4, approximate to a few seconds)
 *   GET /proxy/protect/api/cameras/{id}/recording-snapshot?ts&w
 * Known limits: no endpoint for recording gaps is known, so availability is reported as outer
 * bounds only; live video needs an RTSP stream that is already enabled on the camera, because
 * enabling one would be a write.
 */
export class UnifiProtectAdapter implements ProtectAdapter {
  readonly mode = "real" as const;
  private client?: ProtectClient;
  private listeners = new Set<(e: ProtectEvent) => void>();
  private seen = new Set<string>();
  private abort = new AbortController();
  private state: AdapterHealth["state"] = "connecting";
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private connecting?: Promise<void>;

  constructor(readonly nvrId: string, private o: { host: string; username: string; password: string; verifyTls: boolean; rtspsFingerprint?: string }) {}

  private base() { return `https://${this.o.host}/proxy/protect/api`; }
  private ok() { this.state = "connected"; this.lastOkAt = Date.now(); this.lastError = null; }
  private failed(e: unknown) { this.state = "down"; this.lastError = (e as Error)?.message?.slice(0, 200) ?? "error"; }

  async connect(): Promise<void> {
    if (this.client) return;
    this.connecting ??= (async () => {
      try {
        // TLS is verified unless explicitly disabled for development. Trust the UNVR's certificate
        // with NODE_EXTRA_CA_CERTS; never disable verification process-wide.
        this.client = await ProtectClient.connect({ host: this.o.host, username: this.o.username, password: this.o.password, verifyTls: this.o.verifyTls, signal: this.abort.signal });
        this.ok();
        void this.pump();
      } catch (e) {
        this.failed(e);
        throw new ProtectUnavailableError(this.lastError ?? "connect failed");
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }
  async close() {
    this.abort.abort();
    const c = this.client as unknown as { [Symbol.asyncDispose]?: () => Promise<void> } | undefined;
    this.client = undefined;
    await c?.[Symbol.asyncDispose]?.().catch(() => {});
  }
  health(): AdapterHealth {
    const nvr = this.client?.nvr as unknown as { config?: { version?: string } } | undefined;
    return { mode: "real", state: this.state, lastOkAt: this.lastOkAt, lastError: this.lastError, protectVersion: nvr?.config?.version ?? null };
  }

  /** Realtime packets -> events. Restarts with backoff; ids are de-duplicated across reconnects. */
  private async pump() {
    let delay = 1000;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.client) await this.connect();
        for await (const pkt of this.client!.rawPackets({ signal: this.abort.signal })) {
          this.ok();
          delay = 1000;
          const h = (pkt as { header?: { action?: string; modelKey?: string } }).header;
          if (h?.modelKey === "camera" && h.action === "update") {
            const id = (h as { id?: string }).id, rec = (pkt as { payload?: { isRecording?: unknown } }).payload?.isRecording;
            if (id && typeof rec === "boolean") this.recording.set(id, rec);
            continue;
          }
          if (h?.modelKey !== "event" || h.action !== "add") continue;
          const e = this.map((pkt as { payload: RawEvent }).payload);
          if (!e || this.seen.has(e.id)) continue;
          this.seen.add(e.id);
          if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
          for (const l of this.listeners) l(e);
        }
      } catch (e) {
        if (this.abort.signal.aborted) return;
        this.recording.clear(); // updates were missed; fall back to the library's state until new ones arrive
        this.failed(e);
        log("warn", "protect event stream interrupted; retrying", { error: e, delayMs: delay });
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async c(): Promise<ProtectClient> {
    if (!this.client) await this.connect();
    return this.client!;
  }
  private async get(path: string, opts: { signal?: AbortSignal; timeout?: number } = {}) {
    const c = await this.c();
    try {
      const r = await c.transport.send(this.base() + path, { method: "GET", signal: opts.signal, timeout: opts.timeout ?? 15_000 });
      this.ok();
      return r;
    } catch (e) {
      if (!opts.signal?.aborted) this.failed(e);
      throw new ProtectUnavailableError((e as Error).message);
    }
  }
  private map(r: RawEvent | undefined): ProtectEvent | null {
    const cam = r?.camera ?? r?.cameraId;
    if (!r?.id || !cam || typeof r.start !== "number") return null;
    const smart = r.smartDetectTypes?.map((t) => SMART[t]).find(Boolean);
    const type: EventType = r.type === "motion" ? "motion" : r.type === "ring" ? "ring" : r.type === "smartAudioDetect" ? "audio" : r.type?.startsWith("smartDetect") ? smart ?? "other" : "other";
    return { id: r.id, protectCameraId: cam, type, startMs: r.start, endMs: r.end ?? null, hasThumbnail: !!r.thumbnailId && r.end != null };
  }

  /** Realtime `isRecording` updates seen since the stream last connected, by Protect camera id. */
  private recording = new Map<string, boolean>();
  async recordingNow(): Promise<string[]> {
    const c = await this.c();
    return c.cameras.filter((cam) => { const cfg = cam.config as unknown as { id: string; isRecording?: boolean }; return cam.isOnline && (this.recording.get(cfg.id) ?? cfg.isRecording === true); }).map((cam) => (cam.config as unknown as { id: string }).id);
  }

  async listCameras(): Promise<ProtectCamera[]> {
    const c = await this.c();
    return c.cameras.map((cam) => {
      const cfg = cam.config as unknown as { id: string; name?: string; type?: string; marketName?: string; channels?: { id: number; width: number; height: number; isRtspEnabled?: boolean; rtspAlias?: string }[]; featureFlags?: { smartDetectTypes?: string[]; isDoorbell?: boolean }; stats?: { video?: { recordingStart?: number | null; recordingEnd?: number | null } }; videoCodec?: string };
      const q = ["high", "medium", "low"] as const;
      const types: EventType[] = ["motion", ...((cfg.featureFlags?.smartDetectTypes ?? []).map((t) => SMART[t]).filter(Boolean) as EventType[])];
      if (cfg.featureFlags?.isDoorbell) types.push("ring");
      return {
        protectId: cfg.id, name: cam.name, online: cam.isOnline, model: cfg.marketName ?? cfg.type, eventTypes: types,
        streams: (cfg.channels ?? []).filter((ch) => ch.isRtspEnabled && ch.rtspAlias && q[ch.id]).map((ch) => ({ quality: q[ch.id], width: ch.width, height: ch.height, codec: cfg.videoCodec })),
        recordingStartMs: cfg.stats?.video?.recordingStart ?? undefined, recordingEndMs: cfg.stats?.video?.recordingEnd ?? undefined,
      };
    });
  }

  async snapshot(id: string, opts: { width?: number; atMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    const w = Math.min(Math.max(opts.width ?? 640, 160), 1920), h = Math.round((w * 9) / 16);
    if (opts.atMs != null) {
      const r = await this.get(`/cameras/${encodeURIComponent(id)}/recording-snapshot?ts=${Math.floor(opts.atMs)}&w=${w}&h=${h}`, { signal: opts.signal });
      if (r.statusCode !== 200 || !r.body.length) throw new NoRecordingError();
      return r.body;
    }
    const cam = (await this.c()).camera(id);
    if (!cam) throw new Error("unknown camera");
    return cam.snapshot({ width: w, height: h, signal: opts.signal });
  }

  async liveSource(id: string, quality: "wall" | "focus"): Promise<LiveSource | null> {
    const c = await this.c(), cam = c.camera(id);
    if (!cam?.isOnline) return null;
    const chans = ((cam.config as unknown as { channels?: { id: number; isRtspEnabled?: boolean; rtspAlias?: string }[] }).channels ?? []).filter((ch) => ch.isRtspEnabled && ch.rtspAlias);
    // Wall tiles take the smallest enabled stream, the focused player the largest. Never enables a stream.
    const pick = [...chans].sort((a, b) => (quality === "focus" ? a.id - b.id : b.id - a.id))[0];
    if (!pick) return null;
    const port = (c.nvr as unknown as { config?: { ports?: { rtsps?: number } } }).config?.ports?.rtsps ?? 7441;
    const host = this.o.host.replace(/:\d+$/, "");
    return { kind: "rtsp", url: `rtsps://${host}:${port}/${pick.rtspAlias}?enableSrtp`, tlsFingerprint: this.o.rtspsFingerprint };
  }

  async recordingRanges(id: string, fromMs: number, toMs: number): Promise<RecordingRanges> {
    const cam = (await this.listCameras()).find((x) => x.protectId === id);
    const a = Math.max(fromMs, cam?.recordingStartMs ?? Infinity), b = Math.min(toMs, cam?.recordingEndMs ?? Date.now(), Date.now());
    return { ranges: a < b ? [[a, b]] : [], precision: "bounds" };
  }

  async exportClip(id: string, startMs: number, endMs: number, destPath: string, opts: { quality?: "wall" | "focus"; signal?: AbortSignal } = {}) {
    // The transport buffers the whole body, so callers keep windows short (see PLAYBACK_WINDOW_SECONDS / CLIP_MAX_SECONDS).
    const channel = opts.quality === "focus" ? 0 : 2;
    const r = await this.get(`/video/export?camera=${encodeURIComponent(id)}&start=${Math.floor(startMs)}&end=${Math.floor(endMs)}&channel=${channel}`, { signal: opts.signal, timeout: 180_000 });
    if (r.statusCode !== 200 || r.body.length < 1024) throw new NoRecordingError();
    await writeFile(destPath, r.body, { mode: 0o600 });
    // Adaptive recording's Low channel comes out with a short, fast video clock (see retimeVideoToAudio).
    await retimeVideoToAudio(destPath, opts.signal).catch((e) => { if (!opts.signal?.aborted) log("warn", "could not retime export", { error: e }); });
  }

  async listEvents(q: EventQuery): Promise<ProtectEvent[]> {
    const ids = new Set(q.protectCameraIds), out: ProtectEvent[] = [];
    let end = q.toMs;
    // Page newest-first until enough authorized events are collected or the window is exhausted.
    for (let page = 0; page < 10 && out.length < q.limit; page++) {
      const r = await this.get(`/events?start=${Math.floor(q.fromMs)}&end=${Math.floor(end)}&limit=100&orderDirection=DESC&types=motion&types=ring&types=smartDetectZone&types=smartDetectLine&types=smartAudioDetect`);
      if (r.statusCode !== 200) throw new ProtectUnavailableError(`events query failed (${r.statusCode})`);
      const rows = r.json<RawEvent[]>();
      if (!Array.isArray(rows) || !rows.length) break;
      for (const raw of rows) {
        const e = this.map(raw);
        if (e && ids.has(e.protectCameraId) && (!q.types?.length || q.types.includes(e.type)) && !out.some((x) => x.id === e.id)) out.push(e);
      }
      const oldest = Math.min(...rows.map((x) => x.start));
      if (rows.length < 100 || oldest <= q.fromMs || oldest >= end) break;
      end = oldest;
    }
    return out.sort((a, b) => b.startMs - a.startMs).slice(0, q.limit);
  }
  async getEvent(id: string): Promise<ProtectEvent | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    const r = await this.get(`/events/${id}`);
    return r.statusCode === 200 ? this.map(r.json<RawEvent>()) : null;
  }
  async eventThumbnail(id: string, signal?: AbortSignal): Promise<Buffer | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    const r = await this.get(`/events/${id}/thumbnail?w=480`, { signal });
    return r.statusCode === 200 && r.body.length ? r.body : null;
  }
  subscribeEvents(cb: (e: ProtectEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
