import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const newId = () => randomUUID();
export const now = () => Date.now();
/** Opaque, unguessable token for cookies and capabilities (256 bits). */
export const randomToken = () => randomBytes(32).toString("base64url");
/** Tokens are stored hashed so a database leak does not yield usable sessions. */
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM with a deployment key kept outside the database. Format: v1.iv.tag.ciphertext (base64url). */
export function encrypt(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function decrypt(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported ciphertext");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** What people see when an error carries only a code. */
const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  preview_read_only: "Changes are turned off while viewing as someone else.",
  preview_not_allowed: "You can't view as this person.",
  bad_origin: "Something went wrong. Reload and try again.",
  bad_csrf_token: "Something went wrong. Reload and try again.",
  nvr_unavailable: "Can't reach the recorder.",
  relay_unavailable: "Video is unavailable right now.",
  relay_error: "Video is unavailable right now.",
  no_live_stream: "No live video.",
  invalid_request: "Something went wrong. Try again.",
  sso_not_configured: "Sign-in isn't set up yet.",
};
export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? code);
  }
}
/** Used for anything a caller may not see. Deliberately identical to "does not exist". */
export const notFound = () => new HttpError(404, "not_found", "This is no longer available.");
export const forbidden = (code = "forbidden") => new HttpError(403, code);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const SECRET_KEYS = /pass|secret|token|cookie|authorization|code_verifier|csrf/i;
/** Structured JSON logs. Values under secret-looking keys are dropped rather than masked. */
export function log(level: keyof typeof levels, msg: string, fields: Record<string, unknown> = {}) {
  const min = levels[(process.env.LOG_LEVEL as keyof typeof levels) ?? "info"] ?? 20;
  if (levels[level] < min) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (!SECRET_KEYS.test(k)) safe[k] = v instanceof Error ? v.message : v;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
