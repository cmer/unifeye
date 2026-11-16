import type { Access, CameraGrant as Grant } from "../authz/access";
import { subjectOf, type Actor } from "../authz/actor";
import type { Policy } from "../authz/policy";
import { config } from "../config";
import type { ProtectAdapter } from "../protect/types";
import { HttpError, log, notFound, randomToken, safeEqual } from "../util";
import { MTX_API_USER, MTX_PUBLISH_USER, SRC_SUFFIX } from "./mediamtx";
import { RelayUnavailable, type HlsReader, type ReaderKind, type Relay } from "./relay";

export type Quality = "wall" | "focus";
interface Ticket extends Grant { path: string; kind: ReaderKind; exp: number; single: boolean; used: boolean }
interface Live extends Grant { kind: ReaderKind; path: string; since: number }
export interface HookBody { user?: string; password?: string; token?: string; ip?: string; action?: string; path?: string; protocol?: string; id?: string; query?: string }

const pathFor = (cameraId: string, q: Quality) => `c_${cameraId}_${q}`;
/** A relay that cannot be reached is a 503 for the browser; anything else is a bug and propagates. */
const relayDown = (e: unknown): never => { throw e instanceof RelayUnavailable ? new HttpError(503, "relay_unavailable") : e; };
const isInternal = (ip = "") => /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd|fc)/.test(ip);

/**
 * The media boundary. Browsers never receive an RTSP URL, a Protect cookie or a MediaMTX address.
 *
 * Enforcement, in order:
 *  1. Setup: every WHEP/HLS request arrives at a Unifeye route, which authenticates the session,
 *     resolves the effective subject (the staff member during a preview) and asks Policy for the camera.
 *  2. Capability: Unifeye then calls the relay itself with a random ticket bound to
 *     session + subject + camera + path + transport, valid for 30 seconds (single use for WebRTC).
 *  3. Relay boundary: MediaMTX is configured with `authMethod: http` and asks `hook()` before
 *     serving any reader. A reader without a valid ticket is refused even if it reaches MediaMTX directly.
 *  4. Ongoing delivery: each admitted relay reader id is recorded with its grant. `sweep()` re-checks
 *     every one with `Access.holds` (session, preview, Policy) and kicks failures through the relay.
 *     It runs on every access change (`revalidate`) and every REVOCATION_SWEEP_SECONDS (default 10 s, max 30 s).
 *     Relay readers Unifeye does not know are kicked too. HLS is also re-authorized per request.
 * If anything cannot be resolved (policy error, unknown session), access is denied.
 *
 * Everything said to the relay goes through the `Relay` interface (relay.ts). This class keeps the
 * decisions: tickets, the ledger of admitted readers, and the grants behind WHEP and HLS state.
 */
export class Media {
  private tickets = new Map<string, Ticket>();
  private live = new Map<string, Live>();
  /** WHEP resource -> its grant and the relay reader it admitted, so a teardown frees that reader's slot at once. */
  private whep = new Map<string, Grant & { path: string; readerId?: string }>();
  /** WebRTC ticket -> relay reader id, between the hook admitting the reader and `whepCreate` reading it back. */
  private admitted = new Map<string, string>();
  /** One entry per session + subject + preview + stream: who it was opened for, when to re-issue, and the relay's reader. */
  private hlsJar = new Map<string, { grant: Grant; exp: number; reader: HlsReader }>();
  private sweeping = false;
  private pending = false;
  private again = false;
  lastSweepAt = 0;

  constructor(private policy: Policy, private access: Access, private adapter: () => ProtectAdapter, private relay: Relay) {}

  relayHealthy() { return this.relay.healthy(); }

