import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { CameraLogin, DirectCheck } from "./types";

interface Reply { status: number; headers: Map<string, string>; body: string }
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Reads RTSP replies off one socket, in order. */
function replies(sock: Socket) {
  let buf = Buffer.alloc(0), waiting: ((r: Reply) => void) | null = null, failed: ((e: Error) => void) | null = null;
  const queue: Reply[] = [];
  const pump = () => {
    for (;;) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const headers = new Map<string, string>();
      for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()); }
      const len = Number(headers.get("content-length") ?? 0);
      if (buf.length < end + 4 + len) return;
      const body = buf.subarray(end + 4, end + 4 + len).toString("utf8");
      buf = buf.subarray(end + 4 + len);
      const status = Number(/^RTSP\/1\.\d (\d{3})/.exec(lines[0])?.[1] ?? 0);
      const r = { status, headers, body };
      if (waiting) { const w = waiting; waiting = null; w(r); } else queue.push(r);
    }
  };
  sock.on("data", (d: Buffer) => { buf = Buffer.concat([buf, d]); if (buf.length > 256 * 1024) sock.destroy(new Error("reply too large")); else pump(); });
  sock.on("error", (e) => failed?.(e));
  sock.on("close", () => failed?.(new Error("closed")));
  return () => new Promise<Reply>((resolve, reject) => {
    const q = queue.shift();
    if (q) return resolve(q);
    waiting = resolve; failed = reject;
  });
}

/** Builds an Authorization header from a 401 challenge (Digest preferred, as cameras usually ask for it). */
export function authorization(challenge: string, login: CameraLogin, method: string, uri: string): string | null {
  if (/^basic/i.test(challenge)) return `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;
  if (!/^digest/i.test(challenge)) return null;
  const p = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
  if (!p.nonce) return null;
  const ha1 = md5(`${login.username}:${p.realm ?? ""}:${login.password}`), ha2 = md5(`${method}:${uri}`);
  const qop = (p.qop ?? "").split(",").map((x: string) => x.trim()).includes("auth") ? "auth" : null;
  const nc = "00000001", cnonce = randomBytes(8).toString("hex");
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  const q = (k: string, v: string) => `${k}="${v.replace(/"/g, "")}"`;
  return `Digest ${[q("username", login.username), q("realm", p.realm ?? ""), q("nonce", p.nonce), q("uri", uri), q("response", response), ...(p.opaque ? [q("opaque", p.opaque)] : []), ...(qop ? [`qop=${qop}`, `nc=${nc}`, q("cnonce", cnonce)] : [])].join(", ")}`;
}

/** The codec of the first video and audio track in an SDP description, upper-cased (H264, H265, MPEG4-GENERIC, PCMA…). */
export function sdpCodecs(sdp: string): { video: string | null; audio: string | null } {
  const out: { video: string | null; audio: string | null } = { video: null, audio: null };
  let media: "video" | "audio" | null = null, pts: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^m=(\w+) \S+ \S+ (.*)$/.exec(line);
    if (m) { media = m[1] === "video" || m[1] === "audio" ? m[1] : null; pts = m[2].trim().split(/\s+/); continue; }
    const r = /^a=rtpmap:(\d+) ([^/\s]+)/.exec(line);
    if (r && media && out[media] == null && pts.includes(r[1])) out[media] = r[2].toUpperCase();
  }
  return out;
}

/**
 * Asks a camera to describe one RTSP stream (DESCRIBE, answering a login challenge once) on a single
 * connection, then hangs up. No video is read and nothing on the camera changes.
 */
export async function checkRtsp(rawUrl: string, login: CameraLogin, timeoutMs = 5000): Promise<DirectCheck> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: "unsupported" }; }
  if (url.protocol !== "rtsp:") return { ok: false, reason: "unsupported" };
  url.username = ""; url.password = "";
  const uri = url.toString();
  const sock = connect({ host: url.hostname, port: Number(url.port || 554) });
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error("timed out")));
  const next = replies(sock);
  try {
    await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    const send = (cseq: number, auth?: string) => sock.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: Unifeye\r\n${auth ? `Authorization: ${auth}\r\n` : ""}\r\n`);
    send(1);
    let r = await next();
    if (r.status === 401) {
      const auth = authorization(r.headers.get("www-authenticate") ?? "", login, "DESCRIBE", uri);
      if (!auth) return { ok: false, reason: "login" };
      send(2, auth);
      r = await next();
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "login" };
    if (r.status !== 200) return { ok: false, reason: "no_stream", detail: `status ${r.status}` };
    const c = sdpCodecs(r.body);
    if (!c.video) return { ok: false, reason: "no_stream", detail: "no video track" };
    // Video is passed through untouched, and browsers only play H.264 live.
    if (c.video !== "H264") return { ok: false, reason: "video_format", detail: c.video };
    return { ok: true, video: c.video, audio: c.audio };
  } catch (e) {
    return { ok: false, reason: "unreachable", detail: (e as Error).message };
  } finally {
    sock.destroy();
  }
}

/** Puts a login into an RTSP URL. MediaMTX decodes the percent-escapes before answering the camera's challenge. */
export function withLogin(rawUrl: string, login: CameraLogin): string {
  const u = new URL(rawUrl);
  u.username = encodeURIComponent(login.username);
  u.password = encodeURIComponent(login.password);
  return u.toString();
}
