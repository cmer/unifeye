import { eq } from "drizzle-orm";
import { join } from "node:path";
import type { Actor } from "../authz/actor";
import { syncCameras } from "../cameras";
import { config, loadConfig, setConfigForTests } from "../config";
import { openDb, schema, type Db } from "../db";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { MOCK_CAMERAS } from "../protect/mock-data";
import { MockProtectAdapter } from "../protect/mock";
import { buildServices, setServicesForTests } from "../services";
import { seedDemo } from "../seed";
import { MemoryRelay } from "./relay";

export const ISS = "https://id.test.example";
export const TEST_ENV = { NODE_ENV: "test", UNIFEYE_MODE: "mock", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), OIDC_ISSUER: ISS, OIDC_CLIENT_ID: "unifeye-test", OIDC_ADMIT_CLAIM: "groups", OIDC_ADMIT_VALUES: "unifeye", MEDIAMTX_HOOK_SECRET: "hook", MEDIAMTX_API_SECRET: "api" } as unknown as NodeJS.ProcessEnv;

/**
 * The permission fixture required by the specification:
 *  Admin; Upper Level Staff; Front Desk; Security (overlapping membership: Security + Front Desk Team);
 *  a new hire with zero camera access; a shared view mixing permitted and forbidden cameras
 *  ("Building Overview", shared with everyone); and dynamic views whose membership depends on tags.
 */
export function makeFixture(db: Db = openDb(":memory:")) {
  setConfigForTests(loadConfig(TEST_ENV));
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  const adapter = new MockProtectAdapter("default", { liveEvents: false, rtspPublishUrl: (p) => `rtsp://127.0.0.1:8554/${p}` });
  // The relay is in memory and asks the real auth hook, as MediaMTX does through the hook listener (hook-server.ts).
  const relay = new MemoryRelay();
  const s = buildServices(db, adapter, relay);
  relay.connect((body) => s.media.hook(config().MEDIAMTX_HOOK_SECRET ?? null, body));
  setServicesForTests(s);
  const { policy, views, sessions, previews, admin } = s;
  const t = Date.now();
  const user = (id: string, name: string, role: "admin" | "staff", allowPrivateViews = false) => { db.insert(schema.users).values({ id, issuer: ISS, subject: `sub-${id}`, name, email: `${id}@example.test`, role, allowPrivateViews, createdAt: t, updatedAt: t }).run(); return id; };
  const u = { admin: user("admin", "Avery Chen", "admin", true), upper: user("upper", "Morgan Reyes", "staff"), front: user("front", "Sam Okafor", "staff", true), sec: user("sec", "Jordan Blake", "staff"), nobody: user("nobody", "Riley Park", "staff") };
  syncCameras(db, policy, "default", MOCK_CAMERAS.map((m) => ({ protectId: m.protectId, name: m.name, online: m.online, eventTypes: ["motion", "person", "vehicle", "animal", "package"], streams: [{ quality: "high", width: 1920, height: 1080 }] })));
  seedDemo(db, u.admin);
  const g = Object.fromEntries(db.select().from(schema.groups).all().map((x) => [x.name, x.id])) as Record<string, string>;
  const member = (groupName: string, userId: string) => db.insert(schema.groupMembers).values({ groupId: g[groupName], userId, createdAt: t }).run();
  member("Upper Level Team", u.upper); member("Front Desk Team", u.front); member("Security", u.sec); member("Front Desk Team", u.sec);
  const camByName = Object.fromEntries(db.select().from(schema.cameras).all().map((c) => [c.name, c.id])) as Record<string, string>;
  db.insert(schema.userCameraGrants).values({ userId: u.front, cameraId: camByName["Loading Dock"], createdAt: t }).run();
  const viewByName = () => Object.fromEntries(db.select().from(schema.views).all().map((v) => [v.name, v.id])) as Record<string, string>;
  const tagByName = () => Object.fromEntries(db.select().from(schema.tags).all().map((x) => [x.name, x.id])) as Record<string, string>;
  policy.invalidate();
  const actor = (userId: string, extra: Partial<Actor> = {}): Actor => ({ userId, role: db.select().from(schema.users).where(eq(schema.users.id, userId)).get()!.role, sessionId: `sess-${userId}`, ...extra });
  const names = (userId: string) => policy.cameras(userId).map((c) => c.name);
  return { s, adapter, relay, db, policy, views, sessions, previews, admin, u, g, cam: camByName, viewByName, tagByName, actor, names };
}
export type Fixture = ReturnType<typeof makeFixture>;
