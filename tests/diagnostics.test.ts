import { beforeEach, describe, expect, it } from "vitest";
import {
  camerasFor, cameraIdIn, fmtMbps, perStreamMbps, clearDiagnostics, clockOffset, codecName, filterCandidates, formatReport, groupRefusals, inboundVideo, mayReleaseHls, median,
  parsePlaylist, parseUserAgent, pickTestStream, problemLog, recordProblem, recordRequestFailure, refusalsSince, refusalText, REFUSAL_WINDOW_MS,
  selectedPair, shortenPath, verdict, versionRow, type Stat,
} from "@/ui/diagnostics";

beforeEach(() => clearDiagnostics());

// A MediaMTX-style answer: one UDP and one TCP host candidate on port 8189, plus a second UDP address.
const ANSWER = [
  "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:abc", "a=ice-pwd:def",
  "a=candidate:1 1 udp 2130706431 192.0.2.10 8189 typ host",
  "a=candidate:2 1 tcp 1671430143 192.0.2.10 8189 typ host tcptype passive",
  "a=candidate:3 1 UDP 1694498815 198.51.100.7 8190 typ srflx raddr 0.0.0.0 rport 0",
  "a=end-of-candidates", "a=mid:0", "",
].join("\r\n");

describe("filtering ICE candidates to one transport", () => {
  it("keeps only UDP candidates, case-insensitively, and the rest of the SDP as it was", () => {
    const r = filterCandidates(ANSWER, "udp");
    expect(r.kept).toBe(2); expect(r.ports).toEqual([8189, 8190]);
    expect(r.sdp).not.toMatch(/ tcp /);
    expect(r.sdp).toContain("a=end-of-candidates"); expect(r.sdp).toContain("a=ice-pwd:def");
    expect(r.sdp.split("\r\n").length).toBe(ANSWER.split("\r\n").length - 1);
  });
  it("keeps only TCP candidates", () => {
    const r = filterCandidates(ANSWER, "tcp");
    expect(r.kept).toBe(1); expect(r.ports).toEqual([8189]);
    expect(r.sdp).toContain("tcptype passive"); expect(r.sdp).not.toMatch(/ udp /i);
  });
  it("reports none when the server offers no address of that kind, and keeps plain newlines", () => {
    const udpOnly = ANSWER.replace(/\r\n/g, "\n").split("\n").filter((l) => !/ tcp /.test(l)).join("\n");
    const r = filterCandidates(udpOnly, "tcp");
    expect(r.kept).toBe(0); expect(r.sdp).not.toContain("\r\n");
  });
});

describe("HLS playlists", () => {
  it("finds the video playlist in a MediaMTX top playlist and the segments in a media playlist", () => {
    const top = '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-INDEPENDENT-SEGMENTS\n\n#EXT-X-MEDIA:TYPE="AUDIO",GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8"\n\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio"\nvideo1_stream.m3u8\n';
    expect(parsePlaylist(top)).toEqual({ variants: ["video1_stream.m3u8"], segments: [], init: null });
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="abc_video1_init.mp4"\n#EXTINF:1.00000,\nabc_video1_seg7.mp4\n#EXTINF:1.00000,\nabc_video1_seg8.mp4\n';
    expect(parsePlaylist(media)).toEqual({ variants: [], segments: ["abc_video1_seg7.mp4", "abc_video1_seg8.mp4"], init: "abc_video1_init.mp4" });
  });
});

