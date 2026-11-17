import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "./audit";
import { applyProviderGroups } from "./auth/claims";
import { insertLocalUser, issuePasswordLink, usernameSchema } from "./auth/local";
import type { Sessions } from "./auth/session";
import { subjectOf, type Actor } from "./authz/actor";
import type { Policy } from "./authz/policy";
import type { Views, ViewRow } from "./authz/views";
import { config, groupsClaim, signInMethods } from "./config";
import { schema, type Db } from "./db";
import { badRequest, conflict, encrypt, forbidden, newId, notFound } from "./util";

const S = schema;
const tagName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_]{0,39}$/, "Tags can only use lowercase letters, numbers and underscores.");
const name = z.string().trim().min(1, "Enter a name.").max(80, "Names can be up to 80 characters.");
const providerValues = z.array(z.string().trim().max(200, "Values can be up to 200 characters.")).max(50, "A group can match up to 50 values.").transform((v) => [...new Set(v.filter(Boolean))]);
const viewInput = z.object({
  name,
  type: z.enum(["dynamic", "static"]),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  tagIds: z.array(z.string()).max(20).default([]),
  cameraIds: z.array(z.string()).max(64).default([]),
});
export type ViewInput = z.input<typeof viewInput>;

/**
 * Every change to Unifeye-owned data goes through this class. Each method:
 *  refuses to run during a staff preview, checks the caller's role on the server,
 *  validates input, writes inside a transaction, records an audit entry, and
 *  invalidates the permission cache so the change reaches open sessions and streams.
 * Nothing here talks to UniFi Protect.
 */
export class Admin {
  constructor(private db: Db, private policy: Policy, private views: Views, private sessions: Sessions) {}

  private writable(a: Actor) {
    if (a.preview) {
      audit(this.db, { actorId: a.userId, previewSubjectId: a.preview.subjectId, action: "preview.mutation", outcome: "denied", requestId: a.requestId });
      throw forbidden("preview_read_only");
    }
    if (!this.policy.activeUser(a.userId)) throw forbidden();
  }
  private admin(a: Actor, action: string) {
    this.writable(a);
    if (!this.policy.isAdmin(a.userId)) {
      audit(this.db, { actorId: a.userId, action, outcome: "denied", requestId: a.requestId, ip: a.ip });
      throw forbidden();
    }
  }
  private log(a: Actor, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>) {
    audit(this.db, { actorId: a.userId, action, targetType, targetId, detail, requestId: a.requestId, ip: a.ip });
  }
  private done() {
    this.policy.invalidate();
  }

  // ---- tags -------------------------------------------------------------
  createTag(a: Actor, raw: string) {
    this.admin(a, "tag.create");
    const n = tagName.parse(raw), id = newId();
    try { this.db.insert(S.tags).values({ id, name: n, createdAt: Date.now() }).run(); } catch { throw conflict("That tag already exists."); }
    this.log(a, "tag.create", "tag", id, { name: n });
    this.done();
    return { id, name: n };
  }
  renameTag(a: Actor, id: string, raw: string) {
    this.admin(a, "tag.rename");
    const n = tagName.parse(raw);
    try { if (!this.db.update(S.tags).set({ name: n }).where(eq(S.tags.id, id)).run().changes) throw notFound(); } catch (e) { if ((e as { status?: number }).status) throw e; throw conflict("That tag already exists."); }
    this.log(a, "tag.rename", "tag", id, { name: n });
    this.done();
  }
  /** Refused while a dynamic view depends on the tag, so no view widens silently. */
  deleteTag(a: Actor, id: string) {
    this.admin(a, "tag.delete");
    const used = this.db.$client.prepare("select v.name from view_predicate_tags p join views v on v.id = p.view_id where p.tag_id = ?").all(id) as { name: string }[];
    if (used.length) throw conflict(`This tag is used by ${used.map((u) => u.name).join(", ")}. Remove it from there first.`);
    if (!this.db.delete(S.tags).where(eq(S.tags.id, id)).run().changes) throw notFound();
    this.log(a, "tag.delete", "tag", id);
    this.done();
  }
  setCameraTag(a: Actor, cameraId: string, tagId: string, on: boolean) {
    this.admin(a, "camera.tag");
    if (on) this.db.insert(S.cameraTags).values({ cameraId, tagId }).onConflictDoNothing().run();
    else this.db.delete(S.cameraTags).where(and(eq(S.cameraTags.cameraId, cameraId), eq(S.cameraTags.tagId, tagId))).run();
    this.log(a, on ? "camera.tag" : "camera.untag", "camera", cameraId, { tagId });
    this.done();
  }

