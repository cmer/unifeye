/**
 * The playback order of one stretch of recorded video, as the server sends it and the player and clip
 * export follow it. The placement module (`placement/`) builds it; this file holds the format and the
 * readers the player shares.
 *
 * An export is a plain run of GOPs (keyframe plus what follows) with no times inside, and every
 * export starts with the last GOP before the requested start: the "lead", which the export of the
 * stretch before holds too, as its last GOP. With adaptive recording there are two files: the base
 * (the low channel) and the high channel. The order is a list of entries, played in order:
 *
 * - `base`: the base file alone.
 * - `over`: the high file over the base, both running (the same moment, in better quality).
 * - `insert`: the high file alone while the base waits: a moment the base does not have.
 *
 * Every frame of both files appears once, so nothing recorded is left out. Lead GOPs come first and
 * are flagged, so playing on from the stretch before can skip them (see `startAfter`).
 */

/** One GOP of an export: keyframe time and length in seconds of media time, and its keyframe's hash. */
export interface Gop { t: number; len: number; hash: string }

export interface Entry {
  kind: "base" | "over" | "insert";
  /** Seconds of playback. */
  len: number;
  /** Base media time at the entry's start; for an insert, where the base waits. */
  base: number;
  /** High media time at the entry's start (`over` and `insert`). */
  high?: number;
  /** Wall-clock ms at the entry's start, and how much wall-clock time it covers (shown time and seeking). */
  at: number;
  span: number;
  /** The lead GOP of that file: the stretch before ends with the same GOP. */
  lead?: true;
}

/**
 * Recorded segments of one channel, wall-clock ms, as the recorder lists them: each runs from the
 * first keyframe of a recorded run to its last keyframe, and short gaps inside are not listed.
 */
export type Segments = [number, number][];

/** Index of the first entry past the leads. */
export function skipLead(entries: Entry[]): number {
  let i = 0;
  while (i < entries.length && entries[i].lead) i++;
  return i;
}

/** Keyframe hashes of a file's first GOP (its lead) and last GOP: neighbouring stretches share them. */
export interface Seam { first: string; last: string }
/** A stretch's seams: its base file's, and its high file's when it has one. */
export interface Seams { base: Seam; high: Seam | null }

/**
 * Index of the first entry to play when a stretch carries on from `prev`, whose files ended with
 * those seams (null when nothing plays before it). The player starts the next window here, and a saved
 * clip joins its pieces here. All leads are skipped when the base lead is the GOP either of the
 * stretch before's files ended with: it was shown already. Otherwise the base lead plays so nothing
 * is left out. The high lead never plays: it is the last high GOP before the start, which may be from
 * well before it, and the stretch before showed it if it had it.
 */
export function startAfter(prev: Seams | null, next: { seams: Seams; entries: Entry[] }): number {
  const es = next.entries, first = next.seams.base.first;
  if (prev && first && (first === prev.base.last || first === prev.high?.last)) return skipLead(es);
  const k = es.findIndex((e) => e.lead && e.kind === "base");
  return k < 0 ? skipLead(es) : k;
}

/** Entry and offset (seconds into it) that show wall-clock `ms`. Leads are only chosen before their stretch starts. */
export function entryFor(entries: Entry[], ms: number): { i: number; offset: number } {
  if (!entries.length) return { i: 0, offset: 0 };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (ms < e.at) return { i, offset: 0 };
    if (ms < e.at + e.span) return { i, offset: Math.min(e.len, ((ms - e.at) / e.span) * e.len) };
  }
  const last = entries.length - 1;
  return { i: last, offset: entries[last].len };
}

/** Wall-clock time shown `offset` seconds into entry `e`. */
export const wallAt = (e: Entry, offset: number) => e.at + (e.len > 0 ? Math.min(1, Math.max(0, offset / e.len)) : 0) * e.span;
