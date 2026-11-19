"use client";
import { Pause, Play, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, dayBounds, EVENT_COLOR, EVENT_LABEL, fmtShort, fmtTime, type ActivityEvent } from "./api";
import { windowStart } from "./recorded-playback";
import { WindowWarmer } from "./scrub-still";
import { DAY, fmtAgo, tickTimes, wheelZoomSteps } from "./timeline";

type Range = [number, number];
/** How much time the timeline shows, widest first. 0 is the last 24 hours. */
const ZOOMS: [number, string][] = [[0, "24 hours"], [6 * 3600_000, "6 hours"], [3600_000, "1 hour"], [600_000, "10 minutes"]];
/** Spacing between timeline labels: the first that gives at most six across. */
const TICKS = [60_000, 120_000, 300_000, 600_000, 900_000, 1800_000, 3600_000, 7200_000, 3 * 3600_000, 6 * 3600_000];
/** A tile further than this from the others is moved back in step (at most once every `RESYNC_EVERY`). */
const DRIFT_MS = 3000, RESYNC_EVERY = 10_000;
/** Stills asked for per second across the whole wall while dragging, to go easy on the recorder. */
const WALL_STILLS_PER_SECOND = 10;
const now = () => Date.now();

/** Joins overlapping ranges (sorted by start). */
export function mergeRanges(lists: Range[][]): Range[] {
  const all = lists.flat().sort((a, b) => a[0] - b[0]), out: Range[] = [];
  for (const [s, e] of all) { const last = out[out.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]); }
  return out;
}

/** The middle of the tiles' times: one slow or early tile doesn't pull the wall with it. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Which tiles to move back in step with the wall. `times` are the tiles that reported recently, with
 * their time now; a tile is moved when it is more than `drift` away and was not moved in the last `every` ms.
 */
export function outOfStep(times: Map<string, number>, at: number, lastMoved: Map<string, number>, clock: number, drift = DRIFT_MS, every = RESYNC_EVERY): string[] {
  return [...times].filter(([id, ms]) => Math.abs(ms - at) > drift && clock - (lastMoved.get(id) ?? -Infinity) >= every).map(([id]) => id);
}

/**
 * Each view is its own wall (it remounts), so switching views hands the rewind over here: the wall
 * going away leaves it, the next one picks it up if it is fresh. `at` null: rewinding but live.
 */
let handover: { at: number | null; playing: boolean; speed: number; savedAt: number } | null = null;
const HANDOVER_MS = 3000;
function fromHandover() {
  const h = handover, age = h ? Date.now() - h.savedAt : Infinity;
  if (!h || age > HANDOVER_MS) return null;
  return { ...h, at: h.at === null ? null : h.at + (h.playing ? age * h.speed : 0) };
}

export interface TileHandlers {
  onTime: (ms: number) => void;
  onEnd: (ms: number) => void;
  onMissing: (missing: boolean) => void;
  onPlaying: () => void;
}

/**
 * Playing the wall back in time. Every tile plays the same moment: one seek moves them all, and a tile
 * that falls out of step (a slow load, a stall) is moved back to where the others are. While someone drags
 * the timeline, tiles show stills and nothing seeks until they let go.
 */
