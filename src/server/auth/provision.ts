import { and, eq } from "drizzle-orm";
import { audit } from "../audit";
import { config } from "../config";
import { schema, type Db } from "../db";
import { newId } from "../util";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type UserRow = typeof schema.users.$inferSelect;

/**
 * Finds or creates the profile for an identity proven by an outside party (the identity provider or
 * Cloudflare Access), inside the caller's transaction. Identity is the exact (issuer, subject) pair;
 * email is a display attribute and is never used to find or link a profile.
 *
 *  - First sign-in creates a profile with no cameras, no groups and no administrator rights.
 *  - The first administrator is promoted once, by the exact issuer + subject from configuration.
 *  - A profile is only ever matched for the method that created it, so an `oidc` and a `cloudflare`
 *    identity can never collide even if an operator points both at the same issuer.
 *
 * Returns the row and whether anything Policy caches changed (new profile or promotion).
 */
export function provisionExternal(tx: Tx, db: Db, id: { method: "oidc" | "cloudflare"; issuer: string; subject: string; name: string; email: string | null }, ip?: string): { user: UserRow; changed: boolean } {
  const c = config(), t = Date.now();
  let changed = false;
  let u = tx.select().from(schema.users).where(and(eq(schema.users.issuer, id.issuer), eq(schema.users.subject, id.subject))).get();
  if (u && u.authMethod !== id.method) throw Object.assign(new Error("identity belongs to another sign-in method"), { reason: "method_mismatch" });
  if (!u) {
    const row: UserRow = { id: newId(), issuer: id.issuer, subject: id.subject, email: id.email, name: id.name, role: "staff", authMethod: id.method, status: "active", allowPrivateViews: false, providerGroups: [], createdAt: t, updatedAt: t, lastLoginAt: null, version: 1 };
    tx.insert(schema.users).values(row).run();
    u = row;
    changed = true;
    audit(db, { actorId: u.id, action: "user.provisioned", targetType: "user", targetId: u.id, ip, detail: { method: id.method } });
  }
  const done = tx.select().from(schema.settings).where(eq(schema.settings.key, "bootstrap_admin_done")).get();
  if (!done && c.BOOTSTRAP_ADMIN_ISSUER === id.issuer && c.BOOTSTRAP_ADMIN_SUBJECT === id.subject) {
    tx.update(schema.users).set({ role: "admin", updatedAt: t }).where(eq(schema.users.id, u.id)).run();
    tx.insert(schema.settings).values({ key: "bootstrap_admin_done", value: { userId: u.id, at: t }, updatedAt: t }).run();
    audit(db, { actorId: u.id, action: "admin.bootstrap", targetType: "user", targetId: u.id, ip });
    u = { ...u, role: "admin" };
    changed = true;
  }
  tx.update(schema.users).set({ name: id.name || u.name, email: id.email, lastLoginAt: t, updatedAt: t }).where(eq(schema.users.id, u.id)).run();
  return { user: u, changed };
}
