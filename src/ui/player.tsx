"use client";
import { ArrowLeft, CalendarDays, CircleAlert, CircleCheck, Download, Lock, Maximize, Pause, Play, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { api, dateInput, dayBounds, EVENT_COLOR, EVENT_LABEL, fmtDay, fmtShort, fmtTime, mediaUrl, timeInput, zonedParts, zonedToUtc, type ActivityEvent, type Camera } from "./api";
import { Empty, fail, RecMark, Select, useApp, useRecording } from "./app";
import { LiveVideo, type LiveInfo, type Transport, type VideoSource } from "./live";
import type { WindowInfo as WinInfo } from "@/server/media/recordings";
import { canHandOver, carryOnAt, cursorAt, cursorAtBase, positionAt, shouldArm, stepEntries, windowStart, type Cursor } from "./recorded-playback";
import { dragTrim, nearestEnd, panTrim, startTrim as newTrim, TRIM_SPAN, typeTrim as typedTrim, zoomedSpan, zoomTrim as zoomedTrim, type End, type Trim } from "./trim";
import { applySound, claimSound, play, setSound, SoundButton, useSound, watchAudio } from "./sound";
import { fmtAgo, tickTimes, timelineBounds } from "./timeline";

type Ranges = { ranges: [number, number][]; precision: "exact" | "bounds" };
const ZONES: [string, string][] = [["recorder", "Recorder's time zone"], ["local", "My time zone"], ["UTC", "UTC"], ["America/Toronto", "Toronto"], ["America/Vancouver", "Vancouver"], ["America/Chicago", "Chicago"], ["Europe/London", "London"], ["Europe/Paris", "Paris"], ["Australia/Sydney", "Sydney"]];
const ghost = "text-white hover:bg-white/15 hover:text-white";
/** `gap`: why a finished clip is noticeably shorter than asked (`durationMs` is its real length). */
type Job = { id: string; status: string; error: string | null; progress?: number; etaMs?: number | null; fileName?: string | null; bytes?: number | null; durationMs?: number | null; gap?: "unrecorded" | "busy" | null };
/** Wall-clock time, for event handlers only (never called while rendering). */
const now = () => Date.now();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtLen = (ms: number) => {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h} hr${m % 60 ? ` ${m % 60} min` : ""}` : m ? `${m} min${s % 60 ? ` ${s % 60} sec` : ""}` : `${s} sec`;
};
const fmtSpan = (ms: number) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${+(m / 60).toFixed(1)} hour${m === 60 ? "" : "s"}` : `${m} minute${m === 1 ? "" : "s"}`; };
/** How much time the timeline shows, widest first. 0 is everything (see `timelineBounds`). */
const ZOOMS: [number, string][] = [[0, "Whole day"], [6 * 3600_000, "6 hours"], [3600_000, "1 hour"], [600_000, "10 minutes"]];
/** Spacing between timeline labels: the first that gives at most six across. */
const TICKS = [60_000, 120_000, 300_000, 600_000, 900_000, 1800_000, 3600_000, 7200_000, 3 * 3600_000, 6 * 3600_000];

/**
 * One camera, live or recorded. Recorded video is fetched in short windows: seeking loads only the
 * window around the chosen moment, and the next window follows when one ends. Times are UTC
 * underneath and shown in the chosen time zone.
 */
