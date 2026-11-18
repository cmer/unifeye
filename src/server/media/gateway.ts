import type { Access, CameraGrant as Grant } from "../authz/access";
import { subjectOf, type Actor } from "../authz/actor";
import type { Policy } from "../authz/policy";
import { config } from "../config";
import type { ProtectAdapter } from "../protect/types";
import { HttpError, log, notFound, randomToken } from "../util";
import type { DirectVideo } from "./direct";
import { RelayUnavailable, type HlsReader, type ReaderKind, type ReaderRequest, type Relay } from "./relay";

export type Quality = "wall" | "focus";
/** Where a live stream is read from. "fallback": the camera is set to stream directly but can't right now, so the recorder is used. */
export type VideoSource = "camera" | "recorder" | "fallback";
/** One HLS reader per session, subject, preview and stream: tiles and retries in a tab share it. */
const jarKey = (a: Actor, path: string) => `${a.sessionId}|${subjectOf(a)}|${a.preview?.id ?? ""}|${path}`;
/** Distinct live streams one session may hold: the wall's tiles plus a few for the player and handovers. */
export const maxStreams = () => config().MAX_WALL_STREAMS + 3;
interface Ticket extends Grant { path: string; kind: ReaderKind; exp: number; single: boolean; used: boolean }
interface Live extends Grant { kind: ReaderKind; path: string; since: number }

const pathFor = (cameraId: string, q: Quality) => `c_${cameraId}_${q}`;
/** A relay that cannot be reached is a 503 for the browser; anything else is a bug and propagates. */
const relayDown = (e: unknown): never => { throw e instanceof RelayUnavailable ? new HttpError(503, "relay_unavailable") : e; };

