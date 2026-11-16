import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { alignSpans } from "@/server/media/align";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;

/** Loudness curve made of random 50 ms steps, like speech or playground noise. */
function noise(n: number, seed: number) {
  const out = new Float64Array(n); let v = 0;
  for (let i = 0; i < n; i++) { if (i % 5 === 0) { seed = (seed * 1103515245 + 12345) % 2 ** 31; v = (seed / 2 ** 31) * 6; } out[i] = v; }
  return out;
}

describe("alignSpans", () => {
  it("places one stretch, and two stretches joined into one export", () => {
    const base = noise(6000, 7);
    expect(alignSpans(base.slice(1200, 3000), base)).toEqual([{ at: 12, from: 0, len: 18 }]);
    const joined = new Float64Array(1800); joined.set(base.slice(1400, 2300)); joined.set(base.slice(4400, 5300), 900);
    const spans = alignSpans(joined, base);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ at: 14, from: 0 }); expect(spans[0].len).toBeGreaterThanOrEqual(8.75);
    expect(spans[1].at - spans[1].from).toBeCloseTo(35, 5); expect(spans[1].from + spans[1].len).toBeCloseTo(18, 5); expect(spans[1].from).toBeLessThanOrEqual(9.25);
  });
  it("places nothing from unrelated or silent audio", () => {
    expect(alignSpans(noise(1800, 99), noise(6000, 7))).toEqual([]);
    expect(alignSpans(new Float64Array(1800), noise(6000, 7))).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)("adaptive playback windows", () => {
  let f: Fixture, cam: string, ws: number;
  const dir = mkdtempSync(join(tmpdir(), "unifeye-pb-"));
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

  it("uses the low channel as the base and places the high-resolution stretches over it", async () => {
    const w = await f.s.recordings.window(f.actor(f.u.admin), cam, ws + 1000);
    expect(w.info.leadMs).toBeGreaterThanOrEqual(1900); expect(w.info.leadMs).toBeLessThanOrEqual(2100);
    expect(w.high).not.toBeNull();
    // Motion at seconds 12-21 and 42-51 of the minute; the base starts 2 s before the minute.
    expect(w.info.overlay).toHaveLength(2);
    const [a, b] = w.info.overlay;
    expect(a.at - a.from).toBeCloseTo(14, 1); expect(a.from).toBe(0); expect(a.len).toBeGreaterThanOrEqual(8.5);
    expect(b.at - b.from).toBeCloseTo(35, 1); expect(b.from + b.len).toBeCloseTo(18, 1); expect(b.from).toBeLessThanOrEqual(9.5);
    // Served from the cache the second time.
    expect(await f.s.recordings.window(f.actor(f.u.admin), cam, ws + 30_000)).toEqual(w);
  }, 30_000);

  it("keeps a single file for cameras without adaptive recording", async () => {
    const w = await f.s.recordings.window(f.actor(f.u.admin), f.cam["Upper Hallway East"], ws + 1000);
    expect(w.high).toBeNull(); expect(w.info.overlay).toEqual([]);
  }, 30_000);
});
