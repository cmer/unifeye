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
  /** `mock` serves simulated cameras; `real` talks to the UNVR. Sign-in works the same in both. */
  UNIFEYE_MODE: z.enum(["mock", "real"]).default("mock"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/unifeye.sqlite"),
  BACKUP_DIR: z.string().default("./data/backups"),
  BACKUP_RETENTION_DAYS: int(14, 1),
  BACKUP_HOUR_UTC: int(8, 0),
  MEDIA_CACHE_DIR: z.string().default("./data/cache"),
  MEDIA_CACHE_MAX_MB: int(2048, 16),
  AUDIT_RETENTION_DAYS: int(365, 1),

  /**
   * How people sign in, comma separated: `oidc` (your identity provider), `local` (usernames and
   * passwords that administrators hand out) and `cloudflare` (Cloudflare Access in front of Unifeye).
   * `oidc` and `cloudflare` cannot be combined. Turning a method off locks out the people who use it.
   */
  SIGN_IN_METHODS: z
    .string()
    .optional()
    .transform((v) => [...new Set((v || "oidc").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.enum(["oidc", "local", "cloudflare"])).min(1, "SIGN_IN_METHODS needs at least one method")),
  /** Shown on the sign-in page as "Continue with …" when passwords are also on, e.g. `Google` or `Okta`. */
  OIDC_DISPLAY_NAME: z.string().trim().min(1).max(60).default("SSO"),
  /**
   * Email domains that must sign in with the identity provider, comma separated, such as
   * `example.com`. On the sign-in page, a username at one of them goes straight to the provider, and
   * password and email-code sign-in refuse it. Exact domains only: `example.com` does not cover
   * `mail.example.com`. Needs `oidc` and `local` in SIGN_IN_METHODS.
   */
  OIDC_EMAIL_DOMAINS: z
    .string()
    .optional()
    .transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "OIDC_EMAIL_DOMAINS must be domains like example.com"))),
  /** Cloudflare Access team domain, for example `acme.cloudflareaccess.com`. */
  CF_ACCESS_TEAM_DOMAIN: z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "") || undefined)
    .pipe(z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/i, "CF_ACCESS_TEAM_DOMAIN must look like acme.cloudflareaccess.com").optional()),
  /** Application Audience (AUD) tag of the Access application, or several, comma separated. */
  CF_ACCESS_AUD: list,
  /**
   * A Cloudflare session that has not been seen with a valid Access token for this long is
   * suspended, so streams stop soon after Cloudflare stops letting the person through.
   */
  CF_ACCESS_RECHECK_SECONDS: int(300, 60),
  /**
   * A secret Cloudflare adds to every request it forwards (a Transform Rule setting the
   * `X-Unifeye-Origin-Secret` request header). A valid Access token alone does not prove a request
   * came through Cloudflare, because its holder can attach it themselves. Required when passwords
   * are on too, since then Unifeye is reachable without Cloudflare by design.
   */
  CF_ACCESS_ORIGIN_SECRET: z.string().optional(),
  /**
   * Optional second address for password sign-in, such as the address used on the local network
   * when APP_URL goes through Cloudflare Access. Password links point here when it is set.
   */
  LOCAL_APP_URL: z.string().url().optional(),
  /**
   * Outgoing mail server, such as `smtps://user:pass@smtp.example.com:465` or
   * `smtp://user:pass@smtp.example.com:587` (upgraded with STARTTLS). With MAIL_FROM and the `local`
   * sign-in method, it lets administrators give password accounts email codes. It may be set without
   * `local`; email codes then stay off. Unset: no email is ever sent.
   */
  SMTP_URL: z.string().optional().transform((v) => v?.trim() || undefined).pipe(z.string().regex(/^smtps?:\/\/[^\s]+$/, "SMTP_URL must start with smtp:// or smtps://").optional()),
  /** The From address on outgoing email, for example `Unifeye <cameras@example.com>`. */
  MAIL_FROM: z.string().optional().transform((v) => v?.trim() || undefined).pipe(z.string().max(200).regex(/@/, "MAIL_FROM must contain an email address").optional()),

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

  /** How long a sign-in is remembered. After this, people sign in again however active they were. */
  SESSION_DAYS: int(30, 1),
  /** Optional: also end a session after this many minutes without use. 0 (the default) turns it off. */
  SESSION_IDLE_MINUTES: int(0, 0),
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
  /**
   * Login for reading video straight from cameras made by someone else, for the cameras an
   * administrator switches over in Admin. A camera can have its own login instead (stored encrypted
   * with TOKEN_ENC_KEY).
   */
  DEFAULT_CAMERA_USERNAME: z.string().optional(),
  DEFAULT_CAMERA_PASSWORD: z.string().optional(),

  MEDIAMTX_API_URL: z.string().url().default("http://127.0.0.1:9997"),
  MEDIAMTX_WHEP_URL: z.string().url().default("http://127.0.0.1:8889"),
  MEDIAMTX_HLS_URL: z.string().url().default("http://127.0.0.1:8888"),
  /**
   * Where Unifeye answers MediaMTX's auth hook. A separate listener from the web app, never published
   * or put behind the reverse proxy. Inside a container it must listen on all interfaces (0.0.0.0).
   */
  HOOK_HOST: z.string().default("127.0.0.1"),
  HOOK_PORT: int(3001, 1),
  /** Shared secret MediaMTX presents when calling the Unifeye auth hook. */
  MEDIAMTX_HOOK_SECRET: z.string().optional(),
  /** Username Unifeye uses for the MediaMTX control API (checked by the same hook). */
  MEDIAMTX_API_SECRET: z.string().optional(),
  /** Tiles on screen that play at once, live or rewound; off-screen tiles never play, and the rest show stills. */
  MAX_WALL_STREAMS: int(24, 1),
  CLIP_MAX_SECONDS: int(7200, 5),
  /** A long clip is fetched from the recorder in 5-minute pieces, this many at a time. */
  CLIP_EXPORT_PARALLEL: int(3, 1),
  /**
   * With adaptive recording, some pieces of a long clip are recorded only in low resolution. When
   * on, they are re-encoded at the largest size so the picture stays one size in a player. (Pieces
   * with some high-resolution video are always combined at full size; see `exportPiece`.)
   */
  CLIP_MATCH_RESOLUTION: bool(true),
  /**
   * Encoder for that re-encode. `auto` tries a GPU (VAAPI for Intel Quick Sync and AMD, then NVIDIA
   * NVENC, then Apple VideoToolbox) and falls back to the CPU. A named encoder that fails also
   * falls back to the CPU.
   */
  VIDEO_ENCODER: z.enum(["auto", "cpu", "vaapi", "nvenc", "videotoolbox"]).default("auto"),
  /** VAAPI render node. Unset: every /dev/dri/renderD* is tried. */
  VAAPI_DEVICE: z.string().optional(),
  PLAYBACK_WINDOW_SECONDS: int(60, 10),
  EVENT_PREROLL_SECONDS: int(5, 0),
  /**
   * How long the playhead must rest while someone drags a camera's timeline before that moment's
   * recording starts loading, so letting go there plays sooner. 0 turns it off.
   */
  SCRUB_PRELOAD_MS: int(500, 0),
  /**
   * How much live video a browser holds before showing it over WebRTC. Cameras and the recorder
   * send in bursts (a pause around each keyframe, then the backlog), which shows as a freeze and a
   * jump unless the player has something in hand. Live video runs this far behind real time.
   * 0 turns it off; browsers accept at most 4000.
   */
  LIVE_BUFFER_MS: int(1000, 0).pipe(z.number().max(4000)),
  /**
   * A TURN relay (coturn) for live video, so viewers who cannot reach the WebRTC media port still get
   * real-time video, and the port need not be open to the internet. Host name or IPv4 address only.
   * Unset: no relay; viewers who cannot reach the port get HLS. See docs/turn.md.
   */
  TURN_HOST: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9.-]+$/, "TURN_HOST must be a host name or IPv4 address, without a scheme or port").optional()),
  /** coturn's `static-auth-secret`. Browser logins are made from it and last 12 hours. */
  TURN_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** coturn's plain listening port, UDP and TCP. */
  TURN_PORT: int(3478, 1),
  /** coturn's TLS port, for networks that only let HTTPS out. 0 leaves TURN over TLS out. */
  TURN_TLS_PORT: int(443, 0),
  /**
   * Browsers use only the relay, never the media port directly. Off: browsers that can reach the
   * port (on the office network, say) connect directly, the rest through the relay.
   */
  TURN_RELAY_ONLY: bool(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * The commit this build was made from, shown in the diagnostics window. The image build sets it
   * (`GIT_SHA` build argument); there is no reason to set it by hand.
   */
  GIT_SHA: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[0-9a-f]{7,40}$/).optional()),
  /**
   * `on`: a few times a day, ask GitHub whether a newer Unifeye exists, and say so in the diagnostics
   * window. Two anonymous requests to api.github.com; the only thing sent is the commit this build
   * runs. `off`: never ask.
   */
  UPDATE_CHECK: z.enum(["on", "off"]).default("on"),
});

