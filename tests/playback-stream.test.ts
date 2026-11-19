import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fragmentStart, frameReader, readPackets, RESUME, stampCollector, videoTrack } from "@/server/protect/playback-stream";

/**
 * Reading the recorder's GOP times from Protect's playback stream, on hand-built messages and MP4
 * boxes: no network.
 */

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const box = (type: string, ...body: Buffer[]) => { const b = Buffer.concat(body); return Buffer.concat([u32(8 + b.length), Buffer.from(type, "latin1"), b]); };
/** A full box: version and flags first. */
const full = (type: string, version: number, flags: number, ...body: Buffer[]) => box(type, u32((version << 24) | flags), ...body);

/** A track of the init segment: `tkhd` and `mdhd` in version 0 or 1 (64-bit times). */
function trak(id: number, timescale: number, handler: string, version = 0) {
  const times = Buffer.alloc(version ? 16 : 8);
  return box("trak",
    full("tkhd", version, 3, times, u32(id), Buffer.alloc(60)),
    box("mdia", full("mdhd", version, 0, times, u32(timescale), Buffer.alloc(8)), full("hdlr", 0, 0, u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12))));
}
const moov = (...traks: Buffer[]) => box("moov", full("mvhd", 0, 0, Buffer.alloc(96)), ...traks);
/** The init segment as the recorder sends it: sound first, then the picture (track 2, 90 kHz). */
const INIT = Buffer.concat([box("ftyp", Buffer.from("isom")), moov(trak(1, 48_000, "soun"), trak(2, 90_000, "vide", 1))]);

/**
 * A fragment's `moof` with one `traf` per [track, start in ticks, first-sample flags]: the flags go
 * in the `trun` (its first-sample flags, else per sample) or as the `tfhd` default, per `where`.
 */
function moof(trafs: [number, bigint, number | null][], where: "first" | "sample" | "default" = "first") {
  const traf = ([id, at, flags]: [number, bigint, number | null]) => {
    const def = where === "default" && flags != null;
    // tfhd: base data offset (0x1) and sample description (0x2) before the default flags, as allowed.
    const tfhd = full("tfhd", 0, def ? 0x20 | 0x1 | 0x2 : 0, u32(id), ...(def ? [u64(BigInt(0)), u32(1), u32(flags)] : []));
    const tfdt = full("tfdt", 1, 0, u64(at));
    let trun: Buffer;
    if (flags == null || where === "default") trun = full("trun", 0, 0x1, u32(2), u32(0));
    else if (where === "first") trun = full("trun", 0, 0x1 | 0x4, u32(2), u32(0), u32(flags));
    // Per sample: duration and size, then flags, for two samples.
    else trun = full("trun", 0, 0x1 | 0x100 | 0x200 | 0x400, u32(2), u32(0), u32(3000), u32(100), u32(flags), u32(3000), u32(100), u32(0x10000));
    return box("traf", tfhd, tfdt, trun);
  };
  return box("moof", full("mfhd", 0, 0, u32(1)), ...trafs.map(traf));
}
const KEY = 0x2000000, DELTA = 0x1010000;
/** Wall-clock ms to 90 kHz ticks: beyond 32 bits. */
const ticks = (ms: number) => BigInt(ms) * BigInt(90);
const T = 1_800_000_000_000;

/** A stream frame: 1-byte type, 3-byte length. */
const frame = (type: number, body: Buffer) => { const h = Buffer.alloc(4); h[0] = type; h.writeUIntBE(body.length, 1, 3); return Buffer.concat([h, body]); };

describe("the handshake", () => {
  it("reads compressed and plain JSON packets", () => {
    const plain = Buffer.from(JSON.stringify({ success: true })), packed = deflateSync(Buffer.from(JSON.stringify({ a: [1, 2] })));
    const head = (type: number, compressed: number, len: number) => Buffer.from([type, 1, compressed, 0, ...u32(len)]);
    expect(readPackets(Buffer.concat([head(1, 0, plain.length), plain, head(2, 1, packed.length), packed]))).toEqual([{ success: true }, { a: [1, 2] }]);
    expect(readPackets(RESUME)).toEqual([{ command: "resume" }, {}]);
  });

  it("refuses anything else", () => {
    const body = Buffer.from("{}");
    expect(() => readPackets(Buffer.concat([Buffer.from([1, 2, 0, 0, ...u32(body.length)]), body]))).toThrow();
    expect(() => readPackets(Buffer.concat([Buffer.from([1, 1, 0, 0, ...u32(10)]), body]))).toThrow();
  });
});

