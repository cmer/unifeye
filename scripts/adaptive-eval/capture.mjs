/**
 * Captures one dataset for the adaptive matching harness (see README.md) from a UniFi Protect
 * recorder. Read-only: it signs in with Unifeye's recorder account and only asks for exports, segment
 * lists and camera details. It changes nothing on the recorder.
 *
 * Run it inside the Unifeye app container, which has the recorder's address and account in its
 * environment (PROTECT_HOST, PROTECT_USERNAME, PROTECT_PASSWORD), by piping it to node:
 *
 *   docker compose exec -T app node --input-type=module - list < capture.mjs
 *       lists the cameras recording in adaptive mode (Protect camera id and name)
 *   docker compose exec -T app node --input-type=module - <camera id> <start ms> [minutes=5] [out dir=/tmp/adaptive-eval] < capture.mjs
 *       writes lo.mp4 (channel 2), hi.mp4 (channel 0), segs.json, stamps.json and meta.json to the out dir.
 *       The high channel (export and stamps) runs 60 s past the window, because the recorder stamps
 *       high-resolution GOPs up to about 35 s late; meta.json says so (highExtendMs).
 *   docker compose exec -T app node --input-type=module - stamps <camera id> <start ms> <end ms> < capture.mjs
 *       prints {"lo":[...],"hi":[...]} on stdout for a dataset captured before stamps existed
 *       (both channels over exactly the window)
 *
 * stamps.json holds the recorder's wall-clock ms for each GOP of each file, read from Protect's
 * playback websocket (the same GOPs as the export, in the same order).
 *
 * The recorder drops the connection when asked for many exports at once, so requests are paced and
 * retried. Fill in meta.json's clockCrop before labelling (see label.mts).
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const origin = `https://${process.env.PROTECT_HOST}`;
const HIGH_EXTEND_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn() {
  const root = await fetch(origin), tok = root.headers.get("x-csrf-token");
  const r = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { "x-csrf-token": tok } : {}) },
    body: JSON.stringify({ username: process.env.PROTECT_USERNAME, password: process.env.PROTECT_PASSWORD, rememberMe: false, token: "" }),
  });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith("TOKEN="));
  if (!cookie) throw new Error("sign-in gave no session");
  return { cookie: cookie.split(";")[0], "x-csrf-token": r.headers.get("x-updated-csrf-token") ?? r.headers.get("x-csrf-token") ?? "" };
}

async function getJson(headers, path) {
  const r = await fetch(`${origin}/proxy/protect/api${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** Minutes east of UTC in a time zone at a moment, e.g. -300 for UTC-5. */
function utcOffset(timeZone, ms) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

