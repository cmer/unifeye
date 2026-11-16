import { lt } from "drizzle-orm";
import { schema, type Db } from "./db";
import { log } from "./util";

export interface AuditEntry {
  actorId?: string | null;
  previewSubjectId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: "ok" | "denied" | "error";
  requestId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}
const SECRET = /pass|secret|token|cookie|authorization|url/i;

/** Append-only. Never pass secrets; keys that look secret are stripped as a second line of defence. */
export function audit(db: Db, e: AuditEntry) {
  const detail = e.detail ? Object.fromEntries(Object.entries(e.detail).filter(([k]) => !SECRET.test(k))) : undefined;
  try {
    db.insert(schema.auditLog).values({ at: Date.now(), actorId: e.actorId ?? null, previewSubjectId: e.previewSubjectId ?? null, action: e.action, targetType: e.targetType, targetId: e.targetId, outcome: e.outcome ?? "ok", requestId: e.requestId, ip: e.ip, detail }).run();
  } catch (err) {
    log("error", "audit write failed", { action: e.action, error: err });
  }
}
export function pruneAudit(db: Db, retentionDays: number) {
  return db.delete(schema.auditLog).where(lt(schema.auditLog.at, Date.now() - retentionDays * 864e5)).run().changes;
}
