import type { Access } from "./authz/access";
import { subjectOf, type Actor } from "./authz/actor";
import type { CameraInfo, Policy } from "./authz/policy";
import { EVENT_TYPES, type EventType, type ProtectAdapter, type ProtectEvent } from "./protect/types";
import { badRequest, HttpError, notFound } from "./util";

export interface EventDto { id: string; cameraId: string; cameraName: string; type: EventType; startMs: number; endMs: number | null; hasThumbnail: boolean }

/**
 * Motion and detection events, read from Protect and filtered by camera permission before anything
 * else happens: the recorder is only ever asked about cameras the subject may see, so limits,
 * counts and "has more" can never reflect a forbidden camera. An event id is always resolved to
 * its camera and checked again before details or a thumbnail are returned.
 */
export class Events {
  constructor(private policy: Policy, private access: Access, private adapter: () => ProtectAdapter) {}

  private dto(e: ProtectEvent, cams: Map<string, CameraInfo>): EventDto | null {
    const c = cams.get(e.protectCameraId);
    return c ? { id: e.id, cameraId: c.id, cameraName: c.name, type: e.type, startMs: e.startMs, endMs: e.endMs, hasThumbnail: e.hasThumbnail } : null;
  }
  private byProtectId(userId: string) {
    return new Map(this.policy.cameras(userId).filter((c) => c.nvrId === this.adapter().nvrId).map((c) => [c.protectId, c]));
  }

  async list(a: Actor, q: { cameraId?: string; fromMs: number; toMs: number; types?: string[]; limit?: number }) {
    const subject = subjectOf(a);
    let cams = this.byProtectId(subject);
    if (q.cameraId) { const one = this.policy.camera(subject, q.cameraId); cams = new Map([[one.protectId, one]]); }
    if (!(q.toMs > q.fromMs) || q.toMs - q.fromMs > 31 * 864e5) throw badRequest("Invalid time range");
    const types = (q.types ?? []).filter((t): t is EventType => (EVENT_TYPES as string[]).includes(t));
    const limit = Math.min(Math.max(q.limit ?? 48, 1), 200);
    // What these cameras can detect at all, so the UI can tell "unsupported" from "no results".
    const supported = [...new Set([...cams.values()].flatMap((c) => (c.meta.eventTypes as EventType[] | undefined) ?? []))];
    if (!cams.size) return { events: [] as EventDto[], hasMore: false, supportedTypes: supported };
    const rows = await this.adapter().listEvents({ protectCameraIds: [...cams.keys()], fromMs: q.fromMs, toMs: q.toMs, types: types.length ? types : undefined, limit: limit + 1 }).catch(() => { throw new HttpError(503, "nvr_unavailable"); });
    const events = rows.map((e) => this.dto(e, cams)).filter((e): e is EventDto => !!e);
    return { events: events.slice(0, limit), hasMore: events.length > limit, supportedTypes: supported };
  }

  /** Resolves an event id to its camera and checks access. Unknown and forbidden look the same. */
  async get(a: Actor, id: string): Promise<{ dto: EventDto; raw: ProtectEvent }> {
    const e = await this.adapter().getEvent(id).catch(() => { throw new HttpError(503, "nvr_unavailable"); });
    const dto = e && this.dto(e, this.byProtectId(subjectOf(a)));
    if (!e || !dto) throw notFound();
    return { dto, raw: e };
  }
  async thumbnail(a: Actor, id: string, signal?: AbortSignal): Promise<Buffer> {
    await this.get(a, id);
    const img = await this.adapter().eventThumbnail(id, signal).catch(() => null);
    if (!img) throw notFound();
    return img;
  }

  /**
   * Live events for one connection. Permission is evaluated per event at delivery time, so a
   * revoked camera stops appearing immediately; `onEnd` fires when the session or preview is gone.
   */
  subscribe(a: Actor, onEvent: (e: EventDto) => void, onEnd: () => void) {
    const sent = new Set<string>();
    const feed = this.access.grant(a); // not tied to one camera: each event is filtered by Policy below
    const alive = () => this.access.holds(feed);
    const off = this.adapter().subscribeEvents((e) => {
      if (!alive()) return void stop(true);
      if (sent.has(e.id)) return;
      const dto = this.dto(e, this.byProtectId(subjectOf(a)));
      if (!dto) return;
      sent.add(e.id);
      if (sent.size > 2000) sent.clear();
      onEvent(dto);
    });
    const unwatch = this.access.onChange(() => { if (!alive()) stop(true); });
    let done = false;
    const stop = (ended = false) => { if (done) return; done = true; off(); unwatch(); if (ended) onEnd(); };
    return () => stop(false);
  }
}