export type Config = z.infer<typeof schema>;
/** Set by Unifeye itself on every authorization request; overriding them would weaken the flow. */
/** Shared secrets between Unifeye and MediaMTX must be long enough that guessing is hopeless. */
const MIN_SECRET = 32;
const RESERVED_AUTH_PARAMS = new Set(["client_id", "redirect_uri", "response_type", "response_mode", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "request", "request_uri"]);
let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const problems: string[] = [];
  if (env.SESSION_ABSOLUTE_HOURS) problems.push("SESSION_ABSOLUTE_HOURS was replaced by SESSION_DAYS");
  const prod = c.NODE_ENV === "production";
  if (c.REVOCATION_SWEEP_SECONDS > 30) problems.push("REVOCATION_SWEEP_SECONDS must be 30 or less");
  const m = signInMethods(c);
  if (m.oidc && m.cloudflare) problems.push("SIGN_IN_METHODS cannot combine oidc and cloudflare");
  if (m.cloudflare && (!c.CF_ACCESS_TEAM_DOMAIN || !c.CF_ACCESS_AUD.length)) problems.push("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required when SIGN_IN_METHODS includes cloudflare");
  if (c.CF_ACCESS_RECHECK_SECONDS > 3600) problems.push("CF_ACCESS_RECHECK_SECONDS must be 3600 or less");
  if (m.cloudflare && m.local && !c.CF_ACCESS_ORIGIN_SECRET) problems.push("CF_ACCESS_ORIGIN_SECRET is required when SIGN_IN_METHODS combines cloudflare and local");
  if (c.CF_ACCESS_ORIGIN_SECRET && c.CF_ACCESS_ORIGIN_SECRET.length < MIN_SECRET) problems.push(`CF_ACCESS_ORIGIN_SECRET must be at least ${MIN_SECRET} characters (openssl rand -hex 24)`);
  if (c.OIDC_EMAIL_DOMAINS.length && !(m.oidc && m.local)) problems.push("OIDC_EMAIL_DOMAINS needs SIGN_IN_METHODS to include both oidc and local");
  if (c.LOCAL_APP_URL && !m.local) problems.push("LOCAL_APP_URL needs SIGN_IN_METHODS to include local");
  if (!!c.SMTP_URL !== !!c.MAIL_FROM) problems.push("SMTP_URL and MAIL_FROM must be set together");
  if (c.LOCAL_APP_URL && new URL(c.LOCAL_APP_URL).origin === new URL(c.APP_URL).origin) problems.push("LOCAL_APP_URL must be a different address from APP_URL");
  if (prod) {
    for (const k of ["MEDIAMTX_HOOK_SECRET", "MEDIAMTX_API_SECRET"] as const)
      if (!c[k]) problems.push(`${k} is required in production`);
    if (m.oidc) {
      for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "TOKEN_ENC_KEY"] as const)
        if (!c[k]) problems.push(`${k} is required in production`);
      if (!c.OIDC_ADMIT_CLAIM && !c.OIDC_ADMIT_ANY) problems.push("OIDC_ADMIT_CLAIM is required in production (or set OIDC_ADMIT_ANY=1 if the provider already restricts who can sign in)");
    }
    if (c.LOCAL_APP_URL && !c.LOCAL_APP_URL.startsWith("https://")) problems.push("LOCAL_APP_URL must use https in production");
    if (c.OIDC_ISSUER && !c.OIDC_ISSUER.startsWith("https://")) problems.push("OIDC_ISSUER must use https");
    if (c.OIDC_ALLOW_INSECURE_ISSUER) problems.push("OIDC_ALLOW_INSECURE_ISSUER is not allowed in production");
    if (c.PROTECT_TLS_INSECURE) problems.push("PROTECT_TLS_INSECURE is not allowed in production");
    if (!c.APP_URL.startsWith("https://")) problems.push("APP_URL must use https in production");
    for (const k of ["MEDIAMTX_HOOK_SECRET", "MEDIAMTX_API_SECRET"] as const)
      if (c[k] && c[k].length < MIN_SECRET) problems.push(`${k} must be at least ${MIN_SECRET} characters (openssl rand -hex 24)`);
  }
  if (!!c.TURN_HOST !== !!c.TURN_SECRET) problems.push("TURN_HOST and TURN_SECRET must be set together");
  if (c.TURN_SECRET && c.TURN_SECRET.length < MIN_SECRET) problems.push(`TURN_SECRET must be at least ${MIN_SECRET} characters (openssl rand -hex 24)`);
  if (c.TURN_RELAY_ONLY && !c.TURN_HOST) problems.push("TURN_RELAY_ONLY needs TURN_HOST");
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