async function exportTo(headers, camera, startMs, endMs, channel, file) {
  for (let attempt = 1; ; attempt++) {
    await sleep(400);
    try {
      const t = Date.now();
      const r = await fetch(`${origin}/proxy/protect/api/video/export?camera=${camera}&start=${startMs}&end=${endMs}&channel=${channel}`, { headers });
      if (!r.ok) throw new Error(`export of channel ${channel}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
      console.log(`channel ${channel}: ${fs.statSync(file).size} bytes in ${Date.now() - t} ms`);
      return;
    } catch (e) {
      fs.rmSync(file, { force: true });
      if (attempt >= 3) throw e;
      console.log(`channel ${channel}: ${e.message}; trying again`);
      await sleep(3000);
    }
  }
}

/** The `tfdt` (epoch ms) of the video track of every GOP the recorder's playback stream sends for a window. */
function stampsOf(headers, camera, channel, startMs, endMs) {
  const url = `wss://${process.env.PROTECT_HOST}/proxy/protect/ws/playback?camera=${encodeURIComponent(camera)}&channel=${channel}&end=${endMs}&format=FMP4&lens=0&start=${startMs}`;
  // A packet: 8-byte header (type, format, deflated, 0, 4-byte length) then the payload.
  const packet = (type, obj) => {
    const body = zlib.deflateSync(Buffer.from(JSON.stringify(obj))), head = Buffer.alloc(8);
    head[0] = type; head[1] = 1; head[2] = 1; head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  // The boxes of an MP4 fragment, as [path, body]; only the ones holding others are entered.
  const boxes = (b, path = "") => {
    const out = [];
    for (let o = 0; o + 8 <= b.length;) {
      const size = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
      if (size < 8) break;
      const body = b.subarray(o + 8, o + size);
      out.push([path + type, body]);
      if (["moof", "traf"].includes(type)) out.push(...boxes(body, path + type + "/"));
      o += size;
    }
    return out;
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.binaryType = "arraybuffer";
    const stamps = [];
    let first = true, acc = Buffer.alloc(0), moofs = null, idle, finished = false;
    const finish = (err) => { if (finished) return; finished = true; clearTimeout(idle); try { ws.close(); } catch {} if (err) reject(err); else resolve(stamps); };
    // The server never closes the stream: it is over when nothing has come for 3 s.
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => finish(), 3000); };
    bump();
    ws.onerror = (e) => finish(new Error(`playback stream: ${e.message ?? "error"}`));
    ws.onclose = () => finish();
    ws.onmessage = (m) => {
      bump();
      const d = Buffer.from(m.data);
      if (first) { // the handshake; answer it with "resume"
        first = false;
        ws.send(Buffer.concat([packet(1, { command: "resume" }), packet(2, {})]));
        return;
      }
      acc = Buffer.concat([acc, d]);
      // Frames: 1 byte type, 3 bytes length, payload. 249 starts a GOP, 251 is a moof, 255 ends it.
      while (acc.length >= 4) {
        const type = acc[0], len = acc.readUIntBE(1, 3);
        if (acc.length < 4 + len) break;
        const p = acc.subarray(4, 4 + len);
        acc = acc.subarray(4 + len);
        if (type === 249) moofs = [];
        else if (type === 251 && moofs) moofs.push(Buffer.from(p));
        else if (type === 255 && moofs) {
          // The video track's time, and whether its first frame is a keyframe (bit 16 of its flags clear).
          // The recorder cuts a GOP in two where one of its own files ends; the second half starts
          // without a keyframe and belongs to the GOP before, as in the export.
          let track = null, at = null, flags = null;
          for (const [path, body] of boxes(Buffer.concat(moofs))) {
            if (path.endsWith("tfhd")) {
              track = body.readUInt32BE(4);
              const f = body.readUInt32BE(0) & 0xffffff, o = 8 + (f & 1 ? 8 : 0) + (f & 2 ? 4 : 0) + (f & 8 ? 4 : 0) + (f & 16 ? 4 : 0);
              if (track === 1 && f & 32 && o + 4 <= body.length) flags = body.readUInt32BE(o);
            } else if (track !== 1) continue;
            else if (path.endsWith("tfdt")) at = body[0] === 1 ? Number(body.readBigUInt64BE(4)) : body.readUInt32BE(4);
            else if (path.endsWith("trun")) {
              const f = body.readUInt32BE(0) & 0xffffff, o = 8 + (f & 1 ? 4 : 0);
              if (f & 4) flags = body.readUInt32BE(o);
              else if (f & 0x400) flags = body.readUInt32BE(o + (f & 0x100 ? 4 : 0) + (f & 0x200 ? 4 : 0));
            }
          }
          if (at != null && (!stamps.length || flags == null || !(flags & 0x10000))) stamps.push(at);
          moofs = null;
        }
      }
    };
  });
}

/** Both channels' stamps, paced and retried like the exports; a window with none is tried again. */
async function stampsBoth(headers, camera, lo, hi) {
  const out = {};
  for (const [key, channel, [a, b]] of [["lo", 2, lo], ["hi", 0, hi]]) {
    for (let attempt = 1; ; attempt++) {
      await sleep(500);
      try {
        out[key] = await stampsOf(headers, camera, channel, a, b);
        if (!out[key].length) throw new Error("no GOPs came");
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`stamps of channel ${channel}: ${e.message}`);
        await sleep(3000);
      }
    }
  }
  return out;
}

