import type { WindowInfo } from "@/server/media/recordings";
import { entryFor, skipLead, wallAt, type Entry } from "@/server/media/timeline";

/**
 * Recorded playback, without React: where to start a window, when to buffer the next one and hand
 * over to it, and which file plays on every frame. The player wires these to its video elements;
 * tests drive them with fake elements.
 *
 * Time is cut into windows of `W` ms. Each window has a base file and, for adaptive recordings, a
 * high-resolution file, played in the order its entries give (`timeline.ts`):
 * - `base`: the base file plays.
 * - `over`: the base plays and the high file runs in step over it (the same moment, sharper).
 * - `insert`: the high file plays on its own while the base waits (a moment only it has).
 * Sound comes from the base alone, so inserts are silent.
 */

/** The parts of a <video> element playback needs. */
export interface MediaPort {
  currentTime: number;
  playbackRate: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  readonly error: unknown;
  play(): Promise<void>;
  pause(): void;
}

/** How far the high file may drift from the base under an `over` before it is moved, and before it is hidden. */
const DRIFT = 0.25;
/** How close a waiting file must sit to where it starts next. */
const PARKED = 0.05;
/** Seconds before an entry's end at which it counts as played. */
const EPS = 0.02;
const HAVE_METADATA = 1, HAVE_CURRENT_DATA = 2;

export const windowStart = (ms: number, W: number) => Math.floor(ms / W) * W;

/**
 * Whether to buffer the window after `ws`: only once that one is fully recorded (it ends more than
 * two seconds ago), so a buffered window is never a partial one.
 */
export const shouldArm = (ws: number, W: number, now: number) => ws + 2 * W < now - 2000;

/**
 * Whether the buffered next window can take over in place. Otherwise the player seeks to it, which
 * loads it from scratch (or goes live when it is too recent to be recorded yet).
 */
export const canHandOver = (buffered: MediaPort | null, nextStart: number, now: number) => !!buffered && !buffered.error && nextStart < now - 5000;

/**
 * Where playback stands: the entry playing, and where each file still has to be moved to (a seek
 * not yet carried out because the file was not ready).
 */
export interface Cursor { i: number; base?: number; high?: number }

/**
 * Where each file belongs to show entry `i`, `offset` seconds in. The high file goes to its place in
 * that entry or, when the entry doesn't use it, waits at the start of the next entry that does.
 */
export function positionAt(entries: Entry[], i: number, offset = 0): { base: number; high?: number } {
  const e = entries[i];
  if (!e) return { base: 0 };
  const base = e.kind === "insert" ? e.base : e.base + offset;
  if (e.high != null) return { base, high: e.high + offset };
  const next = entries.slice(i + 1).find((x) => x.high != null);
  return next ? { base, high: next.high } : { base };
}

/** The cursor that shows wall-clock `ms` (a seek). */
export function cursorAt(entries: Entry[], ms: number): Cursor {
  const { i, offset } = entryFor(entries, ms);
  return { i, ...positionAt(entries, i, offset) };
}

/**
 * The cursor for a base file already playing at media time `t`, in a new list of entries for the
 * same window: when the high file's order arrives while the base plays on. The base stays where it is.
 */
export function cursorAtBase(entries: Entry[], t: number): Cursor {
  // An insert where the base waits at or after `t` has not been shown yet (a lead never: it belongs before the window).
  let i = entries.findIndex((e) => (e.kind === "insert" ? !e.lead && e.base >= t - EPS : t < e.base + e.len - EPS));
  if (i < 0) i = entries.length;
  const e = entries[i], offset = e && e.kind !== "insert" ? Math.max(0, t - e.base) : 0;
  return { i, high: positionAt(entries, i, offset).high };
}

/**
 * Where the next window starts when playing on from `prev`. A window's first entries (its leads)
 * repeat the end of the window before: the base lead is skipped when its keyframe is the same as the
 * last one before, and played otherwise so nothing is left out. The high lead is always skipped: the
 * window before showed that moment already.
 */
