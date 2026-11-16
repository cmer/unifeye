import { createHash } from "node:crypto";
import { config } from "../config";
import type { LiveSource } from "../protect/types";
import { RelayUnavailable, type HlsFile, type HlsReader, type ReaderKind, type Relay, type WhepAnswer } from "./relay";

export const MTX_API_USER = "vantage-api";
export const MTX_PUBLISH_USER = "vantage-publisher";

/**
 * The MediaMTX relay: its control API (v3), its WHEP listener and its HLS listener. This file is
 * the only place that knows MediaMTX's URL shapes, the Bearer-ticket convention, the WHEP
 * `location` format and the HLS cookie and redirect mechanics. MediaMTX is never reachable from
 * browsers: these listeners stay on the internal network, and every reader is authorized by
 * Vantage through the HTTP auth hook. Only the WebRTC media port (ICE) is published.
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
  /** Creates or updates an on-demand path. */
  async ensureStream(name: string, src: LiveSource) {
    const conf = src.kind === "rtsp"
      ? { source: src.url, sourceOnDemand: true, sourceOnDemandCloseAfter: "10s", rtspTransport: "tcp", ...(src.tlsFingerprint ? { sourceFingerprint: src.tlsFingerprint } : {}) }
      : { source: "publisher", runOnDemand: src.command, runOnDemandRestart: true, runOnDemandCloseAfter: "10s" };
    const hash = createHash("sha256").update(JSON.stringify(conf)).digest("hex");
    if (this.known.get(name) === hash) return;
    let r = await this.api("POST", `/v3/config/paths/add/${encodeURIComponent(name)}`, conf);
    if (!r.ok) r = await this.api("POST", `/v3/config/paths/replace/${encodeURIComponent(name)}`, conf);
    if (!r.ok) throw new Error(`mediamtx path setup failed (${r.status})`);
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
