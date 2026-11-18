"use client";

/** Thin client for the Unifeye API. The server decides everything; this only carries the session. */
export interface Camera { id: string; name: string; tags: string[]; missing: boolean; online: boolean; eventTypes: string[]; hasLive: boolean }
export interface ViewSummary { id: string; name: string; type: "dynamic" | "static"; visibility: "private" | "curated"; columns: number; count: number; editable: boolean }
export interface Me {
  user: { id: string; name: string; role: "admin" | "staff"; signsInWith: "oidc" | "local" | "cloudflare" };
  csrf: string;
  preview: { subject: { id: string; name: string } } | null;
  subject: { id: string; name: string; role: string; canCreateViews: boolean; canExportClips: boolean };
  isAdmin: boolean;
  landing: { viewId: string | null; reason: string };
  views: ViewSummary[];
  preferences: Record<string, unknown>;
  mode: "mock" | "real";
  recorder: "connected" | "connecting" | "down";
  limits: { maxStreams: number; windowSeconds: number; prerollSeconds: number; clipMaxSeconds: number };
}
export interface ActivityEvent { id: string; cameraId: string; cameraName: string; type: string; startMs: number; endMs: number | null; hasThumbnail: boolean }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let csrf = "";
export const setCsrf = (v: string) => { csrf = v; };
const PV = "unifeye.preview";
/** The preview token lives in this tab only, so two tabs can never confuse who is being previewed. */
export const previewToken = () => (typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(PV));
export const setPreviewToken = (t: string | null) => { if (t) sessionStorage.setItem(PV, t); else sessionStorage.removeItem(PV); };
/** For <img>, <video> and EventSource, which cannot send headers. */
export const mediaUrl = (path: string) => { const t = previewToken(); return t ? `${path}${path.includes("?") ? "&" : "?"}pv=${encodeURIComponent(t)}` : path; };

/** `keepalive`: the request still goes out when the page is closing (releasing a stream on the way out). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: string; signal?: AbortSignal; keepalive?: boolean; onHeaders?: (h: Headers) => void } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const method = init.method ?? "GET", pv = previewToken();
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  if (pv) headers["x-unifeye-preview"] = pv;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.raw !== undefined) headers["content-type"] = "application/sdp";
  const res = await fetch(`/api${path}`, { method, headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)), signal: init.signal, keepalive: init.keepalive, credentials: "same-origin" });
  if (res.status === 401) {
    location.assign(`/api/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, "unauthenticated", "Signing in…");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 409 && j.error === "preview_ended") { setPreviewToken(null); location.assign("/admin"); }
    throw new ApiError(res.status, j.error ?? "error", j.message ?? "Something went wrong");
  }
  init.onHeaders?.(res.headers);
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? await res.json() : type.includes("sdp") ? { sdp: await res.text(), location: res.headers.get("location") } : undefined) as T;
}

// ---- time helpers: UTC in transport and storage, a chosen zone on screen ----
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const cache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = cache.get(tz);
  if (!f) cache.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })));
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
const offset = (ms: number, tz: string) => { const p = parts(ms, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
/** Wall-clock time in a zone -> UTC ms. Two passes settle daylight-saving edges; a time skipped by a spring-forward lands just after the gap. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - offset(guess - offset(guess, tz), tz);
}
/** Start and end of the calendar day containing `ms` in the zone (23, 24 or 25 hours long). */
export function dayBounds(ms: number, tz: string): [number, number] {
  const p = parts(ms, tz), next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return [zonedToUtc(p.year, p.month, p.day, 0, 0, 0, tz), zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz)];
}
export const dateInput = (ms: number, tz: string) => { const p = parts(ms, tz); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };
export const timeInput = (ms: number, tz: string) => { const p = parts(ms, tz); return [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, "0")).join(":"); };
export const zonedParts = parts;
const fmt = (o: Intl.DateTimeFormatOptions) => (ms: number, tz: string) => new Intl.DateTimeFormat(undefined, { ...o, timeZone: tz }).format(ms);
export const fmtTime = fmt({ hour: "numeric", minute: "2-digit", second: "2-digit" });
export const fmtShort = fmt({ hour: "numeric", minute: "2-digit" });
export const fmtDay = fmt({ weekday: "short", month: "short", day: "numeric" });
export const EVENT_LABEL: Record<string, string> = { motion: "Motion", person: "Person", vehicle: "Vehicle", package: "Package", animal: "Animal", ring: "Doorbell", licensePlate: "Licence plate", audio: "Sound", other: "Other" };
export const EVENT_COLOR: Record<string, string> = { motion: "#f59e0b", person: "#3b82f6", vehicle: "#8b5cf6", package: "#10b981", animal: "#f97316", ring: "#ec4899", licensePlate: "#14b8a6", audio: "#a3a3a3", other: "#a3a3a3" };
