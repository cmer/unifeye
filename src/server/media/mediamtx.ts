import { createHash } from "node:crypto";
import { config } from "../config";
import type { LiveSource } from "../protect/types";
import { RelayUnavailable, type HlsFile, type HlsReader, type ReaderKind, type Relay, type WhepAnswer } from "./relay";

export const MTX_API_USER = "unifeye-api";
export const MTX_PUBLISH_USER = "unifeye-publisher";
/** Suffix of the internal path a retimed stream is pulled into. Only the retiming FFmpeg reads it. */
export const SRC_SUFFIX = "_src";

/**
 * The FFmpeg that MediaMTX runs to publish `<name>` from `<name>_src`. `$RTSP_PORT` and `$MTX_PATH`
 * are filled in by MediaMTX. Short probing keeps start-up near half a second; `asetpts=N/SR/TB`
 * ignores the camera's audio timestamps and counts samples instead. The camera's first audio track
 * is used (AAC on Protect, present on every camera with a microphone); `?` makes it optional.
 */
function retimeCommand(name: string) {
  const auth = `${MTX_PUBLISH_USER}:${encodeURIComponent(config().MEDIAMTX_API_SECRET ?? "")}`;
  return [
    "ffmpeg -hide_banner -loglevel error -analyzeduration 500000 -probesize 500000",
    `-rtsp_transport tcp -i rtsp://${auth}@127.0.0.1:$RTSP_PORT/${name}${SRC_SUFFIX}`,
    "-map 0:v:0 -map 0:a:0? -map 0:a:0? -c:v copy -filter:a asetpts=N/SR/TB",
    "-c:a:0 aac -b:a:0 48k -c:a:1 libopus -b:a:1 48k",
    `-f rtsp -rtsp_transport tcp rtsp://${auth}@127.0.0.1:$RTSP_PORT/$MTX_PATH`,
  ].join(" ");
}

/**
 * The MediaMTX relay: its control API (v3), its WHEP listener and its HLS listener. This file is
 * the only place that knows MediaMTX's URL shapes, the Bearer-ticket convention, the WHEP
 * `location` format and the HLS cookie and redirect mechanics. MediaMTX is never reachable from
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
  hlsReader(stream: string, ticket: string): HlsReader {
    let cookie = "";
    return {
      fetch: async (file, search): Promise<HlsFile> => {
        let url = `${config().MEDIAMTX_HLS_URL}/${stream}/${file}${search}`;
        for (let hop = 0; hop < 4; hop++) {
          const r = await fetch(url, { redirect: "manual", headers: { authorization: `Bearer ${ticket}`, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15_000) }).catch(() => { throw this.unreachable(); });
          const set = r.headers.getSetCookie?.() ?? [];
          if (set.length) cookie = set.map((s) => s.split(";")[0]).join("; ");
          if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location")!, url).toString(); continue; }
          if (r.status === 404) { if (file.endsWith(".m3u8")) this.known.delete(stream); return { outcome: "not_found" }; }
          if (!r.ok) return { outcome: "failed" };
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