describe("refusals and the problem log", () => {
  it("groups 429s by error code and marks those from HLS requests", () => {
    for (let i = 0; i < 3; i++) recordRequestFailure({ method: "GET", path: "/media/live/0f8a2c4e-1b3d-4f5a-9c7e-123456789abc/hls/wall/index.m3u8", status: 429, code: "rate_limited" });
    for (let i = 0; i < 5; i++) recordRequestFailure({ method: "POST", path: "/media/live/0f8a2c4e-1b3d-4f5a-9c7e-123456789abc/whep?q=wall", status: 429, code: "too_many_streams" });
    recordRequestFailure({ method: "GET", path: "/cameras", status: 500, code: "internal" });
    const groups = groupRefusals(refusalsSince(Date.now() - REFUSAL_WINDOW_MS));
    expect(groups).toEqual([{ code: "too_many_streams", hls: false, count: 5 }, { code: "rate_limited", hls: true, count: 3 }]);
    expect(refusalText(groups)).toBe("5 × too_many_streams · 3 × rate_limited (HLS)");
    expect(problemLog()).toHaveLength(9);
    expect(problemLog()[1]).toMatchObject({ title: "HTTP 429 too_many_streams", method: "POST", path: "/media/live/…/whep", cameraId: "0f8a2c4e-1b3d-4f5a-9c7e-123456789abc" });
  });
  it("forgets refusals older than ten minutes and keeps the newest 50 problems", () => {
    expect(refusalsSince(Date.now() + 1)).toHaveLength(0);
    for (let i = 0; i < 60; i++) recordProblem({ kind: "tile", title: `p${i}` });
    expect(problemLog()).toHaveLength(50); expect(problemLog()[0].title).toBe("p59");
  });
  it("shortens ids in paths and finds the camera in media paths", () => {
    expect(shortenPath("/media/live/whep/aB3dE5fG7hJ9kL1mN3pQ?x=1")).toBe("/media/live/whep/…");
    expect(shortenPath("/media/live/abc/hls/wall/index.m3u8")).toBe("/media/live/abc/hls/wall/index.m3u8");
    expect(cameraIdIn("/api/media/live/cam1/hls/wall/x.mp4")).toBe("cam1");
    expect(cameraIdIn("/cameras/cam2/snapshot")).toBe("cam2");
    expect(cameraIdIn("/media/live/whep/secret")).toBeUndefined(); // a WebRTC session, not a camera
    expect(cameraIdIn("/me")).toBeUndefined();
  });
});

describe("the verdict", () => {
  it("names the most important problem first and the next ones briefly", () => {
    const v = verdict(["webrtc_blocked", "streams_full", "clock_off"], { running: false });
    expect(v).toEqual({ status: "bad", title: "This browser has too many streams open", text: "Close other Unifeye tabs or windows to free some up. Also, WebRTC is blocked and the device clock is off." });
    expect(verdict(["webrtc_blocked"], { running: false })).toEqual({ status: "warn", title: "WebRTC can't get through on this network", text: "Cameras still play over HLS, a few seconds behind." });
  });
  it("says all is well only when the checks have finished", () => {
    expect(verdict([], { running: true }).status).toBe("pending");
    expect(verdict([], { running: false, tookMs: 6200 })).toEqual({ status: "ok", title: "Everything looks good", text: "Checked just now. Took 6 seconds." });
    expect(verdict(["server_unreachable"], { running: true }).title).toBe("Can't reach Unifeye"); // a problem shows at once
  });
});

describe("numbers", () => {
  it("medians, clock offset, and how many cameras fit in a download speed", () => {
    expect(median([40, 10, 30])).toBe(30); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNaN();
    expect(clockOffset(1_000_000, 1_000_900, 1_001_100)).toBe(1000); // this device is a second ahead
    expect(perStreamMbps([])).toBe(2); expect(perStreamMbps([0.05, 0.1])).toBe(1); expect(perStreamMbps([3, 5])).toBe(4);
    expect(fmtMbps(0.0812)).toBe("81 kbps"); expect(fmtMbps(4.13)).toBe("4.1 Mbps"); expect(fmtMbps(2663.4)).toBe("2,663 Mbps");
    expect(camerasFor(84, 2)).toBe(31); expect(camerasFor(6, 2)).toBe(2); expect(camerasFor(1, 2)).toBe(0); expect(camerasFor(10, 0)).toBe(0);
  });
});

