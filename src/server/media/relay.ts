import type { LiveSource } from "../protect/types";

/**
 * Everything Vantage says to the media relay. `Media` (gateway.ts) decides who may watch what and
 * owns tickets, grants and the sweep; a relay only carries those decisions out. The production
 * adapter is MediaMTX (mediamtx.ts); tests use the in-memory one (testing/relay.ts).
 *
 * The other direction is not part of this interface: the relay asks `Media.hook()` before it
 * admits any reader, and the reader id it reports there is the id used by `readers` and `kick`.
 *
 * A `stream` is the relay-side name of one camera at one quality; `Media` chooses the names.
 * Every method except `healthy` and `kick` throws `RelayUnavailable` when the relay cannot be reached.
 */
export type ReaderKind = "webrtc" | "hls";

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
 * One HLS reader as the relay sees it: a stream, the ticket that authorizes it, and whatever the
 * relay needs to recognise the same reader across requests (for MediaMTX, its session cookie).
 * That last part is the adapter's private state; nothing about it reaches `Media` or the browser.
 */
export interface HlsReader {
  fetch(file: string, search: string): Promise<HlsFile>;
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

  /** Starts an HLS reader. Nothing is sent until its first `fetch`; the relay asks the auth hook with `ticket`. */
  hlsReader(stream: string, ticket: string): HlsReader;

  /** Readers currently attached, by the id the relay gave the auth hook. */
  readers(kind: ReaderKind): Promise<{ id: string }[]>;
  /** Disconnects a reader. Best effort: never throws. */
  kick(kind: ReaderKind, id: string): Promise<void>;
}