export function carryOnAt(prev: Pick<WindowInfo, "seams">, next: Pick<WindowInfo, "seams" | "entries">): number {
  const es = next.entries, last = prev.seams.base.last;
  if (last && last === next.seams.base.first) return skipLead(es);
  const k = es.findIndex((e) => e.lead && e.kind === "base");
  return k < 0 ? skipLead(es) : k;
}

export interface Step {
  cur: Cursor;
  /** The window has played to its last entry: time to hand over to the next one. */
  handOver: boolean;
  /** Whether the high file is the picture to show (an insert, or an over it has caught up with). */
  showHigh: boolean;
  /** The wall-clock time on screen, or null while the files are still being moved into place. */
  wall: number | null;
}

/**
 * One animation frame of a playing window (see the module comment).
 *
 * An entry is over once the file it follows (the high file for an insert, else the base) reaches its
 * end; the next one then starts from where the files wait. Each file is played, paused and moved
 * only as its entry needs: under an `over`, the high file is kept in step with the base (moved when
 * it drifts, matched in speed); otherwise it waits at the start of the next entry that uses it, so
 * that entry can be shown at once. Without a usable high file, inserts are skipped and overs play as
 * the base alone. `start` plays a file (the player's version also handles a browser that refuses sound).
 */
export function stepEntries(base: MediaPort, high: MediaPort | null, entries: Entry[], cur: Cursor, o: { playing: boolean; rate: number; start?: (m: MediaPort) => void }): Step {
  const start = o.start ?? ((m: MediaPort) => void m.play().catch(() => {}));
  const hi = high && !high.error ? high : null;
  let i = cur.i, pb = cur.base, ph = cur.high;
  const move = (m: MediaPort, t: number) => { if (Math.abs(m.currentTime - t) > PARKED) m.currentTime = t; };
  if (pb != null && base.readyState >= HAVE_METADATA) { move(base, pb); pb = undefined; }
  if (ph != null && (!hi || hi.readyState >= HAVE_METADATA)) { if (hi) move(hi, ph); ph = undefined; }
  // Past the entries already played (several at once after the tab was in the background).
  for (let n = 0; n < 16 && i < entries.length; n++) {
    const e = entries[i];
    if (e.kind === "insert" && !hi) { i++; continue; }
    const m = e.kind === "insert" ? hi! : base, from = e.kind === "insert" ? e.high! : e.base;
    if ((e.kind === "insert" ? ph : pb) != null || m.readyState < HAVE_METADATA || m.seeking) break;
    if (!m.ended && m.currentTime - from < e.len - EPS) break;
    i++;
  }
  const out = (showHigh: boolean, wall: number | null, handOver = false): Step => ({ cur: { i, ...(pb != null ? { base: pb } : {}), ...(ph != null ? { high: ph } : {}) }, handOver, showHigh, wall });
  const keep = (m: MediaPort, run: boolean) => {
    if (m.playbackRate !== o.rate) m.playbackRate = o.rate;
    if (run) { if (m.paused && !m.ended) start(m); } else if (!m.paused) m.pause();
  };
  if (i >= entries.length) {
    if (hi && !hi.paused) hi.pause();
    if (!base.paused && !base.ended && entries.length && base.readyState >= HAVE_METADATA) base.pause();
    return out(false, null, o.playing);
  }
  const e = entries[i];
  if (e.kind === "insert") {
    const h = hi!;
    keep(base, false);
    if (pb == null && base.readyState >= HAVE_METADATA && !base.seeking && base.currentTime < e.base - PARKED) base.currentTime = e.base;
    if (ph != null || h.readyState < HAVE_METADATA) return out(false, null);
    if (!h.seeking && h.currentTime < e.high! - PARKED) h.currentTime = e.high!;
    keep(h, o.playing);
    return out(h.readyState >= HAVE_CURRENT_DATA && !h.seeking, wallAt(e, h.currentTime - e.high!));
  }
  if (pb != null) return out(false, null);
  if (base.readyState >= HAVE_METADATA && !base.seeking && base.currentTime < e.base - PARKED) base.currentTime = e.base;
  keep(base, o.playing);
  const wall = wallAt(e, base.currentTime - e.base);
  if (!hi) return out(false, wall);
  if (e.kind === "over") {
    const want = e.high! + (base.currentTime - e.base);
    if (ph == null && hi.readyState >= HAVE_METADATA && !hi.seeking && Math.abs(hi.currentTime - want) > DRIFT) hi.currentTime = want;
    keep(hi, !base.paused && !base.seeking && o.playing);
    return out(hi.readyState >= HAVE_CURRENT_DATA && !hi.seeking && Math.abs(hi.currentTime - want) <= DRIFT, wall);
  }
  keep(hi, false);
  const up = positionAt(entries, i).high;
  if (ph == null && up != null && hi.readyState >= HAVE_METADATA && !hi.seeking) move(hi, up);
  return out(false, wall);
}

