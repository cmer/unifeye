import { createHash } from "node:crypto";
import { config } from "../config";
import type { LiveSource } from "../protect/types";
import { safeEqual } from "../util";
import { RelayUnavailable, type HlsFile, type HlsReader, type ReaderKind, type ReaderRequest, type Relay, type WhepAnswer } from "./relay";

export const MTX_API_USER = "unifeye-api";
export const MTX_PUBLISH_USER = "unifeye-publisher";
/** Suffix of the internal path a retimed stream is pulled into. Only the retiming FFmpeg reads it. */
export const SRC_SUFFIX = "_src";

/** What MediaMTX sends its HTTP auth hook (`authHTTPAddress`) for every publish, read and API action. */
export interface HookBody { user?: string; password?: string; token?: string; ip?: string; action?: string; path?: string; protocol?: string; id?: string; query?: string }

const isInternal = (ip = "") => /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd|fc)/.test(ip);

/**
 * Answers MediaMTX's auth hook. `secret` is the one in the hook URL. MediaMTX's own traffic is
 * decided here: its control API (`MTX_API_USER`), and the FFmpeg it runs (`MTX_PUBLISH_USER`, from
 * a loopback or private-network address, since MediaMTX may sit on a container network), which may
 * publish a camera path and read only the internal `_src` path over RTSP. A viewer reading over WebRTC or HLS is handed to `admit` in relay-neutral terms. Everything
 * else (other RTSP readers, RTMP, SRT, playback, metrics) is refused.
 */
export function authorizeHook(secret: string | null, b: HookBody, admit: (r: ReaderRequest) => boolean): boolean {
  const c = config();
  if (!c.MEDIAMTX_HOOK_SECRET || !secret || !safeEqual(secret, c.MEDIAMTX_HOOK_SECRET)) return false;
  const api = c.MEDIAMTX_API_SECRET ?? "";
  if (b.action === "api") return b.user === MTX_API_USER && !!api && safeEqual(b.password ?? "", api);
  const relay = b.user === MTX_PUBLISH_USER && !!api && safeEqual(b.password ?? "", api) && isInternal(b.ip);
  // The relay's own FFmpeg: the mock test streams, and real cameras whose audio is retimed.
  if (b.action === "publish") return relay && !(b.path ?? "").endsWith(SRC_SUFFIX);
  // That FFmpeg reads the camera from the internal `_src` path over RTSP. Nobody else reads RTSP.
  if (b.action === "read" && b.protocol === "rtsp") return relay && (b.path ?? "").endsWith(SRC_SUFFIX);
  if (b.action !== "read" || (b.protocol !== "webrtc" && b.protocol !== "hls") || !b.id || !b.path) return false;
  // Browsers send the ticket as a Bearer token; MediaMTX passes it as `token`, or as `password` for basic auth.
  return admit({ kind: b.protocol, stream: b.path, ticket: b.token || b.password || "", id: b.id });
}

/**
 * Where an FFmpeg that MediaMTX runs on demand publishes the path it was started for: MediaMTX's own
 * RTSP listener on loopback, with the publisher credentials the auth hook accepts. `$RTSP_PORT` and
 * `$MTX_PATH` are filled in by MediaMTX. The mock adapter's test streams use it (services.ts).
 */
export function commandPublishUrl() {
  return `rtsp://${MTX_PUBLISH_USER}:${encodeURIComponent(config().MEDIAMTX_API_SECRET ?? "")}@127.0.0.1:$RTSP_PORT/$MTX_PATH`;
}

/**
 * The FFmpeg that MediaMTX runs to publish `<name>` from `<name>_src`. `$RTSP_PORT` and `$MTX_PATH`
 * are filled in by MediaMTX. The probe must last until the first video frame: on a cold start the
 * camera's sound arrives a few seconds before its picture, and a short probe (half a second) ended on
 * sound alone, so FFmpeg exited ("dimensions not set") and MediaMTX retried only after a 5 s pause,
 * often too late for the reader. A 10 s ceiling still ends as soon as every track is known, and
 * `-fpsprobesize 0` skips waiting for 20 frames to guess a frame rate. `asetpts=N/SR/TB`
 * ignores the camera's audio timestamps and counts samples instead. The camera's first audio track
 * is used (AAC on Protect, present on every camera with a microphone); `?` makes it optional.
 */