/**
 * The media boundary. Browsers never receive an RTSP URL, a Protect cookie or a MediaMTX address.
 *
 * Enforcement, in order:
 *  1. Setup: every WHEP/HLS request arrives at a Unifeye route, which authenticates the session,
 *     resolves the effective subject (the staff member during a preview) and asks Policy for the camera.
 *  2. Capability: Unifeye then calls the relay itself with a random ticket bound to
 *     session + subject + camera + path + transport, valid for 30 seconds (single use for WebRTC).
 *  3. Relay boundary: the relay asks `admit()` before serving any reader (MediaMTX through its HTTP
 *     auth hook, see `authorizeHook`). A reader without a valid ticket is refused even if it reaches MediaMTX directly.
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
  /** One entry per session + subject + preview + stream: who it was opened for, when to re-issue, the current ticket and the relay's reader. */
  private hlsJar = new Map<string, { grant: Grant; exp: number; ticket: string; reader: HlsReader; source: VideoSource }>();
  /** Streams currently read from the camera itself rather than the recorder: path -> camera id. */
  private directPaths = new Map<string, string>();
  private sweeping = false;
  private pending = false;
  private again = false;
  lastSweepAt = 0;

  constructor(private policy: Policy, private access: Access, private adapter: () => ProtectAdapter, private relay: Relay, readonly direct: DirectVideo) {}

  relayHealthy() { return this.relay.healthy(); }

  /** Access may have changed: sweep on the next tick. Bursts collapse into one sweep. Subscribed in services.ts. */
  revalidate() {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => { this.pending = false; void this.sweep().catch(() => {}); });
  }

  /** Authorizes a live view and prepares the relay path. Throws 404 for anything the subject may not see. */
  private async issue(a: Actor, cameraId: string, q: Quality, kind: ReaderKind): Promise<{ ticket: string; path: string; source: VideoSource }> {
    const cam = this.policy.camera(subjectOf(a), cameraId), path = pathFor(cameraId, q);
    // The limit is on distinct streams (camera + quality), not relay readers: HLS takes a new reader
    // every 25 s and a WebRTC attempt may precede it, and none of that is another stream on screen.
    const mine = new Set([...this.live.values()].filter((l) => l.sessionId === a.sessionId).map((l) => l.path));
    if (!mine.has(path) && mine.size >= maxStreams()) throw new HttpError(429, "too_many_streams", "Too many live streams are open");
    // A camera switched to direct video is read from the camera itself; if that isn't possible right
    // now (offline, or it recently failed), the recorder's stream is used instead.
    const login = this.direct.login(cameraId);
    let src = login ? await this.adapter().directSource(cam.protectId, q, login).catch(() => null) : null;
    if (src) this.directPaths.set(path, cameraId); else this.directPaths.delete(path);
    const source: VideoSource = src ? "camera" : this.direct.enabled(cameraId) ? "fallback" : "recorder";
    src ??= await this.adapter().liveSource(cam.protectId, q).catch(() => { throw new HttpError(503, "nvr_unavailable"); });
    if (!src) throw new HttpError(409, "no_live_stream", "This camera has no live stream available");
    await this.relay.ensureStream(path, src).catch((e) => { log("error", "relay path setup failed", { error: e }); throw new HttpError(503, "relay_unavailable"); });
    const ticket = randomToken();
    this.tickets.set(ticket, { ...this.access.grant(a, cameraId), path, kind, exp: Date.now() + 30_000, single: kind === "webrtc", used: false });
    return { ticket, path, source };
  }

  /**
   * Whether the relay may let this viewer read: only with a fresh ticket for that stream and
   * transport, used once for WebRTC, whose grant still holds. An admitted reader joins the ledger
   * the sweep checks.
   */
  admit(r: ReaderRequest): boolean {
    const t = r.ticket ? this.tickets.get(r.ticket) : undefined;
    if (!t || Date.now() > t.exp || t.path !== r.stream || t.kind !== r.kind || (t.single && t.used) || !r.id || !this.access.holds(t)) return false;
    t.used = true;
    if (t.single) this.tickets.delete(r.ticket);
    if (t.kind === "webrtc") this.admitted.set(r.ticket, r.id);
    this.live.set(r.id, { sessionId: t.sessionId, subjectId: t.subjectId, previewId: t.previewId, cameraId: t.cameraId, kind: t.kind, path: t.path, since: Date.now() });
    return true;
  }

  // ---- WebRTC (WHEP). Signalling is proxied; media flows over ICE to MediaMTX's UDP/TCP port. ----
  async whepCreate(a: Actor, cameraId: string, q: Quality, sdpOffer: string) {
    const { ticket, path, source } = await this.issue(a, cameraId, q, "webrtc");
    let readerId: string | undefined;
    const r = await this.relay.whepCreate(path, ticket, sdpOffer).catch(relayDown).finally(() => {
      readerId = this.admitted.get(ticket);
      this.tickets.delete(ticket); this.admitted.delete(ticket);
    });
    if (r.outcome !== "created") {
      // The hook may have admitted a reader before the offer failed (the camera stopped sending, for
      // example). Nobody will tear it down, so free its slot now instead of after the next sweeps.
      if (readerId) { this.live.delete(readerId); await this.relay.kick("webrtc", readerId); }
      this.directFailed(path);
      throw new HttpError(r.outcome === "no_stream" ? 409 : 502, r.outcome === "no_stream" ? "no_live_stream" : "relay_error");
    }
    const secret = r.resource;
    if (!/^[A-Za-z0-9-]{8,80}$/.test(secret)) throw new HttpError(502, "relay_error");
    this.whep.set(secret, { ...this.access.grant(a, cameraId), path, readerId });
    return { sdp: r.sdp, secret, etag: r.etag, source };
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
    const path = pathFor(cameraId, q), key = jarKey(a, path);
    let jar = this.hlsJar.get(key);
    this.policy.camera(subjectOf(a), cameraId); // every request, not only the first
    if (!jar || Date.now() > jar.exp) {
      // Renewal re-checks the stream limit and issues a fresh ticket, but keeps the reader: the
      // player's media playlists and segments belong to the relay session it already holds.
      const { ticket, source } = await this.issue(a, cameraId, q, "hls");
      jar = { grant: this.access.grant(a, cameraId), exp: Date.now() + 25_000, ticket, source, reader: jar?.reader ?? this.relay.hlsReader(path) };
      this.hlsJar.set(key, jar);
    }
    const r = await jar.reader.fetch(file, search, jar.ticket).catch(relayDown);
    // The camera itself didn't deliver: the player's retry starts over through the recorder.
    if (r.outcome !== "ok" && file.endsWith(".m3u8") && this.directPaths.has(path)) { this.directFailed(path); this.hlsJar.delete(key); }
    if (r.outcome !== "ok") throw new HttpError(r.outcome === "not_found" ? 404 : 502, r.outcome === "not_found" ? "not_found" : "relay_error");
    return new Response(r.body, { status: 200, headers: { "content-type": r.contentType ?? "application/octet-stream", "cache-control": "no-store", "x-video-source": jar.source } });
  }
  /** A stream read from the camera itself sent nothing: read that camera through the recorder for a while. */
  private directFailed(path: string) {
    const cameraId = this.directPaths.get(path);
    if (!cameraId) return;
    this.directPaths.delete(path);
    this.direct.failed(cameraId);
  }

  /**
   * The player stopped an HLS stream. HLS has no teardown of its own: without this, the stream keeps
   * its slot until the relay closes the idle reader and a sweep notices (30 to 60 s), so changing
   * views refuses the new tiles. Only this session's own readers for that stream are released. The
   * camera is not looked up: releasing reveals nothing, and the answer is the same for any id.
   */
  async hlsClose(a: Actor, cameraId: string, q: Quality) {
    const path = pathFor(cameraId, q);
    this.hlsJar.delete(jarKey(a, path));
    for (const [id, l] of this.live) {
      if (l.kind !== "hls" || l.sessionId !== a.sessionId || l.path !== path || (l.previewId ?? "") !== (a.preview?.id ?? "")) continue;
      await this.relay.kick("hls", id);
      this.live.delete(id);
    }
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

  /**
   * The live streams one session holds, as the stream limit counts them: distinct camera and quality.
   * `kinds` says how each is being read; one stream can be read both ways during a handover. For the
   * diagnostics route, which shows a person their own session only.
   */
  sessionStreams(sessionId: string): { cameraId: string; quality: Quality; kinds: ReaderKind[] }[] {
    const byPath = new Map<string, { cameraId: string; quality: Quality; kinds: ReaderKind[] }>();
    for (const l of this.live.values()) {
      if (l.sessionId !== sessionId) continue;
      let s = byPath.get(l.path);
      if (!s) byPath.set(l.path, (s = { cameraId: l.cameraId, quality: l.path === pathFor(l.cameraId, "focus") ? "focus" : "wall", kinds: [] }));
      if (!s.kinds.includes(l.kind)) s.kinds.push(l.kind);
    }
    return [...byPath.values()];
  }
}
