"use client";
import { api } from "./api";

/**
 * Relay (TURN) settings for WebRTC connections, from `GET /api/media/ice`. One answer serves every
 * tile in the tab until shortly before its logins expire, so a wall does not ask once per tile.
 * Without a relay the answer is empty and connections go straight to the media port, as before.
 */
export interface IceConfig { iceServers: RTCIceServer[]; relayOnly: boolean; expiresAt: number | null; relayDown?: boolean }

/** Ask again when less than this is left on the logins. Longer than any one connection attempt. */
const RENEW_BEFORE_MS = 30 * 60_000;
/** With no relay set up there is nothing to expire; check again now and then in case that changed. */
const NO_RELAY_REUSE_MS = 10 * 60_000;
/** The relay was not answering: ask again soon, since the server re-checks it every 30 s. */
const RELAY_DOWN_REUSE_MS = 30_000;

let cached: { cfg: IceConfig; until: number } | undefined;
let pending: Promise<IceConfig> | undefined;

/** The relay settings as the server gives them, fresh, without using or filling the shared copy. For the diagnostics window. */
export const iceSettings = () => api<IceConfig>("/media/ice", { record: false });

async function load(): Promise<IceConfig> {
  const cfg = await api<IceConfig>("/media/ice");
  cached = { cfg, until: cfg.relayDown ? Date.now() + RELAY_DOWN_REUSE_MS : cfg.expiresAt ? cfg.expiresAt - RENEW_BEFORE_MS : Date.now() + NO_RELAY_REUSE_MS };
  return cfg;
}

/**
 * The `RTCPeerConnection` settings for a live connection. If the server can't be asked, a direct
 * connection is tried. Null: WebRTC can only go through the relay and the relay isn't answering, so
 * use HLS without trying.
 */
export async function rtcConfiguration(): Promise<RTCConfiguration | null> {
  let cfg = cached && Date.now() < cached.until ? cached.cfg : undefined;
  if (!cfg) {
    pending ??= load().finally(() => { pending = undefined; });
    cfg = await pending.catch(() => undefined);
  }
  if (cfg?.relayDown && cfg.relayOnly) return null;
  if (!cfg?.iceServers.length) return {};
  return { iceServers: cfg.iceServers, iceTransportPolicy: cfg.relayOnly ? "relay" : "all" };
}
