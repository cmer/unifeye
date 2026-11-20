import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { config, type Config } from "../config";

/**
 * Relay (TURN) servers for live video. When a browser cannot reach the WebRTC media port, both ends
 * meet at a TURN server instead: the browser and MediaMTX each connect out to it, and the video goes
 * through it. The relay only forwards encrypted media; who may watch what is still decided by the
 * gateway and the auth hook, exactly as without it.
 *
 * Browsers get short-lived logins from `GET /api/media/ice`. MediaMTX makes its own logins from the
 * same shared secret (its `AUTH_SECRET` mode, set up in compose.yaml), so nothing here talks to it.
 */
export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface IceConfig {
  iceServers: IceServer[];
  /** The browser should use only the relay, never a direct connection to the media port. */
  relayOnly: boolean;
  /** When the logins stop working (ms since epoch), or null when there are none. */
  expiresAt: number | null;
  /**
   * The relay did not answer its last check. A browser told to use only the relay goes straight to
   * HLS rather than wait for a connection that cannot work.
   */
  relayDown?: boolean;
}

/**
 * Where browser logins come from. One implementation today (coturn's shared secret); a hosted service
 * such as Cloudflare would be another, asking its API for logins and caching them.
 */
export interface TurnProvider {
  issue(sessionId: string): Promise<IceConfig>;
  /** Checks that the relay answers, and remembers it for `issue`. Null: no relay set up. */
  check(): Promise<boolean | null>;
  /** The last check's answer (true before the first). Null: no relay set up. */
  answering(): boolean | null;
}

export const NO_RELAY: IceConfig = { iceServers: [], relayOnly: false, expiresAt: null };
/** How long a browser login lasts. Browsers ask again before it runs out (src/ui/ice.ts). */
export const TURN_LOGIN_MS = 12 * 3600_000;

/** The relay addresses browsers are given, from the most to the least direct. */
export function turnUrls(c: Config = config()): string[] {
  const h = c.TURN_HOST!;
  return [
    `turn:${h}:${c.TURN_PORT}?transport=udp`,
    `turn:${h}:${c.TURN_PORT}?transport=tcp`,
    ...(c.TURN_TLS_PORT ? [`turns:${h}:${c.TURN_TLS_PORT}?transport=tcp`] : []),
  ];
}

/**
 * coturn with `use-auth-secret` (the "TURN REST API" convention): the username is
 * `<expiry in seconds>:<label>` and the password is base64(HMAC-SHA1(secret, username)). coturn checks
 * both without knowing anything about Unifeye. The label is a hash of the session, so the relay's logs
 * can tell viewers apart without learning anything that signs anyone in.
 */
export class CoturnProvider implements TurnProvider {
  /** Result of the last check; true until the first one, so start-up never blocks video. */
  up = true;
  constructor(private c: Config = config(), private now: () => number = Date.now, private probe: (host: string, port: number) => Promise<boolean> = stunPing) {}
  async issue(sessionId: string): Promise<IceConfig> {
    const expiresAt = this.now() + TURN_LOGIN_MS;
    const username = `${Math.floor(expiresAt / 1000)}:${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
    const credential = createHmac("sha1", this.c.TURN_SECRET!).update(username).digest("base64");
    return { iceServers: [{ urls: turnUrls(this.c), username, credential }], relayOnly: this.c.TURN_RELAY_ONLY, expiresAt, ...(this.up ? {} : { relayDown: true }) };
  }
  async check() {
    return (this.up = await this.probe(this.c.TURN_HOST!, this.c.TURN_PORT));
  }
  answering() { return this.up; }
}

/**
 * Sends a STUN Binding request over UDP (what MediaMTX uses to reach the relay) and waits for the
 * matching answer, retrying twice. coturn answers these without a login.
 */
export function stunPing(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomBytes(12), req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); // Binding request, no attributes
    req.writeUInt32BE(0x2112a442, 4); // magic cookie
    id.copy(req, 8);
    const sock = createSocket("udp4");
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearInterval(resend); clearTimeout(timer); sock.close(); resolve(ok); };
    sock.on("error", () => finish(false));
    sock.on("message", (m) => { if (m.length >= 20 && m.readUInt16BE(0) === 0x0101 && m.subarray(8, 20).equals(id)) finish(true); });
    const send = () => sock.send(req, port, host, (e) => { if (e) finish(false); });
    const resend = setInterval(send, timeoutMs / 3);
    const timer = setTimeout(() => finish(false), timeoutMs);
    send();
  });
}

const off: TurnProvider = { issue: async () => NO_RELAY, check: async () => null, answering: () => null };
/** The provider the configuration asks for. No TURN_HOST: no relay, browsers connect directly. */
export function turnProvider(c: Config = config()): TurnProvider {
  return c.TURN_HOST ? new CoturnProvider(c) : off;
}