export function useRewind({ playIds, shownIds, W, preloadMs, startAt }: { playIds: string[]; shownIds: string[]; W: number; preloadMs: number; startAt?: number }) {
  /** `startAt`: coming back to a wall that was rewound (see the wall's `at` address parameter). Otherwise a view just switched from may hand its rewind over. */
  const [carried] = useState(() => (startAt ? { at: startAt, playing: true, speed: 1 } : fromHandover()));
  const [open, setOpen] = useState(!!carried);
  const [clock, setClock] = useState(() => Date.now());
  /** Where the last seek landed, and a count of seeks (tiles remount on each). null: live. */
  const [seekTo, setSeekTo] = useState<{ ms: number; n: number } | null>(carried?.at ? { ms: carried.at, n: 0 } : null);
  const seeks = useRef(0);
  const [t, setT] = useState(() => carried?.at || Date.now());
  const [playing, setPlaying] = useState(carried?.playing ?? true);
  const [speed, setSpeed] = useState(carried?.speed ?? 1);
  /** Tiles moved on their own since the last seek: back in step, or to the next window when it couldn't take over. */
  const [tileSeek, setTileSeek] = useState<Record<string, { ms: number; n: number }>>({});
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  /** Tiles that have started playing since the last seek. */
  const [started, setStarted] = useState<Set<string>>(() => new Set());
  const [scrub, setScrub] = useState<{ ms: number; held: boolean; n: number } | null>(null);
  const reports = useRef(new Map<string, { ms: number; at: number }>()), moved = useRef(new Map<string, number>()), seekedAt = useRef(0);
  const live = seekTo === null;
  // Leave the rewind for the next view's wall (see `handover`). Kept current on every update, since the
  // next wall is built before this one goes away.
  useEffect(() => { handover = open ? { at: live ? null : t, playing, speed, savedAt: Date.now() } : null; });

  useEffect(() => { const i = setInterval(() => { const n = Date.now(); setClock(n); if (live) setT(n); }, 1000); return () => clearInterval(i); }, [live]);

  const seek = (ms: number) => {
    reports.current.clear(); moved.current.clear(); seekedAt.current = now();
    setTileSeek({}); setMissing({}); setStarted(new Set()); setPlaying(true);
    if (ms >= now() - 5000) { setSeekTo(null); setT(now()); return; }
    setSeekTo({ ms, n: ++seeks.current }); setT(ms);
  };
  /** Pausing live holds the wall a few seconds back, as the player does. */
  const toggle = () => { if (live) { seek(now() - 6000); setPlaying(false); } else setPlaying((p) => !p); };
  const close = () => { setOpen(false); setScrub(null); if (!live) seek(now()); };

  // Keep the wall in step: its time is the middle of the tiles' times, and a tile far from it is moved there.
  // Until a tile plays, and for tiles with nothing recorded, the time moves on by itself.
  const ids = useRef(playIds);
  useEffect(() => { ids.current = playIds; });
  useEffect(() => {
    if (live || !playing) return;
    const i = setInterval(() => {
      const c = now(), fresh = new Map<string, number>();
      for (const [id, r] of reports.current) if (ids.current.includes(id) && c - r.at < 1500) fresh.set(id, r.ms + (c - r.at) * speed);
      if (fresh.size) {
        const m = median([...fresh.values()]);
        setT(m);
        const late = outOfStep(fresh, m, moved.current, c);
        if (late.length) {
          for (const id of late) { moved.current.set(id, c); reports.current.delete(id); }
          setTileSeek((p) => ({ ...p, ...Object.fromEntries(late.map((id) => [id, { ms: m, n: (p[id]?.n ?? 0) + 1 }])) }));
        }
      } else if (c - seekedAt.current > 4000) setT((p) => p + 500 * speed);
    }, 500);
    return () => clearInterval(i);
  }, [live, playing, speed]);

  // A tile that starts playing after the seek (scrolled into view, a filter changed) starts where the wall is now.
  const [prevPlay, setPrevPlay] = useState(playIds);
  if (prevPlay !== playIds) {
    setPrevPlay(playIds);
    const added = seekTo ? playIds.filter((id) => !prevPlay.includes(id)) : [];
    if (added.length) setTileSeek((p) => ({ ...p, ...Object.fromEntries(added.map((id) => [id, { ms: t, n: (p[id]?.n ?? 0) + 1 }])) }));
  }
  const tile = (id: string): TileHandlers => ({
    onTime: (ms) => reports.current.set(id, { ms, at: now() }),
    onEnd: (ms) => setTileSeek((p) => ({ ...p, [id]: { ms, n: (p[id]?.n ?? 0) + 1 } })),
    onMissing: (m) => setMissing((p) => (p[id] === m ? p : { ...p, [id]: m })),
    onPlaying: () => setStarted((p) => (p.has(id) ? p : new Set(p).add(id))),
  });
  const tileStart = (id: string) => (seekTo ? { key: `${seekTo.n}:${tileSeek[id]?.n ?? 0}`, ms: tileSeek[id]?.ms ?? seekTo.ms } : null);

  // ---- the timeline's data: when any camera on screen recorded, and what they saw ----
  const [ranges, setRanges] = useState<Record<string, { ranges: Range[]; precision: "exact" | "bounds" }>>({});
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [refresh, setRefresh] = useState(0);
  const from = Math.floor((clock - DAY) / 3600_000) * 3600_000, idKey = shownIds.join(",");
  useEffect(() => {
    if (!open || !idKey) return;
    let off = false;
    const to = Date.now(), list = idKey.split(",");
    Promise.all(list.map((id) => api<{ ranges: Range[]; precision: "exact" | "bounds" }>(`/cameras/${id}/recordings?from=${from}&to=${to}`).then((r) => [id, r] as const, () => null)))
      .then((rs) => { if (!off) setRanges(Object.fromEntries(rs.filter((r) => r !== null))); });
    api<{ events: ActivityEvent[] }>(`/events?from=${from}&to=${to}&limit=1000`).then((r) => { if (!off) { const keep = new Set(list); setEvents(r.events.filter((e) => keep.has(e.cameraId))); } }).catch(() => {});
    return () => { off = true; };
  }, [open, idKey, from, refresh]);
  useEffect(() => { if (!open) return; const i = setInterval(() => setRefresh((n) => n + 1), 180_000); return () => clearInterval(i); }, [open]);
  const union = useMemo(() => mergeRanges(Object.values(ranges).map((r) => r.ranges)), [ranges]);
  const exact = Object.values(ranges).every((r) => r.precision === "exact");
  /** Whether a camera recorded at `ms`, as far as the timeline knows (see the player's `recorded`). */
  const recorded = (id: string, ms: number) => { const r = ranges[id]; return !r || r.precision !== "exact" || ms > clock - 200_000 || r.ranges.some(([s, e]) => ms >= s && ms < e); };

  // ---- dragging: stills on every tile, one seek on letting go ----
  const warmRef = useRef<WindowWarmer | null>(null);
  /** Made on first use, in an event handler; it loads the window on every tile that would play it. */
  const warmer = () => (warmRef.current ??= new WindowWarmer((at, signal) => Promise.all(ids.current.map((id) => api(`/cameras/${id}/playback/info?t=${at}`, { signal }).catch(() => null))), { rest: preloadMs }));
  useEffect(() => { const w = warmRef; return () => w.current?.stop(); }, []);
  const scrubTo = (ms: number) => { warmer().at(ms < now() - 10_000 ? windowStart(ms, W) : null); setScrub((p) => (p ? { ...p, ms } : p)); };
  const startScrub = (ms: number) => { setPlaying(false); setScrub((p) => ({ ms, held: false, n: (p?.n ?? 0) + 1 })); scrubTo(ms); };
  const endScrub = () => {
    if (!scrub || scrub.held) return;
    warmer().release(); seek(scrub.ms);
    setScrub(scrub.ms < now() - 5000 ? { ...scrub, held: true } : null);
  };
  // The stills stay up until every tile plays from there, or for a few seconds at most.
  useEffect(() => { if (!scrub?.held) return; const i = setTimeout(() => setScrub(null), 8000); return () => clearTimeout(i); }, [scrub]);
  const allStarted = playIds.every((id) => started.has(id) || missing[id]);
  if (scrub?.held && allStarted) setScrub(null);
  const dragging = !!scrub && !scrub.held;
  /** A still is shown on a tile while dragging, and after letting go until that tile plays. */
  const stillAt = (id: string) => (scrub && (dragging || (!started.has(id) && !missing[id])) ? scrub.ms : null);
  const stillGap = Math.max(250, Math.round((1000 * Math.max(1, shownIds.length)) / WALL_STILLS_PER_SECOND));

  return { open, setOpen, close, live, clock, t, seek, toggle, playing, setPlaying, speed, setSpeed, tile, tileStart, missing, union, exact, events, recorded,
    scrub, dragging, startScrub, scrubTo, endScrub, stillAt, stillGap, pt: dragging ? scrub.ms : t };
}
export type RewindState = ReturnType<typeof useRewind>;

