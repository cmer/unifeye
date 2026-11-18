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
 *       writes lo.mp4 (channel 2), hi.mp4 (channel 0), segs.json and meta.json to the out dir
 *
 * The recorder drops the connection when asked for many exports at once, so requests are paced and
 * retried. Fill in meta.json's clockCrop before labelling (see label.mts).
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const origin = `https://${process.env.PROTECT_HOST}`;
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

try {
  const [cmd, startArg, minutes = "5", out = "/tmp/adaptive-eval"] = process.argv.slice(2);
  if (!cmd) throw new Error("usage: node - list | <camera id> <start ms> [minutes] [out dir]");
  const headers = await signIn();
  if (cmd === "list") {
    for (const c of await getJson(headers, "/cameras")) if (c.recordingSettings?.mode === "adaptive") console.log(`${c.id}  ${c.name}`);
    process.exit(0);
  }
  const camera = cmd, startMs = Number(startArg), endMs = startMs + Number(minutes) * 60_000;
  if (!Number.isFinite(startMs) || !(endMs > startMs)) throw new Error("start must be ms since the epoch, minutes a positive number");
  const cam = await getJson(headers, `/cameras/${encodeURIComponent(camera)}`);
  if (cam.recordingSettings?.mode !== "adaptive") console.log(`warning: ${cam.name} records in "${cam.recordingSettings?.mode}" mode, not adaptive`);
  const nvr = await getJson(headers, "/nvr").catch(() => ({}));
  fs.mkdirSync(out, { recursive: true });
  await exportTo(headers, camera, startMs, endMs, 2, `${out}/lo.mp4`);
  await exportTo(headers, camera, startMs, endMs, 0, `${out}/hi.mp4`);
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
    clockCrop: { lo: "", hi: "" },
    notes: `Captured ${new Date().toISOString().slice(0, 10)} with capture.mjs from a recorder on Protect ${nvr.version ?? "(unknown version)"}.`,
  };
  fs.writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
  console.log(`${cam.name}: ${segs.lo.length} low and ${segs.hi.length} high segments; wrote ${out}`);
  if (meta.utcOffsetMinutes == null) console.log("warning: the recorder's time zone is unknown; set utcOffsetMinutes in meta.json by hand");
} catch (e) {
  console.error(e.message ?? e);
  process.exit(1);
}