/**
 * Where recorded playback stands across frames: the window it plays (`key`), the cursor in that
 * window's entries, whether it started with a seek, and whether the window's high-resolution order
 * is still to come. `from` is the window it was handed over from, if any.
 */
export interface Playback { key: string; cur: Cursor; seek: boolean; pending: boolean; from?: string }

/** A window as playback needs it: its key and its description. */
export interface PlayWindow { key: string; info: Pick<WindowInfo, "entries" | "pending"> }

/** Seconds after a seek within which the high-resolution order, once it arrives, starts again from the moment asked for. */
const SEEK_SWAP = 10_000;

/** Playback started by a seek to wall-clock `ms` in window `w`. */
export const seekTo = (w: PlayWindow, ms: number): Playback => ({ key: w.key, cur: cursorAt(w.info.entries, ms), seek: true, pending: !!w.info.pending });

/**
 * Playback handed over in place from window `prev` to the buffered window `next`: it carries on
 * where `carryOnAt` says, rather than seeking.
 */
export function handOver(prev: { key: string; info: Pick<WindowInfo, "seams"> }, next: { key: string; info: Pick<WindowInfo, "seams" | "entries" | "pending"> }): Playback {
  const i = carryOnAt(prev.info, next.info);
  return { key: next.key, cur: { i, ...positionAt(next.info.entries, i) }, seek: false, pending: !!next.info.pending, from: prev.key };
}

/**
 * One animation frame of recorded playback: `s` stepped in window `w` (see `stepEntries`), or null
 * when this frame should do nothing.
 *
 * A window other than the one playing starts with a seek to `at.target`. When the high-resolution
 * order arrives (the window was `pending` and no longer is), playback shortly after a seek (a seek
 * not yet carried out, or less than 10 seconds shown from the moment asked for) starts again from
 * that moment, which may be one only the high-resolution file has; otherwise it carries on from where
 * the base file is. A frame of the window just handed over from does nothing: the player may still
 * run one before it has caught up with the hand-over, and it must not undo it.
 */
export function stepPlayback(
  s: Playback | null, w: PlayWindow, base: MediaPort, high: MediaPort | null,
  at: { target: number; shown: number }, o: { playing: boolean; rate: number; start?: (m: MediaPort) => void },
): { s: Playback; step: Step } | null {
  if (s && s.key !== w.key && s.from === w.key) return null;
  if (s?.key !== w.key) s = seekTo(w, at.target);
  else if (s.pending && !w.info.pending) {
    const atSeek = s.cur.base != null || Math.abs(at.shown - at.target) < SEEK_SWAP;
    s = { ...s, pending: false, cur: s.seek && atSeek ? cursorAt(w.info.entries, at.target) : cursorAtBase(w.info.entries, base.currentTime) };
  }
  const step = stepEntries(base, high, w.info.entries, s.cur, o);
  return { s: { ...s, cur: step.cur }, step };
}
