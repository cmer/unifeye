import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { skipLead } from "@/server/media/timeline";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";
import { carryOnAt, cursorAt } from "@/ui/recorded-playback";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;

/**
 * Playback windows of the simulated adaptive camera, with real files: the mock recorder keeps high
 * resolution in seconds 12.5-21.5 of every half minute and low resolution everywhere but seconds
 * 15.5-18.5, in one-second GOPs starting half a second past each whole second, each picture showing
 * the moment it was recorded.
 */
describe.skipIf(!hasFfmpeg)("adaptive playback windows", () => {
  let f: Fixture, cam: string, ws: number;
  const dir = mkdtempSync(join(tmpdir(), "unifeye-pb-"));
  const window = (camera: string, t: number, early = false) => f.s.recordings.window(f.actor(f.u.admin), camera, t, undefined, early);
  beforeAll(async () => {
    f = makeFixture();
    setConfigForTests(loadConfig({ ...TEST_ENV, MEDIA_CACHE_DIR: dir } as NodeJS.ProcessEnv));
    cam = f.cam["Upper Lounge"];
    f.adapter.adaptive.add("mock-06");
    // A minute well inside a recorded stretch.
    const t = Date.now() - 3 * 3600e3, r = (await f.adapter.recordingRanges("mock-06", t - 864e5, t)).ranges.find(([a, b]) => b - a > 5 * 60_000)!;
    ws = Math.floor(r[0] / 60_000) * 60_000 + 2 * 60_000;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("shows the high resolution over the low one, and fills the low one's gaps from it", async () => {
    const w = await window(cam, ws + 1000);
    expect(w.high).not.toBeNull();
    expect(w.info).toMatchObject({ startMs: ws, endMs: ws + 60_000, high: true });
    expect(w.info.pending).toBeUndefined();
    // Seconds into the window, as the entries play them (leads aside), to the half second: the first
    // ones are dated within half a second, since the recorder lists no keyframe inside a recorded run.
    const half = (ms: number) => Math.round(ms / 500) / 2;
    const order = w.info.entries.filter((e) => !e.lead).map((e) => [e.kind, half(e.at - ws), half(e.span)]);
    expect(order).toEqual([
      ["base", 0, 12], ["over", 12.5, 3], ["insert", 15.5, 3], ["over", 18.5, 3],
      ["base", 21.5, 21], ["over", 42.5, 3], ["insert", 45.5, 3], ["over", 48.5, 3], ["base", 51.5, 9],
    ]);
    // The leads: the high file's last keyframe before the window, then the low file's.
    expect(w.info.entries.filter((e) => e.lead).map((e) => e.kind)).toEqual(["insert", "base"]);
    // Served from the cache the second time.
    expect(await window(cam, ws + 30_000)).toEqual(w);
  }, 30_000);

  it("answers with the low resolution alone first, while the high resolution is placed", async () => {
    const early = await window(cam, ws + 61_000, true);
    expect(early.info).toMatchObject({ pending: true, high: false });
    expect(early.high).toBeNull();
    expect(early.info.entries.every((e) => e.kind === "base")).toBe(true);
    const full = await window(cam, ws + 61_000);
    expect(full.info.pending).toBeUndefined();
    expect(full.high).not.toBeNull();
    expect(full.base).toBe(early.base);
    // Once placed, the early answer is the full one.
    expect(await window(cam, ws + 61_000, true)).toEqual(full);
  }, 30_000);

  it("starts a window inside the GOP the window before ended with, when that GOP is the last before a gap", async () => {
    // Fifteen-second windows: the one at second 15 of a half minute opens with the low file's last GOP
    // before its gap, which runs from half a second before the window to half a second into it.
    const dir15 = mkdtempSync(join(tmpdir(), "unifeye-pb15-"));
    setConfigForTests(loadConfig({ ...TEST_ENV, MEDIA_CACHE_DIR: dir15, PLAYBACK_WINDOW_SECONDS: "15" } as NodeJS.ProcessEnv));
    try {
      const at = ws + 15_000, prev = await window(cam, ws + 1000), next = await window(cam, at);
      const k = next.info.entries.findIndex((e) => e.lead && e.kind === "base"), lead = next.info.entries[k];
      expect([lead.at - at, lead.span]).toEqual([-500, 1000]);
      // The window before ended with the same GOP, so playing on starts past it ...
      expect(prev.info.seams.base.last).toBe(next.info.seams.base.first);
      expect(carryOnAt(prev.info, next.info)).toBe(skipLead(next.info.entries));
      // ... while a seek to the window's first moment lands half a second into it, a moment already shown.
      expect(cursorAt(next.info.entries, at)).toMatchObject({ i: k, base: 0.5 });
    } finally {
      setConfigForTests(loadConfig({ ...TEST_ENV, MEDIA_CACHE_DIR: dir } as NodeJS.ProcessEnv));
      rmSync(dir15, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps a single file for cameras without adaptive recording", async () => {
    const w = await window(f.cam["Upper Hallway East"], ws + 1000);
    expect(w.high).toBeNull();
    expect(w.info.high).toBe(false);
    expect(w.info.entries.every((e) => e.kind === "base")).toBe(true);
  }, 30_000);
});
