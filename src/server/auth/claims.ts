import { and, eq } from "drizzle-orm";
import { audit } from "../audit";
import { schema, type Db } from "../db";

/**
 * The values a claim carries: a string, an array of strings, or an object whose keys are the
 * values (the shape some providers use for roles). A dotted name such as `realm_access.roles` is
 * followed as a path when no claim has that exact name.
 */
export function claimValues(claims: Record<string, unknown>, name: string): string[] {
  let v: unknown = claims[name];
  if (v === undefined && name.includes(".")) v = name.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), claims);
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

/**
 * Records the group-claim values from a person's freshly verified ID token and applies them.
 * Returns true when a membership changed, so the caller can invalidate the policy cache.
 */
export function recordProviderGroups(db: Db, userId: string, values: string[], ctx: { ip?: string } = {}): boolean {
  const v = [...new Set(values)].sort();
  db.update(schema.users).set({ providerGroups: v }).where(eq(schema.users.id, userId)).run();
  return applyProviderGroups(db, [userId], ctx);
}

/**
 * Brings provider-synced memberships in line with each person's stored claim values and every
 * group's mapping. Only rows with source `provider` are ever removed: a membership an
 * administrator added by hand is left alone, and an existing manual member gets no second row.
 * The built-in "Everyone" group is never synced (everyone is in it already).
 * Runs on the caller's connection, so inside the caller's transaction when there is one.
 * With no `userIds`, every person is re-evaluated (used after a mapping changes).
 */
export function applyProviderGroups(db: Db, userIds?: string[], ctx: { ip?: string; actorId?: string } = {}): boolean {
  const groups = db.select().from(schema.groups).all().filter((g) => !g.isAllStaff);
  const users = (userIds ? userIds.map((id) => db.select().from(schema.users).where(eq(schema.users.id, id)).get()) : db.select().from(schema.users).all()).filter((u) => !!u);
  const members = db.select().from(schema.groupMembers).all();
  const t = Date.now();
  let changed = false;
  for (const u of users) {
    const have = new Set(u.providerGroups);
    const rows = new Map(members.filter((m) => m.userId === u.id).map((m) => [m.groupId, m]));
    for (const g of groups) {
      const want = g.providerValues.some((v) => have.has(v)), row = rows.get(g.id);
      if (want && !row) {
        db.insert(schema.groupMembers).values({ groupId: g.id, userId: u.id, source: "provider", createdAt: t }).run();
        audit(db, { actorId: ctx.actorId, action: "group.member.sync_add", targetType: "group", targetId: g.id, ip: ctx.ip, detail: { userId: u.id } });
        changed = true;
      } else if (!want && row?.source === "provider") {
        db.delete(schema.groupMembers).where(and(eq(schema.groupMembers.groupId, g.id), eq(schema.groupMembers.userId, u.id))).run();
        audit(db, { actorId: ctx.actorId, action: "group.member.sync_remove", targetType: "group", targetId: g.id, ip: ctx.ip, detail: { userId: u.id } });
        changed = true;
      }
    }
  }
  return changed;
}