export function Player({ cameraId }: { cameraId: string }) {
  const { me, nav, loc, tz, setPref } = useApp();
  const recording = useRecording();
  const W = me.limits.windowSeconds * 1000;
  const startAt = Number(loc.query.get("t")) || 0;
  const [cam, setCam] = useState<Camera | null | "gone">(null);
  const [live, setLive] = useState(!startAt);
  const [via, setVia] = useState<LiveInfo | null>(null);
  const [t, setT] = useState(() => startAt || Date.now());
  const [target, setTarget] = useState({ ms: startAt, n: 0 });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  /** Wall-clock time, ticking every second. The 24-hour timeline ends here. */
  const [clock, setClock] = useState(() => Date.now());
  /** A past date was picked: show that calendar day rather than the last 24 hours (see `timelineBounds`). */
  const [pinned, setPinned] = useState(false);
  const [zoom, setZoom] = useState(0);
  /** Start of the zoomed-in stretch. It stays put while the playhead is inside it, so clicks and drags land where aimed. */
  const [view, setView] = useState<number | null>(null);
  const [zoomNote, setZoomNote] = useState<{ text: string; n: number } | null>(null);
  const [rec, setRec] = useState<Ranges | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [noRec, setNoRec] = useState(false);
  const [jump, setJump] = useState(false);
  const [trim, setTrim] = useState<Trim | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; ms: number; img: number } | null>(null);
  // Most third-party cameras give no picture from a recording. After three misses in a row, show only the time.
  const stillMisses = useRef(0);
  const [noStills, setNoStills] = useState<string | null>(null);
  useEffect(() => { stillMisses.current = 0; }, [cameraId]);
  const [refresh, setRefresh] = useState(0);
  /** Start of the window being buffered in the background so the next one starts without a black gap. */
  const [armed, setArmed] = useState<number | null>(null);
  /** Window descriptions by `${window start}:${seek count}`; "none" when the window has no recording. */
  const [infos, setInfos] = useState<Record<string, WinInfo | "none">>({});
  const infoReq = useRef(new Map<string, AbortController>()), handed = useRef(""), frame = useRef<() => void>(() => {});
  /**
   * Where the current window stands (`stepEntries`). `seek`: it began with a seek rather than playing
   * on from the window before. `pending`: its entries are for the base alone, fuller ones are coming.
   */
  const cur = useRef<{ key: string; c: Cursor; seek: boolean; pending: boolean } | null>(null);
  /** The wall-clock time on screen, and the last one passed to `setT` (which re-renders, so it is held back). */
  const shown = useRef(0), shownSet = useRef(0);
  const hiVideo = useRef<HTMLVideoElement>(null);
  /** Whether the live stream and the recording carry sound (null while unknown), and the element the level meter listens to. */
  const [liveAudio, setLiveAudio] = useState<boolean | null>(null), [recAudio, setRecAudio] = useState<boolean | null>(null);
  const [liveEl, setLiveEl] = useState<HTMLVideoElement | null>(null), [recEl, setRecEl] = useState<HTMLVideoElement | null>(null);
  const soundOn = useSound() === cameraId;
  // Opening a camera while sound is on (it was playing for another one) brings the sound along.
  useEffect(() => claimSound(cameraId), [cameraId]);
  const video = useRef<HTMLVideoElement>(null), nextVideo = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null), tl = useRef<HTMLDivElement>(null), lastMove = useRef(0), lastTrimSeek = useRef(0);

  useEffect(() => { api<{ cameras: Camera[] }>("/cameras").then((r) => setCam(r.cameras.find((c) => c.id === cameraId) ?? "gone")).catch(fail); }, [cameraId, me.preview?.subject.id]);

  const ready = cam !== null && cam !== "gone";
  const { rolling, lo, hi } = timelineBounds(t, clock, pinned, tz);
  // The last 24 hours are fetched from the top of the hour, so the request changes once an hour rather than every second.
  const fetchFrom = rolling ? Math.floor(lo / 3600_000) * 3600_000 : lo, fetchTo = rolling ? 0 : hi;
  useEffect(() => {
    if (!ready) return;
    let off = false;
    const to = fetchTo ? Math.min(fetchTo, Date.now()) : Date.now();
    api<Ranges>(`/cameras/${cameraId}/recordings?from=${fetchFrom}&to=${to}`).then((r) => !off && setRec(r)).catch(() => !off && setRec({ ranges: [], precision: "exact" }));
    api<{ events: ActivityEvent[] }>(`/events?cameraId=${cameraId}&from=${fetchFrom}&to=${to}&limit=1000`).then((r) => !off && setEvents(r.events)).catch(() => {});
    return () => { off = true; };
  }, [cameraId, fetchFrom, fetchTo, ready, refresh]);
  // While the timeline reaches now, pick up newly recorded time and new activity every few minutes.
  useEffect(() => { if (!live && !rolling) return; const i = setInterval(() => setRefresh((n) => n + 1), 180_000); return () => clearInterval(i); }, [live, rolling]);

  useEffect(() => { const i = setInterval(() => { const n = Date.now(); setClock(n); if (live) setT(n); }, 1000); return () => clearInterval(i); }, [live]);
  const seek = useCallback((ms: number, play = true) => {
    setNoRec(false);
    if (ms >= Date.now() - 5000) { setLive(true); setPinned(false); setT(Date.now()); setPlaying(true); return; }
    setLive(false); setT(ms); setTarget((p) => ({ ms, n: p.n + 1 })); if (play) setPlaying(true);
  }, []);

  // ---- choosing a clip: two handles on the timeline, or typed times ----
  const maxClip = me.limits.clipMaxSeconds * 1000;
  /** Shows the frame at one end of the selection. Never slips into live: the newest moments are shown from just behind. */
  const showEnd = (ms: number) => seek(Math.min(ms, now() - 6000), false);
  const limits = () => ({ now: now(), maxClip });
  const startTrim = () => {
    const tr = newTrim(t, live, limits());
    setJump(false); setHover(null); setTrim(tr);
    seek(tr.a, false); setPlaying(false);
  };
  /** Dragging moves one end (see `dragTrim`), showing the frame there at most every 300 ms, and when the drag ends. */
  const drag = (g: End, ms: number, done = false) => {
    if (!trim) return;
    const tr = dragTrim(trim, g, ms, done, limits());
    setTrim(tr);
    if (done || now() - lastTrimSeek.current > 300) { lastTrimSeek.current = now(); showEnd(tr[g]); }
  };
  /** A typed time, in the chosen time zone, on the day of the end it sets (see `typeTrim`). */
  const typeTrim = (g: End, value: string) => {
    if (!trim || !value) return;
    const [h, mi, sec = 0] = value.split(":").map(Number), p = zonedParts(trim[g], tz);
    const tr = typedTrim(trim, g, zonedToUtc(p.year, p.month, p.day, h, mi, sec, tz), limits());
    setTrim(tr); showEnd(tr[g]);
  };
  /** Zooms the clip timeline (see `zoomTrim`). Updates from the latest state, since wheel events can arrive faster than renders. */
  const zoomTrim = (factor: number, frac?: number, note = true) => {
    if (!trim) return;
    const span0 = trim.view[1] - trim.view[0], span = zoomedSpan(trim, factor);
    if (note && Math.abs(span - span0) >= 1) setZoomNote((p) => ({ text: fmtSpan(span), n: (p?.n ?? 0) + 1 }));
    const at = now();
    setTrim((tr) => tr && zoomedTrim(tr, factor, frac, at));
  };
  const panTrimBy = (frac: number) => { const at = now(); setTrim((tr) => tr && panTrim(tr, frac, at)); };
  // On the timeline while choosing a clip, the wheel or a pinch zooms around the pointer and a sideways scroll pans.
  // A native listener, because React's wheel handler can't stop the page from scrolling or zooming.
  useEffect(() => {
    const el = tl.current;
    if (!el || !trim) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (trim.grab) return;
      const r = el.getBoundingClientRect(), px = e.deltaMode === 1 ? 16 : 1;
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { panTrimBy((e.deltaX * px) / r.width); return; }
      zoomTrim(Math.exp(clamp(e.deltaY * px, -100, 100) * (e.ctrlKey ? 0.01 : 0.004)), clamp((e.clientX - r.left) / r.width, 0, 1), false);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  const saveClip = async () => {
    if (!trim) return;
    try { const r = await api<{ id: string }>("/exports", { method: "POST", body: { cameraId, startMs: Math.round(trim.a), endMs: Math.round(trim.b) } }); setJob({ id: r.id, status: "running", error: null }); } catch (e) { fail(e); }
  };

  const ws = windowStart(target.ms, W), curKey = `${ws}:${target.n}`, nextKey = `${ws + W}:${target.n}`;
  const info = infos[curKey], nextInfo = armed === ws + W ? infos[nextKey] : undefined;
  // Fetch the descriptions of this window and, once armed, the next. A description no longer wanted
  // (after a seek) is cancelled, which also cancels its export on the server. The first answer comes
  // as soon as the base file is ready; an adaptive window then says `pending`, and a second request
  // brings the order with the high-resolution file.
  useEffect(() => {
    if (live || !target.ms) return;
    const want = new Map([[curKey, ws], ...(armed === ws + W ? [[nextKey, ws + W] as const] : [])]), reqs = infoReq.current;
    for (const [k, ac] of reqs) if (!want.has(k)) { ac.abort(); reqs.delete(k); }
    for (const [k, at] of want) {
      if (reqs.has(k)) continue;
      const ac = new AbortController();
      reqs.set(k, ac);
      const get = (early: boolean) => api<WinInfo>(`/cameras/${cameraId}/playback/info?t=${at}${early ? "&early=1" : ""}`, { signal: ac.signal });
      get(true).then((i) => {
        setInfos((p) => ({ ...p, [k]: i }));
        // Without the high-resolution order, the base plays on alone.
        if (i.pending) get(false).then((f) => setInfos((p) => ({ ...p, [k]: f })), () => {});
      }, () => { if (!ac.signal.aborted) setInfos((p) => ({ ...p, [k]: "none" })); });
    }
  }, [live, target.ms, curKey, nextKey, armed, ws, W, cameraId]);
  useEffect(() => { const reqs = infoReq.current; return () => { for (const ac of reqs.values()) ac.abort(); reqs.clear(); }; }, []);
  const missing = !live && (noRec || info === "none");
  const url = (at: number, high = false) => mediaUrl(`/api/cameras/${cameraId}/playback?t=${at}${high ? "&layer=high" : ""}`);
  const ok = info && info !== "none" ? info : null, withHigh = (i: WinInfo | null) => !!i?.high && !i.pending;
  const src = !live && target.ms && ok ? url(ws) : undefined, hiSrc = src && withHigh(ok) ? url(ws, true) : undefined;
  // The following window loads in hidden elements while this one plays (armed once it is fully recorded),
  // each file already waiting where that window will start.
  const nextOk = src && nextInfo && nextInfo !== "none" ? nextInfo : null;
  const nextSrc = nextOk ? url(ws + W) : undefined, nextHiSrc = withHigh(nextOk) ? url(ws + W, true) : undefined;
  const nextAt = ok && nextOk ? positionAt(nextOk.entries, carryOnAt(ok, nextOk)) : null;
  /** At the end of a window, the buffered next one takes over in place (same keys, so React keeps the elements). */
  const advance = () => {
    if (handed.current === curKey) return;
    handed.current = curKey;
    const nx = ws + W;
    if (ok && nextOk && canHandOver(nextSrc ? nextVideo.current : null, nx, now())) {
      const i = carryOnAt(ok, nextOk);
      cur.current = { key: nextKey, c: { i, ...positionAt(nextOk.entries, i) }, seek: false, pending: !!nextOk.pending };
      setT(nx); setTarget((p) => ({ ms: nx, n: p.n }));
    } else seek(nx);
  };
  // Every animation frame: play the window's entries in order and hand over at their end (see `stepEntries`).
  useEffect(() => { frame.current = () => {
    const v = video.current, h = hiVideo.current;
    if (!v || live || !ok) return;
    let c = cur.current;
    if (c?.key !== curKey) c = cur.current = { key: curKey, c: cursorAt(ok.entries, target.ms), seek: true, pending: !!ok.pending };
    else if (c.pending && !ok.pending) {
      // The high-resolution order arrived. Shortly after a seek, start again from the moment asked
      // for, which may be one only the high-resolution file has; later, carry on from the base.
      c.pending = false;
      const atSeek = c.c.base != null || Math.abs(shown.current - target.ms) < 10_000;
      c.c = c.seek && atSeek ? cursorAt(ok.entries, target.ms) : cursorAtBase(ok.entries, v.currentTime);
    }
    const r = stepEntries(v, h, ok.entries, c.c, { playing, rate: speed, start: (m) => play(m as HTMLVideoElement) });
    c.c = r.cur;
    if (h) h.style.visibility = r.showHigh ? "visible" : "hidden";
    if (r.wall != null) {
      shown.current = r.wall;
      if (Math.abs(r.wall - shownSet.current) >= 250) { shownSet.current = r.wall; setT(r.wall); }
    }
    if (r.handOver) advance();
  }; });
  useEffect(() => { if (live) return; let id = 0; const tick = () => { frame.current(); id = requestAnimationFrame(tick); }; id = requestAnimationFrame(tick); return () => cancelAnimationFrame(id); }, [live]);
  // Pausing takes effect at once, even where animation frames are held back (a tab in the background).
  useEffect(() => { if (!playing) { video.current?.pause(); hiVideo.current?.pause(); } }, [playing, src]);
  // Each recorded window is its own element: find out whether it has sound, and apply the sound setting to it.
  useEffect(() => { const v = video.current; if (!v || live) return; setRecEl(v); return watchAudio(v, setRecAudio); }, [live, curKey, ready]);
  useEffect(() => { const v = video.current; if (v && !live) applySound(v, soundOn && recAudio === true); }, [soundOn, recAudio, live, curKey, ready]);
  const hasAudio = live ? liveAudio : recAudio;
  const nextRange = rec?.ranges.find(([a]) => a > t);

  const zoomBy = (d: number) => {
    const z = clamp(zoom + d, 0, ZOOMS.length - 1);
    if (z === zoom) return;
    setZoom(z); setView(null); setZoomNote((p) => ({ text: z || !rolling ? ZOOMS[z][1] : "24 hours", n: (p?.n ?? 0) + 1 }));
  };
  useEffect(() => { if (!zoomNote) return; const i = setTimeout(() => setZoomNote(null), 1200); return () => clearTimeout(i); }, [zoomNote]);
  const back = () => (history.length > 1 ? history.back() : nav("/"));
  const toggle = () => { if (live) { seek(Date.now() - 6000, false); setPlaying(false); } else setPlaying((p) => !p); };
  useEffect(() => {
    const move = () => { lastMove.current = Date.now(); setIdle(false); };
    const key = (e: KeyboardEvent) => {
      move();
      if (trim) {
        if (e.key === "Escape" && !job) setTrim(null);
        else if (!job && !(e.target as HTMLElement).closest("input,select,textarea")) { if (e.key === "-") zoomTrim(2); else if (e.key === "=" || e.key === "+") zoomTrim(0.5); }
        return;
      }
      if (e.defaultPrevented || (e.target as HTMLElement).closest("input,select,textarea,[role=dialog]")) return;
      if (e.key === "Escape") { if (jump) setJump(false); else if (!document.fullscreenElement) back(); return; }
      if (e.key === " ") { e.preventDefault(); toggle(); } else if (e.key === "ArrowLeft") seek(t - 10000); else if (e.key === "ArrowRight") seek(t + 10000);
      else if (e.key.toLowerCase() === "m" && hasAudio) setSound(soundOn ? null : cameraId);
      else if (e.key === "-") zoomBy(-1); else if (e.key === "=" || e.key === "+") zoomBy(1);
    };
    if (!lastMove.current) lastMove.current = Date.now();
    const i = setInterval(() => setIdle(playing && !jump && !trim && Date.now() - lastMove.current > 3500), 500);
    addEventListener("pointermove", move); addEventListener("keydown", key);
    return () => { clearInterval(i); removeEventListener("pointermove", move); removeEventListener("keydown", key); };
  });

  if (cam === "gone") return <Empty icon={<Lock />} title="Camera unavailable">You don&apos;t have access to this camera.<div><Button variant="outline" className="mt-4" onClick={() => nav("/")}>Back to cameras</Button></div></Empty>;
  if (!cam) return <div className="flex-1 bg-black" />;

  let a = lo, b = hi;
  // Zoomed in, the timeline shows a stretch around the playhead. It holds still while the playhead is
  // inside it and re-centres when the playhead leaves (live stays at the right edge).
  const span = ZOOMS[zoom][0];
  if (trim) [a, b] = trim.view;
  else if (span) {
    const fits = view !== null && view >= lo && view + span <= hi && t >= view && t <= view + span;
    a = fits ? view : clamp(t - span * (live ? 0.9 : 0.5), lo, hi - span); b = a + span;
    if (a !== view) setView(a);
  }
  const step = TICKS.find((s) => (b - a) / s <= 6) ?? TICKS[TICKS.length - 1];
  // When the timeline reaches now, the right edge reads "Now" and labels too close to it are dropped. Today's midnight reads "Today".
  const toNow = b >= clock - 2000, today = dayBounds(clock, tz)[0];
  const ticks = tickTimes(a, b, step, tz).filter((m) => !toNow || (b - m) / (b - a) > 0.08);
  const ago = live ? null : fmtAgo(clock - t);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - a) / (b - a)) * 100))}%`;
  const at = (el: HTMLElement, clientX: number) => { const r = el.getBoundingClientRect(); return a + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (b - a); };
  const down = me.recorder === "down";

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-black text-white">
      {live ? <LiveVideo cameraId={cameraId} quality="focus" active={!down} online={cam.online && !down} onTransport={setVia} sound={soundOn} onAudio={setLiveAudio} onMedia={setLiveEl} />
        : [<video ref={video} key={curKey} src={src} playsInline muted className="absolute inset-0 size-full object-contain"
            onTimeUpdate={() => { if (armed !== ws + W && shouldArm(ws, W, now())) setArmed(ws + W); }}
            onError={() => setNoRec(true)} />,
          hiSrc && <video ref={hiVideo} key={`${curKey}:hi`} src={hiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className="absolute inset-0 size-full object-contain" />,
          nextSrc && <video ref={nextVideo} key={nextKey} src={nextSrc} preload="auto" playsInline muted aria-hidden className="invisible absolute inset-0 size-full object-contain"
            onLoadedMetadata={(e) => { if (nextAt) e.currentTarget.currentTime = nextAt.base; }} />,
          nextHiSrc && <video key={`${nextKey}:hi`} src={nextHiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className="absolute inset-0 size-full object-contain"
            onLoadedMetadata={(e) => { if (nextAt?.high != null) e.currentTarget.currentTime = nextAt.high; }} />]}
      {(missing || (live && !cam.online)) && !down && (
        <div className="absolute inset-0 grid place-items-center bg-zinc-900 p-6 text-center text-sm text-zinc-400">
          <div><div className="mb-1 font-medium text-zinc-50">{missing ? `No recording at ${fmtTime(t, tz)}` : "Camera offline"}</div>
            <div className="mt-4 flex justify-center gap-2">
              {missing && nextRange && <Button variant="outline" className="border-white/30 bg-transparent text-white" onClick={() => seek(nextRange[0] + 1000)}>Skip to {fmtShort(nextRange[0], tz)}</Button>}
              {!missing && rec?.ranges.length ? <Button variant="outline" className="border-white/30 bg-transparent text-white" onClick={() => seek(rec.ranges[rec.ranges.length - 1][1] - 60000)}>Watch last recording</Button> : null}
              {missing && <Button variant="outline" className="border-white/30 bg-transparent text-white" onClick={() => seek(Date.now())}>Go live</Button>}
            </div></div>
        </div>
      )}
      <div className={`absolute inset-x-0 top-0 flex items-center gap-2.5 bg-gradient-to-b from-black/70 to-transparent px-4 pt-3.5 pb-10 transition-opacity ${idle ? "opacity-0" : ""}`}>
        <Button variant="ghost" size="icon" className={ghost} aria-label="Back to cameras" onClick={back}><ArrowLeft /></Button>
        <b className="truncate text-[15px] font-semibold">{cam.name}</b>
        {live ? <LiveLabel info={via} /> : <span className="text-xs text-zinc-300">Recorded</span>}
        <span className="flex-1" />
        {recording.has(cameraId) && <RecMark />}
        <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => setJump((j) => !j)}><CalendarDays />{fmtDay(t, tz)}</Button>
      </div>
      {jump && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setJump(false)} />
          <div role="dialog" aria-label="Jump to a time" className="absolute top-14 right-4 z-20 grid w-64 gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl">
            <Input type="date" aria-label="Date" value={dateInput(t, tz)} onChange={(e) => { if (!e.target.value) return; const [y, m, d] = e.target.value.split("-").map(Number), p = zonedParts(t, tz), ms = zonedToUtc(y, m, d, p.hour, p.minute, p.second, tz); setPinned(ms < dayBounds(now(), tz)[0]); seek(ms); }} />
            <Input type="time" step={1} aria-label="Time" value={timeInput(t, tz)} onChange={(e) => { if (!e.target.value) return; const [h, mi, s = 0] = e.target.value.split(":").map(Number), p = zonedParts(t, tz); seek(zonedToUtc(p.year, p.month, p.day, h, mi, s, tz)); }} />
            <Select aria-label="Time zone" value={typeof me.preferences.tz === "string" ? me.preferences.tz : "recorder"} onChange={(e) => setPref("tz", e.target.value)}>{ZONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </div>
        </>
      )}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-4 pt-12 pb-[max(0.9rem,env(safe-area-inset-bottom))] transition-opacity ${idle ? "opacity-0" : ""}`}>
        {zoomNote && <div key={zoomNote.n} role="status" className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-xs font-semibold whitespace-nowrap">{zoomNote.text}</div>}
        <div ref={tl} className="relative h-8 cursor-pointer touch-none select-none" role="slider" aria-label="Timeline" aria-valuemin={a} aria-valuemax={b} aria-valuenow={Math.round(t)} aria-valuetext={fmtTime(t, tz)} tabIndex={0}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const ms = at(e.currentTarget, e.clientX); if (trim) drag(nearestEnd(trim, ms), ms); else seek(ms); }}
          onPointerUp={(e) => { if (trim?.grab) drag(trim.grab, at(e.currentTarget, e.clientX), true); }}
          onPointerCancel={() => { if (trim?.grab) drag(trim.grab, trim[trim.grab], true); }}
          onPointerMove={(e) => { const ms = at(e.currentTarget, e.clientX), y = e.currentTarget.getBoundingClientRect().top; if (trim) { if (e.buttons && trim.grab) drag(trim.grab, ms); } else if (e.buttons) seek(ms); if (e.pointerType === "mouse") setHover((h) => ({ x: e.clientX, y, ms, img: h && Math.abs(h.img - ms) < (b - a) / 150 ? h.img : ms })); }}
          onPointerLeave={() => setHover(null)}>
          <div className="absolute inset-x-0 bottom-2 h-[5px] overflow-hidden rounded-full bg-white/20" title={rec?.precision === "bounds" ? "Some gaps in the recording may not be shown" : undefined}>
            {!down && rec?.ranges.map(([s, e], i) => e > a && s < b ? <i key={i} className={`absolute inset-y-0 ${rec.precision === "exact" ? "bg-white/80" : "bg-white/50"}`} style={{ left: pct(s), right: `calc(100% - ${pct(e)})` }} /> : null)}
          </div>
          {!down && events.filter((e) => e.startMs > a && e.startMs < b).map((e) => <i key={e.id} title={`${EVENT_LABEL[e.type] ?? e.type}, ${fmtShort(e.startMs, tz)}`} className="absolute bottom-[17px] size-1.5 -translate-x-1/2 rounded-full" style={{ left: pct(e.startMs), background: EVENT_COLOR[e.type] ?? "#a3a3a3" }} />)}
          {trim ? <>
            <i className="pointer-events-none absolute bottom-[1px] h-[19px] border-y-2 border-yellow-400 bg-yellow-400/30" style={{ left: pct(trim.a), right: `calc(100% - ${pct(trim.b)})` }} />
            {(["a", "b"] as const).map((g) => <i key={g} className="pointer-events-none absolute -bottom-0.5 h-[25px] w-3 -translate-x-1/2 rounded-[4px] bg-yellow-400 shadow" style={{ left: pct(trim[g]) }} />)}
            {trim.grab && <span className="pointer-events-none absolute bottom-8 -translate-x-1/2 rounded bg-yellow-400 px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-black" style={{ left: pct(trim[trim.grab]) }}>{fmtTime(trim[trim.grab], tz)}</span>}
          </> : <i className={`pointer-events-none absolute bottom-[3px] size-[15px] -translate-x-1/2 rounded-full ${live ? "live-dot bg-red-500" : "bg-white shadow-[0_0_0_4px_rgba(255,255,255,.25)]"}`} style={{ left: pct(t) }} />}
          {live && !trim && <span className="pointer-events-none absolute right-0 bottom-[25px] rounded bg-red-500 px-1 text-[10px] leading-[14px] font-bold tracking-wide">LIVE</span>}
        </div>
        <div className="relative mt-0.5 h-4 text-[11px] text-zinc-400">{ticks.map((m) => { const f = (m - a) / (b - a); return <span key={m} className={`absolute top-0 whitespace-nowrap ${f < 0.04 ? "" : f > 0.96 ? "-translate-x-full" : "-translate-x-1/2"} ${m === today ? "font-semibold text-zinc-200" : ""}`} style={{ left: pct(m) }}>{m === today ? "Today" : fmtShort(m, tz)}</span>; })}
          {toNow && <span className="absolute top-0 right-0 font-semibold text-red-400">Now</span>}</div>
        {trim ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(["a", "b"] as const).map((g) => <input key={g} type="time" step={1} aria-label={g === "a" ? "Clip starts" : "Clip ends"} value={timeInput(trim[g], tz)} onChange={(e) => typeTrim(g, e.target.value)} className="h-9 rounded-lg border border-white/30 bg-transparent px-2 text-sm text-white tabular-nums outline-none [color-scheme:dark] focus-visible:border-white" />)}
            <span className="text-sm text-zinc-300">{fmtLen(trim.b - trim.a)}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom out" title="Zoom out (−)" disabled={trim.view[1] - trim.view[0] >= TRIM_SPAN[1]} onClick={() => zoomTrim(2)}><ZoomOut /></Button>
            <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom in" title="Zoom in (+)" disabled={trim.view[1] - trim.view[0] <= TRIM_SPAN[0]} onClick={() => zoomTrim(0.5)}><ZoomIn /></Button>
            <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => setTrim(null)}>Cancel</Button>
            <Button className="bg-white text-black hover:bg-white/90" onClick={saveClip}><Download />Save clip</Button>
          </div>
        ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon" className={ghost} aria-label="Back 10 seconds" onClick={() => seek(t - 10000)}><RotateCcw /></Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause /> : <Play />}</Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label="Forward 10 seconds" onClick={() => seek(t + 10000)}><RotateCw /></Button>
          {live
            ? <span className="ml-2 flex items-center gap-2 tabular-nums"><span className="flex items-center gap-1.5 text-xs font-bold tracking-wide"><i className="size-2 rounded-full bg-red-500" />LIVE</span><span className="text-base text-zinc-400">{fmtTime(t, tz)}</span></span>
            : <span className="ml-2 text-base font-semibold tabular-nums">{fmtTime(t, tz)}{ago && <span className="font-normal text-zinc-400 max-sm:hidden"> · {ago}</span>}</span>}
          <span className="flex-1" />
          {!live && <Button variant="outline" size="sm" className="mr-1 rounded-full border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => seek(Date.now())}><i className="size-1.5 rounded-full bg-zinc-400" />Go live</Button>}
          <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom out" title="Zoom out (−)" disabled={zoom === 0} onClick={() => zoomBy(-1)}><ZoomOut /></Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom in" title="Zoom in (+)" disabled={zoom === ZOOMS.length - 1} onClick={() => zoomBy(1)}><ZoomIn /></Button>
          {!live && <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="h-9 rounded-lg bg-transparent px-1 text-sm text-white outline-none hover:bg-white/15 [&>option]:text-black">{[0.5, 1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}</select>}
          {me.subject.canExportClips && <Button variant="ghost" className={ghost} disabled={down} onClick={startTrim}><Download /><span className="max-sm:hidden">Save clip</span></Button>}
          <SoundButton cameraId={cameraId} has={hasAudio} media={live ? liveEl : recEl} recorded={!live} />
          <Button variant="ghost" size="icon" className={ghost} aria-label="Full screen" onClick={() => { const el = box.current!, v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (document.fullscreenElement) void document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast("Full screen isn't available")); else v?.webkitEnterFullscreen?.(); }}><Maximize /></Button>
        </div>
        )}
      </div>
      {hover && !down && (
        <div className="pointer-events-none fixed z-30 w-36 -translate-x-1/2 rounded-lg border bg-popover p-1 text-center text-xs text-popover-foreground shadow-xl" style={{ left: Math.max(hover.x, 80), top: hover.y - (noStills === cameraId ? 36 : 108) }}>
          {noStills !== cameraId && <div className="mb-0.5 aspect-video overflow-hidden rounded bg-black"><img alt="" key={Math.round(hover.img / 1000)} src={mediaUrl(`/api/cameras/${cameraId}/snapshot?w=240&at=${Math.round(hover.img)}`)} className="size-full object-cover" onLoad={() => { stillMisses.current = 0; }} onError={(e) => { e.currentTarget.style.display = "none"; if (++stillMisses.current >= 3) setNoStills(cameraId); }} /></div>}
          {fmtTime(hover.ms, tz)}
        </div>
      )}
      {job && trim && <ClipDialog name={cam.name} startMs={trim.a} endMs={trim.b} first={job} onClose={(saved) => { setJob(null); if (saved) setTrim(null); }} />}
    </div>
  );
}

