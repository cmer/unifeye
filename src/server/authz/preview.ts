import { and, eq, isNull } from "drizzle-orm";
import { audit } from "../audit";
import { config } from "../config";
import { schema, type Db } from "../db";
import { forbidden, hashToken, HttpError, randomToken } from "../util";
import type { Actor } from "./actor";
import type { Policy } from "./policy";

type PreviewRow = typeof schema.previewContexts.$inferSelect;

/**
 * "See as staff": a read-only authorization preview. It is not impersonation.
 *  - The administrator stays the authenticated actor; no session is created for the subject and
 *    nothing about the subject (identity, preferences, last sign-in) is touched.
 *  - The preview is a server-side record bound to the administrator's session. The browser holds
 *    an opaque token per tab and sends it explicitly with each request; a forged or foreign token
 *    is rejected, so tabs cannot confuse subjects and a client-supplied user id is never trusted.
 *  - All reads then run through the normal policy with the subject's id. All writes are refused.
 */
export class Previews {
  private ended = new Set<() => void>();
  constructor(private db: Db, private policy: Policy) {}

  /** Called after a preview ends for any reason (exit, timeout, actor or subject no longer eligible). */
  onEnd(fn: () => void) {
    this.ended.add(fn);
    return () => { this.ended.delete(fn); };
  }
  /** The one statement of when a preview context is usable: null while live, otherwise why not. */
  private whyDead(p: PreviewRow | undefined): null | "ended" | "timeout" | "actor_not_admin" | "subject_unavailable" {
    if (!p || p.endedAt) return "ended";
    if (Date.now() >= p.expiresAt) return "timeout";
    if (!this.policy.isAdmin(p.actorId)) return "actor_not_admin";
    return this.policy.activeUser(p.subjectId)?.role === "staff" ? null : "subject_unavailable";
  }
  private row(id: string) {
    return this.db.select().from(schema.previewContexts).where(eq(schema.previewContexts.id, id)).get();
  }

  start(actor: Actor, subjectId: string): { token: string; expiresAt: number } {
    const base = { actorId: actor.userId, targetType: "user", targetId: subjectId, requestId: actor.requestId, ip: actor.ip };
    const subject = this.policy.activeUser(subjectId);
    if (actor.preview || !this.policy.isAdmin(actor.userId) || !subject || subject.role !== "staff") {
      audit(this.db, { ...base, action: "preview.start", outcome: "denied" });
      throw forbidden("preview_not_allowed");
    }
    const token = randomToken(), t = Date.now(), expiresAt = t + config().PREVIEW_MINUTES * 6e4;
    this.db.insert(schema.previewContexts).values({ id: hashToken(token), sessionId: actor.sessionId, actorId: actor.userId, subjectId, createdAt: t, expiresAt }).run();
    audit(this.db, { ...base, previewSubjectId: subjectId, action: "preview.start" });
    return { token, expiresAt };
  }

  /**
   * Validates a preview token for this session. Returns the context, or throws 409 `preview_ended`
   * so the client leaves preview instead of silently falling back to administrator visibility.
   */
  resolve(sessionId: string, actorId: string, token: string): { id: string; subjectId: string; expiresAt: number } {
    const id = hashToken(token), p = this.row(id);
    const gone = () => new HttpError(409, "preview_ended", "The preview has ended");
    if (!p || p.sessionId !== sessionId || p.actorId !== actorId) {
      audit(this.db, { actorId, action: "preview.use", outcome: "denied", detail: { why: "unknown_or_foreign_context" } });
      throw gone();
    }
    const why = this.whyDead(p);
    if (why) {
      if (why !== "ended") this.finish(id, why);
      throw gone();
    }
    return { id, subjectId: p.subjectId, expiresAt: p.expiresAt };
  }

  private finish(id: string, reason: string) {
    const p = this.row(id);
    const n = this.db.update(schema.previewContexts).set({ endedAt: Date.now(), endReason: reason }).where(and(eq(schema.previewContexts.id, id), isNull(schema.previewContexts.endedAt))).run().changes;
    if (n && p) {
      audit(this.db, { actorId: p.actorId, previewSubjectId: p.subjectId, action: reason === "exit" ? "preview.exit" : "preview.end", targetType: "user", targetId: p.subjectId, detail: { reason } });
      for (const fn of [...this.ended]) fn(); // stop whatever was authorized through this preview
    }
  }
  end(actor: Actor) {
    if (actor.preview) this.finish(actor.preview.id, "exit");
  }
  /** True while a preview context can still authorize anything. Read-only: it never ends or notifies. */
  isLive(id: string): boolean {
    return this.whyDead(this.row(id)) === null;
  }
  /** Background sweep: record timeouts even if no request arrives to notice them. */
  expireDue() {
    const rows = this.db.select().from(schema.previewContexts).where(isNull(schema.previewContexts.endedAt)).all();
    for (const p of rows) if (Date.now() >= p.expiresAt) this.finish(p.id, "timeout");
  }
}
