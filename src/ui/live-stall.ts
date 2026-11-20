/**
 * Notices live HLS video that has stopped moving and says what to do about it. A player can sit
 * waiting forever, for example on a gap where the camera skipped frames, without reporting an
 * error. Stuck for `stuckMs`: jump to the live edge. Still stuck `recoverMs` after that: reconnect.
 */

/** How long playback may stand still before jumping to live. */
export const STALL_MS = 3000;
/** How long after a jump playback may still stand still before reconnecting. */
export const RECOVER_MS = 5000;

export type StallAction = "jump" | "reconnect" | null;

/**
 * `check(now, time, running)` is called about once a second with the clock (ms) and the video's
 * position (s). While `running` is false (not started, paused, tab hidden) nothing counts as stuck.
 */
export function stallWatch({ stuckMs = STALL_MS, recoverMs = RECOVER_MS } = {}) {
  let last = NaN, movedAt = 0, jumpedAt = 0, jumped = false, rebase = true;
  return function check(now: number, time: number, running: boolean): StallAction {
    if (!running) { movedAt = now; rebase = true; return null; }
    // The first look after a pause or a jump only sets where playback is: the jump itself moves
    // the position, which is not playback moving.
    if (rebase) { rebase = false; last = time; if (!jumped) movedAt = now; return null; }
    if (time !== last) { last = time; movedAt = now; jumped = false; return null; }
    if (!jumped) {
      if (now - movedAt < stuckMs) return null;
      jumped = true; jumpedAt = now; rebase = true;
      return "jump";
    }
    if (now - jumpedAt < recoverMs) return null;
    jumped = false; movedAt = now; rebase = true;
    return "reconnect";
  };
}

/**
 * Whether to play HLS with hls.js rather than the browser's own player. Chrome now reports that it
 * can play HLS itself, but its player has no way to recover from a stall; hls.js does. Apple's
 * browsers keep their own player: it uses less battery, and older iPhones cannot run hls.js.
 */
export const preferHlsJs = (vendor: string) => !/apple/i.test(vendor);
