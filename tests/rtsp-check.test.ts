import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { authorization, checkRtsp, sdpCodecs, withLogin } from "@/server/protect/rtsp-check";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const SDP = (video: string, audio = "MPEG4-GENERIC/16000/1") => `v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=cam\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 ${video}/90000\r\na=control:track1\r\nm=audio 0 RTP/AVP 97\r\na=rtpmap:97 ${audio}\r\na=control:track2\r\n`;

/** A pretend camera: asks for a Digest login, then describes one stream. Records every request. */
function camera(o: { password: string; video?: string; status?: number }) {
  const seen: string[] = [];
  let connections = 0;
  const server: Server = createServer((sock) => {
    connections++;
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      while (buf.includes("\r\n\r\n")) {
        const end = buf.indexOf("\r\n\r\n"), req = buf.slice(0, end);
        buf = buf.slice(end + 4);
        seen.push(req);
        const cseq = /CSeq: (\d+)/.exec(req)?.[1];
        const auth = /Authorization: (.*)/.exec(req)?.[1];
        const uri = /^DESCRIBE (\S+)/.exec(req)![1];
        const want = md5(`${md5(`admin:cam:${o.password}`)}:abc:${md5(`DESCRIBE:${uri}`)}`);
        if (!auth || !auth.includes(`response="${want}"`)) { sock.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Digest realm="cam", nonce="abc"\r\n\r\n`); continue; }
        if (o.status) { sock.write(`RTSP/1.0 ${o.status} Nope\r\nCSeq: ${cseq}\r\n\r\n`); continue; }
        const body = SDP(o.video ?? "H264");
        sock.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    });
  });
  return new Promise<{ url: string; seen: string[]; connections: () => number; server: Server }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `rtsp://127.0.0.1:${(server.address() as AddressInfo).port}/h264Preview_01_main`, seen, connections: () => connections, server })));
}
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

describe("checking a camera directly", () => {
  it("answers the login challenge on one connection and reports the codecs", async () => {
    const cam = await camera({ password: "Ja:m@es!" }); servers.push(cam.server);
    expect(await checkRtsp(cam.url, { username: "admin", password: "Ja:m@es!" })).toEqual({ ok: true, video: "H264", audio: "MPEG4-GENERIC" });
    expect(cam.seen).toHaveLength(2);
    expect(cam.connections()).toBe(1);
    expect(cam.seen.every((r) => r.startsWith(`DESCRIBE ${cam.url} RTSP/1.0`))).toBe(true); // never PLAY or SETUP
  });
  it("tells a wrong password, an unplayable format, a missing stream and an unreachable camera apart", async () => {
    const cam = await camera({ password: "right" }); servers.push(cam.server);
    expect(await checkRtsp(cam.url, { username: "admin", password: "wrong" })).toEqual({ ok: false, reason: "login" });
    const hevc = await camera({ password: "p", video: "H265" }); servers.push(hevc.server);
    expect(await checkRtsp(hevc.url, { username: "admin", password: "p" })).toMatchObject({ ok: false, reason: "video_format" });
    const gone = await camera({ password: "p", status: 404 }); servers.push(gone.server);
    expect(await checkRtsp(gone.url, { username: "admin", password: "p" })).toMatchObject({ ok: false, reason: "no_stream" });
    const closed = createServer(); await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port; closed.close();
    expect(await checkRtsp(`rtsp://127.0.0.1:${port}/x`, { username: "a", password: "b" })).toMatchObject({ ok: false, reason: "unreachable" });
    expect(await checkRtsp("rtsps://127.0.0.1/x", { username: "a", password: "b" })).toMatchObject({ ok: false, reason: "unsupported" });
  });
  it("builds Basic and Digest (with qop) answers", () => {
    expect(authorization('Basic realm="x"', { username: "u", password: "p" }, "DESCRIBE", "rtsp://h/x")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    const d = authorization('Digest realm="r", nonce="n", qop="auth"', { username: "u", password: "p" }, "DESCRIBE", "rtsp://h/x")!;
    const cnonce = /cnonce="([^"]+)"/.exec(d)![1];
    expect(d).toContain(`response="${md5(`${md5("u:r:p")}:n:00000001:${cnonce}:auth:${md5("DESCRIBE:rtsp://h/x")}`)}"`);
  });
  it("reads the first video and audio codec", () => {
    expect(sdpCodecs(SDP("H264", "PCMA/8000"))).toEqual({ video: "H264", audio: "PCMA" });
    expect(sdpCodecs("m=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\n")).toEqual({ video: "H265", audio: null });
  });
  it("puts the login into the address so the relay decodes it back exactly", () => {
    const u = new URL(withLogin("rtsp://10.0.0.5:554/h264Preview_01_sub", { username: "admin", password: "Ja:m@es123!%" }));
    expect(u.host).toBe("10.0.0.5:554");
    expect(decodeURIComponent(u.password)).toBe("Ja:m@es123!%");
  });
});
