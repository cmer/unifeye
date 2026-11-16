import { schema, type Db } from "../db";
import type { CameraInfo, Policy } from "./policy";

export type ViewRow = typeof schema.views.$inferSelect;
export interface ResolvedView {
  id: string;
  name: string;
  type: "dynamic" | "static";
  visibility: "private" | "curated";
  columns: number;
  /** Dynamic views only: the tag names every camera must carry. */
  tags: string[];
  /** Only cameras the viewer is allowed to see, in display order. */
  cameras: CameraInfo[];
  editable: boolean;
}
export type LandingReason = "user" | "group" | "personal" | "org" | "wall" | "none";
export interface Landing { viewId: string | null; reason: LandingReason; groupId?: string }

const VIEW_COLS = "id, name, owner_id as ownerId, visibility, type, columns, shared_with_all as sharedWithAll, created_at as createdAt, updated_at as updatedAt, version";
const fix = (v: ViewRow): ViewRow => ({ ...v, sharedWithAll: !!v.sharedWithAll });

/**
 * Saved views. Two rules matter above all:
 *  1. Being able to open a view never grants a camera. The cameras shown are always
 *     (what the view selects) ∩ (what the viewer's grants allow), computed on every request.
 *  2. What a non-owner receives is sanitized: no ids, names or counts of cameras they cannot see.
 */
export class Views {
  constructor(private db: Db, private policy: Policy) {}

  get(viewId: string): ViewRow | undefined {
    const v = this.db.$client.prepare(`select ${VIEW_COLS} from views where id = ?`).get(viewId) as ViewRow | undefined;
    return v && fix(v);
  }

  /** Views the user may open, sorted by name. Individual and group shares never produce duplicates. */
  accessible(userId: string): ViewRow[] {
    const u = this.policy.activeUser(userId);
    if (!u) return [];
    const rows =
      u.role === "admin"
        ? (this.db.$client.prepare(`select ${VIEW_COLS} from views where visibility = 'curated' or owner_id = ? order by name, id`).all(userId) as ViewRow[])
        : (this.db.$client
            .prepare(
              `select ${VIEW_COLS} from views v where
                 (v.visibility = 'private' and v.owner_id = @u)
                 or (v.visibility = 'curated' and (
                   v.shared_with_all = 1
                   or exists (select 1 from view_user_shares s where s.view_id = v.id and s.user_id = @u)
                   or exists (select 1 from view_group_shares s where s.view_id = v.id and s.group_id in
                     (select group_id from group_members where user_id = @u union select id from groups where is_all_staff = 1))))
               order by name, id`,
            )
            .all({ u: userId }) as ViewRow[]);
    return rows.map(fix);
  }

  canOpen(userId: string, viewId: string): ViewRow | undefined {
    return this.accessible(userId).find((v) => v.id === viewId);
  }

  /** Who may change the definition: admins for curated views, owners for their private views (when allowed). */
  canEdit(userId: string, v: ViewRow): boolean {
    const u = this.policy.activeUser(userId);
    if (!u) return false;
    if (v.visibility === "curated") return u.role === "admin";
    return v.ownerId === u.id && (u.role === "admin" || u.allowPrivateViews);
  }

  predicateTags(viewId: string): { id: string; name: string }[] {
    return this.db.$client.prepare("select t.id, t.name from view_predicate_tags p join tags t on t.id = p.tag_id where p.view_id = ? order by t.name").all(viewId) as { id: string; name: string }[];
  }
  staticCameraIds(viewId: string): string[] {
    return (this.db.$client.prepare("select camera_id as id from view_cameras where view_id = ? order by position, camera_id").all(viewId) as { id: string }[]).map((r) => r.id);
  }

  /** Membership is recomputed from current tags, inventory and grants every time. */
  resolve(v: ViewRow, userId: string): ResolvedView {
    const allowed = this.policy.cameras(userId);
    let cameras: CameraInfo[];
    let tags: string[] = [];
    if (v.type === "dynamic") {
      tags = this.predicateTags(v.id).map((t) => t.name);
      cameras = allowed.filter((c) => tags.every((t) => c.tags.includes(t))); // already sorted by name, id
    } else {
      const byId = new Map(allowed.map((c) => [c.id, c]));
      cameras = this.staticCameraIds(v.id).flatMap((id) => byId.get(id) ?? []);
    }
    return { id: v.id, name: v.name, type: v.type, visibility: v.visibility, columns: v.columns, tags, cameras, editable: this.canEdit(userId, v) };
  }

  /**
   * Landing-view precedence (first accessible match wins):
   *  1. individual default assigned by an administrator
   *  2. group default: highest `default_priority`, ties broken by the lower group id
   *  3. the user's own choice, when personal views are enabled for them
   *  4. organization default
   *  5. the authorized camera wall (`wall`), or `none` when the user has no cameras
   * A default that points to a view the user can no longer open is skipped, never shown.
   */
  landing(userId: string): Landing {
    const u = this.policy.activeUser(userId);
    if (!u) return { viewId: null, reason: "none" };
    const open = new Set(this.accessible(userId).map((v) => v.id));
    const one = (scope: string) => (this.db.$client.prepare("select view_id as v from default_views where scope = ? and user_id = ?").get(scope, userId) as { v: string } | undefined)?.v;
    const mine = one("user");
    if (mine && open.has(mine)) return { viewId: mine, reason: "user" };
    const groups = this.policy.groupIds(userId);
    if (groups.length) {
      const rows = this.db.$client
        .prepare(`select d.view_id as v, g.id as g from default_views d join groups g on g.id = d.group_id where d.scope = 'group' and g.id in (${groups.map(() => "?").join(",")}) order by g.default_priority desc, g.id asc`)
        .all(...groups) as { v: string; g: string }[];
      for (const r of rows) if (open.has(r.v)) return { viewId: r.v, reason: "group", groupId: r.g };
    }
    if (u.allowPrivateViews || u.role === "admin") {
      const p = one("personal");
      if (p && open.has(p)) return { viewId: p, reason: "personal" };
    }
    const org = (this.db.$client.prepare("select view_id as v from default_views where scope = 'org'").get() as { v: string } | undefined)?.v;
    if (org && open.has(org)) return { viewId: org, reason: "org" };
    return { viewId: null, reason: this.policy.cameraIds(userId).size ? "wall" : "none" };
  }
}
