/**
 * Reads the recorder's time for every GOP of a stretch from Protect's playback stream, the websocket
 * its own timeline player uses (`/proxy/protect/ws/playback`). The stream is the same run of GOPs an
 * export of that stretch holds, cut into one fragment per GOP, and each fragment says when its
 * first frame was recorded (the video track's `tfdt`, counted from 1970). An export has no times
 * inside at all, so this is the only way to learn them. Only the times are kept here; the media
 * itself still comes from the export.
 *
 * The stream is not part of Protect's published API (seen on Protect 7.3): anything unexpected gives
 * null and callers carry on without stamps. It only reads.
 *
 * Framing, as Protect's web player reads it: the first message is a header and a body packet (8-byte
 * head: type, format, compressed flag, 0, length; JSON), `success` in the header. The stream starts
 * once the client sends a `resume` command in the same form. Then come frames with a 1-byte type and
 * a 3-byte length, which may span messages: 249 opens a fragment, 250 is the file header (`moov`),
 * 251 a part of the fragment header (`moof`), 252 to 254 media, 255 closes the fragment. The recorder
 * never closes the socket, so the end is a short silence after the last fragment.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { WebSocket, type Dispatcher } from "undici";

const BEGIN = 249, INIT = 250, MOOF = 251, END = 255;
/** Silence that ends the stream once fragments have arrived, and the wait for the first one. */
const QUIET_MS = 500, FIRST_MS = 5000, LIMIT_MS = 60_000;

function packet(type: number, value: unknown): Buffer {
  const body = deflateSync(Buffer.from(JSON.stringify(value))), head = Buffer.alloc(8);
  head[0] = type; head[1] = 1; head[2] = 1; head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
/** The command that starts the stream. */
export const RESUME = Buffer.concat([packet(1, { command: "resume" }), packet(2, {})]);

/** The JSON packets of a handshake message; throws on anything else. */
export function readPackets(b: Buffer): unknown[] {
  const out: unknown[] = [];
  for (let o = 0; o + 8 <= b.length; ) {
    const len = b.readUInt32BE(o + 4), raw = b.subarray(o + 8, o + 8 + len);
    if (b[o + 1] !== 1 || raw.length < len) throw new Error("unexpected handshake");
    out.push(JSON.parse((b[o + 2] ? inflateSync(raw) : raw).toString()));
    o += 8 + len;
  }
  return out;
}

/** Top-level boxes of `b` as [type, body]. */
function* boxes(b: Buffer): Generator<[string, Buffer]> {
  for (let o = 0; o + 8 <= b.length; ) {
    let size = b.readUInt32BE(o), head = 8;
    if (size === 1 && o + 16 <= b.length) { size = Number(b.readBigUInt64BE(o + 8)); head = 16; }
    if (size < head || o + size > b.length) return;
    yield [b.toString("latin1", o + 4, o + 8), b.subarray(o + head, o + size)];
    o += size;
  }
}
const child = (b: Buffer, type: string) => { for (const [t, body] of boxes(b)) if (t === type) return body; return null; };

/** The video track of a `moov`: its id and how many ticks its clock counts per second. */
export function videoTrack(moov: Buffer): { id: number; timescale: number } | null {
  const m = child(moov, "moov") ?? moov;
  for (const [t, trak] of boxes(m)) {
    if (t !== "trak") continue;
    const tkhd = child(trak, "tkhd"), mdia = child(trak, "mdia"), mdhd = mdia && child(mdia, "mdhd"), hdlr = mdia && child(mdia, "hdlr");
    if (!tkhd || !mdhd || !hdlr || hdlr.toString("latin1", 8, 12) !== "vide") continue;
    const id = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12), timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
    if (timescale > 0) return { id, timescale };
  }
  return null;
}

/**
 * When a fragment's first frame of track `id` was recorded, in the track's ticks, and whether that
 * frame is a keyframe; null when the fragment has no such track. The recorder cuts a GOP in two
 * where one of its own files ends, and the second half then starts without a keyframe.
 */
