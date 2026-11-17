import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export { schema };

/**
 * One process, one connection. SQLite runs in WAL mode with foreign keys on.
 * This deployment supports a single application instance on a local filesystem;
 * do not share the database file between replicas or over a network filesystem.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");
  return drizzle({ client, schema }) as Db;
}

const g = globalThis as unknown as { __unifeyeDb?: Db };
export function db(): Db {
  return (g.__unifeyeDb ??= openDb(config().DATABASE_PATH));
}
export function setDbForTests(d: Db | undefined) {
  g.__unifeyeDb = d;
}
