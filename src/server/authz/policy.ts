import { signInMethods } from "../config";
import { schema, type Db } from "../db";
import { notFound } from "../util";

export type UserRow = typeof schema.users.$inferSelect;
export interface CameraInfo {
  id: string;
  nvrId: string;
  protectId: string;
  name: string;
  tags: string[];
  /** True when the recorder no longer reports this camera. Tags, grants and view slots are kept. */
  missing: boolean;
  meta: Record<string, unknown>;
}

/**
 * The single source of truth for "who may see which camera".
 *
 * Rules (initial implementation, intentionally small):
 *  - Deny by default. A disabled or unknown user sees nothing, and so does anyone whose sign-in
 *    method (SIGN_IN_METHODS) is turned off.
 *  - Staff: union of explicit allow grants made to the user and to every group they belong to
 *    (including the built-in "Everyone" group, flagged `is_all_staff`). There are no deny rules.
 *  - Admin: every camera known to Unifeye. This is an explicit policy, not a side effect.
 *  - Tags and view sharing never grant access.
 *
 * Every route, background job and media boundary must go through this class. Results are cached
 * in memory and dropped whenever anything that can affect them changes (`invalidate()`).
 *
 * Policy answers the question for one moment. Whether access that was already handed out (a
 * stream, a download, an event feed) still holds, and telling the holders to re-check, belongs to
 * `Access` (./access.ts), which is the only production subscriber of `onChange`.
 */
export class Policy {
  private camIds = new Map<string, ReadonlySet<string>>();
  private camInfo?: Map<string, CameraInfo>;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(private db: Db) {}

  /** Call after any write that can change who may see which camera. Drops the cache and notifies. */
  invalidate() {
    this.camIds.clear();
    this.camInfo = undefined;
    this.version++;
    for (const l of [...this.listeners]) l();
  }
  /**
   * Drops only the descriptive camera cache (name, tags, recorder metadata, missing flag). None of
   * it is an input to `cameraIds`, so no access answer can change and nobody is notified. Anything
   * that adds or removes a camera, user, grant or membership must use `invalidate()` instead.
   */
  refreshCameraInfo() {
    this.camInfo = undefined;
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  user(userId: string): UserRow | undefined {
    const u = this.db.$client
      .prepare("select id, issuer, subject, email, name, role, auth_method as authMethod, status, allow_private_views as allowPrivateViews, created_at as createdAt, updated_at as updatedAt, last_login_at as lastLoginAt, version from users where id = ?")
      .get(userId) as UserRow | undefined;
    return u ? { ...u, allowPrivateViews: !!u.allowPrivateViews } : undefined;
  }
  /**
   * The user, if they may use Unifeye right now: not disabled, and their sign-in method is turned on.
   * Every session, grant, preview and admin check goes through here, so turning a method off in
   * configuration locks its people out everywhere at once.
   */
  activeUser(userId: string): UserRow | undefined {
    const u = this.user(userId);
    return u && u.status === "active" && signInMethods()[u.authMethod] ? u : undefined;
  }
  isAdmin(userId: string) {
    return this.activeUser(userId)?.role === "admin";
  }

  /** Groups whose grants, shares and defaults apply to the user. Empty for disabled users. */
  groupIds(userId: string): string[] {
    if (!this.activeUser(userId)) return [];
    const rows = this.db.$client
      .prepare("select group_id as id from group_members where user_id = ? union select id from groups where is_all_staff = 1 order by id")
      .all(userId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  cameraIds(userId: string): ReadonlySet<string> {
    const hit = this.camIds.get(userId);
    if (hit) return hit;
    const u = this.activeUser(userId);
    let ids: Set<string>;
    if (!u) ids = new Set();
    else if (u.role === "admin") ids = new Set((this.db.$client.prepare("select id from cameras").all() as { id: string }[]).map((r) => r.id));
    else
      ids = new Set(
        (
          this.db.$client
            .prepare(
              `select camera_id as id from user_camera_grants where user_id = @u
               union
               select camera_id from group_camera_grants where group_id in
                 (select group_id from group_members where user_id = @u union select id from groups where is_all_staff = 1)`,
            )
            .all({ u: userId }) as { id: string }[]
        ).map((r) => r.id),
      );
    this.camIds.set(userId, ids);
    return ids;
  }

  /**
   * Whether the user may save clips: an administrator, or staff in at least one group that allows
   * it (the built-in "Everyone" group counts for all of them). Not cached; it is one small query.
   */
  canExportClips(userId: string) {
    const u = this.activeUser(userId);
    if (!u) return false;
    if (u.role === "admin") return true;
    return !!this.db.$client
      .prepare("select 1 from groups where can_export_clips = 1 and (is_all_staff = 1 or id in (select group_id from group_members where user_id = ?)) limit 1")
      .get(userId);
  }

  canAccessCamera(userId: string, cameraId: string) {
    return this.cameraIds(userId).has(cameraId);
  }

  private allInfo(): Map<string, CameraInfo> {
    if (this.camInfo) return this.camInfo;
    const m = new Map<string, CameraInfo>();
    const rows = this.db.$client.prepare("select id, nvr_id, protect_id, name, meta, missing_since from cameras").all() as { id: string; nvr_id: string; protect_id: string; name: string; meta: string; missing_since: number | null }[];
    for (const r of rows) m.set(r.id, { id: r.id, nvrId: r.nvr_id, protectId: r.protect_id, name: r.name, tags: [], missing: r.missing_since != null, meta: JSON.parse(r.meta || "{}") });
    const tags = this.db.$client.prepare("select ct.camera_id c, t.name n from camera_tags ct join tags t on t.id = ct.tag_id order by t.name").all() as { c: string; n: string }[];
    for (const t of tags) m.get(t.c)?.tags.push(t.n);
    return (this.camInfo = m);
  }

  /** Cameras the user may see, sorted by name then id. Nothing about other cameras is included. */
  cameras(userId: string): CameraInfo[] {
    const ids = this.cameraIds(userId), all = this.allInfo(), out: CameraInfo[] = [];
    for (const id of ids) { const c = all.get(id); if (c) out.push(c); }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /**
   * Returns the camera or throws 404. A forbidden camera is indistinguishable from one that
   * does not exist, so knowing an id reveals nothing.
   */
  camera(userId: string, cameraId: string): CameraInfo {
    const c = this.canAccessCamera(userId, cameraId) ? this.allInfo().get(cameraId) : undefined;
    if (!c) throw notFound();
    return c;
  }

  /** Internal lookups for trusted server code (sync, media path setup). Never return to a client unchecked. */
  cameraUnchecked(cameraId: string) {
    return this.allInfo().get(cameraId);
  }
  allCamerasUnchecked() {
    return [...this.allInfo().values()];
  }
}
