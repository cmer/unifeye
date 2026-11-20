"use client";
import { useEffect, useRef } from "react";
import { api } from "./api";
import { windowStart } from "./recorded-playback";

/**
 * Getting tiles just off screen ready while the wall is rewound: so a tile scrolled into view starts
 * at once rather than waiting for the recorder, the windows it would play are asked for ahead (their
 * description only, which has the server export and cache them; nothing is downloaded or decoded).
 */

/** Tiles warmed at once, nearest the screen first. */
export const WARM_TILES = 4;
/** The window after the wall's is warmed too once the wall is this close to its end. */
const NEXT_WITHIN = 20_000;

/**
 * The tiles to warm: those near the screen (`near`) that are not playing, nearest first by their
 * place in the wall (`shown`) from the closest tile on screen, at most `limit`.
 */
export function warmTiles(shown: string[], playing: string[], near: string[], limit = WARM_TILES): string[] {
  const on = playing.map((id) => shown.indexOf(id)).filter((i) => i >= 0);
  const dist = (id: string) => { const i = shown.indexOf(id); return on.length ? Math.min(...on.map((j) => Math.abs(i - j))) : i; };
  return near.filter((id) => !playing.includes(id) && shown.includes(id)).sort((a, b) => dist(a) - dist(b)).slice(0, limit);
}

/**
 * The windows to warm at wall time `t`: the wall's own and, near its end, the next one. Only windows
 * fully recorded by `now` (as the server counts them), since a partial one is fetched again as it grows.
 */
export function warmWindows(t: number, W: number, now: number): number[] {
  const ws = windowStart(t, W), done = (s: number) => s + W < now - 2000;
  return [ws, ...(t >= ws + W - NEXT_WITHIN ? [ws + W] : [])].filter(done);
}

/**
 * Asks for the low-resolution description of each window of `windows` on each tile of `ids` while
 * `active`. A request no longer wanted is cancelled, which cancels its export on the server unless a
 * playing tile has since asked for the same window.
 */
export function useWarmTiles(ids: string[], windows: number[], active: boolean) {
  const reqs = useRef(new Map<string, AbortController>());
  const want = active ? ids.flatMap((id) => windows.map((ws) => `${id}@${ws}`)) : [], key = want.join(",");
  useEffect(() => {
    const m = reqs.current, keep = new Set(key ? key.split(",") : []);
    for (const [k, ac] of m) if (!keep.has(k)) { ac.abort(); m.delete(k); }
    for (const k of keep) {
      if (m.has(k)) continue;
      const [id, ws] = k.split("@"), ac = new AbortController();
      m.set(k, ac);
      api(`/cameras/${id}/playback/info?t=${ws}&low=1`, { signal: ac.signal }).catch(() => {});
    }
  }, [key]);
  useEffect(() => { const m = reqs.current; return () => { for (const ac of m.values()) ac.abort(); m.clear(); }; }, []);
}
