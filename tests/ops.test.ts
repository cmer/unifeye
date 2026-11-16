import Database from "better-sqlite3";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, schema } from "@/server/db";
import { backupDatabase, pruneBackups, verifyDatabaseFile } from "@/server/db/backup";
import { runMigrations } from "@/server/db/migrate";
import { restoreDatabase } from "@/server/ops/restore";
import { makeFixture } from "@/server/testing/fixture";
import { dayBounds, timeInput, zonedToUtc } from "@/ui/api";

const tmp = () => mkdtempSync(join(tmpdir(), "unifeye-ops-"));
/** How many migrations this build ships; the schema version of a freshly installed database. */
const SHIPPED = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")).entries.length as number;
/** The real migrations up to and including the first `count`, as an older build would have shipped them. */
function firstMigrations(count: number) {
  const dir = join(tmp(), "drizzle");
  cpSync(join(process.cwd(), "drizzle"), dir, { recursive: true });
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  j.entries = j.entries.slice(0, count);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(j));
  return dir;
}
/** A copy of the real migrations plus one synthetic later migration, to exercise an upgrade. */
function withExtraMigration(sql: string) {
  const dir = join(tmp(), "drizzle");
  cpSync(join(process.cwd(), "drizzle"), dir, { recursive: true });
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  j.entries.push({ idx: j.entries.length, version: j.entries[0].version, when: Date.now(), tag: "9999_test_upgrade", breakpoints: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(j));
  writeFileSync(join(dir, "9999_test_upgrade.sql"), sql);
  return dir;
}

describe("migrations", () => {
  it("installs cleanly, is idempotent, and enables WAL and foreign keys", async () => {
    const db = openDb(join(tmp(), "v.sqlite"));
    expect((await runMigrations(db)).applied).toBeGreaterThan(0);
    expect((await runMigrations(db)).applied).toBe(0);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.$client.prepare("insert into group_members (group_id, user_id, created_at) values ('nope','nope',1)").run()).toThrow(/FOREIGN KEY/);
  });
  it("upgrades a database from the previous schema, keeping data and taking a backup first", async () => {
    const dir = tmp(), path = join(dir, "v.sqlite"), backups = join(dir, "backups");
    const f = makeFixture(openDb(path)); // schema as shipped today, with data
    const before = f.names(f.u.front);
    const folder = withExtraMigration("ALTER TABLE `settings` ADD `note` text;");
    expect(await runMigrations(f.db, { folder, backupDir: backups })).toMatchObject({ applied: 1 });
    expect(readdirSync(backups).filter((x) => x.endsWith("-pre-migration.sqlite"))).toHaveLength(1);
    expect(f.db.$client.prepare("select note from settings limit 1").get()).toBeDefined();
    f.policy.invalidate();
    expect(f.names(f.u.front)).toEqual(before);
  });
  it("upgrades the initial schema to the current one: export jobs gain a preview reference and keep their rows", async () => {
    const db = openDb(join(tmp(), "v.sqlite"));
    expect(await runMigrations(db, { folder: firstMigrations(1) })).toMatchObject({ applied: 1 });
    db.$client.exec("insert into users (id, issuer, subject, name, role, status, allow_private_views, created_at, updated_at, version) values ('u','i','s','n','staff','active',0,1,1,1)");
    db.$client.exec("insert into cameras (id, nvr_id, protect_id, name, meta, first_seen_at, last_seen_at) values ('c','n','p','Cam','{}',1,1)");
    db.$client.exec("insert into sessions (id, token_hash, user_id, csrf_secret, created_at, last_seen_at, idle_expires_at, absolute_expires_at, last_validated_at) values ('s','h','u','x',1,1,1,1,1)");
    db.$client.exec("insert into export_jobs (id, session_id, subject_id, camera_id, start_ms, end_ms, status, progress, created_at, expires_at) values ('j','s','u','c',1,2,'ready',100,1,2)");
    expect(await runMigrations(db)).toMatchObject({ applied: SHIPPED - 1 });
    expect(db.select().from(schema.exportJobs).all()).toMatchObject([{ id: "j", previewId: null }]);
  });
  it("a failing migration aborts start-up and leaves the data as it was", async () => {
    const f = makeFixture(openDb(join(tmp(), "v.sqlite")));
    const users = f.db.select().from(schema.users).all().length;
    await expect(runMigrations(f.db, { folder: withExtraMigration("ALTER TABLE `no_such_table` ADD `x` text;") })).rejects.toThrow();
    expect(f.db.select().from(schema.users).all()).toHaveLength(users);
    expect(f.db.$client.prepare("select count(*) c from __drizzle_migrations").get()).toEqual({ c: SHIPPED });
  });
  it("refuses a database that is newer than the running build", async () => {
    const db = openDb(join(tmp(), "v.sqlite"));
    await runMigrations(db, { folder: withExtraMigration("ALTER TABLE `settings` ADD `note` text;") });
    await expect(runMigrations(db)).rejects.toThrow(/newer than this build/);
  });
});