function retimeCommand(name: string) {
  return [
    "ffmpeg -hide_banner -loglevel error -analyzeduration 10000000 -probesize 10000000 -fpsprobesize 0",
    `-rtsp_transport tcp -i rtsp://${MTX_PUBLISH_USER}:${encodeURIComponent(config().MEDIAMTX_API_SECRET ?? "")}@127.0.0.1:$RTSP_PORT/${name}${SRC_SUFFIX}`,
    "-map 0:v:0 -map 0:a:0? -map 0:a:0? -c:v copy -filter:a asetpts=N/SR/TB",
    "-c:a:0 aac -b:a:0 48k -c:a:1 libopus -b:a:1 48k",
    `-f rtsp -rtsp_transport tcp ${commandPublishUrl()}`,
  ].join(" ");
}

/**
 * Leaves only the default sound track in MediaMTX's top HLS playlist. A retimed stream carries its
 * sound twice (`retimeCommand`: AAC, then Opus for WebRTC), and MediaMTX lists both as choices in one
 * group, with "opus" added to the video's codecs. Apple's player (Safari, iPhone) refuses that
 * playlist outright ("Cannot Open", CoreMedia -15517). HLS players only play the default track, the
 * first one, anyway. `opus` is dropped from the codecs only when another track was dropped with it.
 */
