import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { openDb, schema } from "../db";
import { verifyDatabaseFile } from "../db/backup";
import { runMigrations } from "../db/migrate";

/**
 * Restores a backup into `dbPath`. The application must be stopped.
 *  1. The backup is integrity-checked before anything is touched.
 *  2. An existing database is moved aside (never deleted) unless the target is empty.
 *  3. Stale WAL files are removed, then the restored copy is opened and checked against this build.
 *  4. Every session, preview and pending download is invalidated: people sign in again through
 *     Zitadel, and no media capability from before the restore survives.
 * Secrets and configuration (.env) are not in the backup and must be restored separately.
 */
export async function restoreDatabase(backupFile: string, dbPath: string, opts: { force?: boolean; migrationsFolder?: string } = {}) {
  const { schemaVersion } = verifyDatabaseFile(backupFile);
  let movedAside: string | undefined;
  if (existsSync(dbPath)) {
    if (!opts.force) throw new Error(`${dbPath} already exists. Stop the app and pass --force to replace it (the current file is kept alongside).`);
    movedAside = `${dbPath}.replaced-${Date.now()}`;
    renameSync(dbPath, movedAside);
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(backupFile, dbPath);
  const db = openDb(dbPath);
  try {
    const m = await runMigrations(db, { folder: opts.migrationsFolder }); // refuses a backup newer than this build; upgrades an older one
    const t = Date.now();
    const sessions = db.update(schema.sessions).set({ revokedAt: t, revokeReason: "restored_from_backup", refreshTokenEnc: null, idTokenEnc: null }).run().changes;
    db.delete(schema.previewContexts).run();
    db.delete(schema.exportJobs).run();
    db.delete(schema.loginTransactions).run();
    db.insert(schema.auditLog).values({ at: t, action: "system.restore", outcome: "ok", detail: { backupSchemaVersion: schemaVersion, schemaVersion: m.schemaVersion, sessionsRevoked: sessions } }).run();
    const count = (table: string) => (db.$client.prepare(`select count(*) c from ${table}`).get() as { c: number }).c;
    return { backupSchemaVersion: schemaVersion, schemaVersion: m.schemaVersion, sessionsRevoked: sessions, movedAside, users: count("users"), cameras: count("cameras"), tags: count("tags"), views: count("views"), grants: count("user_camera_grants") + count("group_camera_grants") };
  } finally {
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.close();
  }
}
