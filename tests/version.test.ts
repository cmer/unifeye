import { describe, expect, it } from "vitest";
import { decideUpdate, isNewer, lookUpUpdate } from "@/server/version";

/** A stand-in for GitHub: answers by path, and records what was asked. */
function github(routes: Record<string, { status: number; body?: unknown }>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    const path = url.replace("https://api.github.com/repos/cmer/unifeye", "");
    asked.push(path);
    const r = routes[path] ?? { status: 500 };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fetch, asked };
}
const SHA = "cf62c23000000000000000000000000000000000";

describe("update check", () => {
  it("compares version numbers", () => {
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.3")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("nightly", "0.1.0")).toBe(false);
  });
  it("lets commits decide when the running commit is known", () => {
    expect(decideUpdate({ version: "0.1.0", release: "v0.2.0", missing: 3 })).toEqual({ state: "behind", latest: "v0.2.0", behindBy: 3 });
    // Built from main after the release: nothing missing, even though package.json still says 0.1.0.
    expect(decideUpdate({ version: "0.1.0", release: "v0.2.0", missing: 0 })).toEqual({ state: "current", latest: "v0.2.0", behindBy: 0 });
    expect(decideUpdate({ version: "0.1.0", release: null, missing: 0 }).state).toBe("current");
  });
  it("falls back to version numbers, and admits when it cannot tell", () => {
    expect(decideUpdate({ version: "0.1.0", release: "v0.2.0", missing: null }).state).toBe("behind");
    expect(decideUpdate({ version: "0.2.0", release: "v0.2.0", missing: null }).state).toBe("current");
    expect(decideUpdate({ version: "0.1.0", release: null, missing: null }).state).toBe("unknown");
  });
  it("with no releases yet, compares the running commit with main", async () => {
    const g = github({ "/releases/latest": { status: 404 }, [`/compare/${SHA}...main?per_page=1`]: { status: 200, body: { ahead_by: 4, behind_by: 0 } } });
    expect(await lookUpUpdate({ version: "0.1.0", commit: SHA, fetch: g.fetch })).toEqual({ state: "behind", latest: null, behindBy: 4 });
    expect(g.asked).toEqual(["/releases/latest", `/compare/${SHA}...main?per_page=1`]);
  });
  it("with releases, compares the running commit with the newest one", async () => {
    const g = github({ "/releases/latest": { status: 200, body: { tag_name: "v0.2.0" } }, [`/compare/${SHA}...v0.2.0?per_page=1`]: { status: 200, body: { ahead_by: 0, behind_by: 2 } } });
    expect(await lookUpUpdate({ version: "0.1.0", commit: SHA, fetch: g.fetch })).toEqual({ state: "current", latest: "v0.2.0", behindBy: 0 });
  });
  it("a commit GitHub has never seen falls back to version numbers", async () => {
    const g = github({ "/releases/latest": { status: 200, body: { tag_name: "v0.2.0" } }, [`/compare/${SHA}...v0.2.0?per_page=1`]: { status: 404 } });
    expect(await lookUpUpdate({ version: "0.1.0", commit: SHA, fetch: g.fetch })).toEqual({ state: "behind", latest: "v0.2.0", behindBy: null });
  });
  it("without a commit it asks only for the release", async () => {
    const g = github({ "/releases/latest": { status: 404 } });
    expect((await lookUpUpdate({ version: "0.1.0", commit: null, fetch: g.fetch })).state).toBe("unknown");
    expect(g.asked).toEqual(["/releases/latest"]);
  });
  it("fails when GitHub refuses, so the last good answer is kept", async () => {
    await expect(lookUpUpdate({ version: "0.1.0", commit: SHA, fetch: github({ "/releases/latest": { status: 403 } }).fetch })).rejects.toThrow("403");
  });
});
