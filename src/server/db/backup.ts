import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util";
import type { Db } from "./index";

export interface BackupResult { file: string; bytes: number }
let lastBackup: { at: number; ok: boolean; error?: string; file?: string } | undefined;
export const backupStatus = () => lastBackup;

/** Throws unless the file is a readable SQLite database that passes integrity_check. */
export function verifyDatabaseFile(file: string): { schemaVersion: number } {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const res = d.pragma("integrity_check", { simple: true });
    if (res !== "ok") throw new Error(`integrity_check failed: ${String(res)}`);
    const has = d.prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'").get();
    const schemaVersion = has ? (d.prepare("select count(*) c from __drizzle_migrations").get() as { c: number }).c : 0;
    return { schemaVersion };
  } finally {
    d.close();
  }
}

/**
 * Transactionally consistent backup through SQLite's online backup API (WAL-safe).
 * The file is written under a temporary name, verified, then renamed into place, so a
 * partial backup never looks complete. Backups hold user, session and permission data: mode 0600.
 */
export async function backupDatabase(db: Db, dir: string, reason: "daily" | "manual" | "pre-migration"): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const final = join(dir, `vantage-${stamp}-${reason}.sqlite`);
  const tmp = `${final}.partial`;
  try {
    await db.$client.backup(tmp);
    verifyDatabaseFile(tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, final);
    const bytes = statSync(final).size;
    lastBackup = { at: Date.now(), ok: true, file: final };
    log("info", "backup complete", { file: final, bytes, reason });
    return { file: final, bytes };
  } catch (e) {
    rmSync(tmp, { force: true });
    lastBackup = { at: Date.now(), ok: false, error: (e as Error).message };
    log("error", "backup failed", { reason, error: e });
    throw e;
  }
}

/** Removes daily backups older than the retention window. Manual and pre-migration backups are kept. */
export function pruneBackups(dir: string, retentionDays: number, nowMs = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^vantage-.*-daily\.sqlite$/.test(f)) continue;
    const p = join(dir, f);
    if (nowMs - statSync(p).mtimeMs > retentionDays * 864e5) {
      rmSync(p);
      removed.push(f);
    }
  }
  return removed;
}
