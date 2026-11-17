import { RelayUnavailable, type HlsFile, type HlsReader, type ReaderKind, type ReaderRequest, type Relay, type WhepAnswer } from "../media/relay";
import type { LiveSource } from "../protect/types";

export const HLS_PLAYLIST = "#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nseg1.mp4\n";
export const HLS_SEGMENT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

/**
 * An in-memory media relay for tests. It behaves like MediaMTX as far as Unifeye can observe:
 *  - it admits no reader on its own: every WHEP offer and every new HLS session (opened by the top
 *    playlist, `index.m3u8`) asks `Media.admit` with the ticket it was given, and refuses when that refuses;
 *  - other HLS files are served only to the session the reader already holds, whatever ticket comes with them;
 *  - admitted readers are sessions with ids, which `readers` lists and `kick` removes;
 *  - a stream must have been set up before anyone can read it;
 *  - it can be down, and it can forget everything like a restarted relay.
 * It has no cookies, redirects, auth-hook bodies or internal publishers: those are MediaMTX mechanics
 * that live inside the MediaMTX adapter.
 */
export class MemoryRelay implements Relay {
  /** Simulates an unreachable relay. */
  down = false;
  readonly streams = new Map<string, LiveSource>();
  /** Every ticket presented by a reader, in order. */
  readonly tickets: string[] = [];
  /** Every reader id kicked, in order. */
  readonly kicked: string[] = [];
  private sessions = new Map<string, { kind: ReaderKind; stream: string; resource?: string }>();
  private admitReader: (r: ReaderRequest) => boolean = () => false;
  private seq = 0;
  private held: Promise<void> | null = null;

  /** Who decides whether a reader may read. Until this is called, every reader is refused. */
  connect(admit: (r: ReaderRequest) => boolean) { this.admitReader = admit; }

  // ---- test controls ----
  /** Ids of attached readers of one kind, oldest first. */
  ids(kind: ReaderKind) { return [...this.sessions].filter(([, s]) => s.kind === kind).map(([id]) => id); }
  /** A reader that got in without Unifeye admitting it (it never went through the hook). */
  intruder(kind: ReaderKind, stream = "c_unknown_wall") { const id = `intruder-${++this.seq}`; this.sessions.set(id, { kind, stream }); return id; }
  /** Makes `readers()` wait until the returned function is called, to hold a sweep mid-flight. */
  holdListing() { let release = () => {}; this.held = new Promise((r) => { release = () => { this.held = null; r(); }; }); return release; }
  /** A relay restart: streams and readers are gone. */
  restart() { this.streams.clear(); this.sessions.clear(); }

  private up() { if (this.down) throw new RelayUnavailable(); }
  private admit(kind: ReaderKind, stream: string, ticket: string, id: string) {
    this.tickets.push(ticket);
    return this.admitReader({ kind, stream, ticket, id });
  }

  // ---- Relay ----
  async healthy() { return !this.down; }
  async ensureStream(stream: string, source: LiveSource) { this.up(); this.streams.set(stream, source); }

  async whepCreate(stream: string, ticket: string): Promise<WhepAnswer> {
    this.up();
    if (!this.streams.has(stream)) return { outcome: "no_stream" };
    const id = `webrtc-${++this.seq}`;
    if (!this.admit("webrtc", stream, ticket, id)) return { outcome: "failed" };
    const resource = `whep-${id}-resource`;
    this.sessions.set(id, { kind: "webrtc", stream, resource });
    return { outcome: "created", sdp: "v=0 answer", resource, etag: `"${id}"` };
  }
  async whepTrickle(stream: string, resource: string) {
    this.up();
    return this.byResource(stream, resource) ? 204 : 404;
  }
  async whepClose(stream: string, resource: string) {
    this.up();
    const id = this.byResource(stream, resource);
    if (!id) return 404;
    this.sessions.delete(id);
    return 200;
  }
  private byResource(stream: string, resource: string) {
    for (const [id, s] of this.sessions) if (s.stream === stream && s.resource === resource) return id;
    return undefined;
  }

  hlsReader(stream: string): HlsReader {
    let id = "";
    return {
      fetch: async (file, _search, ticket): Promise<HlsFile> => {
        this.up();
        if (!this.streams.has(stream)) return { outcome: "not_found" };
        // As in MediaMTX, only the top playlist opens a session, and that is when the hook is asked.
        // Every other file belongs to the session this reader already holds; without one it is refused.
        if (file === "index.m3u8") {
          const next = `hls-${++this.seq}`;
          if (!this.admit("hls", stream, ticket, next)) return { outcome: "failed" };
          id = next;
          this.sessions.set(id, { kind: "hls", stream });
          return { outcome: "ok", body: new Response(HLS_PLAYLIST).body, contentType: "application/vnd.apple.mpegurl" };
        }
        if (!this.sessions.has(id)) return { outcome: "failed" };
        if (file === "init.mp4" || file === "seg1.mp4") return { outcome: "ok", body: new Response(HLS_SEGMENT).body, contentType: "video/mp4" };
        return { outcome: "not_found" };
      },
    };
  }

  async readers(kind: ReaderKind) {
    this.up();
    if (this.held) await this.held;
    return this.ids(kind).map((id) => ({ id }));
  }
  async kick(_kind: ReaderKind, id: string) {
    if (this.down) return;
    this.kicked.push(id);
    this.sessions.delete(id);
  }
}