/** How long a session lasts from sign-in, in milliseconds. */
export const sessionLifetimeMs = (c: Config = config()) => c.SESSION_DAYS * 864e5;
/** The idle limit in milliseconds, or null when it is off. */
export const sessionIdleMs = (c: Config = config()) => (c.SESSION_IDLE_MINUTES ? c.SESSION_IDLE_MINUTES * 6e4 : null);

export type SignInMethod = "oidc" | "local" | "cloudflare";
/** Which sign-in methods are turned on. */
export function signInMethods(c: Config = config()): Record<SignInMethod, boolean> {
  const on = new Set(c.SIGN_IN_METHODS);
  return { oidc: on.has("oidc"), local: on.has("local"), cloudflare: on.has("cloudflare") };
}
/** Email sign-in codes are available: password accounts are on and outgoing mail is set up. */
export const emailCodesOn = (c: Config = config()) => signInMethods(c).local && !!c.SMTP_URL && !!c.MAIL_FROM;
/**
 * The domain of a username that must sign in with the identity provider (OIDC_EMAIL_DOMAINS), or
 * null. Only the part after the last `@` counts, compared exactly and ignoring case.
 */
export function ssoDomain(username: unknown, c: Config = config()): string | null {
  if (typeof username !== "string" || !c.OIDC_EMAIL_DOMAINS.length || !signInMethods(c).oidc) return null;
  const v = username.normalize("NFKC").trim().toLowerCase(), at = v.lastIndexOf("@");
  if (at < 1) return null;
  const d = v.slice(at + 1);
  return c.OIDC_EMAIL_DOMAINS.includes(d) ? d : null;
}
/** The issuer Cloudflare Access puts in its tokens, which is also the issuer of a Cloudflare identity. */
export const cloudflareIssuer = (c: Config = config()) => (c.CF_ACCESS_TEAM_DOMAIN ? `https://${c.CF_ACCESS_TEAM_DOMAIN}` : null);
/** The origins a browser may send writes and password sign-ins from. */
export function allowedOrigins(c: Config = config()): string[] {
  return [new URL(c.APP_URL).origin, ...(c.LOCAL_APP_URL ? [new URL(c.LOCAL_APP_URL).origin] : [])];
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