  /**
   * Reads a camera's live video from the camera itself instead of the recorder, optionally with its own
   * login. `password`: undefined keeps the saved one, null or "" goes back to the default. The caller
   * checks the camera accepts the login first (`Media`); nothing here talks to the camera or the recorder.
   */
  setCameraDirect(a: Actor, cameraId: string, input: { enabled: boolean; username?: string | null; password?: string | null }) {
    this.admin(a, "camera.direct");
    if (!this.db.select({ id: S.cameras.id }).from(S.cameras).where(eq(S.cameras.id, cameraId)).get()) throw notFound();
    const v = z.object({
      enabled: z.boolean(),
      username: z.string().trim().max(64, "Usernames can be up to 64 characters.").nullish(),
      password: z.string().max(128, "Passwords can be up to 128 characters.").nullish(),
    }).parse(input);
    const key = config().TOKEN_ENC_KEY;
    if (v.password && !key) throw badRequest("Unifeye can't save camera passwords until TOKEN_ENC_KEY is set on the server.");
    const cur = this.db.select().from(S.cameraDirect).where(eq(S.cameraDirect.cameraId, cameraId)).get();
    const row = {
      cameraId, enabled: v.enabled, updatedAt: Date.now(),
      username: v.username !== undefined ? v.username || null : cur?.username ?? null,
      passwordEnc: v.password ? encrypt(v.password, key!) : v.password === undefined ? cur?.passwordEnc ?? null : null,
    };
    this.db.insert(S.cameraDirect).values(row).onConflictDoUpdate({ target: S.cameraDirect.cameraId, set: row }).run();
    // Never the password, not even its length.
    this.log(a, "camera.direct", "camera", cameraId, { enabled: row.enabled, ownLogin: !!row.username || !!row.passwordEnc });
    this.done();
  }

  // ---- groups -----------------------------------------------------------
  createGroup(a: Actor, raw: string) {
    this.admin(a, "group.create");
    const id = newId(), n = name.parse(raw);
    try { this.db.insert(S.groups).values({ id, name: n, createdAt: Date.now() }).run(); } catch { throw conflict("A group with that name already exists."); }
    this.log(a, "group.create", "group", id, { name: n });
    this.done();
    return { id, name: n };
  }
  updateGroup(a: Actor, id: string, patch: { name?: string; defaultPriority?: number; providerValues?: string[] }) {
    this.admin(a, "group.update");
    const set: Partial<typeof S.groups.$inferInsert> = {};
    if (patch.name != null) set.name = name.parse(patch.name);
    if (patch.defaultPriority != null) set.defaultPriority = z.number().int().min(-1000).max(1000).parse(patch.defaultPriority);
    if (patch.providerValues != null) {
      if (!groupsClaim()) throw badRequest("Group sync is off. Set OIDC_GROUPS_CLAIM to turn it on.");
      const g = this.db.select().from(S.groups).where(eq(S.groups.id, id)).get();
      if (!g) throw notFound();
      if (g.isAllStaff) throw badRequest("Everyone is already in this group.");
      set.providerValues = providerValues.parse(patch.providerValues);
    }
    this.db.transaction(() => {
      try { if (!this.db.update(S.groups).set({ ...set, version: sql`${S.groups.version} + 1` }).where(eq(S.groups.id, id)).run().changes) throw notFound(); } catch (e) { if ((e as { status?: number }).status) throw e; throw conflict("A group with that name already exists."); }
      // A new mapping applies at once, from the values each person's last sign-in or re-check reported.
      if (set.providerValues) applyProviderGroups(this.db, undefined, { actorId: a.userId, ip: a.ip });
    }, { behavior: "immediate" });
    this.log(a, "group.update", "group", id, set);
    this.done();
  }
  deleteGroup(a: Actor, id: string) {
    this.admin(a, "group.delete");
    const g = this.db.select().from(S.groups).where(eq(S.groups.id, id)).get();
    if (!g) throw notFound();
    if (g.isAllStaff) throw badRequest("This group can't be deleted.");
    this.db.delete(S.groups).where(eq(S.groups.id, id)).run(); // grants, shares, defaults and memberships cascade
    this.log(a, "group.delete", "group", id, { name: g.name });
    this.done();
  }
  setMember(a: Actor, groupId: string, userId: string, on: boolean) {
    this.admin(a, "group.member");
    const where = and(eq(S.groupMembers.groupId, groupId), eq(S.groupMembers.userId, userId));
    const row = this.db.select().from(S.groupMembers).where(where).get();
    // A synced membership belongs to the provider while sync is on: remove the person from the group there.
    if (!on && row?.source === "provider" && groupsClaim()) throw badRequest("This person is in the group through your sign-in provider. Remove them from the matching group there.");
    // Adding someone who is only synced makes the membership manual, so it survives a change at the provider.
    if (on) this.db.insert(S.groupMembers).values({ groupId, userId, source: "manual", createdAt: Date.now() }).onConflictDoUpdate({ target: [S.groupMembers.groupId, S.groupMembers.userId], set: { source: "manual" } }).run();
    else this.db.delete(S.groupMembers).where(where).run();
    this.log(a, on ? "group.member.add" : "group.member.remove", "group", groupId, { userId });
    this.done();
  }