try {
  const [cmd, startArg, minutes = "5", out = "/tmp/adaptive-eval"] = process.argv.slice(2);
  if (!cmd) throw new Error("usage: node - list | stamps <camera id> <start ms> <end ms> | <camera id> <start ms> [minutes] [out dir]");
  const headers = await signIn();
  if (cmd === "list") {
    for (const c of await getJson(headers, "/cameras")) if (c.recordingSettings?.mode === "adaptive") console.log(`${c.id}  ${c.name}`);
    process.exit(0);
  }
  if (cmd === "stamps") {
    const [camera, a, b] = [startArg, minutes, out], s = Number(a), e = Number(b);
    if (!camera || !(e > s)) throw new Error("usage: node - stamps <camera id> <start ms> <end ms>");
    console.log(JSON.stringify(await stampsBoth(headers, camera, [s, e], [s, e])));
    process.exit(0);
  }
  const camera = cmd, startMs = Number(startArg), endMs = startMs + Number(minutes) * 60_000;
  if (!Number.isFinite(startMs) || !(endMs > startMs)) throw new Error("start must be ms since the epoch, minutes a positive number");
  const cam = await getJson(headers, `/cameras/${encodeURIComponent(camera)}`);
  if (cam.recordingSettings?.mode !== "adaptive") console.log(`warning: ${cam.name} records in "${cam.recordingSettings?.mode}" mode, not adaptive`);
  const nvr = await getJson(headers, "/nvr").catch(() => ({}));
  fs.mkdirSync(out, { recursive: true });
  await exportTo(headers, camera, startMs, endMs, 2, `${out}/lo.mp4`);
  // The high channel runs past the window: its stamps come up to ~35 s late.
  const highEndMs = endMs + HIGH_EXTEND_MS;
  await exportTo(headers, camera, startMs, highEndMs, 0, `${out}/hi.mp4`);
  const stamps = await stampsBoth(headers, camera, [startMs, endMs], [startMs, highEndMs]);
  fs.writeFileSync(`${out}/stamps.json`, JSON.stringify(stamps));
  // Like the product (recordedSegments in src/server/protect/unifi.ts): a narrow query only lists
  // segments that start inside it, so ask from 30 minutes earlier.
  const segs = {};
  for (const [key, resolution] of [["lo", 2], ["hi", 0]]) {
    await sleep(400);
    const rows = await getJson(headers, `/cameras/${encodeURIComponent(camera)}/playback-history?start=${startMs - 30 * 60_000}&end=${endMs}&resolution=${resolution}`);
    segs[key] = rows.filter((x) => typeof x?.start === "number" && typeof x.end === "number" && x.end >= x.start).map((x) => [x.start, x.end]);
  }
  fs.writeFileSync(`${out}/segs.json`, JSON.stringify(segs));
  const meta = {
    camera: { id: camera, name: cam.name },
    startMs, endMs,
    utcOffsetMinutes: nvr.timezone ? utcOffset(nvr.timezone, startMs) : null,
    highExtendMs: HIGH_EXTEND_MS,
    clockCrop: { lo: "", hi: "" },
    notes: `Captured ${new Date().toISOString().slice(0, 10)} with capture.mjs from a recorder on Protect ${nvr.version ?? "(unknown version)"}.`,
  };
  fs.writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(`${cam.name}: ${segs.lo.length} low and ${segs.hi.length} high segments; wrote ${out} (${stamps.lo.length} low and ${stamps.hi.length} high GOP stamps)`);
  if (meta.utcOffsetMinutes == null) console.log("warning: the recorder's time zone is unknown; set utcOffsetMinutes in meta.json by hand");
} catch (e) {
  console.error(e.message ?? e);
  process.exit(1);
}