/** Hands a finished clip to the browser's downloads, as clicking a link to it would. The server sends it as an attachment, so the page stays. */
const saveFile = (id: string) => { const a = document.createElement("a"); a.href = mediaUrl(`/api/exports/${id}/download`); a.download = ""; document.body.append(a); a.click(); a.remove(); };
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** "About 4 min left" for a rough estimate. */
const fmtLeft = (ms: number) => { const m = Math.round(ms / 60_000); return ms < 45_000 ? "Less than a minute left" : m < 60 ? `About ${Math.max(1, m)} min left` : `About ${fmtLen(Math.round(ms / 300_000) * 300_000)} left`; };

/**
 * Progress and download for a clip that has already been requested. Closing after a failure returns to the selection.
 * Until the first piece of a long clip arrives (and for a short clip, which is one piece) nothing can be measured, so
 * the bar sweeps; after that it fills, with an estimate of the time left. When the clip is ready the download starts by
 * itself, and the dialog stays to say so, with a way to download it again.
 */
function ClipDialog({ name, startMs, endMs, first, onClose }: { name: string; startMs: number; endMs: number; first: Job; onClose: (saved: boolean) => void }) {
  const { tz } = useApp();
  const [job, setJob] = useState<Job>(first);
  // The server's estimate of the time left. It is extrapolated, so it may only rise by a real margin; small upward wobbles are ignored.
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (job.status !== "running") return;
    const i = setInterval(() => {
      api<Job>(`/exports/${job.id}`).then((j) => {
        const e = j.etaMs ?? null;
        setLeft((l) => (e == null ? null : l != null && e > l && e - l < 20_000 ? l : e));
        if (j.status !== "running") clearInterval(i);
        if (j.status === "ready") saveFile(j.id);
        setJob(j);
      }).catch(() => { clearInterval(i); setJob((x) => ({ ...x, status: "failed", error: "This clip is no longer available." })); });
    }, 1000);
    return () => clearInterval(i);
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (job.status === "running") void api(`/exports/${job.id}`, { method: "DELETE" }).catch(() => {}); onClose(job.status === "ready"); };
  const ready = job.status === "ready", pct = job.progress ?? 0, measured = job.status === "running" && pct > 0 && pct < 95;
  const note = pct >= 95 ? "Putting the pieces together…" : left != null ? fmtLeft(left) : pct > 0 ? "Estimating time left…" : "Waiting for the recorder…";
  // Missing time is measured on what the clip covers, so the file can be as long as asked (sharper
  // moments the low-quality recording lacks add to it). Its length is only worth a word when shorter.
  const len = job.durationMs ?? endMs - startMs, asked = endMs - startMs;
  const short = len < asked && fmtLen(len) !== fmtLen(asked) ? ` The clip is ${fmtLen(len)} instead of ${fmtLen(asked)}.` : "";
  const gap = !ready || !job.gap ? null : job.gap === "busy" ? `The recorder was busy, so part of this time is missing.${short} Try again in a few minutes.` : `Part of this time wasn\u2019t recorded.${short}`;
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={ready ? "flex items-center gap-2" : undefined}>{ready && <CircleCheck className="size-5 text-green-600 dark:text-green-500" />}{job.status === "running" ? "Preparing clip…" : ready ? "Download started" : "Couldn't save clip"}</DialogTitle>
          <DialogDescription>{job.status === "running" ? `${name} · ${fmtDay(startMs, tz)}, ${fmtTime(startMs, tz)} · ${fmtLen(endMs - startMs)}` : ready ? "Your browser is saving it to your Downloads folder." : job.error ?? "Something went wrong. Try again."}</DialogDescription>
        </DialogHeader>
        {ready && (
          <>
            <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted p-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">MP4</span>
              <div className="min-w-0 text-sm"><div className="truncate font-medium" title={job.fileName ?? undefined}>{job.fileName ?? `${name}.mp4`}</div><div className="text-xs text-muted-foreground">{fmtLen(len)}{job.bytes ? ` · ${fmtBytes(job.bytes)}` : ""}</div></div>
            </div>
            {gap && <p role="status" className="flex gap-2 text-sm text-muted-foreground"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />{gap}</p>}
            <p className="text-sm text-muted-foreground">Didn&rsquo;t start? <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => saveFile(job.id)}>Download again</button></p>
          </>
        )}
        {job.status === "running" && (
          <div className="grid gap-2">
            <div role="progressbar" aria-label="Clip progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={measured ? pct : undefined} className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              {measured
                ? <div className="clip-shimmer h-full rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
                : <div className="clip-sweep absolute inset-y-0 w-2/5 rounded-full bg-primary" />}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground tabular-nums" aria-live="polite"><span>{note}</span>{measured && <span>{pct}%</span>}</div>
          </div>
        )}
        <DialogFooter>
          <Button variant={ready ? "default" : "outline"} onClick={close}>{job.status === "running" ? "Cancel" : ready ? "Done" : "Back"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const VIA: Record<Transport | "none", [string, string]> = {
  webrtc: ["Real-time", "Connected with WebRTC."],
  hls: ["A few seconds behind", "Real-time isn't reachable from this network, so this uses standard streaming (HLS)."],
  none: ["Connecting", "Live video is starting."],
};

const SOURCE: Record<VideoSource, [string, string?]> = {
  camera: ["Camera"],
  recorder: ["Recorder"],
  fallback: ["Recorder", "Couldn\u2019t reach the camera directly. Trying again in a few minutes."],
};

/** "Live" in the player's top bar. A ring around the dot means real-time (WebRTC); hover or tap explains. */
function LiveLabel({ info }: { info: LiveInfo | null }) {
  const via = info?.via ?? null;
  const [title, text] = VIA[via ?? "none"];
  const source = info?.source ? SOURCE[info.source] : null;
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} aria-label={`Live: ${title}`} className="flex cursor-default items-center gap-1.5 rounded text-xs text-zinc-300 underline decoration-white/40 decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-white">
        <i className={`size-1.5 rounded-full bg-red-500 ${via === "webrtc" ? "outline-[1.5px] outline-offset-[1.5px] outline-red-500/60 outline-solid" : ""}`} />Live
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-60">
        <PopoverHeader><PopoverTitle>{title}</PopoverTitle><PopoverDescription>{text}</PopoverDescription></PopoverHeader>
        {source && (
          <div className="grid gap-1 border-t pt-2.5 text-sm">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Source</span><span className="font-medium">{source[0]}</span></div>
            {source[1] && <p className="text-xs text-muted-foreground">{source[1]}</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
