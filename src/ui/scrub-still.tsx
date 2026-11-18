"use client";
import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "./api";

/** At most one still is asked for in each stretch this long. */
export const STILL_GAP = 250;

type Later = (fn: () => void, ms: number) => () => void;

/**
 * Stills from a recording while someone drags along the timeline. One request at a time, at most one
 * every `gap` ms, always for the latest moment wanted; moments within `close` of the last one asked for
 * are skipped. A still is shown only once it has arrived, so the last one stays up until the next.
 */
export class StillFeed {
  private target: number | null = null;
  private close = 0;
  private tried: number | null = null;
  private busy = false;
  private last = -Infinity;
  private timer: (() => void) | null = null;
  private dead = false;

  constructor(
    private load: (ms: number) => Promise<string>,
    private show: (url: string, ms: number) => void,
    private o: { gap?: number; now?: () => number; later?: Later; onResult?: (ok: boolean, ms: number) => void } = {},
  ) {}

  want(ms: number, close = 0) { this.target = ms; this.close = close; this.pump(); }
  stop() { this.dead = true; this.timer?.(); this.timer = null; }

  private pump() {
    if (this.dead || this.busy || this.timer || this.target === null) return;
    if (this.tried !== null && Math.abs(this.target - this.tried) < Math.max(this.close, 1)) return;
    const now = this.o.now ?? Date.now, wait = this.last + (this.o.gap ?? STILL_GAP) - now();
    if (wait > 0) {
      const later: Later = this.o.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
      this.timer = later(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const ms = Math.round(this.target);
    this.busy = true; this.tried = ms; this.last = now();
    this.load(ms)
      .then((url) => { if (!this.dead) { this.o.onResult?.(true, ms); this.show(url, ms); } }, () => { if (!this.dead) this.o.onResult?.(false, ms); })
      .then(() => { this.busy = false; this.pump(); });
  }
}

/** Resolves once the picture has loaded, so showing it never flashes an empty frame. */
function loadImage(url: string): Promise<string> {
  return new Promise((ok, no) => { const img = new Image(); img.onload = () => ok(url); img.onerror = no; img.src = url; });
}

/**
 * A full-size still from a camera's recording at `ms`, following it as it changes. Shows nothing until
 * the first still arrives. Mount one per drag (with a fresh `key`) so a new drag never starts on an old picture.
 */
export function ScrubStill({ cameraId, ms, close, width = 1280, gap = STILL_GAP, onResult, className }: { cameraId: string; ms: number; close: number; width?: number; gap?: number; onResult?: (ok: boolean, ms: number) => void; className?: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const feed = useRef<StillFeed | null>(null);
  const report = useRef(onResult);
  useEffect(() => { report.current = onResult; });
  useEffect(() => {
    const f = new StillFeed((at) => loadImage(mediaUrl(`/api/cameras/${cameraId}/snapshot?w=${width}&at=${at}`)), (url) => setShown(url), { gap, onResult: (ok, at) => report.current?.(ok, at) });
    feed.current = f;
    return () => { f.stop(); feed.current = null; };
  }, [cameraId, width, gap]);
  useEffect(() => { feed.current?.want(ms, close); }, [ms, close, cameraId, width, gap]);
  return shown ? <img alt="" src={shown} className={className} /> : null;
}

/** How long the playhead must rest while dragging before its stretch of recording starts loading (`SCRUB_PRELOAD_MS`). */
export const WARM_REST = 500;
/** How long a warmed stretch is kept going after the drag ends, so the seek that follows can join it. */
export const WARM_KEEP = 3000;

/**
 * Gets a stretch of recording ready while someone drags the timeline, so letting go starts sooner. When
 * the playhead rests on one stretch for `rest` ms (0: never), `load` starts. Moving to another stretch cancels it;
 * the server then drops the export unless someone else is waiting for it. When the drag ends, the load
 * keeps going for `keep` ms so the seek that follows joins it rather than starting over.
 */
export class WindowWarmer {
  private warm: { at: number; ac: AbortController } | null = null;
  private resting: { at: number; cancel: () => void } | null = null;

  constructor(
    private load: (at: number, signal: AbortSignal) => Promise<unknown>,
    private o: { rest?: number; keep?: number; later?: Later } = {},
  ) {}

  private later(fn: () => void, ms: number) {
    return (this.o.later ?? ((f, m) => { const t = setTimeout(f, m); return () => clearTimeout(t); }))(fn, ms);
  }

  /** The stretch under the playhead (its start), or null where nothing should load (a gap, near live). */
  at(at: number | null) {
    if (this.warm && this.warm.at !== at) this.drop(0);
    if (this.resting && this.resting.at !== at) { this.resting.cancel(); this.resting = null; }
    const rest = this.o.rest ?? WARM_REST;
    if (at === null || rest <= 0 || this.warm || this.resting) return;
    this.resting = { at, cancel: this.later(() => {
      this.resting = null;
      const ac = new AbortController();
      this.warm = { at, ac };
      this.load(at, ac.signal).catch(() => {});
    }, rest) };
  }

  /** The drag ended: stop waiting, and let a load already going run a little longer. */
  release() { this.resting?.cancel(); this.resting = null; this.drop(this.o.keep ?? WARM_KEEP); }
  /** Cancel everything now. */
  stop() { this.resting?.cancel(); this.resting = null; this.drop(0); }

  private drop(after: number) {
    const w = this.warm;
    this.warm = null;
    if (!w) return;
    if (after) this.later(() => w.ac.abort(), after); else w.ac.abort();
  }
}