describe("backup and restore", () => {
  it("backs up consistently while in WAL mode, verifies, and restores with permissions intact and sessions revoked", async () => {
    const dir = tmp(), path = join(dir, "v.sqlite"), backups = join(dir, "backups");
    const f = makeFixture(openDb(path));
    const live = f.sessions.create(f.u.front, {});
    f.db.insert(schema.previewContexts).values({ id: "p", sessionId: live.session.id, actorId: f.u.admin, subjectId: f.u.front, createdAt: 1, expiresAt: Date.now() + 1e6 }).run();
    const want = { cams: f.names(f.u.sec), views: f.views.accessible(f.u.sec).map((v) => v.name), landing: f.views.landing(f.u.sec), shared: f.views.resolve(f.views.get(f.viewByName()["Building Overview"])!, f.u.front).cameras.map((c) => c.name) };
    const b = await backupDatabase(f.db, backups, "manual");
    expect(statSync(b.file).mode & 0o777).toBe(0o600);
    expect(verifyDatabaseFile(b.file).schemaVersion).toBe(SHIPPED);
    expect(readdirSync(backups).some((x) => x.endsWith(".partial"))).toBe(false);
    f.db.delete(schema.users).run(); // disaster after the backup
    f.db.$client.close();

    const target = join(tmp(), "restored.sqlite"); // a clean volume
    const r = await restoreDatabase(b.file, target);
    expect(r).toMatchObject({ users: 5, cameras: 14, sessionsRevoked: 1, schemaVersion: SHIPPED });
    const g = makeFixtureView(target);
    expect(g.policy.cameras(f.u.sec).map((c) => c.name)).toEqual(want.cams);
    expect(g.views.accessible(f.u.sec).map((v) => v.name)).toEqual(want.views);
    expect(g.views.landing(f.u.sec)).toEqual(want.landing);
    expect(g.views.resolve(g.views.get(viewId(g.db, "Building Overview"))!, f.u.front).cameras.map((c) => c.name)).toEqual(want.shared);
    expect(g.sessions.load(live.token)).toBeUndefined(); // sessions from before the restore are dead
    expect(g.db.select().from(schema.previewContexts).all()).toHaveLength(0);
    await expect(restoreDatabase(b.file, target)).rejects.toThrow(/already exists/);
    expect((await restoreDatabase(b.file, target, { force: true })).movedAside).toBeTruthy();
  });
  it("rejects a corrupt or truncated backup before touching anything", async () => {
    const dir = tmp(), bad = join(dir, "bad.sqlite"), target = join(dir, "t.sqlite");
    writeFileSync(bad, "this is not a database, just a copied fragment");
    await expect(restoreDatabase(bad, target)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it("prunes only daily backups past retention", () => {
    const dir = tmp();
    for (const n of ["unifeye-20200101T000000Z-daily.sqlite", "unifeye-20200101T000000Z-manual.sqlite", "unifeye-20200101T000000Z-pre-migration.sqlite"]) writeFileSync(join(dir, n), "x");
    const old = Date.now() + 30 * 864e5;
    expect(pruneBackups(dir, 14, old)).toEqual(["unifeye-20200101T000000Z-daily.sqlite"]);
    expect(readdirSync(dir)).toHaveLength(2);
  });
  it("a plain file copy of a live WAL database can miss committed data; the backup API does not", async () => {
    const dir = tmp(), path = join(dir, "v.sqlite");
    const f = makeFixture(openDb(path));
    f.db.$client.pragma("wal_autocheckpoint = 0");
    f.admin.createTag(f.actor(f.u.admin), "only_in_wal");
    const naive = join(dir, "naive.sqlite");
    cpSync(path, naive); // copies the main file without its -wal
    const has = (file: string) => { const d = new Database(file, { readonly: true }); try { return !!d.prepare("select 1 from tags where name = 'only_in_wal'").get(); } catch { return false; } finally { d.close(); } };
    expect(has(naive)).toBe(false);
    expect(has((await backupDatabase(f.db, join(dir, "b"), "manual")).file)).toBe(true);
  });
});

describe("time zones and daylight saving", () => {
  const TZ = "America/Toronto";
  it("day lengths follow the zone: 23 hours in spring, 25 in autumn", () => {
    const [a, b] = dayBounds(Date.UTC(2026, 2, 8, 15), TZ); // 8 March 2026, clocks go forward
    expect((b - a) / 36e5).toBe(23);
    const [c, d] = dayBounds(Date.UTC(2026, 10, 1, 15), TZ); // 1 November 2026, clocks go back
    expect((d - c) / 36e5).toBe(25);
    const [e, g] = dayBounds(Date.UTC(2026, 5, 10, 15), TZ);
    expect((g - e) / 36e5).toBe(24);
    expect(timeInput(a, TZ)).toBe("00:00:00");
  });
  it("round-trips wall-clock times and resolves the repeated autumn hour to one instant", () => {
    const utc = zonedToUtc(2026, 6, 10, 14, 30, 5, TZ);
    expect(new Date(utc).toISOString()).toBe("2026-06-10T18:30:05.000Z");
    expect(timeInput(utc, TZ)).toBe("14:30:05");
    const ambiguous = zonedToUtc(2026, 11, 1, 1, 30, 0, TZ); // 01:30 happens twice
    expect(timeInput(ambiguous, TZ)).toBe("01:30:00");
    expect([5.5, 6.5]).toContain((ambiguous - Date.UTC(2026, 10, 1)) / 36e5); // one of the two real instants, deterministically
    expect(zonedToUtc(2026, 11, 1, 1, 30, 0, TZ)).toBe(ambiguous);
  });
  it("a time skipped by the spring change maps to a real instant instead of failing", () => {
    const skipped = zonedToUtc(2026, 3, 8, 2, 30, 0, TZ); // 02:30 does not exist that night
    expect(Number.isFinite(skipped)).toBe(true);
    expect(["01:30:00", "03:30:00"]).toContain(timeInput(skipped, TZ));
  });
  it("UTC is exact", () => { expect(zonedToUtc(2026, 1, 2, 3, 4, 5, "UTC")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5)); });
});

// Helpers that open an existing database with the real services, without reseeding it.
import { Sessions } from "@/server/auth/session";
import { Policy } from "@/server/authz/policy";
import { Views } from "@/server/authz/views";
function makeFixtureView(path: string) { const db = openDb(path), policy = new Policy(db); return { db, policy, views: new Views(db, policy), sessions: new Sessions(db, policy) }; }
const viewId = (db: ReturnType<typeof openDb>, name: string) => db.select().from(schema.views).all().find((v) => v.name === name)!.id;
