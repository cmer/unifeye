/**
 * Operations commands. In the container: `node cli.mjs <command>`; locally: `pnpm vantage <command>`.
 *   migrate            apply pending migrations (backs up first when upgrading an existing database)
 *   backup             write a verified, consistent backup to BACKUP_DIR
 *   verify <file>      integrity-check a backup and print its schema version
 *   restore <file> [--force]   restore a backup into DATABASE_PATH (stop the app first)
 */
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { backupDatabase, pruneBackups, verifyDatabaseFile } from "../src/server/db/backup";
import { runMigrations } from "../src/server/db/migrate";
import { restoreDatabase } from "../src/server/ops/restore";

const [cmd, ...args] = process.argv.slice(2);
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === "production" ? "development" : process.env.NODE_ENV } as NodeJS.ProcessEnv; // paths only; sign-in settings are not needed here
const c = loadConfig(env);

const main = async () => {
  if (cmd === "migrate") { const db = openDb(c.DATABASE_PATH); console.log(JSON.stringify(await runMigrations(db, { backupDir: c.BACKUP_DIR }))); db.$client.close(); }
  else if (cmd === "backup") { const db = openDb(c.DATABASE_PATH); console.log(JSON.stringify(await backupDatabase(db, c.BACKUP_DIR, "manual"))); pruneBackups(c.BACKUP_DIR, c.BACKUP_RETENTION_DAYS); db.$client.close(); }
  else if (cmd === "verify" && args[0]) console.log(JSON.stringify({ ok: true, ...verifyDatabaseFile(args[0]) }));
  else if (cmd === "restore" && args[0]) console.log(JSON.stringify(await restoreDatabase(args[0], c.DATABASE_PATH, { force: args.includes("--force") })));
  else { console.error("usage: vantage migrate | backup | verify <file> | restore <file> [--force]"); process.exit(2); }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