describe("user agents", () => {
  it("names common browsers and systems, and leaves out what it doesn't know", () => {
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")).toEqual({ browser: "Chrome 142", os: "macOS" });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toEqual({ browser: "Edge 141", os: "Windows" });
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toEqual({ browser: "Safari 18.1", os: "iOS 18.1" });
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toEqual({ browser: "Firefox 133", os: "Linux" });
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36")).toEqual({ browser: "Chrome 142", os: "Android 14" });
    expect(parseUserAgent("curl/8.4.0")).toEqual({ browser: null, os: null });
  });
});

describe("WebRTC statistics", () => {
  const stats = (bytes: number, ts: number): Stat[] => [
    { type: "transport", id: "T1", selectedCandidatePairId: "CP1" },
    { type: "candidate-pair", id: "CP1", localCandidateId: "L1", remoteCandidateId: "R1", currentRoundTripTime: 0.004, state: "succeeded", nominated: true },
    { type: "local-candidate", id: "L1", protocol: "udp", candidateType: "host" },
    { type: "remote-candidate", id: "R1", protocol: "udp", candidateType: "host", port: 8189, address: "192.0.2.10" },
    { type: "codec", id: "C1", mimeType: "video/H264" },
    { type: "inbound-rtp", id: "V1", kind: "video", codecId: "C1", bytesReceived: bytes, timestamp: ts, framesPerSecond: 25, frameWidth: 1920, frameHeight: 1080, packetsLost: 1, packetsReceived: 999, jitter: 0.003 },
  ];
  it("reads the selected route and the incoming video", () => {
    expect(selectedPair(stats(0, 0))).toEqual({ protocol: "udp", localType: "host", remoteType: "host", relayProtocol: undefined, port: 8189, address: "192.0.2.10", rttMs: 4 });
    const v = inboundVideo(stats(1_512_500, 2000), stats(1_000_000, 1000))!;
    expect(v).toMatchObject({ codec: "H.264", width: 1920, height: 1080, fps: 25, mbps: 4.1, lossPct: 0.1 });
    expect(v.jitterMs).toBeCloseTo(3);
    expect(inboundVideo(stats(5, 1), null)!.mbps).toBeUndefined();
  });
  it("reports how long frames were held before showing, between two samples", () => {
    const held = (delay: number, shown: number): Stat[] => [{ type: "inbound-rtp", id: "V1", kind: "video", jitterBufferDelay: delay, jitterBufferEmittedCount: shown }];
    expect(inboundVideo(held(130, 125), held(100, 100))!.heldMs).toBeCloseTo(1200); // 30 s over 25 frames
    expect(inboundVideo(held(50, 100), null)!.heldMs).toBeCloseTo(500); // one sample: since the stream started
    expect(inboundVideo(held(100, 100), held(100, 100))!.heldMs).toBeUndefined(); // nothing shown in between
    expect(inboundVideo(stats(5, 1), null)!.heldMs).toBeUndefined(); // a browser that does not report it
  });
  it("falls back to the nominated pair when there is no transport report (Firefox)", () => {
    const s = stats(0, 0).filter((x) => x.type !== "transport");
    expect(selectedPair(s)?.port).toBe(8189);
    expect(selectedPair([])).toBeNull();
  });
  it("names codecs from WebRTC and HLS strings", () => {
    expect(codecName("video/H265")).toBe("H.265"); expect(codecName("hvc1.1.6.L120.90")).toBe("H.265"); expect(codecName("avc1.640028")).toBe("H.264"); expect(codecName(undefined)).toBeUndefined();
  });
});

