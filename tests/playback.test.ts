import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { highReachMs } from "@/server/media/placement";
import { skipLead, wallAt } from "@/server/media/timeline";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";
import { carryOnAt, cursorAt } from "@/ui/recorded-playback";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;

/**
 * Playback windows of the simulated adaptive camera, with real files: the mock recorder keeps high
 * resolution in seconds 12.5-21.5 of every half minute and low resolution everywhere but seconds
 * 15.5-18.5, in one-second GOPs starting half a second past each whole second, each picture showing
 * the moment it was recorded. The recorder's times run late on the high channel, by an amount that
 * depends on the half minute (`MockProtectAdapter.stampOf`), so the windows are picked by it.
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
    // A minute well inside a recorded stretch, whose high GOPs are stamped late enough that some
    // recorded before it are stamped inside it, and some recorded inside it are stamped after it
    // (minutes whose number is 4 more than a multiple of five).
    const t = Date.now() - 3 * 3600e3, r = (await f.adapter.recordingRanges("mock-06", t - 864e5, t)).ranges.find(([a, b]) => b - a > 12 * 60_000)!;
    ws = Math.ceil(r[0] / 60_000 + 2) * 60_000;
    while (Math.floor(ws / 60_000) % 5 !== 4) ws += 60_000;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("shows the high resolution over the low one, and fills the low one's gaps from it", async () => {
    const w = await window(cam, ws + 1000);
    expect(w.high).not.toBeNull();
    expect(w.info).toMatchObject({ startMs: ws, endMs: ws + 60_000, high: true });
    expect(w.info.pending).toBeUndefined();
    // Seconds into the window, as the entries play them (leads aside), to the half second. The
    // recorder's times date every GOP, and nothing past the window plays.
    const half = (ms: number) => Math.round(ms / 500) / 2;
    const order = w.info.entries.filter((e) => !e.lead).map((e) => [e.kind, half(e.at - ws), half(e.span)]);
    expect(order).toEqual([
      ["base", 0, 12.5], ["over", 12.5, 3], ["insert", 15.5, 3], ["over", 18.5, 3],
      ["base", 21.5, 21], ["over", 42.5, 3], ["insert", 45.5, 3], ["over", 48.5, 3], ["base", 51.5, 8.5],
    ]);
    // The lead: the low file's last keyframe before the window. High GOPs recorded before the window
    // belong to the window before, even those the recorder stamped inside this one.
    expect(w.info.entries.filter((e) => e.lead).map((e) => e.kind)).toEqual(["base"]);
    // Served from the cache the second time.
    expect(await window(cam, ws + 30_000)).toEqual(w);
  }, 30_000);

  /** Checks a window second by second against what the mock recorded: every moment shows once, in order, at its time. */
  const expectShownOnce = async (start: number) => {
    const w = await window(cam, start + 1000), end = start + 60_000;
    // What each file's GOPs show (one second each). The high file reaches past the window, for GOPs recorded in it and stamped after it.
    const low = f.adapter.adaptiveGops("mock-06", start, end, "wall").keys, high = f.adapter.adaptiveGops("mock-06", start, end + highReachMs(), "focus");
    const real = (keys: number[], s: number) => { const g = Math.floor(s + 1e-9); return keys[g] + (s - g) * 1000; };
    const samples: { shown: number; real: number }[] = [];
    for (const e of w.info.entries) {
      if (e.lead) continue;
      for (let x = 0; x < e.len - 1e-6; x += 0.1) samples.push({ shown: wallAt(e, x), real: e.kind === "base" ? real(low, e.base + x) : real(high.keys, e.high! + x) });
    }
    let latest = -Infinity;
    for (const { shown, real: r } of samples) {
      expect(Math.abs(shown - r)).toBeLessThan(1000);
      expect(r).toBeGreaterThan(latest - 1);
      latest = Math.max(latest, r);
    }
    // Every second of the window plays once: ten samples a second.
    const perSecond = Array.from({ length: 60 }, (_, k) => samples.filter((x) => x.real >= start + k * 1000 && x.real < start + (k + 1) * 1000).length);
    expect(perSecond).toEqual(perSecond.map(() => 10));
    return high;
  };

  it("shows every recorded moment once, in order and at its time, though the recorder stamps the high resolution late", async () => {
    const high = await expectShownOnce(ws), end = ws + 60_000;
    expect(high.stamps.some((s, g) => s >= ws && high.keys[g] < ws)).toBe(true);
    expect(high.stamps.some((s, g) => s >= end && high.keys[g] < end)).toBe(true);
  }, 30_000);

  // The minute after: stamps 3 s late in its first half, 5 s in its second, growing half a second a
  // GOP, which is not a whole number of steps of the lag search.
  it("shows every moment of a minute whose stamps grow by half a second a GOP", async () => {
    await expectShownOnce(ws + 60_000);
  }, 30_000);

  it("answers with the low resolution alone first, while the high resolution is placed", async () => {
    const early = await window(cam, ws + 121_000, true);
    expect(early.info).toMatchObject({ pending: true, high: false });
    expect(early.high).toBeNull();
    expect(early.info.entries.every((e) => e.kind === "base")).toBe(true);
    const full = await window(cam, ws + 121_000);
    expect(full.info.pending).toBeUndefined();
    expect(full.high).not.toBeNull();
    expect(full.base).toBe(early.base);
    // Once placed, the early answer is the full one.
    expect(await window(cam, ws + 121_000, true)).toEqual(full);
  }, 30_000);

  it("starts a window inside the GOP the window before ended with, when that GOP is the last before a gap", async () => {
    // Fifteen-second windows: the one at second 15 of a half minute opens with the low file's last GOP
    // before its gap, which runs from half a second before the window to half a second into it.
    const dir15 = mkdtempSync(join(tmpdir(), "unifeye-pb15-"));
    setConfigForTests(loadConfig({ ...TEST_ENV, MEDIA_CACHE_DIR: dir15, PLAYBACK_WINDOW_SECONDS: "15" } as NodeJS.ProcessEnv));
    try {
      const at = ws + 15_000, prev = await window(cam, ws + 1000), next = await window(cam, at);
      const k = next.info.entries.findIndex((e) => e.lead && e.kind === "base"), lead = next.info.entries[k];
      expect(lead.at - at).toBe(-500);
      // The window before ended with the same GOP, so playing on starts past the lead, where the
      // window before stopped: nothing shows twice or not at all ...
      expect(prev.info.seams.base.last).toBe(next.info.seams.base.first);
      const i = carryOnAt(prev.info, next.info), last = prev.info.entries[prev.info.entries.length - 1];
      expect(i).toBe(skipLead(next.info.entries));
      expect(next.info.entries[i].at).toBe(last.at + last.span);
      // ... while a seek to the window's first moment lands half a second into that GOP.
      expect(cursorAt(next.info.entries, at)).toMatchObject({ base: 0.5 });
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
