import type { LiveSource } from "../protect/types";

/**
 * Everything Unifeye says to the media relay, and what it hears back. `Media` (gateway.ts) decides who may watch what and
 * owns tickets, grants and the sweep; a relay only carries those decisions out. The production
 * adapter is MediaMTX (mediamtx.ts); tests use the in-memory one (testing/relay.ts).
 *
 * The other direction: before admitting any reader, the relay asks `Media.admit()` with a
 * `ReaderRequest`, and the reader id in it is the id used by `readers` and `kick`. How a relay
 * receives that question, and how it recognises its own internal traffic (for MediaMTX, the auth
 * hook's body, its usernames and internal paths), stays inside the adapter.
 *
 * A `stream` is the relay-side name of one camera at one quality; `Media` chooses the names.
 * Every method except `healthy` and `kick` throws `RelayUnavailable` when the relay cannot be reached.
 */
export type ReaderKind = "webrtc" | "hls";

/** A viewer asking the relay to read `stream` with `ticket`. `id` is the relay's reader id. */
export interface ReaderRequest { kind: ReaderKind; stream: string; ticket: string; id: string }

export class RelayUnavailable extends Error {
  constructor() { super("media relay unavailable"); }
}

export type WhepAnswer =
  /** `resource` identifies the WHEP session for later trickle and close calls. Unvalidated: the caller checks it. */
  | { outcome: "created"; sdp: string; resource: string; etag: string | null }
  /** The relay has no such stream, or nothing is publishing to it. */
  | { outcome: "no_stream" }
  /** Anything else, including the auth hook refusing the ticket. */
  | { outcome: "failed" };

export type HlsFile =
  | { outcome: "ok"; body: ReadableStream<Uint8Array> | null; contentType: string | null }
  | { outcome: "not_found" }
  | { outcome: "failed" };

/**
 * One HLS reader as the relay sees it: a stream, and whatever the relay needs to recognise the same
 * reader across requests (for MediaMTX, its session cookie). It must live as long as the player does:
 * a new reader is a stranger to the relay, and MediaMTX refuses everything but the top playlist from one.
 * That state is the adapter's private business; nothing about it reaches `Media` or the browser.
 */
export interface HlsReader {
  /**
   * `ticket` is the current one for this reader. Unifeye renews it while the stream plays; the relay
   * presents it whenever it has to authorize the reader again (for MediaMTX, when a new session starts).
   */
  fetch(file: string, search: string, ticket: string): Promise<HlsFile>;
}

export interface Relay {
  healthy(): Promise<boolean>;
  /** Makes the stream available on demand from this source. The source carries upstream secrets and stays server-side. */
  ensureStream(stream: string, source: LiveSource): Promise<void>;

  /** Offers a WebRTC reader to the relay. The relay asks the auth hook with `ticket` before answering. */
  whepCreate(stream: string, ticket: string, sdpOffer: string): Promise<WhepAnswer>;
  /** ICE trickle. Returns the HTTP status to hand back to the browser. */
  whepTrickle(stream: string, resource: string, body: string | undefined, headers: Record<string, string>): Promise<number>;
  /** Teardown. Returns the HTTP status to hand back to the browser. */
  whepClose(stream: string, resource: string, headers: Record<string, string>): Promise<number>;

  /** Starts an HLS reader. Nothing is sent until its first `fetch`, which carries the ticket for the auth hook. */
  hlsReader(stream: string): HlsReader;

  /** Readers currently attached, by the id the relay gave the auth hook. */
  readers(kind: ReaderKind): Promise<{ id: string }[]>;
  /** Disconnects a reader. Best effort: never throws. */
  kick(kind: ReaderKind, id: string): Promise<void>;
}
