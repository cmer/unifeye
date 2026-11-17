import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Unifeye owns everything in this file. Protect stays authoritative for cameras, video and events;
 * the `cameras` table holds only stable references plus a disposable metadata cache.
 * There are deliberately no credential or password tables: OIDC is the only way to sign in.
 */
const id = () => text("id").primaryKey();
const ts = (name: string) => integer(name, { mode: "number" }); // UTC milliseconds

export const users = sqliteTable(
  "users",
  {
    id: id(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"), // profile attribute only, never an identity key
    name: text("name").notNull().default(""),
    role: text("role", { enum: ["admin", "staff"] }).notNull().default("staff"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    allowPrivateViews: integer("allow_private_views", { mode: "boolean" }).notNull().default(false),
    /** The group-claim values from this person's latest verified ID token, kept so a mapping change applies at once. */
    providerGroups: text("provider_groups", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    lastLoginAt: ts("last_login_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => [uniqueIndex("users_issuer_subject").on(t.issuer, t.subject), check("users_role", sql`${t.role} in ('admin','staff')`), check("users_status", sql`${t.status} in ('active','disabled')`)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(), // sha-256 of the opaque cookie value
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerSid: text("provider_sid"), // provider `sid`, for back-channel logout
    idTokenEnc: text("id_token_enc"), // encrypted; used only as id_token_hint at logout
    refreshTokenEnc: text("refresh_token_enc"), // encrypted; used only for lifecycle re-validation
    csrfSecret: text("csrf_secret").notNull(),
    createdAt: ts("created_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    idleExpiresAt: ts("idle_expires_at").notNull(),
    absoluteExpiresAt: ts("absolute_expires_at").notNull(),
    lastValidatedAt: ts("last_validated_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokeReason: text("revoke_reason"),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [uniqueIndex("sessions_token_hash").on(t.tokenHash), index("sessions_user").on(t.userId), index("sessions_sid").on(t.providerSid)],
);

/** One row per in-flight OIDC login. Single use, short lived. */
export const loginTransactions = sqliteTable("login_transactions", {
  id: id(), // sha-256 of the transaction cookie value
  state: text("state").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  returnTo: text("return_to").notNull().default("/"),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
});

/** Replay protection for back-channel logout tokens. */
export const logoutTokenJtis = sqliteTable("logout_token_jtis", {
  jti: text("jti").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const groups = sqliteTable(
  "groups",
  {
    id: id(),
    name: text("name").notNull(),
    /** Higher wins when several group defaults compete. Ties break on the lower group id. */
    defaultPriority: integer("default_priority").notNull().default(0),
    /** The built-in "All staff" group: every active staff member is treated as a member. */
    isAllStaff: integer("is_all_staff", { mode: "boolean" }).notNull().default(false),
    /**
     * Values of the provider's group claim (OIDC_GROUPS_CLAIM) that make someone a member. At every
     * sign-in and session re-check, people whose claim carries one of these are added, and synced
     * members whose claim no longer does are removed. Empty: membership is managed by hand only.
     */
    providerValues: text("provider_values", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: ts("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [uniqueIndex("groups_name").on(t.name)],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** `manual`: added by an administrator. `provider`: added by the group-claim sync, which may also remove it. */
    source: text("source", { enum: ["manual", "provider"] }).notNull().default("manual"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index("group_members_user").on(t.userId)],
);

export const cameras = sqliteTable(
  "cameras",
  {
    id: id(), // Unifeye id; safe to expose to authorized clients
    nvrId: text("nvr_id").notNull(),
    protectId: text("protect_id").notNull(), // stable Protect camera id, scoped to the NVR
    name: text("name").notNull(), // cached native name
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}), // disposable cache
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    /** Set when discovery no longer reports the camera. Tags, grants and view slots are kept. */
    missingSince: ts("missing_since"),
  },
  (t) => [uniqueIndex("cameras_nvr_protect").on(t.nvrId, t.protectId)],
);

export const tags = sqliteTable("tags", { id: id(), name: text("name").notNull(), createdAt: ts("created_at").notNull() }, (t) => [
  uniqueIndex("tags_name").on(t.name),
  check("tags_name_format", sql`${t.name} glob '[a-z0-9]*' and ${t.name} not glob '*[^a-z0-9_]*' and length(${t.name}) <= 40`),
]);

export const cameraTags = sqliteTable(
  "camera_tags",
  {
    cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.cameraId, t.tagId] }), index("camera_tags_tag").on(t.tagId)],
);

/** Explicit allow grants. There are no deny rules: absence of a grant is denial. */
export const userCameraGrants = sqliteTable(
  "user_camera_grants",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cameraId] })],
);
export const groupCameraGrants = sqliteTable(
  "group_camera_grants",
  {
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.cameraId] })],
);

