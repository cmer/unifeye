import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

const DAY = 864e5;
const env = (over: Record<string, string> = {}) => setConfigForTests(loadConfig({ ...TEST_ENV, ...over } as unknown as NodeJS.ProcessEnv));

let f: Fixture;
beforeEach(() => { f = makeFixture(); vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("session lifetime", () => {
  it("lasts 30 days by default, however long it goes unused", () => {
    const { token, session } = f.sessions.create(f.u.admin, {});
    expect(session.absoluteExpiresAt - session.createdAt).toBe(30 * DAY);
    vi.setSystemTime(Date.now() + 29 * DAY);
    expect(f.sessions.load(token)).toBeDefined();
    vi.setSystemTime(Date.now() + DAY);
    expect(f.sessions.load(token)).toBeUndefined();
  });

  it("follows SESSION_DAYS", () => {
    env({ SESSION_DAYS: "2" });
    const { token } = f.sessions.create(f.u.admin, {});
    vi.setSystemTime(Date.now() + 2 * DAY - 1000);
    expect(f.sessions.load(token)).toBeDefined();
    vi.setSystemTime(Date.now() + 1000);
    expect(f.sessions.load(token)).toBeUndefined();
  });

  it("ends after SESSION_IDLE_MINUTES without use when set, and use extends it", () => {
    env({ SESSION_IDLE_MINUTES: "60" });
    const { token } = f.sessions.create(f.u.admin, {});
    vi.setSystemTime(Date.now() + 50 * 6e4);
    expect(f.sessions.load(token)).toBeDefined();
    vi.setSystemTime(Date.now() + 50 * 6e4);
    expect(f.sessions.load(token)).toBeDefined();
    vi.setSystemTime(Date.now() + 61 * 6e4);
    expect(f.sessions.load(token)).toBeUndefined();
  });

  it("refuses the old SESSION_ABSOLUTE_HOURS setting", () => {
    expect(() => env({ SESSION_ABSOLUTE_HOURS: "168" })).toThrow(/replaced by SESSION_DAYS/);
  });
});