  /** Access may have changed: sweep on the next tick. Bursts collapse into one sweep. Subscribed in services.ts. */
  revalidate() {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => { this.pending = false; void this.sweep().catch(() => {}); });
  }

  /** Authorizes a live view and prepares the relay path. Throws 404 for anything the subject may not see. */
  private async issue(a: Actor, cameraId: string, q: Quality, kind: ReaderKind): Promise<{ ticket: string; path: string }> {
    const cam = this.policy.camera(subjectOf(a), cameraId), path = pathFor(cameraId, q);
    // The limit is on distinct streams (camera + quality), not relay readers: HLS takes a new reader
    // every 25 s and a WebRTC attempt may precede it, and none of that is another stream on screen.
    const mine = new Set([...this.live.values()].filter((l) => l.sessionId === a.sessionId).map((l) => l.path));
    if (!mine.has(path) && mine.size >= config().MAX_WALL_STREAMS + 3) throw new HttpError(429, "too_many_streams", "Too many live streams are open");
    const src = await this.adapter().liveSource(cam.protectId, q).catch(() => { throw new HttpError(503, "nvr_unavailable"); });
    if (!src) throw new HttpError(409, "no_live_stream", "This camera has no live stream available");
    await this.relay.ensureStream(path, src).catch((e) => { log("error", "relay path setup failed", { error: e }); throw new HttpError(503, "relay_unavailable"); });
    const ticket = randomToken();
    this.tickets.set(ticket, { ...this.access.grant(a, cameraId), path, kind, exp: Date.now() + 30_000, single: kind === "webrtc", used: false });
    return { ticket, path };
  }

  /** Called by MediaMTX (`authHTTPAddress`) for every publish/read/api action. 2xx allows; anything else denies. */
  hook(secret: string | null, b: HookBody): boolean {
    const c = config();
    if (!c.MEDIAMTX_HOOK_SECRET || !secret || !safeEqual(secret, c.MEDIAMTX_HOOK_SECRET)) return false;
    const api = c.MEDIAMTX_API_SECRET ?? "";
    if (b.action === "api") return b.user === MTX_API_USER && !!api && safeEqual(b.password ?? "", api);
    const relay = b.user === MTX_PUBLISH_USER && !!api && safeEqual(b.password ?? "", api) && isInternal(b.ip);
    // The relay's own FFmpeg: the mock test streams, and real cameras whose audio is retimed (mediamtx.ts).
    if (b.action === "publish") return relay && !(b.path ?? "").endsWith(SRC_SUFFIX);
    // That FFmpeg reads the camera from the internal `_src` path over RTSP. Nobody else reads RTSP.
    if (b.action === "read" && b.protocol === "rtsp") return relay && (b.path ?? "").endsWith(SRC_SUFFIX);
    if (b.action !== "read" || (b.protocol !== "webrtc" && b.protocol !== "hls")) return false; // RTMP/SRT readers, playback, metrics: never
    const token = b.token || b.password || "";
    const t = this.tickets.get(token);
    if (!t || Date.now() > t.exp || t.path !== b.path || t.kind !== b.protocol || (t.single && t.used) || !b.id || !this.access.holds(t)) return false;
    t.used = true;
    if (t.single) this.tickets.delete(token);
    if (t.kind === "webrtc") this.admitted.set(token, b.id);
    this.live.set(b.id, { sessionId: t.sessionId, subjectId: t.subjectId, previewId: t.previewId, cameraId: t.cameraId, kind: t.kind, path: t.path, since: Date.now() });
    return true;
  }

  // ---- WebRTC (WHEP). Signalling is proxied; media flows over ICE to MediaMTX's UDP/TCP port. ----
  async whepCreate(a: Actor, cameraId: string, q: Quality, sdpOffer: string) {
    const { ticket, path } = await this.issue(a, cameraId, q, "webrtc");
    let readerId: string | undefined;
    const r = await this.relay.whepCreate(path, ticket, sdpOffer).catch(relayDown).finally(() => {
      readerId = this.admitted.get(ticket);
      this.tickets.delete(ticket); this.admitted.delete(ticket);
    });
    if (r.outcome !== "created") throw new HttpError(r.outcome === "no_stream" ? 409 : 502, r.outcome === "no_stream" ? "no_live_stream" : "relay_error");
    const secret = r.resource;
    if (!/^[A-Za-z0-9-]{8,80}$/.test(secret)) throw new HttpError(502, "relay_error");
    this.whep.set(secret, { ...this.access.grant(a, cameraId), path, readerId });
    return { sdp: r.sdp, secret, etag: r.etag };
  }
  /** ICE trickle (PATCH) and teardown (DELETE). Only the session that created the WHEP resource may touch it. */
  async whepForward(a: Actor, secret: string, method: "PATCH" | "DELETE", body: string | undefined, headers: Record<string, string>) {
    const w = this.whep.get(secret);
    if (!w || !this.access.heldBy(w, a)) throw notFound();
    const status = await (method === "PATCH" ? this.relay.whepTrickle(w.path, secret, body, headers) : this.relay.whepClose(w.path, secret, headers)).catch(relayDown);
    if (method === "DELETE") {
      this.whep.delete(secret);
      // Otherwise the reader keeps counting against the stream limit until a sweep notices it is gone
      // (20 s or more), which would refuse the HLS fallback that usually follows a failed WebRTC attempt.
      if (w.readerId) this.live.delete(w.readerId);
    }
    return status;
  }

  // ---- HLS fallback: fully proxied, so every playlist and segment request is re-authorized here. ----
  async hls(a: Actor, cameraId: string, q: Quality, file: string, search: string): Promise<Response> {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(file) || file.includes("..")) throw notFound();
    const path = pathFor(cameraId, q);
    const key = `${a.sessionId}|${subjectOf(a)}|${a.preview?.id ?? ""}|${path}`;
    let jar = this.hlsJar.get(key);
    this.policy.camera(subjectOf(a), cameraId); // every request, not only the first
    if (!jar || Date.now() > jar.exp) {
      const { ticket } = await this.issue(a, cameraId, q, "hls");
      jar = { grant: this.access.grant(a, cameraId), exp: Date.now() + 25_000, reader: this.relay.hlsReader(path, ticket) };
      this.hlsJar.set(key, jar);
    }
    const r = await jar.reader.fetch(file, search).catch(relayDown);
    if (r.outcome !== "ok") throw new HttpError(r.outcome === "not_found" ? 404 : 502, r.outcome === "not_found" ? "not_found" : "relay_error");
    return new Response(r.body, { status: 200, headers: { "content-type": r.contentType ?? "application/octet-stream", "cache-control": "no-store" } });
  }

  /**
   * Revocation for media that is already flowing. Idempotent and safe to call at any time.
   * Worst case from a permission change to a stopped stream is one sweep interval.
   */
  async sweep(): Promise<{ kicked: number }> {
    if (this.sweeping) { this.again = true; return { kicked: 0 }; } // re-run when the current sweep ends
    this.sweeping = true;
    let kicked = 0;
    try {
      const t = Date.now();
      for (const [k, v] of this.tickets) if (t > v.exp) this.tickets.delete(k);
      for (const [k, v] of this.hlsJar) if (t > v.exp + 60_000) this.hlsJar.delete(k);
      for (const [k, v] of this.whep) if (!this.access.holds(v)) this.whep.delete(k);
      for (const [id, l] of this.live) if (!this.access.holds(l)) { await this.relay.kick(l.kind, id); this.live.delete(id); kicked++; }
      for (const [k, v] of this.hlsJar) if (!this.access.holds(v.grant)) this.hlsJar.delete(k);
      // Reconcile with the relay: unknown readers are removed (fail closed); finished ones are forgotten.
      for (const kind of ["webrtc", "hls"] as const) {
        const active = await this.relay.readers(kind).catch(() => null);
        if (!active) continue;
        const ids = new Set(active.map((s) => s.id));
        for (const s of active) if (!this.live.has(s.id)) { await this.relay.kick(kind, s.id); kicked++; }
        for (const [id, l] of this.live) if (l.kind === kind && !ids.has(id) && t - l.since > 20_000) this.live.delete(id);
      }
      this.lastSweepAt = Date.now();
    } finally {
      this.sweeping = false;
      if (this.again) { this.again = false; this.revalidate(); }
    }
    return { kicked };
  }
  stats() { return { liveSessions: this.live.size, lastSweepAt: this.lastSweepAt }; }
}
