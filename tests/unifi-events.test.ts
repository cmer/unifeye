import { describe, expect, it } from "vitest";
import { UnifiProtectAdapter } from "../src/server/protect/unifi";

/** A recorder with `n` motion events per camera, one a minute, answering the private events query. */
function recorder(cameras: string[], n: number, o: { refuseFilter?: boolean } = {}) {
  const all = cameras.flatMap((cam, c) => Array.from({ length: n }, (_, i) => ({ id: `${cam}-${i}`, type: "motion", start: 1_000_000 + i * 60_000 + c, end: 1_000_000 + i * 60_000 + c + 5000, camera: cam })));
  const paths: string[] = [];
  const adapter = new UnifiProtectAdapter("nvr", { host: "nvr.test", username: "u", password: "p", verifyTls: true });
  (adapter as unknown as { get: (p: string) => Promise<unknown> }).get = async (path: string) => {
    paths.push(path);
    const q = new URL(path, "https://x").searchParams, want = q.getAll("cameras");
    if (want.length && o.refuseFilter) return { statusCode: 400, json: () => ({}) };
    const rows = all.filter((e) => e.start >= Number(q.get("start")) && e.start <= Number(q.get("end")) && (!want.length || want.includes(e.camera)))
      .sort((a, b) => b.start - a.start).slice(0, Number(q.get("limit")));
    return { statusCode: 200, json: () => rows };
  };
  return { adapter, paths };
}

describe("UniFi events", () => {
  it("asks for the requested camera only and reaches the start of a busy day", async () => {
    // Twelve busy cameras would use up the page budget long before the morning without a filter.
    const cams = Array.from({ length: 12 }, (_, i) => `cam${i}`), { adapter, paths } = recorder(cams, 600);
    const out = await adapter.listEvents({ protectCameraIds: ["cam3"], fromMs: 0, toMs: 1e12, limit: 1000 });
    expect(out).toHaveLength(600);
    expect(out.every((e) => e.protectCameraId === "cam3")).toBe(true);
    expect(out.at(-1)!.id).toBe("cam3-0");
    expect(paths.every((p) => p.includes("&cameras=cam3"))).toBe(true);
  });

  it("falls back to filtering locally when the recorder refuses the camera filter", async () => {
    const { adapter, paths } = recorder(["a", "b"], 30, { refuseFilter: true });
    const out = await adapter.listEvents({ protectCameraIds: ["a"], fromMs: 0, toMs: 1e12, limit: 100 });
    expect(out).toHaveLength(30);
    expect(out.every((e) => e.protectCameraId === "a")).toBe(true);
    await adapter.listEvents({ protectCameraIds: ["a"], fromMs: 0, toMs: 1e12, limit: 100 });
    expect(paths.filter((p) => p.includes("cameras=")).length).toBe(1); // remembered, not retried every time
  });

  it("sees the thumbnail of a finished event in the shape the recorder sends", async () => {
    const adapter = new UnifiProtectAdapter("nvr", { host: "nvr.test", username: "u", password: "p", verifyTls: true });
    const rows = [
      { id: "done", type: "motion", start: 1000, end: 2000, camera: "a", thumbnail: "e-done" },
      { id: "open", type: "motion", start: 3000, end: null, camera: "a", thumbnail: "e-open" },
      { id: "none", type: "motion", start: 4000, end: 5000, camera: "a", thumbnail: null },
    ];
    (adapter as unknown as { get: () => Promise<unknown> }).get = async () => ({ statusCode: 200, json: () => rows });
    const out = await adapter.listEvents({ protectCameraIds: ["a"], fromMs: 0, toMs: 1e12, limit: 100 });
    expect(Object.fromEntries(out.map((e) => [e.id, e.hasThumbnail]))).toEqual({ done: true, open: false, none: false });
  });
});
