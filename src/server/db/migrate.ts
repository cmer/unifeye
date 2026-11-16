import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util";
import { backupDatabase } from "./backup";
import type { Db } from "./index";

export const migrationsFolder = () => process.env.MIGRATIONS_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), "drizzle");

function pending(db: Db, folder: string): { applied: number; total: number } {
  const journal = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(folder, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  const has = db.$client.prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'").get();
  const applied = has ? (db.$client.prepare("select count(*) c from __drizzle_migrations").get() as { c: number }).c : 0;
  return { applied, total: journal.entries.length };
}

/**
 * Applies the checked-in, versioned SQL migrations. Never uses schema push.
 * An existing database is backed up first. Any failure throws, and the caller must stop startup.
 * A database newer than this build (more applied migrations than we ship) is refused.
 */
export async function runMigrations(db: Db, opts: { backupDir?: string; folder?: string } = {}) {
  const folder = opts.folder ?? migrationsFolder();
  if (!existsSync(/*turbopackIgnore: true*/ folder)) throw new Error(`migrations folder not found: ${folder}`);
  const { applied, total } = pending(db, folder);
  if (applied > total) throw new Error(`database schema (${applied}) is newer than this build (${total}); restore a compatible backup or upgrade the app`);
  if (applied === total) return { applied: 0, schemaVersion: total };
  if (applied > 0 && opts.backupDir) await backupDatabase(db, opts.backupDir, "pre-migration");
  migrate(db, { migrationsFolder: folder });
  log("info", "migrations applied", { from: applied, to: total });
  return { applied: total - applied, schemaVersion: total };
}