describe("the stream's frames", () => {
  it("come out whole however the messages cut them", () => {
    const frames: [number, Buffer][] = [[250, Buffer.from("init")], [249, Buffer.alloc(0)], [251, Buffer.alloc(300, 7)], [252, Buffer.alloc(70_000, 1)], [255, Buffer.alloc(0)]];
    const bytes = Buffer.concat(frames.map(([t, b]) => frame(t, b)));
    for (const cuts of [[], [1], [2, 3, 5, 6, 7, 8, 9], [10, 400, 401, 30_000], Array.from({ length: 200 }, (_, k) => k * 353 + 1)]) {
      const got: [number, Buffer][] = [], read = frameReader((t, b) => got.push([t, Buffer.from(b)]));
      let at = 0;
      for (const c of [...cuts.filter((c) => c < bytes.length), bytes.length]) { read(bytes.subarray(at, c)); at = c; }
      expect(got).toEqual(frames);
    }
  });
});

describe("the video track", () => {
  it("is found by its handler, with its id and clock from tkhd and mdhd", () => {
    expect(videoTrack(INIT)).toEqual({ id: 2, timescale: 90_000 });
    expect(videoTrack(moov(trak(7, 30_000, "vide")))).toEqual({ id: 7, timescale: 30_000 });
    expect(videoTrack(moov(trak(1, 48_000, "soun")))).toBeNull();
  });
});

describe("a fragment's start", () => {
  it("reads the video track's 64-bit start", () => {
    expect(fragmentStart(moof([[1, BigInt(99), KEY], [2, ticks(T), KEY]]), 2)).toEqual({ at: Number(ticks(T)), key: true });
    expect(fragmentStart(moof([[1, BigInt(99), KEY]]), 2)).toBeNull();
  });

  it("knows a fragment that starts without a keyframe, wherever the flags are", () => {
    for (const where of ["first", "sample", "default"] as const) {
      expect(fragmentStart(moof([[2, BigInt(0), DELTA]], where), 2)!.key).toBe(false);
      expect(fragmentStart(moof([[2, BigInt(0), KEY]], where), 2)!.key).toBe(true);
    }
    // No flags anywhere: a keyframe.
    expect(fragmentStart(moof([[2, BigInt(0), null]]), 2)!.key).toBe(true);
  });
});

describe("collecting the stamps", () => {
  /** The frames of one fragment, its moof cut in two. */
  const fragment = (m: Buffer) => [[249, Buffer.alloc(0)], [251, m.subarray(0, 20)], [251, m.subarray(20)], [252, Buffer.alloc(50)], [255, Buffer.alloc(0)]] as [number, Buffer][];

  it("gives each GOP's start in ms, a fragment without a keyframe joining the GOP before", () => {
    const c = stampCollector();
    for (const [t, b] of [[250, INIT] as [number, Buffer], ...fragment(moof([[1, BigInt(5), KEY], [2, ticks(T), KEY]])), ...fragment(moof([[2, ticks(T + 2000), KEY]])),
      ...fragment(moof([[2, ticks(T + 3000), DELTA]], "sample")), ...fragment(moof([[2, ticks(T + 4000) + BigInt(180), KEY]], "default"))]) c.frame(t, b);
    expect(c.stamps).toEqual([T, T + 2000, T + 4002]);
  });

  it("keeps a first fragment that starts without a keyframe", () => {
    const c = stampCollector();
    for (const [t, b] of [[250, INIT] as [number, Buffer], ...fragment(moof([[2, ticks(T), DELTA]])), ...fragment(moof([[2, ticks(T + 1000), KEY]]))]) c.frame(t, b);
    expect(c.stamps).toEqual([T, T + 1000]);
  });

  it("fails on a fragment without the video's time", () => {
    const c = stampCollector();
    c.frame(250, INIT);
    expect(() => { for (const [t, b] of fragment(moof([[1, BigInt(5), KEY]]))) c.frame(t, b); }).toThrow("no video time");
    // Nor without an init segment to name the video track.
    const d = stampCollector();
    expect(() => { for (const [t, b] of fragment(moof([[2, BigInt(0), KEY]]))) d.frame(t, b); }).toThrow("no video time");
  });
});
