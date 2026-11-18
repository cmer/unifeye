/**
 * Operations commands. In the container: `node cli.mjs <command>`; locally: `pnpm unifeye <command>`.
 *   migrate            apply pending migrations (backs up first when upgrading an existing database)
 *   backup             write a verified, consistent backup to BACKUP_DIR
 *   verify <file>      integrity-check a backup and print its schema version
 *   restore <file> [--force]   restore a backup into DATABASE_PATH (stop the app first)
 *   users              list people, with how they sign in and the issuer and subject that identify them
 *   create-admin <username> [name]   add an administrator who signs in with a password; prints a one-time link
 *   password-link <username>         print a new one-time password link for a password account (turns password sign-in on if it was off)
 * The last two need SIGN_IN_METHODS to include `local`. Links last 24 hours and are shown once.
 */
import { eq } from "drizzle-orm";
import { audit } from "../src/server/audit";
import { insertLocalUser, issuePasswordLink, usernameSchema } from "../src/server/auth/local";
import { loadConfig, setConfigForTests, signInMethods } from "../src/server/config";
import { openDb, schema } from "../src/server/db";
import { backupDatabase, pruneBackups, verifyDatabaseFile } from "../src/server/db/backup";
import { runMigrations } from "../src/server/db/migrate";
import { restoreDatabase } from "../src/server/ops/restore";

const [cmd, ...args] = process.argv.slice(2);
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === "production" ? "development" : process.env.NODE_ENV } as NodeJS.ProcessEnv; // paths only; sign-in settings are not needed here
const c = loadConfig(env);
setConfigForTests(c); // password links are built from APP_URL / LOCAL_APP_URL

const main = async () => {
  if (cmd === "migrate") { const db = openDb(c.DATABASE_PATH); console.log(JSON.stringify(await runMigrations(db, { backupDir: c.BACKUP_DIR }))); db.$client.close(); }
  else if (cmd === "backup") { const db = openDb(c.DATABASE_PATH); console.log(JSON.stringify(await backupDatabase(db, c.BACKUP_DIR, "manual"))); pruneBackups(c.BACKUP_DIR, c.BACKUP_RETENTION_DAYS); db.$client.close(); }
  else if (cmd === "verify" && args[0]) console.log(JSON.stringify({ ok: true, ...verifyDatabaseFile(args[0]) }));
  else if (cmd === "restore" && args[0]) console.log(JSON.stringify(await restoreDatabase(args[0], c.DATABASE_PATH, { force: args.includes("--force") })));
  else if (cmd === "users") {
    const db = openDb(c.DATABASE_PATH);
    const names = new Map(db.select().from(schema.localCredentials).all().map((x) => [x.userId, x.username]));
    for (const u of db.select().from(schema.users).all()) console.log([u.role, u.status, u.authMethod, names.get(u.id) ?? u.email ?? "-", u.name || "-", u.issuer, u.subject].join("\t"));
    db.$client.close();
  }
  else if ((cmd === "create-admin" || cmd === "password-link") && args[0]) {
    if (!signInMethods(c).local) throw new Error("Passwords are turned off. Add local to SIGN_IN_METHODS first.");
    const username = usernameSchema.parse(args[0]), db = openDb(c.DATABASE_PATH);
    const link = db.transaction((tx) => {
      let userId: string;
      if (cmd === "create-admin") {
        userId = insertLocalUser(tx, { name: args.slice(1).join(" ").trim().slice(0, 80) || username, username, role: "admin" });
        audit(db, { action: "user.create", targetType: "user", targetId: userId, detail: { username, role: "admin", via: "cli" } });
      } else {
        const cred = tx.select().from(schema.localCredentials).where(eq(schema.localCredentials.username, username)).get();
        if (!cred) throw new Error(`No password account named ${username}.`);
        userId = cred.userId;
        // The operator's way back in, so it also turns password sign-in on for an email-code-only account.
        if (!cred.passwordAllowed) tx.update(schema.localCredentials).set({ passwordAllowed: true }).where(eq(schema.localCredentials.userId, userId)).run();
        audit(db, { action: "user.password_link", targetType: "user", targetId: userId, detail: { via: "cli", ...(cred.passwordAllowed ? {} : { passwordTurnedOn: true }) } });
      }
      return issuePasswordLink(tx, userId, null);
    }, { behavior: "immediate" });
    db.$client.close();
    console.log(`Open this link within 24 hours to choose a password for ${username}:\n${link.url}`);
  }
  else { console.error("usage: unifeye migrate | backup | verify <file> | restore <file> [--force] | users | create-admin <username> [name] | password-link <username>"); process.exit(2); }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
