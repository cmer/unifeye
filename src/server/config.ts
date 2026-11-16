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
  VANTAGE_MODE: z.enum(["mock", "real"]).default("mock"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/vantage.sqlite"),
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
  /** Zitadel organization IDs whose users may be admitted. Required in production. */
  OIDC_ALLOWED_ORG_IDS: list,
  /** When set, the ID token must carry at least one role for this Zitadel project. */
  OIDC_PROJECT_ID: z.string().optional(),
  /** Test-only: permit an http:// issuer. Refused when NODE_ENV=production. */
  OIDC_ALLOW_INSECURE_ISSUER: bool(false),
  BOOTSTRAP_ADMIN_ISSUER: z.string().optional(),
  BOOTSTRAP_ADMIN_SUBJECT: z.string().optional(),
  /** base64 of 32 random bytes; encrypts provider tokens at rest. */
  TOKEN_ENC_KEY: z.string().optional(),

  SESSION_IDLE_MINUTES: int(720, 1),
  SESSION_ABSOLUTE_HOURS: int(168, 1),
  /** How often each session is re-validated with Zitadel (refresh grant). */
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
  /** Shared secret MediaMTX presents when calling the Vantage auth hook. */
  MEDIAMTX_HOOK_SECRET: z.string().optional(),
  /** Username Vantage uses for the MediaMTX control API (checked by the same hook). */
  MEDIAMTX_API_SECRET: z.string().optional(),
  MAX_WALL_STREAMS: int(9, 1),
  CLIP_MAX_SECONDS: int(300, 5),
  PLAYBACK_WINDOW_SECONDS: int(60, 10),
  EVENT_PREROLL_SECONDS: int(5, 0),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;
let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const problems: string[] = [];
  const prod = c.NODE_ENV === "production";
  if (c.REVOCATION_SWEEP_SECONDS > 30) problems.push("REVOCATION_SWEEP_SECONDS must be 30 or less");
  if (prod) {
    for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "TOKEN_ENC_KEY", "MEDIAMTX_HOOK_SECRET", "MEDIAMTX_API_SECRET"] as const)
      if (!c[k]) problems.push(`${k} is required in production`);
    if (!c.OIDC_ALLOWED_ORG_IDS.length) problems.push("OIDC_ALLOWED_ORG_IDS is required in production");
    if (c.OIDC_ISSUER && !c.OIDC_ISSUER.startsWith("https://")) problems.push("OIDC_ISSUER must use https");
    if (c.OIDC_ALLOW_INSECURE_ISSUER) problems.push("OIDC_ALLOW_INSECURE_ISSUER is not allowed in production");
    if (c.PROTECT_TLS_INSECURE) problems.push("PROTECT_TLS_INSECURE is not allowed in production");
    if (!c.APP_URL.startsWith("https://")) problems.push("APP_URL must use https in production");
  }
  if (c.VANTAGE_MODE === "real")
    for (const k of ["PROTECT_HOST", "PROTECT_USERNAME", "PROTECT_PASSWORD"] as const)
      if (!c[k]) problems.push(`${k} is required when VANTAGE_MODE=real`);
  if (c.TOKEN_ENC_KEY && Buffer.from(c.TOKEN_ENC_KEY, "base64").length !== 32)
    problems.push("TOKEN_ENC_KEY must be base64 of exactly 32 bytes");
  if (!!c.BOOTSTRAP_ADMIN_ISSUER !== !!c.BOOTSTRAP_ADMIN_SUBJECT)
    problems.push("BOOTSTRAP_ADMIN_ISSUER and BOOTSTRAP_ADMIN_SUBJECT must be set together");
  if (problems.length) throw new Error("Invalid configuration:\n- " + problems.join("\n- "));
  return c;
}

export function config(): Config {
  return (cached ??= loadConfig());
}
/** Test hook: replace the cached configuration. */
export function setConfigForTests(c: Config | undefined) {
  cached = c;
}