  // ---- users (application access only; identities live in the identity provider) -------
  updateUser(a: Actor, userId: string, patch: { role?: "admin" | "staff"; status?: "active" | "disabled"; allowPrivateViews?: boolean }) {
    this.admin(a, "user.update");
    const p = z.object({ role: z.enum(["admin", "staff"]).optional(), status: z.enum(["active", "disabled"]).optional(), allowPrivateViews: z.boolean().optional() }).parse(patch);
    this.db.transaction((tx) => {
      const u = tx.select().from(S.users).where(eq(S.users.id, userId)).get();
      if (!u) throw notFound();
      const losesAdmin = u.role === "admin" && u.status === "active" && ((p.role && p.role !== "admin") || p.status === "disabled");
      if (losesAdmin) {
        if (userId === a.userId) throw badRequest("You can't remove your own admin access.");
        const admins = (this.db.$client.prepare("select count(*) c from users where role = 'admin' and status = 'active'").get() as { c: number }).c;
        if (admins <= 1) throw badRequest("There must be at least one administrator.");
      }
      tx.update(S.users).set({ ...p, updatedAt: Date.now(), version: sql`${S.users.version} + 1` }).where(eq(S.users.id, userId)).run();
      if (p.allowPrivateViews === false) tx.delete(S.defaultViews).where(and(eq(S.defaultViews.userId, userId), eq(S.defaultViews.scope, "personal"))).run();
    }, { behavior: "immediate" });
    this.log(a, "user.update", "user", userId, p);
    // Disabling or changing privilege ends existing sessions, previews, downloads and streams.
    if (p.status === "disabled") this.sessions.revokeUser(userId, "user_disabled");
    else if (p.role) this.sessions.revokeUser(userId, "role_changed");
    this.done();
  }

  // ---- password accounts --------------------------------------------------
  /**
   * Adds a person who signs in with a username and password. The account has no password until the
   * person opens the returned one-time link and chooses one; the administrator never sees it.
   */
  createPasswordUser(a: Actor, input: { name?: unknown; username?: unknown; role?: unknown }) {
    this.admin(a, "user.create");
    if (!signInMethods().local) throw badRequest("Passwords are turned off.");
    const p = z.object({ name, username: usernameSchema, role: z.enum(["admin", "staff"]).default("staff") }).parse(input);
    const out = this.db.transaction((tx) => {
      const id = insertLocalUser(tx, p);
      return { id, link: issuePasswordLink(tx, id, a.userId) };
    }, { behavior: "immediate" });
    this.log(a, "user.create", "user", out.id, { username: p.username, role: p.role });
    this.done();
    return out;
  }
  /** A new one-time password link. The current password keeps working until the link is used. */
  passwordLink(a: Actor, userId: string) {
    this.admin(a, "user.password_link");
    if (!signInMethods().local) throw badRequest("Passwords are turned off.");
    const out = this.db.transaction((tx) => {
      if (!tx.select().from(S.localCredentials).where(eq(S.localCredentials.userId, userId)).get()) throw notFound();
      return issuePasswordLink(tx, userId, a.userId);
    }, { behavior: "immediate" });
    this.log(a, "user.password_link", "user", userId);
    return { link: out };
  }

  // ---- camera grants ----------------------------------------------------
  setGrant(a: Actor, subject: { userId: string } | { groupId: string }, cameraId: string, on: boolean) {
    this.admin(a, "grant.set");
    if (!this.policy.cameraUnchecked(cameraId)) throw notFound();
    if ("userId" in subject) {
      if (on) this.db.insert(S.userCameraGrants).values({ userId: subject.userId, cameraId, createdAt: Date.now() }).onConflictDoNothing().run();
      else this.db.delete(S.userCameraGrants).where(and(eq(S.userCameraGrants.userId, subject.userId), eq(S.userCameraGrants.cameraId, cameraId))).run();
    } else {
      if (on) this.db.insert(S.groupCameraGrants).values({ groupId: subject.groupId, cameraId, createdAt: Date.now() }).onConflictDoNothing().run();
      else this.db.delete(S.groupCameraGrants).where(and(eq(S.groupCameraGrants.groupId, subject.groupId), eq(S.groupCameraGrants.cameraId, cameraId))).run();
    }
    this.log(a, on ? "grant.add" : "grant.revoke", "camera", cameraId, subject);
    this.done();
  }