/**
 * The timeline and its controls, in place of the wall's dock while rewinding. `dock` and `tools` are the
 * dock's own buttons (views, filter, full screen), kept on either side.
 */
export function RewindBar({ rw, tz, dock, tools }: { rw: RewindState; tz: string; dock: React.ReactNode; tools: React.ReactNode }) {
  const { clock, t, pt, live, dragging, scrub } = rw;
  const [zoom, setZoom] = useState(0);
  const [view, setView] = useState<number | null>(null);
  const tl = useRef<HTMLDivElement>(null);
  const zoomBy = (d: number) => setZoom((z) => { const n = Math.min(Math.max(z + d, 0), ZOOMS.length - 1); if (n !== z) setView(null); return n; });
  // The wheel or a pinch on the timeline steps through the zoom levels. A native listener, so the page doesn't scroll or zoom.
  const [wheelSteps] = useState(() => wheelZoomSteps());
  useEffect(() => {
    const el = tl.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const d = wheelSteps(e); if (d) zoomBy(d); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [wheelSteps]);
  const lo = clock - DAY, hi = clock, span = ZOOMS[zoom][0];
  let a = lo, b = hi;
  // Zoomed in, the timeline shows a stretch around the playhead that holds still while the playhead is inside it.
  if (span) {
    const fits = view !== null && view >= lo && view + span <= hi && t >= view && t <= view + span;
    a = fits ? view : Math.min(Math.max(t - span * (live ? 0.9 : 0.5), lo), hi - span); b = a + span;
    if (a !== view) setView(a);
  }
  const step = TICKS.find((s) => (b - a) / s <= 6) ?? TICKS[TICKS.length - 1];
  const toNow = b >= clock - 2000, today = dayBounds(clock, tz)[0];
  const ticks = tickTimes(a, b, step, tz).filter((m) => !toNow || (b - m) / (b - a) > 0.08);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - a) / (b - a)) * 100))}%`;
  const at = (el: HTMLElement, x: number) => { const r = el.getBoundingClientRect(); return a + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (b - a); };
  const toLive = dragging && (scrub?.ms ?? 0) >= clock - 5000, showLive = dragging ? toLive : live;
  const ago = showLive ? null : fmtAgo(clock - pt);
  const ghost = "text-foreground";
  const f = (pt - a) / (b - a);

  return (
    <div className="absolute inset-x-3 bottom-3 z-20 rounded-xl border bg-background/90 px-3 pt-2 pb-1.5 shadow-lg backdrop-blur-md">
      <div ref={tl} className="relative h-8 cursor-pointer touch-none select-none before:absolute before:inset-x-0 before:-top-3 before:-bottom-4 before:content-['']" role="slider" aria-label="Timeline" aria-valuemin={a} aria-valuemax={b} aria-valuenow={Math.round(pt)} aria-valuetext={fmtTime(pt, tz)} tabIndex={0}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); rw.startScrub(at(e.currentTarget, e.clientX)); }}
        onPointerMove={(e) => { if (e.buttons && dragging) rw.scrubTo(at(e.currentTarget, e.clientX)); }}
        onPointerUp={rw.endScrub} onPointerCancel={rw.endScrub}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") rw.seek(t - 10_000); else if (e.key === "ArrowRight") rw.seek(t + 10_000); else return; e.preventDefault(); }}>
        <div className="absolute inset-x-0 bottom-2 h-[5px] overflow-hidden rounded-full bg-foreground/15" title={rw.exact ? undefined : "Some gaps in the recording may not be shown"}>
          {rw.union.map(([s, e], i) => e > a && s < b ? <i key={i} className={`absolute inset-y-0 ${rw.exact ? "bg-foreground/70" : "bg-foreground/45"}`} style={{ left: pct(s), right: `calc(100% - ${pct(e)})` }} /> : null)}
        </div>
        {rw.events.filter((e) => e.startMs > a && e.startMs < b).map((e) => <i key={e.id} title={`${EVENT_LABEL[e.type] ?? e.type}, ${fmtShort(e.startMs, tz)}`} className="absolute bottom-[17px] size-1.5 -translate-x-1/2 rounded-full" style={{ left: pct(e.startMs), background: EVENT_COLOR[e.type] ?? "#a3a3a3" }} />)}
        <i className={`pointer-events-none absolute bottom-[3px] size-[15px] -translate-x-1/2 rounded-full ${showLive ? "live-dot bg-red-500" : "bg-foreground shadow-[0_0_0_4px_color-mix(in_oklab,var(--foreground)_25%,transparent)]"}`} style={{ left: pct(pt) }} />
        {dragging && <span className={`pointer-events-none absolute bottom-8 rounded-md bg-foreground px-2 py-0.5 text-sm font-semibold whitespace-nowrap text-background tabular-nums shadow ${f < 0.06 ? "" : f > 0.94 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: pct(pt) }}>{toLive ? "Live" : fmtTime(pt, tz)}</span>}
      </div>
      <div className="pointer-events-none relative h-4 text-[11px] text-muted-foreground">{ticks.map((m) => { const g = (m - a) / (b - a); return <span key={m} className={`absolute top-0 whitespace-nowrap ${g < 0.04 ? "" : g > 0.96 ? "-translate-x-full" : "-translate-x-1/2"} ${m === today ? "font-semibold text-foreground" : ""}`} style={{ left: pct(m) }}>{m === today ? "Today" : fmtShort(m, tz)}</span>; })}
        {toNow && (live ? <span className="absolute top-0 right-0 font-semibold text-red-500">Now</span>
          : <button type="button" className="pointer-events-auto absolute -top-1 -right-2 cursor-pointer rounded px-2 py-1 font-semibold text-red-500 hover:text-red-400" onClick={rw.close}>Now</button>)}</div>
      <div className="mt-1 flex items-center gap-0.5 overflow-x-auto">
        {dock}
        <Button variant="ghost" size="icon" className={ghost} aria-label="Back 10 seconds" onClick={() => rw.seek(t - 10_000)}><RotateCcw /></Button>
        <Button variant="ghost" size="icon" className={ghost} aria-label={rw.playing ? "Pause" : "Play"} onClick={rw.toggle}>{rw.playing ? <Pause /> : <Play />}</Button>
        <Button variant="ghost" size="icon" className={ghost} aria-label="Forward 10 seconds" disabled={live} onClick={() => rw.seek(t + 10_000)}><RotateCw /></Button>
        {showLive
          ? <span className="ml-2 flex shrink-0 items-center gap-2 tabular-nums"><span className="flex items-center gap-1.5 text-xs font-bold tracking-wide"><i className="size-2 rounded-full bg-red-500" />LIVE</span><span className="text-sm text-muted-foreground max-sm:hidden">{fmtTime(clock, tz)}</span></span>
          : <span className="ml-2 shrink-0 text-sm font-semibold whitespace-nowrap tabular-nums">{fmtTime(pt, tz)}{ago && <span className="font-normal text-muted-foreground max-md:hidden"> · {ago}</span>}</span>}
        <span className="min-w-2 flex-1" />
        {!live && <Button variant="outline" size="sm" className="mr-1 shrink-0 rounded-full" onClick={rw.close}><i className="size-1.5 rounded-full bg-muted-foreground" />Go live</Button>}
        {!live && <select aria-label="Playback speed" value={rw.speed} onChange={(e) => rw.setSpeed(Number(e.target.value))} className="h-8 shrink-0 rounded-lg bg-transparent px-1 text-sm outline-none hover:bg-accent max-sm:hidden">{[0.5, 1, 2, 4].map((x) => <option key={x} value={x}>{x}×</option>)}</select>}
        <Button variant="ghost" size="icon" className={`${ghost} max-sm:hidden`} aria-label="Zoom out" title="Zoom out" disabled={zoom === 0} onClick={() => zoomBy(-1)}><ZoomOut /></Button>
        <Button variant="ghost" size="icon" className={`${ghost} max-sm:hidden`} aria-label="Zoom in" title="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => zoomBy(1)}><ZoomIn /></Button>
        {tools}
      </div>
    </div>
  );
}