export function fragmentStart(moof: Buffer, id: number): { at: number; key: boolean } | null {
  const m = child(moof, "moof") ?? moof;
  for (const [t, traf] of boxes(m)) {
    if (t !== "traf") continue;
    const tfhd = child(traf, "tfhd"), tfdt = child(traf, "tfdt"), trun = child(traf, "trun");
    if (!tfhd || !tfdt || tfhd.readUInt32BE(4) !== id) continue;
    // The first sample's flags: its own, else the run's, else the fragment's default. Bit 16 set: not a keyframe.
    let flags: number | null = null;
    const hf = tfhd.readUInt32BE(0) & 0xffffff;
    if (hf & 0x20) { const o = 8 + (hf & 0x1 ? 8 : 0) + (hf & 0x2 ? 4 : 0) + (hf & 0x8 ? 4 : 0) + (hf & 0x10 ? 4 : 0); if (o + 4 <= tfhd.length) flags = tfhd.readUInt32BE(o); }
    if (trun && trun.length >= 8) {
      const rf = trun.readUInt32BE(0) & 0xffffff, o = 8 + (rf & 0x1 ? 4 : 0);
      if (rf & 0x4) { if (o + 4 <= trun.length) flags = trun.readUInt32BE(o); }
      else if (rf & 0x400) { const s = o + (rf & 0x100 ? 4 : 0) + (rf & 0x200 ? 4 : 0); if (s + 4 <= trun.length) flags = trun.readUInt32BE(s); }
    }
    return { at: tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4), key: flags == null || !(flags & 0x10000) };
  }
  return null;
}

/** Splits the stream into frames as bytes arrive; `onFrame` gets each whole one. */
export function frameReader(onFrame: (type: number, body: Buffer) => void): (chunk: Buffer) => void {
  let acc: Buffer = Buffer.alloc(0);
  return (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    while (acc.length >= 4) {
      const len = acc.readUIntBE(1, 3);
      if (acc.length < 4 + len) break;
      onFrame(acc[0], acc.subarray(4, 4 + len));
      acc = acc.subarray(4 + len);
    }
  };
}

/** Collects each GOP's start in wall-clock ms from the frames of a stream. */
export function stampCollector(): { frame: (type: number, body: Buffer) => void; stamps: number[] } {
  const stamps: number[] = [];
  let track: { id: number; timescale: number } | null = null, moof: Buffer[] | null = null;
  return {
    stamps,
    frame(type, body) {
      if (type === INIT) track ??= videoTrack(body);
      else if (type === BEGIN) moof = [];
      else if (type === MOOF) moof?.push(Buffer.from(body));
      else if (type === END && moof) {
        const start = track ? fragmentStart(Buffer.concat(moof), track.id) : null;
        moof = null;
        if (!start || !track) throw new Error("a fragment has no video time");
        // A fragment that starts without a keyframe carries on the GOP before it.
        if (start.key || !stamps.length) stamps.push(Math.round((start.at / track.timescale) * 1000));
      }
    },
  };
}

/**
 * The recorder's wall-clock ms for each GOP of `url`'s stretch, in order. Null when the recorder
 * refuses, has nothing there, or answers in a way this does not understand.
 */
export function readStamps(url: string, o: { headers: Record<string, string>; dispatcher?: Dispatcher; signal?: AbortSignal }): Promise<number[] | null> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket, started = false, done = false, quiet: NodeJS.Timeout | undefined;
    const collect = stampCollector(), read = frameReader((t, b) => collect.frame(t, b));
    const finish = (v: number[] | null, err?: unknown) => {
      if (done) return;
      done = true; clearTimeout(quiet); clearTimeout(limit); o.signal?.removeEventListener("abort", onAbort);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(v);
    };
    const onAbort = () => finish(null, o.signal!.reason ?? new Error("aborted"));
    const wait = (ms: number) => { clearTimeout(quiet); quiet = setTimeout(() => finish(started ? collect.stamps : null), ms); };
    const limit = setTimeout(() => finish(null), LIMIT_MS);
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try { ws = new WebSocket(url, { headers: o.headers, dispatcher: o.dispatcher }); } catch { return finish(null); }
    ws.binaryType = "arraybuffer";
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(started ? collect.stamps : null);
    ws.onmessage = (m) => {
      try {
        const data = Buffer.from(m.data as ArrayBuffer);
        if (!started) {
          const head = readPackets(data)[0] as { success?: boolean } | undefined;
          if (head?.success !== true) return finish(null);
          started = true;
          ws.send(RESUME);
          return wait(FIRST_MS);
        }
        read(data);
        wait(collect.stamps.length ? QUIET_MS : FIRST_MS);
      } catch { finish(null); }
    };
  });
}