describe("choosing the stream to test", () => {
  const cams = [{ id: "a", online: true, hasLive: true }, { id: "b", online: true, hasLive: true }, { id: "off", online: false, hasLive: true }];
  it("prefers a stream this session already holds, so the test takes no extra slot", () => {
    expect(pickTestStream(cams, [{ cameraId: "off", quality: "wall" }, { cameraId: "b", quality: "focus" }], [])).toEqual({ cameraId: "b", quality: "focus", alreadyOpen: true });
    expect(pickTestStream(cams, [], [{ cameraId: "b", quality: "wall" }])).toEqual({ cameraId: "b", quality: "wall", alreadyOpen: true });
    expect(pickTestStream(cams, [], [])).toEqual({ cameraId: "a", quality: "wall", alreadyOpen: false });
    expect(pickTestStream([cams[2]], [], [])).toBeNull();
  });
  it("releases an HLS stream only if the test opened it and no tile here has started it since", () => {
    expect(mayReleaseHls({ cameraId: "a", quality: "wall", alreadyOpen: true }, [])).toBe(false);
    expect(mayReleaseHls({ cameraId: "a", quality: "wall", alreadyOpen: false }, [{ cameraId: "a", quality: "wall" }])).toBe(false);
    expect(mayReleaseHls({ cameraId: "a", quality: "wall", alreadyOpen: false }, [{ cameraId: "a", quality: "focus" }])).toBe(true);
  });
});

describe("the report", () => {
  it("has everything shown plus the technical detail, as plain text", () => {
    recordRequestFailure({ method: "POST", path: "/media/live/cam1/whep", status: 429, code: "too_many_streams", requestId: "8f3a1c00-aaaa" });
    const text = formatReport({
      at: Date.UTC(2026, 10, 18, 14, 41), verdict: verdict(["refused"], { running: false }),
      sections: [{ title: "Live video", rows: [{ id: "udp", label: "WebRTC over UDP", status: "bad", value: "Blocked", detail: "No reply from port 8189 after 5.0 s · ICE failed", tech: ["reason blocked"] }] }],
      playing: [{ name: "Front door", value: "HLS · from recorder", detail: "6 s behind", tech: ["quality wall"] }],
      problems: problemLog(), cameraName: (id) => (id === "cam1" ? "Front door" : undefined), device: { userAgent: "UA/1.0", extra: ["Page: cams.example"] },
    });
    expect(text).toContain("Checked: 2026-11-18T14:41:00.000Z");
    expect(text).toContain("The server turned some requests away.");
    expect(text).toContain("WebRTC over UDP: Blocked [problem]\n  No reply from port 8189 after 5.0 s · ICE failed\n  reason blocked");
    expect(text).toContain("Front door: HLS · from recorder\n  6 s behind\n  quality wall");
    expect(text).toMatch(/Front door: HTTP 429 too_many_streams\n {2}POST \/media\/live\/cam1\/whep · request 8f3a1c00-aaaa/);
    expect(text).toContain("User agent: UA/1.0\nPage: cams.example");
  });
});

describe("the Version row", () => {
  const base = { version: "0.3.0", commit: "cf62c23aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const u = (state: "current" | "behind" | "unknown" | "off", latest: string | null = null, behindBy: number | null = null) => ({ state, latest, behindBy, checkedAt: null });
  it("is green on the newest version and shows a short commit", () => {
    expect(versionRow({ ...base, update: u("current", "v0.3.0", 0) })).toMatchObject({ status: "ok", value: "Unifeye 0.3.0 \u00b7 cf62c23", detail: "Up to date" });
  });
  it("is amber when something newer exists, naming the release when there is one", () => {
    expect(versionRow({ ...base, update: u("behind", "v0.4.0", 12) })).toMatchObject({ status: "warn", detail: "Version 0.4.0 is available \u00b7 12 changes behind" });
    expect(versionRow({ ...base, update: u("behind", null, 1) })).toMatchObject({ status: "warn", detail: "A newer version is available \u00b7 1 change behind" });
    expect(versionRow({ ...base, update: u("behind", "v0.4.0") })).toMatchObject({ status: "warn", detail: "Version 0.4.0 is available" });
  });
  it("takes no colour when nobody knows, and leaves the commit out when there is none", () => {
    expect(versionRow({ version: "0.3.0", commit: null, update: u("unknown") })).toMatchObject({ status: "info", value: "Unifeye 0.3.0", detail: "Couldn\u2019t check for a newer version" });
    expect(versionRow({ ...base, update: u("off") }).detail).toBeUndefined();
  });
});
