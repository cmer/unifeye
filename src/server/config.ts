import { z } from "zod";

/**
 * All runtime configuration comes from environment variables and is validated once.
 * Secrets are never logged; `describeConfig()` returns a redacted view for health output.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : ["1", "true", "yes"].includes(v.toLowerCase())));
const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min));
const list = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** `mock` serves simulated cameras; `real` talks to the UNVR. Sign-in is OIDC in both. */
  UNIFEYE_MODE: z.enum(["mock", "real"]).default("mock"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/unifeye.sqlite"),
  BACKUP_DIR: z.string().default("./data/backups"),
  BACKUP_RETENTION_DAYS: int(14, 1),
  BACKUP_HOUR_UTC: int(8, 0),
  MEDIA_CACHE_DIR: z.string().default("./data/cache"),
  MEDIA_CACHE_MAX_MB: int(2048, 16),
  AUDIT_RETENTION_DAYS: int(365, 1),

  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  /** Optional. When unset the client is public and relies on PKCE alone. */
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid profile email offline_access"),
  /**
   * Admission rule: the ID token claim to check (for example `groups` or `roles`). A dotted path
   * such as `realm_access.roles` is followed when no claim has that exact name.
   */
  OIDC_ADMIT_CLAIM: z.string().optional(),
  /** Accepted values for OIDC_ADMIT_CLAIM. When empty, the claim only has to be present and non-empty. */
  OIDC_ADMIT_VALUES: list,
  /**
   * Extra parameters for the authorization request, as a query string. Google needs
   * `access_type=offline&prompt=consent` to issue a refresh token. Protocol parameters are refused.
   */
  OIDC_AUTH_PARAMS: z
    .string()
    .optional()
    .transform((v) => [...new URLSearchParams((v ?? "").replace(/^\?/, "")).entries()].filter(([k]) => k)),
  /**
   * Group sync: the ID token claim whose values put people into Unifeye groups (each group lists
   * the values it accepts). Same formats as OIDC_ADMIT_CLAIM. Defaults to OIDC_ADMIT_CLAIM.
   * Set to `none` to turn the sync off.
   */
  OIDC_GROUPS_CLAIM: z.string().optional(),
  /** Admit everyone the provider authenticates. Only for providers that already restrict who can use this client. */
  OIDC_ADMIT_ANY: bool(false),
  /** Test-only: permit an http:// issuer. Refused when NODE_ENV=production. */
  OIDC_ALLOW_INSECURE_ISSUER: bool(false),
  BOOTSTRAP_ADMIN_ISSUER: z.string().optional(),
  BOOTSTRAP_ADMIN_SUBJECT: z.string().optional(),
  /** base64 of 32 random bytes; encrypts provider tokens at rest. */
  TOKEN_ENC_KEY: z.string().optional(),

  SESSION_IDLE_MINUTES: int(720, 1),
  SESSION_ABSOLUTE_HOURS: int(168, 1),
  /** How often each session is re-validated with the identity provider (refresh grant). */
  OIDC_RECHECK_SECONDS: int(300, 30),
  /** A session that could not be re-validated for this long is suspended. */
  OIDC_MAX_STALE_SECONDS: int(1800, 60),
  PREVIEW_MINUTES: int(15, 1),
  /** Upper bound on how long revoked media may keep flowing. Must stay <= 30. */
  REVOCATION_SWEEP_SECONDS: int(10, 1),

  PROTECT_HOST: z.string().optional(),
  PROTECT_USERNAME: z.string().optional(),
  PROTECT_PASSWORD: z.string().optional(),
  /** PEM file with the CA (or the self-signed certificate) of the UNVR. */
  PROTECT_TLS_CA_FILE: z.string().optional(),
  /** Development only: skip TLS verification for the UNVR connection. Refused in production. */
  PROTECT_TLS_INSECURE: bool(false),
  PROTECT_NVR_ID: z.string().default("default"),
  /** SHA-256 fingerprint of the UNVR certificate, so MediaMTX can verify the RTSPS source. */
  PROTECT_RTSPS_FINGERPRINT: z.string().optional(),

  MEDIAMTX_API_URL: z.string().url().default("http://127.0.0.1:9997"),
  MEDIAMTX_WHEP_URL: z.string().url().default("http://127.0.0.1:8889"),
  MEDIAMTX_HLS_URL: z.string().url().default("http://127.0.0.1:8888"),
  /** Shared secret MediaMTX presents when calling the Unifeye auth hook. */
  MEDIAMTX_HOOK_SECRET: z.string().optional(),
  /** Username Unifeye uses for the MediaMTX control API (checked by the same hook). */
  MEDIAMTX_API_SECRET: z.string().optional(),
  MAX_WALL_STREAMS: int(9, 1),
  CLIP_MAX_SECONDS: int(7200, 5),
  /** A long clip is fetched from the recorder in 5-minute pieces, this many at a time. */
  CLIP_EXPORT_PARALLEL: int(3, 1),
  PLAYBACK_WINDOW_SECONDS: int(60, 10),
  EVENT_PREROLL_SECONDS: int(5, 0),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;
/** Set by Unifeye itself on every authorization request; overriding them would weaken the flow. */
const RESERVED_AUTH_PARAMS = new Set(["client_id", "redirect_uri", "response_type", "response_mode", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "request", "request_uri"]);
let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const problems: string[] = [];
  const prod = c.NODE_ENV === "production";
  if (c.REVOCATION_SWEEP_SECONDS > 30) problems.push("REVOCATION_SWEEP_SECONDS must be 30 or less");
  if (prod) {
    for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "TOKEN_ENC_KEY", "MEDIAMTX_HOOK_SECRET", "MEDIAMTX_API_SECRET"] as const)
      if (!c[k]) problems.push(`${k} is required in production`);
    if (!c.OIDC_ADMIT_CLAIM && !c.OIDC_ADMIT_ANY) problems.push("OIDC_ADMIT_CLAIM is required in production (or set OIDC_ADMIT_ANY=1 if the provider already restricts who can sign in)");
    if (c.OIDC_ISSUER && !c.OIDC_ISSUER.startsWith("https://")) problems.push("OIDC_ISSUER must use https");
    if (c.OIDC_ALLOW_INSECURE_ISSUER) problems.push("OIDC_ALLOW_INSECURE_ISSUER is not allowed in production");
    if (c.PROTECT_TLS_INSECURE) problems.push("PROTECT_TLS_INSECURE is not allowed in production");
    if (!c.APP_URL.startsWith("https://")) problems.push("APP_URL must use https in production");
  }
  if (c.UNIFEYE_MODE === "real")
    for (const k of ["PROTECT_HOST", "PROTECT_USERNAME", "PROTECT_PASSWORD"] as const)
      if (!c[k]) problems.push(`${k} is required when UNIFEYE_MODE=real`);
  if (c.TOKEN_ENC_KEY && Buffer.from(c.TOKEN_ENC_KEY, "base64").length !== 32)
    problems.push("TOKEN_ENC_KEY must be base64 of exactly 32 bytes");
  for (const [k] of c.OIDC_AUTH_PARAMS)
    if (RESERVED_AUTH_PARAMS.has(k)) problems.push(`OIDC_AUTH_PARAMS cannot set ${k}`);
  if (c.OIDC_ADMIT_CLAIM && c.OIDC_ADMIT_ANY) problems.push("OIDC_ADMIT_CLAIM and OIDC_ADMIT_ANY cannot both be set");
  if (c.OIDC_ADMIT_VALUES.length && !c.OIDC_ADMIT_CLAIM) problems.push("OIDC_ADMIT_VALUES needs OIDC_ADMIT_CLAIM");
  if (!!c.BOOTSTRAP_ADMIN_ISSUER !== !!c.BOOTSTRAP_ADMIN_SUBJECT)
    problems.push("BOOTSTRAP_ADMIN_ISSUER and BOOTSTRAP_ADMIN_SUBJECT must be set together");
  if (problems.length) throw new Error("Invalid configuration:\n- " + problems.join("\n- "));
  return c;
}

/** The claim group sync reads, or null when the sync is off. */
export function groupsClaim(c: Config = config()): string | null {
  const v = c.OIDC_GROUPS_CLAIM?.trim();
  if (v === "none") return null;
  return v || c.OIDC_ADMIT_CLAIM || null;
}

export function config(): Config {
  return (cached ??= loadConfig());
}
/** Test hook: replace the cached configuration. */
export function setConfigForTests(c: Config | undefined) {
  cached = c;
}