  // ---- views ------------------------------------------------------------
  /** A private view may reference only cameras its owner is allowed to see. */
  private checkRefs(a: Actor, v: z.infer<typeof viewInput>) {
    if (v.type === "dynamic") {
      if (v.cameraIds.length) throw badRequest("A view that follows tags cannot also list cameras");
      const found = v.tagIds.length ? this.db.select({ id: S.tags.id }).from(S.tags).where(inArray(S.tags.id, v.tagIds)).all().length : 0;
      if (found !== new Set(v.tagIds).size) throw badRequest("Unknown tag");
    } else {
      if (v.tagIds.length) throw badRequest("A fixed-list view cannot also have a tag rule");
      if (new Set(v.cameraIds).size !== v.cameraIds.length) throw badRequest("A camera can appear only once");
      for (const id of v.cameraIds) if (!this.policy.canAccessCamera(a.userId, id)) throw notFound();
    }
  }
  private writeMembers(tx: Db, viewId: string, v: z.infer<typeof viewInput>) {
    tx.delete(S.viewPredicateTags).where(eq(S.viewPredicateTags.viewId, viewId)).run();
    tx.delete(S.viewCameras).where(eq(S.viewCameras.viewId, viewId)).run();
    if (v.type === "dynamic") for (const tagId of new Set(v.tagIds)) tx.insert(S.viewPredicateTags).values({ viewId, tagId }).run();
    else v.cameraIds.forEach((cameraId, position) => tx.insert(S.viewCameras).values({ viewId, cameraId, position }).run());
  }
  createView(a: Actor, input: ViewInput, visibility: "private" | "curated"): ViewRow {
    this.writable(a);
    const u = this.policy.activeUser(a.userId)!;
    if (visibility === "curated" ? u.role !== "admin" : u.role !== "admin" && !u.allowPrivateViews) {
      audit(this.db, { actorId: a.userId, action: "view.create", outcome: "denied", requestId: a.requestId });
      throw forbidden();
    }
    const v = viewInput.parse(input), id = newId(), t = Date.now();
    this.checkRefs(a, v);
    this.db.transaction((tx) => {
      tx.insert(S.views).values({ id, name: v.name, ownerId: a.userId, visibility, type: v.type, columns: v.columns, createdAt: t, updatedAt: t }).run();
      this.writeMembers(tx as unknown as Db, id, v);
    });
    this.log(a, "view.create", "view", id, { name: v.name, type: v.type, visibility });
    this.done();
    return this.views.get(id)!;
  }
  /**
   * Replaces the definition. `expectedVersion` guards against two people editing at once:
   * the second save gets a 409 instead of silently overwriting the first.
   * Changing `type` is an explicit conversion requested by the caller, never automatic.
   */
  updateView(a: Actor, viewId: string, input: ViewInput, expectedVersion: number) {
    this.writable(a);
    const cur = this.views.get(viewId);
    if (!cur || !this.views.canOpen(a.userId, viewId)) throw notFound();
    if (!this.views.canEdit(a.userId, cur)) throw forbidden();
    const v = viewInput.parse(input);
    this.checkRefs(a, v);
    this.db.transaction((tx) => {
      const n = tx.update(S.views).set({ name: v.name, type: v.type, columns: v.columns, updatedAt: Date.now(), version: sql`${S.views.version} + 1` }).where(and(eq(S.views.id, viewId), eq(S.views.version, expectedVersion))).run().changes;
      if (!n) throw conflict("Someone else changed this view. Reload and try again.");
      this.writeMembers(tx as unknown as Db, viewId, v);
    }, { behavior: "immediate" });
    this.log(a, cur.type === v.type ? "view.update" : "view.convert", "view", viewId, { name: v.name, type: v.type });
    this.done();
  }
  deleteView(a: Actor, viewId: string) {
    this.writable(a);
    const cur = this.views.get(viewId);
    if (!cur || !this.views.canOpen(a.userId, viewId)) throw notFound();
    if (!this.views.canEdit(a.userId, cur)) throw forbidden();
    this.db.delete(S.views).where(eq(S.views.id, viewId)).run(); // shares and default assignments cascade; landing falls back
    this.log(a, "view.delete", "view", viewId, { name: cur.name });
    this.done();
  }
  /** Sharing grants permission to open the definition only. Staff cannot share. */
  setSharing(a: Actor, viewId: string, s: { all: boolean; userIds: string[]; groupIds: string[] }) {
    this.admin(a, "view.share");
    const cur = this.views.get(viewId);
    if (!cur) throw notFound();
    if (cur.visibility !== "curated") throw badRequest("Private views can't be shared.");
    const t = Date.now();
    this.db.transaction((tx) => {
      tx.update(S.views).set({ sharedWithAll: s.all, updatedAt: t }).where(eq(S.views.id, viewId)).run();
      tx.delete(S.viewUserShares).where(eq(S.viewUserShares.viewId, viewId)).run();
      tx.delete(S.viewGroupShares).where(eq(S.viewGroupShares.viewId, viewId)).run();
      for (const userId of new Set(s.userIds)) tx.insert(S.viewUserShares).values({ viewId, userId, createdAt: t }).run();
      for (const groupId of new Set(s.groupIds)) tx.insert(S.viewGroupShares).values({ viewId, groupId, createdAt: t }).run();
    }, { behavior: "immediate" });
    this.log(a, "view.share", "view", viewId, { all: s.all, users: s.userIds.length, groups: s.groupIds.length });
    this.done();
  }

