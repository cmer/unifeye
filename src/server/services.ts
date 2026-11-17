import { eq } from "drizzle-orm";
import { Admin } from "./admin";
import { audit, pruneAudit } from "./audit";
import { CloudflareAccess } from "./auth/cloudflare";
import { LocalAccounts } from "./auth/local";
import { Oidc } from "./auth/oidc";
import { Sessions } from "./auth/session";
import { Access } from "./authz/access";
import { Policy } from "./authz/policy";
import { Previews } from "./authz/preview";
import { Views } from "./authz/views";
import { syncCameras } from "./cameras";
import { config } from "./config";
import { db as openDefaultDb, schema, type Db } from "./db";
import { backupDatabase, pruneBackups } from "./db/backup";
import { runMigrations } from "./db/migrate";
import { Events } from "./events";
import { Media } from "./media/gateway";
import { startHookServer } from "./media/hook-server";
import { commandPublishUrl, MediaMtxRelay } from "./media/mediamtx";
import { Recordings } from "./media/recordings";
import type { Relay } from "./media/relay";
import { MockProtectAdapter } from "./protect/mock";
import type { ProtectAdapter } from "./protect/types";
import { UnifiProtectAdapter } from "./protect/unifi";
import { seedDemo } from "./seed";
import { log } from "./util";

export interface Services {
  db: Db; policy: Policy; access: Access; views: Views; sessions: Sessions; previews: Previews; admin: Admin; oidc: Oidc; local: LocalAccounts; cloudflare: CloudflareAccess;
  adapter: ProtectAdapter; media: Media; recordings: Recordings; events: Events;
  state: { startedAt: number; lastCameraSyncAt: number | null; lastCameraSyncError: string | null; timers: NodeJS.Timeout[] };
}

export function makeAdapter(): ProtectAdapter {
  const c = config();
  if (c.UNIFEYE_MODE === "real") return new UnifiProtectAdapter(c.PROTECT_NVR_ID, { host: c.PROTECT_HOST!, username: c.PROTECT_USERNAME!, password: c.PROTECT_PASSWORD!, verifyTls: !c.PROTECT_TLS_INSECURE, rtspsFingerprint: c.PROTECT_RTSPS_FINGERPRINT });
  // In mock mode MediaMTX runs the FFmpeg test source itself and publishes to its own RTSP listener.
  return new MockProtectAdapter(c.PROTECT_NVR_ID, { publishUrl: commandPublishUrl() });
}

/** Wires every server-side service around one database connection, one Protect adapter and one media relay. */
export function buildServices(db: Db, adapter: ProtectAdapter, relay: Relay = new MediaMtxRelay()): Services {
  const policy = new Policy(db), views = new Views(db, policy), sessions = new Sessions(db, policy), previews = new Previews(db, policy);
  const admin = new Admin(db, policy, views, sessions), oidc = new Oidc(db, policy, sessions);
  const local = new LocalAccounts(db, policy, sessions), cloudflare = new CloudflareAccess(db, policy, sessions);
  const get = () => adapter;
  // Access listens to Policy, Sessions and Previews; everything that holds access listens to Access.
  // Events subscribes per open feed (Events.subscribe); the two process-wide holders are wired here.
  const access = new Access(policy, sessions, previews);
  const media = new Media(policy, access, get, relay), recordings = new Recordings(db, policy, access, get), events = new Events(policy, access, get);
  access.onChange(() => media.revalidate());
  access.onChange(() => { void recordings.dropDeadExports().catch((e) => log("error", "export cleanup failed", { error: e })); });
  return { db, policy, access, views, sessions, previews, admin, oidc, local, cloudflare, adapter, media, recordings, events, state: { startedAt: Date.now(), lastCameraSyncAt: null, lastCameraSyncError: null, timers: [] } };
}

const g = globalThis as unknown as { __unifeye?: Services; __unifeyeStart?: Promise<void> };
export function services(): Services {
  return (g.__unifeye ??= buildServices(openDefaultDb(), makeAdapter()));
}
export function setServicesForTests(s: Services | undefined) { g.__unifeye = s; }

/** Demo data is created only in mock mode, only when asked, only once, and only after an administrator exists. */
export function maybeSeedDemo(s: Services) {
  const c = config();
  if (c.UNIFEYE_MODE !== "mock" || process.env.SEED_DEMO !== "1") return;
  const admin = s.db.select().from(schema.users).where(eq(schema.users.role, "admin")).get();
  if (admin && s.policy.allCamerasUnchecked().length && seedDemo(s.db, admin.id)) { s.policy.invalidate(); log("info", "demo data seeded (mock mode)"); }
}

export async function syncNow(s: Services) {
  try {
    await s.adapter.connect();
    syncCameras(s.db, s.policy, s.adapter.nvrId, await s.adapter.listCameras());
    s.state.lastCameraSyncAt = Date.now();
    s.state.lastCameraSyncError = null;
    maybeSeedDemo(s);
  } catch (e) {
    // An outage never touches camera references, tags, grants or views.
    s.state.lastCameraSyncError = (e as Error).message.slice(0, 200);
  }
}

/**
 * Process start-up, called once from instrumentation. Migrations run first and any failure aborts
 * the process, so the app never serves requests on a half-migrated database.
 */
export function startRuntime(): Promise<void> {
  return (g.__unifeyeStart ??= (async () => {
    const c = config(), s = services();
    await runMigrations(s.db, { backupDir: c.BACKUP_DIR });
    // MediaMTX's auth hook has its own listener, off the public port. Without it no video plays, so a
    // failure to listen (port taken) aborts start-up like a failed migration.
    const hook = await startHookServer(s.media, { host: c.HOOK_HOST, port: c.HOOK_PORT });
    log("info", "media hook listening", { host: c.HOOK_HOST, port: c.HOOK_PORT });
    const every = (sec: number, name: string, fn: () => unknown) => {
      const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => log("error", `${name} failed`, { error: e })); }, sec * 1000);
      t.unref();
      s.state.timers.push(t);
    };
    // After a restart Unifeye has no record of who is watching: remove every reader (fail closed).
    void s.media.sweep().catch(() => {});
    void syncNow(s);
    every(30, "camera sync", () => syncNow(s));
    // Backstop: time limits that passed unnoticed become access changes, and the relay is re-checked regardless.
    every(c.REVOCATION_SWEEP_SECONDS, "revocation sweep", () => { s.access.expireDue(); return s.media.sweep(); });
    every(Math.min(60, c.OIDC_RECHECK_SECONDS), "identity re-validation", () => s.oidc.reconcile());
    every(300, "housekeeping", async () => { await s.recordings.cleanup(); s.sessions.purgeExpired(); });
    let lastBackupDay = "";
    every(600, "backup", async () => {
      const d = new Date(), day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() < c.BACKUP_HOUR_UTC || day === lastBackupDay) return;
      lastBackupDay = day;
      await backupDatabase(s.db, c.BACKUP_DIR, "daily");
      pruneBackups(c.BACKUP_DIR, c.BACKUP_RETENTION_DAYS);
      pruneAudit(s.db, c.AUDIT_RETENTION_DAYS);
    });
    const stop = async () => {
      log("info", "shutting down");
      s.state.timers.forEach(clearInterval);
      hook.close();
      await s.adapter.close().catch(() => {});
      try { s.db.$client.pragma("wal_checkpoint(TRUNCATE)"); s.db.$client.close(); } catch { /* already closed */ }
      process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    audit(s.db, { action: "system.start", detail: { mode: c.UNIFEYE_MODE } });
    log("info", "unifeye started", { mode: c.UNIFEYE_MODE });
  })());
}
