import { describe, expect, it, vi } from "vitest";
import { UnifiProtectAdapter } from "../src/server/protect/unifi";

/** A recorder that gives stills from recordings only for the cameras in `gives`. */
function recorder(gives: Set<string>) {
  const asked: string[] = [];
  const adapter = new UnifiProtectAdapter("nvr", { host: "nvr.test", username: "u", password: "p", verifyTls: true });
  (adapter as unknown as { get: (p: string) => Promise<unknown> }).get = async (path: string) => {
    const cam = path.split("/")[2];
    asked.push(cam);
    return gives.has(cam) ? { statusCode: 200, body: Buffer.from("jpeg") } : { statusCode: 404, body: Buffer.from('{"error":"Recording not found"}') };
  };
  return { adapter, asked, still: (cam: string) => adapter.snapshot(cam, { atMs: 1_000_000 }) };
}

describe("UniFi stills from recordings", () => {
  it("stops asking the recorder for a camera that never gives one, and tries again later", async () => {
    vi.useFakeTimers();
    try {
      const { asked, still } = recorder(new Set());
      for (let i = 0; i < 5; i++) await expect(still("thirdparty")).rejects.toMatchObject({ name: "NoRecordingError" });
      expect(asked).toHaveLength(3); // the last two never reached the recorder
      vi.advanceTimersByTime(30 * 60_000 + 1);
      await expect(still("thirdparty")).rejects.toMatchObject({ name: "NoRecordingError" });
      expect(asked).toHaveLength(4); // one more try after the pause, then skipped again
      await expect(still("thirdparty")).rejects.toMatchObject({ name: "NoRecordingError" });
      expect(asked).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });
  it("keeps asking for a camera that has given one, so gaps in its recording do not turn previews off", async () => {
    const gives = new Set(["unifi"]), { asked, still } = recorder(gives);
    expect((await still("unifi")).toString()).toBe("jpeg");
    gives.delete("unifi"); // a gap in the recording
    for (let i = 0; i < 5; i++) await expect(still("unifi")).rejects.toMatchObject({ name: "NoRecordingError" });
    expect(asked).toHaveLength(6);
  });
});