export function onlyDefaultAudio(playlist: string) {
  const lines = playlist.split("\n");
  const kept = lines.filter((l) => !(l.startsWith("#EXT-X-MEDIA:") && l.includes("TYPE=AUDIO") && !l.includes("DEFAULT=YES")));
  if (kept.length === lines.length) return playlist;
  return kept.map((l) => (l.startsWith("#EXT-X-STREAM-INF:") ? l.replace(/CODECS="([^"]*)"/, (_, c: string) => `CODECS="${c.split(",").filter((x) => x !== "opus").join(",")}"`) : l)).join("\n");
}

/**
 * The MediaMTX relay: its control API (v3), its WHEP listener and its HLS listener. This file is
 * the only place that knows MediaMTX's URL shapes, the Bearer-ticket convention, the WHEP
 * `location` format, the HLS cookie and redirect mechanics, and its auth hook (`authorizeHook`). MediaMTX is never reachable from
 * browsers: these listeners stay on the internal network, and every reader is authorized by
 * Unifeye through the HTTP auth hook. Only the WebRTC media port (ICE) is published.
 *
 * The requests were checked by hand against MediaMTX 1.21.4 and are pinned by tests/mediamtx.test.ts.
 */
export class MediaMtxRelay implements Relay {
  /**
   * Streams already configured, by a hash of their configuration, to skip the control API on most
   * requests. A restarted MediaMTX may have lost paths added through the API, so the cache is dropped
   * whenever MediaMTX looks restarted: all of it when a request cannot connect or the health check fails,
   * one stream when MediaMTX says it does not have it (WHEP or an HLS playlist answering 404).
   */
  private known = new Map<string, string>();
  private headers() {
    return { authorization: "Basic " + Buffer.from(`${MTX_API_USER}:${config().MEDIAMTX_API_SECRET ?? ""}`).toString("base64"), "content-type": "application/json" };
  }
  private async api(method: string, path: string, body?: unknown) {
    try {
      return await fetch(config().MEDIAMTX_API_URL + path, { method, headers: this.headers(), body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    } catch {
      throw this.unreachable();
    }
  }
  private unreachable() { this.known.clear(); return new RelayUnavailable(); }

  async healthy() {
    try {
      const ok = (await this.api("GET", "/v3/paths/list?itemsPerPage=1")).ok;
      if (!ok) this.known.clear();
      return ok;
    } catch { return false; }
  }
  /**
   * Creates or updates an on-demand path. A source whose audio needs retiming gets two paths: MediaMTX
   * pulls the camera into `<name>_src` (keeping the TLS fingerprint check), and an FFmpeg that MediaMTX
   * starts on demand reads that path over loopback RTSP, copies the video, re-encodes the sound with
   * timestamps rebuilt from the sample count (AAC for HLS, Opus for WebRTC) and publishes `<name>`.
   * Readers only ever get tickets for `<name>`; the hook admits nobody but that FFmpeg to `_src`.
   */
  async ensureStream(name: string, src: LiveSource) {
    const pull = (url: string, fp?: string) => ({ source: url, sourceOnDemand: true, sourceOnDemandCloseAfter: "10s", rtspTransport: "tcp", ...(fp ? { sourceFingerprint: fp } : {}) });
    const run = (command: string) => ({ source: "publisher", runOnDemand: command, runOnDemandRestart: true, runOnDemandCloseAfter: "10s" });
    const paths: [string, object][] = src.kind === "command" ? [[name, run(src.command)]]
      : src.retimeAudio ? [[`${name}${SRC_SUFFIX}`, pull(src.url, src.tlsFingerprint)], [name, run(retimeCommand(name))]]
      : [[name, pull(src.url, src.tlsFingerprint)]];
    const hash = createHash("sha256").update(JSON.stringify(paths)).digest("hex");
    if (this.known.get(name) === hash) return;
    for (const [path, conf] of paths) {
      let r = await this.api("POST", `/v3/config/paths/add/${encodeURIComponent(path)}`, conf);
      if (!r.ok) r = await this.api("POST", `/v3/config/paths/replace/${encodeURIComponent(path)}`, conf);
      if (!r.ok) throw new Error(`mediamtx path setup failed (${r.status})`);
    }
    this.known.set(name, hash);
  }

  async whepCreate(stream: string, ticket: string, sdpOffer: string): Promise<WhepAnswer> {
    const r = await fetch(`${config().MEDIAMTX_WHEP_URL}/${stream}/whep`, { method: "POST", headers: { "content-type": "application/sdp", authorization: `Bearer ${ticket}` }, body: sdpOffer, signal: AbortSignal.timeout(15_000) }).catch(() => { throw this.unreachable(); });
    if (r.status === 404) { this.known.delete(stream); return { outcome: "no_stream" }; }
    if (r.status !== 201) return { outcome: "failed" };
    const resource = (r.headers.get("location") ?? "").split("/").pop() ?? "";
    return { outcome: "created", sdp: await r.text(), resource, etag: r.headers.get("etag") };
  }
  whepTrickle(stream: string, resource: string, body: string | undefined, headers: Record<string, string>) {
    return this.whep("PATCH", stream, resource, body, headers);
  }
  whepClose(stream: string, resource: string, headers: Record<string, string>) {
    return this.whep("DELETE", stream, resource, undefined, headers);
  }
  private async whep(method: "PATCH" | "DELETE", stream: string, resource: string, body: string | undefined, headers: Record<string, string>) {
    const r = await fetch(`${config().MEDIAMTX_WHEP_URL}/${stream}/whep/${resource}`, { method, headers, body, signal: AbortSignal.timeout(10_000) }).catch(() => { throw this.unreachable(); });
    return r.status;
  }

  /** MediaMTX may answer with a redirect and a session cookie; both are followed and kept here, per reader. */
  hlsReader(stream: string): HlsReader {
    let cookie = "";
    return {
      fetch: async (file, search, ticket): Promise<HlsFile> => {
        let url = `${config().MEDIAMTX_HLS_URL}/${stream}/${file}${search}`;
        for (let hop = 0; hop < 4; hop++) {
          const r = await fetch(url, { redirect: "manual", headers: { authorization: `Bearer ${ticket}`, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15_000) }).catch(() => { throw this.unreachable(); });
          const set = r.headers.getSetCookie?.() ?? [];
          if (set.length) cookie = set.map((s) => s.split(";")[0]).join("; ");
          if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location")!, url).toString(); continue; }
          if (r.status === 404) { if (file.endsWith(".m3u8")) this.known.delete(stream); return { outcome: "not_found" }; }
          if (!r.ok) return { outcome: "failed" };
          if (file === "index.m3u8") return { outcome: "ok", body: new Response(onlyDefaultAudio(await r.text())).body, contentType: r.headers.get("content-type") };
          return { outcome: "ok", body: r.body, contentType: r.headers.get("content-type") };
        }
        return { outcome: "failed" };
      },
    };
  }

  async readers(kind: ReaderKind) {
    const out: { id: string }[] = [];
    for (let page = 0; page < 50; page++) {
      const r = await this.api("GET", `/v3/${kind}/sessions/list?itemsPerPage=100&page=${page}`);
      if (!r.ok) throw new Error(`mediamtx list failed (${r.status})`);
      const j = (await r.json()) as { pageCount?: number; items?: { id: string }[] };
      out.push(...(j.items ?? []));
      if (page + 1 >= (j.pageCount ?? 1)) break;
    }
    return out;
  }
  async kick(kind: ReaderKind, id: string) {
    await this.api("POST", `/v3/${kind}/sessions/kick/${encodeURIComponent(id)}`).catch(() => {});
  }
}
