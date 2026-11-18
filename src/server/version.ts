import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { config } from "./config";
import { log } from "./util";

/** Where releases are published. The update check asks GitHub about this repository and nothing else. */
const REPO = "cmer/unifeye";
const API = `https://api.github.com/repos/${REPO}`;

/** `current`: nothing newer. `behind`: something newer exists. `unknown`: not checked yet or the check failed. `off`: UPDATE_CHECK=off. */
export type UpdateState = "current" | "behind" | "unknown" | "off";
export interface Update {
  state: UpdateState;
  /** The newest release's tag, when the project has releases. */
  latest: string | null;
  /** How many commits the running build lacks, when the running commit is known. */
  behindBy: number | null;
  checkedAt: number | null;
}
export interface VersionInfo { version: string; commit: string | null; update: Update }

// On globalThis because the server bundles this module more than once.
const g = globalThis as unknown as { __unifeyeVersion?: { commit?: string | null; update?: Update } };
const mem = () => (g.__unifeyeVersion ??= {});

/**
 * The commit this build was made from: `GIT_SHA`, which the image build sets (see the Dockerfile).
 * Outside production, a checkout's own HEAD stands in, so development shows one too.
 */
export function runningCommit(): string | null {
  const m = mem();
  if (m.commit !== undefined) return m.commit;
  const c = config();
  let sha = c.GIT_SHA ?? null;
  if (!sha && c.NODE_ENV !== "production") {
    try { sha = execFileSync("git", ["rev-parse", "HEAD"], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { /* not a checkout, or no git */ }
  }
  return (m.commit = sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null);
}

const parts = (v: string) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
/** Whether release `tag` is a higher version than `version`. False when either is not `x.y.z`. */
export function isNewer(tag: string, version: string) {
  const a = parts(tag), b = parts(version);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Turns what GitHub said into an answer. With the running commit known, commits decide: the build
 * is behind when the newest release (or `main`, while there are no releases) has commits it lacks.
 * A build ahead of the newest release counts as current. Without a commit, version numbers decide,
 * and with neither a commit nor a release nothing can be said.
 */
export function decideUpdate(a: { version: string; release: string | null; missing: number | null }): Pick<Update, "state" | "latest" | "behindBy"> {
  if (a.missing != null) return { state: a.missing > 0 ? "behind" : "current", latest: a.release, behindBy: a.missing };
  if (a.release) return { state: isNewer(a.release, a.version) ? "behind" : "current", latest: a.release, behindBy: null };
  return { state: "unknown", latest: null, behindBy: null };
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/**
 * Asks GitHub for the newest release and how the running commit compares with it. Two anonymous
 * requests that carry nothing about this installation except, in the second, the commit it runs.
 */
export async function lookUpUpdate(a: { version: string; commit: string | null; fetch?: Fetch }): Promise<Pick<Update, "state" | "latest" | "behindBy">> {
  const get = async (path: string) => (a.fetch ?? (fetch as unknown as Fetch))(`${API}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "unifeye" }, signal: AbortSignal.timeout(8000) });
  const rel = await get("/releases/latest");
  if (!rel.ok && rel.status !== 404) throw new Error(`GitHub answered ${rel.status}`);
  const tag = rel.ok ? (await rel.json() as { tag_name?: unknown }).tag_name : null;
  const release = typeof tag === "string" && tag ? tag : null;
  let missing: number | null = null;
  if (a.commit) {
    // base...head: `ahead_by` counts what head has that base lacks, so here, what the running build lacks.
    const cmp = await get(`/compare/${a.commit}...${encodeURIComponent(release ?? "main")}?per_page=1`);
    if (cmp.ok) { const n = (await cmp.json() as { ahead_by?: unknown }).ahead_by; if (typeof n === "number") missing = n; }
    else if (cmp.status !== 404) throw new Error(`GitHub answered ${cmp.status}`); // 404: a commit GitHub has never seen (a local build)
  }
  return decideUpdate({ version: a.version, release, missing });
}

/** Runs the check and remembers the answer. A failed check keeps the last good answer. Never throws. */
export async function checkForUpdate() {
  const m = mem();
  if (config().UPDATE_CHECK === "off") { m.update = { state: "off", latest: null, behindBy: null, checkedAt: null }; return; }
  try { m.update = { ...(await lookUpUpdate({ version: pkg.version, commit: runningCommit() })), checkedAt: Date.now() }; }
  catch (e) { log("warn", "update check failed", { error: e }); }
}

/** What the diagnostics route reports. Reads the remembered answer; never goes to the network. */
export function versionInfo(): VersionInfo {
  return { version: pkg.version, commit: runningCommit(), update: mem().update ?? { state: config().UPDATE_CHECK === "off" ? "off" : "unknown", latest: null, behindBy: null, checkedAt: null } };
}

export function resetVersionForTests() { g.__unifeyeVersion = undefined; }
