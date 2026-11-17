/**
 * Choosing a clip on the player's timeline: two ends, the stretch of time the timeline shows
 * meanwhile, the end being dragged, and whether the viewer has zoomed the timeline themselves (then
 * it stops fitting itself to the selection).
 *
 * Every rule about where the ends and the view may go lives here, as pure transitions: a clip is at
 * least `MIN_CLIP` and at most `maxClip` long, never ends later than two seconds ago, and the
 * timeline zooms between `TRIM_SPAN` and never runs far past now. The player only renders a `Trim`
 * and feeds it events. `now` is passed in, so tests choose the clock.
 */
export type Trim = { a: number; b: number; view: [number, number]; grab: End | null; zoomed: boolean };
export type End = "a" | "b";
export interface Limits { now: number; maxClip: number }

export const MIN_CLIP = 2000;
/** How far the clip timeline can zoom: one minute across at the closest, a day across at the widest. */
export const TRIM_SPAN: [number, number] = [60_000, 24 * 3600_000];
/** The newest moment a clip may include: the recorder needs a moment to write it. */
const latest = (now: number) => now - 2000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The timeline around a selection, with room on both sides to extend it. */
export const viewFor = (a: number, b: number): [number, number] => { const span = Math.max(180_000, (b - a) * 2.5), mid = (a + b) / 2; return [mid - span / 2, mid + span / 2]; };

/** A new selection: the 30 s (or `maxClip`, if shorter) ending 15 s after the playhead, or just behind live. */
export function startTrim(t: number, live: boolean, { now, maxClip }: Limits): Trim {
  const lim = latest(now), b = Math.min(live ? lim : t + 15_000, lim), a = b - Math.min(30_000, maxClip);
  return { a, b, view: viewFor(a, b), grab: null, zoomed: false };
}

/** Until the viewer zooms, the timeline refits to the selection; after that it stays put unless the selection leaves it. */
function keepView(tr: Trim, a: number, b: number): [number, number] {
  if (!tr.zoomed) return viewFor(a, b);
  const [v0, v1] = tr.view, span = v1 - v0;
  if (a >= v0 && b <= v1) return tr.view;
  if (b - a <= span) { const s = a < v0 ? a - span * 0.1 : b + span * 0.1 - span; return [s, s + span]; }
  return viewFor(a, b);
}

/** Dragging moves one end and stops at the limits; the other end stays put. The view refits once the drag is `done`. */
export function dragTrim(tr: Trim, g: End, ms: number, done: boolean, { now, maxClip }: Limits): Trim {
  const a = g === "a" ? clamp(ms, tr.b - maxClip, tr.b - MIN_CLIP) : tr.a;
  const b = g === "b" ? clamp(ms, tr.a + MIN_CLIP, Math.min(tr.a + maxClip, latest(now))) : tr.b;
  return { a, b, view: done ? keepView(tr, a, b) : tr.view, grab: done ? null : g, zoomed: tr.zoomed };
}

/** A typed time sets that end exactly; the other end follows only as far as the limits require. */
export function typeTrim(tr: Trim, g: End, ms: number, { now, maxClip }: Limits): Trim {
  const lim = latest(now);
  let a = tr.a, b = tr.b;
  if (g === "a") { a = Math.min(ms, lim - MIN_CLIP); b = Math.min(lim, clamp(b, a + MIN_CLIP, a + maxClip)); }
  else { b = Math.min(ms, lim); a = clamp(a, b - maxClip, b - MIN_CLIP); }
  return { a, b, view: keepView(tr, a, b), grab: null, zoomed: tr.zoomed };
}

/** The view's width after zooming by `factor` (above 1 widens it), within `TRIM_SPAN`. */
export const zoomedSpan = (tr: Trim, factor: number) => clamp((tr.view[1] - tr.view[0]) * factor, TRIM_SPAN[0], TRIM_SPAN[1]);

/**
 * Zooms by `factor`, keeping the moment at `frac` of the width in place (the selection's middle when
 * `frac` is undefined, as from the buttons or keys), and never runs far past now. Returns `tr`
 * itself when the zoom is already at its limit.
 */
export function zoomTrim(tr: Trim, factor: number, frac: number | undefined, now: number): Trim {
  const [v0, v1] = tr.view, sp = zoomedSpan(tr, factor);
  if (Math.abs(sp - (v1 - v0)) < 1) return tr;
  const f = frac ?? 0.5, at = frac === undefined ? (tr.a + tr.b) / 2 : v0 + frac * (v1 - v0);
  const s = Math.min(at - sp * f, now + sp * 0.1 - sp);
  return { ...tr, view: [s, s + sp], zoomed: true };
}

/** Slides the view sideways by a fraction of its width, stopping a little past now. */
export function panTrim(tr: Trim, frac: number, now: number): Trim {
  const [v0, v1] = tr.view, span = v1 - v0, s = Math.min(v0 + frac * span, now + span * 0.1 - span);
  return { ...tr, view: [s, s + span], zoomed: true };
}

/** The end a press on the timeline grabs: the nearer one. */
export const nearestEnd = (tr: Trim, ms: number): End => (Math.abs(ms - tr.a) <= Math.abs(ms - tr.b) ? "a" : "b");
