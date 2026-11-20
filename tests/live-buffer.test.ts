import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";
import { TEST_ENV } from "@/server/testing/fixture";
import { holdLive, MAX_LIVE_BUFFER_MS, type BufferedReceiver } from "@/ui/live-buffer";

describe("holding live video before showing it", () => {
  it("sets the browser's target in milliseconds", () => {
    const r: BufferedReceiver = { jitterBufferTarget: null };
    expect(holdLive(r, 1000)).toBe("target");
    expect(r.jitterBufferTarget).toBe(1000);
  });
  it("uses the older setting, in seconds, where that is all the browser has", () => {
    const r: BufferedReceiver = { playoutDelayHint: null };
    expect(holdLive(r, 1500)).toBe("hint");
    expect(r.playoutDelayHint).toBe(1.5);
  });
  it("prefers the current setting when a browser has both", () => {
    const r: BufferedReceiver = { jitterBufferTarget: null, playoutDelayHint: null };
    holdLive(r, 1000);
    expect(r).toEqual({ jitterBufferTarget: 1000, playoutDelayHint: null });
  });
  it("never asks for more than browsers accept", () => {
    const r: BufferedReceiver = { jitterBufferTarget: null };
    holdLive(r, 60_000);
    expect(r.jitterBufferTarget).toBe(MAX_LIVE_BUFFER_MS);
  });
  it("leaves the stream alone when it is off or the value is nonsense", () => {
    for (const ms of [0, -5, Number.NaN]) {
      const r: BufferedReceiver = { jitterBufferTarget: null };
      expect(holdLive(r, ms)).toBe("none");
      expect(r.jitterBufferTarget).toBeNull();
    }
  });
  it("plays as before in a browser without either setting, or one that refuses the value", () => {
    expect(holdLive({}, 1000)).toBe("none");
    const refuses = Object.defineProperty({}, "jitterBufferTarget", { enumerable: true, get: () => null, set: () => { throw new RangeError("out of range"); } }) as BufferedReceiver;
    expect(holdLive(refuses, 1000)).toBe("none");
  });
});

describe("LIVE_BUFFER_MS", () => {
  const load = (v?: string) => loadConfig({ ...TEST_ENV, ...(v == null ? {} : { LIVE_BUFFER_MS: v }) } as unknown as NodeJS.ProcessEnv).LIVE_BUFFER_MS;
  it("is one second unless set, and 0 turns it off", () => {
    expect(load()).toBe(1000);
    expect(load("2500")).toBe(2500);
    expect(load("0")).toBe(0);
  });
  it("refuses values a browser would not accept", () => {
    expect(() => load("-1")).toThrow();
    expect(() => load(String(MAX_LIVE_BUFFER_MS + 1))).toThrow();
    expect(() => load("soon")).toThrow();
  });
});