export const views = sqliteTable(
  "views",
  {
    id: id(),
    name: text("name").notNull(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** `private` views belong to their owner alone; `curated` views are managed by administrators. */
    visibility: text("visibility", { enum: ["private", "curated"] }).notNull(),
    /** `dynamic` = tag predicate in view_predicate_tags; `static` = ordered list in view_cameras. */
    type: text("type", { enum: ["dynamic", "static"] }).notNull(),
    columns: integer("columns").notNull().default(3),
    sharedWithAll: integer("shared_with_all", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("views_columns", sql`${t.columns} in (2,3,4)`),
    check("views_type", sql`${t.type} in ('dynamic','static')`),
    check("views_visibility", sql`${t.visibility} in ('private','curated')`),
    check("views_private_unshared", sql`${t.visibility} = 'curated' or ${t.sharedWithAll} = 0`),
    index("views_owner").on(t.ownerId),
  ],
);

/** Dynamic views: a camera matches when it carries every tag listed here (AND). */
export const viewPredicateTags = sqliteTable(
  "view_predicate_tags",
  {
    viewId: text("view_id").notNull().references(() => views.id, { onDelete: "cascade" }),
    /** RESTRICT: a tag used by a view must be removed from the view first, so a rule never widens silently. */
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.tagId] })],
);

/** Static views: explicit cameras in a fixed order. */
export const viewCameras = sqliteTable(
  "view_cameras",
  {
    viewId: text("view_id").notNull().references(() => views.id, { onDelete: "cascade" }),
    cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.cameraId] }), index("view_cameras_order").on(t.viewId, t.position)],
);

export const viewUserShares = sqliteTable(
  "view_user_shares",
  {
    viewId: text("view_id").notNull().references(() => views.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.userId] })],
);
export const viewGroupShares = sqliteTable(
  "view_group_shares",
  {
    viewId: text("view_id").notNull().references(() => views.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.groupId] })],
);

/**
 * Landing-view assignments. Exactly one of the scope columns applies:
 *  org      - neither user nor group; at most one row
 *  group    - group_id set; one per group
 *  user     - user_id set, chosen by an administrator; one per user
 *  personal - user_id set, chosen by the user; one per user
 */
export const defaultViews = sqliteTable(
  "default_views",
  {
    id: id(),
    scope: text("scope", { enum: ["org", "group", "user", "personal"] }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    viewId: text("view_id").notNull().references(() => views.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "default_views_scope",
      sql`(${t.scope} = 'org' and ${t.userId} is null and ${t.groupId} is null) or (${t.scope} = 'group' and ${t.groupId} is not null and ${t.userId} is null) or (${t.scope} in ('user','personal') and ${t.userId} is not null and ${t.groupId} is null)`,
    ),
    uniqueIndex("default_views_org").on(t.scope).where(sql`${t.scope} = 'org'`),
    uniqueIndex("default_views_group").on(t.groupId).where(sql`${t.scope} = 'group'`),
    uniqueIndex("default_views_user").on(t.userId, t.scope).where(sql`${t.scope} in ('user','personal')`),
  ],
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** "See as staff": a read-only authorization preview bound to the administrator's own session. */
export const previewContexts = sqliteTable(
  "preview_contexts",
  {
    id: id(), // sha-256 of the opaque preview token
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    endedAt: ts("ended_at"),
    endReason: text("end_reason"),
  },
  (t) => [index("preview_session").on(t.sessionId)],
);

export const exportJobs = sqliteTable(
  "export_jobs",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** The user whose permissions authorized the export (the preview subject during a preview). */
    subjectId: text("subject_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /**
     * The "See as staff" context (`preview_contexts.id`) the export was made under, if any; the
     * download ends with it. Deliberately not a foreign key: a context that no longer exists reads
     * as ended, so the job is refused and its file removed by cleanup instead of orphaned by a cascade.
     */
    previewId: text("preview_id"),
    cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    startMs: ts("start_ms").notNull(),
    endMs: ts("end_ms").notNull(),
    status: text("status", { enum: ["queued", "running", "ready", "failed", "cancelled", "expired"] }).notNull(),
    progress: integer("progress").notNull().default(0),
    filePath: text("file_path"),
    error: text("error"),
    /** Length of the finished clip, in milliseconds. */
    durationMs: integer("duration_ms"),
    /**
     * Why a finished clip is noticeably shorter than asked, or null: part of the time was not
     * recorded, or the recorder kept failing to export part of it.
     */
    gap: text("gap", { enum: ["unrecorded", "busy"] }),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("export_jobs_session").on(t.sessionId)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: ts("at").notNull(),
    actorId: text("actor_id"), // not a foreign key: history must survive user deletion
    previewSubjectId: text("preview_subject_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome", { enum: ["ok", "denied", "error"] }).notNull().default("ok"),
    requestId: text("request_id"),
    ip: text("ip"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_at").on(t.at), index("audit_actor").on(t.actorId)],
);