  // ---- landing defaults ---------------------------------------------------
  /**
   * Assigns or clears (viewId = null) a landing view. Validated now and again at every sign-in:
   *  org      - curated view shared with all staff
   *  group    - curated view shared with that group (or with all staff)
   *  user     - any view that person can open
   *  personal - set by the person themself, from views they can open, when personal views are enabled
   */
  setDefault(a: Actor, target: { scope: "org" } | { scope: "group"; groupId: string } | { scope: "user"; userId: string } | { scope: "personal" }, viewId: string | null) {
    if (target.scope === "personal") this.writable(a); else this.admin(a, "default.set");
    const scope = target.scope, userId = scope === "user" ? target.userId : scope === "personal" ? a.userId : null, groupId = scope === "group" ? target.groupId : null;
    if (viewId) {
      const v = this.views.get(viewId);
      if (!v) throw notFound();
      if (scope === "org" && !(v.visibility === "curated" && v.sharedWithAll)) throw badRequest("Share this view with everyone first.");
      if (scope === "group") {
        const shared = v.visibility === "curated" && (v.sharedWithAll || !!this.db.select().from(S.viewGroupShares).where(and(eq(S.viewGroupShares.viewId, viewId), eq(S.viewGroupShares.groupId, groupId!))).get());
        if (!shared) throw badRequest("Share this view with the group first.");
      }
      if (scope === "user" && !this.views.canOpen(userId!, viewId)) throw badRequest("Share this view with them first.");
      if (scope === "personal") {
        const u = this.policy.activeUser(a.userId)!;
        if (u.role !== "admin" && !u.allowPrivateViews) throw forbidden();
        if (!this.views.canOpen(a.userId, viewId)) throw notFound();
      }
    }
    this.db.transaction((tx) => {
      const where = scope === "org" ? eq(S.defaultViews.scope, "org") : scope === "group" ? and(eq(S.defaultViews.scope, "group"), eq(S.defaultViews.groupId, groupId!)) : and(eq(S.defaultViews.scope, scope), eq(S.defaultViews.userId, userId!));
      tx.delete(S.defaultViews).where(where).run();
      if (viewId) tx.insert(S.defaultViews).values({ id: newId(), scope, userId, groupId, viewId, createdBy: a.userId, createdAt: Date.now() }).run();
    }, { behavior: "immediate" });
    this.log(a, "default.set", scope, userId ?? groupId ?? "org", { viewId });
    this.done();
  }

  // ---- preferences --------------------------------------------------------
  setPreference(a: Actor, key: string, value: unknown) {
    this.writable(a); // refused during preview: the subject's preferences are never touched
    const k = z.string().regex(/^[a-z][a-zA-Z0-9_.:-]{0,80}$/).parse(key);
    if (JSON.stringify(value).length > 2000) throw badRequest("Preference too large");
    this.db.insert(S.userPreferences).values({ userId: a.userId, key: k, value, updatedAt: Date.now() }).onConflictDoUpdate({ target: [S.userPreferences.userId, S.userPreferences.key], set: { value, updatedAt: Date.now() } }).run();
  }
  preferences(a: Actor): Record<string, unknown> {
    const rows = this.db.select().from(S.userPreferences).where(eq(S.userPreferences.userId, subjectOf(a))).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
