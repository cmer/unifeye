/**
 * How much live video the browser holds before showing it (`LIVE_BUFFER_MS`). Cameras and the
 * recorder send in bursts: nothing for a few hundred milliseconds around each keyframe, then the
 * backlog at once. Shown as it arrives, that is a freeze and a jump every couple of seconds. Held
 * for a moment first, it plays evenly, that much further behind real time.
 */

/** Browsers accept a target of at most four seconds. */
export const MAX_LIVE_BUFFER_MS = 4000;

/** The parts of an `RTCRtpReceiver` this needs. `playoutDelayHint` (seconds) is the older name. */
export interface BufferedReceiver { jitterBufferTarget?: number | null; playoutDelayHint?: number | null }

/**
 * Asks one WebRTC receiver to hold `ms` of media. Sound and picture each get the same target, so
 * they stay together. Says how it was set; "none" when it is off (0) or the browser has no such
 * setting, in which case the stream plays as it arrives, as before.
 */
export function holdLive(receiver: BufferedReceiver, ms: number): "target" | "hint" | "none" {
  if (!Number.isFinite(ms) || ms <= 0) return "none";
  const held = Math.min(ms, MAX_LIVE_BUFFER_MS);
  try {
    if ("jitterBufferTarget" in receiver) { receiver.jitterBufferTarget = held; return "target"; }
    if ("playoutDelayHint" in receiver) { receiver.playoutDelayHint = held / 1000; return "hint"; }
  } catch { /* the browser refused the value: play as it arrives */ }
  return "none";
}
