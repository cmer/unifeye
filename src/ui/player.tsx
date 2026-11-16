"use client";
import { ArrowLeft, CalendarDays, Download, Lock, Maximize, Pause, Play, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { api, dateInput, dayBounds, EVENT_COLOR, EVENT_LABEL, fmtDay, fmtShort, fmtTime, mediaUrl, timeInput, zonedParts, zonedToUtc, type ActivityEvent, type Camera } from "./api";
import { Empty, fail, RecMark, Select, useApp, useRecording } from "./app";
import { LiveVideo, type Transport } from "./live";

type Ranges = { ranges: [number, number][]; precision: "exact" | "bounds" };
/**
 * A recorded window as the server describes it. The base file starts `leadMs` before the window. With
 * adaptive recording, `overlay` lists where the high-resolution file's stretches sit in the base
 * (seconds of media time: `len` seconds from overlay time `from` belong at base time `at`).
 */
type WinInfo = { startMs: number; endMs: number; leadMs: number; overlay: { at: number; from: number; len: number }[] };
const ZONES: [string, string][] = [["local", "My time zone"], ["UTC", "UTC"], ["America/Toronto", "Toronto"], ["America/Vancouver", "Vancouver"], ["America/Chicago", "Chicago"], ["Europe/London", "London"], ["Europe/Paris", "Paris"], ["Australia/Sydney", "Sydney"]];
const ghost = "text-white hover:bg-white/15 hover:text-white";
type Job = { id: string; status: string; error: string | null };
/** A clip being chosen: its two ends, the stretch of time the timeline shows meanwhile, and the end being dragged. */
type Trim = { a: number; b: number; view: [number, number]; grab: "a" | "b" | null };
const MIN_CLIP = 2000;
/** Wall-clock time, for event handlers only (never called while rendering). */
const now = () => Date.now();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtLen = (ms: number) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min${s % 60 ? ` ${s % 60} sec` : ""}` : `${s} sec`; };
/** While trimming, the timeline zooms to the selection with room on both sides to extend it. */
const viewFor = (a: number, b: number): [number, number] => { const span = Math.max(180_000, (b - a) * 2.5), mid = (a + b) / 2; return [mid - span / 2, mid + span / 2]; };
/** How much of the day the timeline shows, widest first. 0 is the whole day. */
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
  const [via, setVia] = useState<Transport | null>(null);
  const [t, setT] = useState(() => startAt || Date.now());
  const [target, setTarget] = useState({ ms: startAt, n: 0 });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
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
  const [refresh, setRefresh] = useState(0);
  /** Start of the window being buffered in the background so the next one starts without a black gap. */
  const [armed, setArmed] = useState<number | null>(null);
  /** Window descriptions by `${window start}:${seek count}`; "none" when the window has no recording. */
  const [infos, setInfos] = useState<Record<string, WinInfo | "none">>({});
  const infoReq = useRef(new Map<string, AbortController>()), handed = useRef(""), frame = useRef<() => void>(() => {});
  const hiVideo = useRef<HTMLVideoElement>(null);
  const video = useRef<HTMLVideoElement>(null), nextVideo = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null), tl = useRef<HTMLDivElement>(null), lastMove = useRef(0), lastTrimSeek = useRef(0);

  useEffect(() => { api<{ cameras: Camera[] }>("/cameras").then((r) => setCam(r.cameras.find((c) => c.id === cameraId) ?? "gone")).catch(fail); }, [cameraId, me.preview?.subject.id]);

  const minute = Math.floor(t / 60000), ready = cam !== null && cam !== "gone";
  const [dayStart, dayEnd] = useMemo(() => dayBounds(minute * 60000, tz), [minute, tz]);
  useEffect(() => {
    if (!ready) return;
    let off = false;
    const to = Math.min(dayEnd, Date.now());
    api<Ranges>(`/cameras/${cameraId}/recordings?from=${dayStart}&to=${to}`).then((r) => !off && setRec(r)).catch(() => !off && setRec({ ranges: [], precision: "exact" }));
    api<{ events: ActivityEvent[] }>(`/events?cameraId=${cameraId}&from=${dayStart}&to=${to}&limit=200`).then((r) => !off && setEvents(r.events)).catch(() => {});
    return () => { off = true; };
  }, [cameraId, dayStart, dayEnd, ready, refresh]);
  // While live, pick up newly recorded time and new activity every few minutes.
  useEffect(() => { if (!live) return; const i = setInterval(() => setRefresh((n) => n + 1), 180_000); return () => clearInterval(i); }, [live]);

  useEffect(() => { if (!live) return; const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, [live]);
  const seek = useCallback((ms: number, play = true) => {
    setNoRec(false);
    if (ms >= Date.now() - 5000) { setLive(true); setT(Date.now()); setPlaying(true); return; }
    setLive(false); setT(ms); setTarget((p) => ({ ms, n: p.n + 1 })); if (play) setPlaying(true);
  }, []);

  // ---- choosing a clip: two handles on the timeline, or typed times ----
  const maxClip = me.limits.clipMaxSeconds * 1000;
  /** Shows the frame at one end of the selection. Never slips into live: the newest moments are shown from just behind. */
  const showEnd = (ms: number) => seek(Math.min(ms, now() - 6000), false);
  const startTrim = () => {
    const lim = now() - 2000, b0 = Math.min(live ? lim : t + 15_000, lim), a0 = b0 - Math.min(30_000, maxClip);
    setJump(false); setHover(null); setTrim({ a: a0, b: b0, view: viewFor(a0, b0), grab: null });
    seek(a0, false); setPlaying(false);
  };
  /** Dragging moves one end and stops at the limits; the other end stays put. */
  const dragTrim = (g: "a" | "b", ms: number, done = false) => {
    if (!trim) return;
    const lim = now() - 2000;
    const a2 = g === "a" ? clamp(ms, trim.b - maxClip, trim.b - MIN_CLIP) : trim.a, b2 = g === "b" ? clamp(ms, trim.a + MIN_CLIP, Math.min(trim.a + maxClip, lim)) : trim.b;
    setTrim({ a: a2, b: b2, view: done ? viewFor(a2, b2) : trim.view, grab: done ? null : g });
    if (done || now() - lastTrimSeek.current > 300) { lastTrimSeek.current = now(); showEnd(g === "a" ? a2 : b2); }
  };
  /** A typed time sets that end exactly; the other end follows only as far as the limits require. */
  const typeTrim = (g: "a" | "b", value: string) => {
    if (!trim || !value) return;
    const [h, mi, sec = 0] = value.split(":").map(Number), p = zonedParts(trim[g], tz), ms = zonedToUtc(p.year, p.month, p.day, h, mi, sec, tz), lim = now() - 2000;
    let a2 = trim.a, b2 = trim.b;
    if (g === "a") { a2 = Math.min(ms, lim - MIN_CLIP); b2 = Math.min(lim, clamp(b2, a2 + MIN_CLIP, a2 + maxClip)); }
    else { b2 = Math.min(ms, lim); a2 = clamp(a2, b2 - maxClip, b2 - MIN_CLIP); }
    setTrim({ a: a2, b: b2, view: viewFor(a2, b2), grab: null });
    showEnd(g === "a" ? a2 : b2);
  };
  const saveClip = async () => {
    if (!trim) return;
    try { const r = await api<{ id: string }>("/exports", { method: "POST", body: { cameraId, startMs: Math.round(trim.a), endMs: Math.round(trim.b) } }); setJob({ id: r.id, status: "running", error: null }); } catch (e) { fail(e); }
  };

  const ws = Math.floor(target.ms / W) * W, curKey = `${ws}:${target.n}`, nextKey = `${ws + W}:${target.n}`;
  const info = infos[curKey], nextInfo = armed === ws + W ? infos[nextKey] : undefined;
  // Fetch the descriptions of this window and, once armed, the next. A description no longer wanted
  // (after a seek) is cancelled, which also cancels its export on the server.
  useEffect(() => {
    if (live || !target.ms) return;
    const want = new Map([[curKey, ws], ...(armed === ws + W ? [[nextKey, ws + W] as const] : [])]), reqs = infoReq.current;
    for (const [k, ac] of reqs) if (!want.has(k)) { ac.abort(); reqs.delete(k); }
    for (const [k, at] of want) {
      if (reqs.has(k)) continue;
      const ac = new AbortController();
      reqs.set(k, ac);
      api<WinInfo>(`/cameras/${cameraId}/playback/info?t=${at}`, { signal: ac.signal }).then((i) => setInfos((p) => ({ ...p, [k]: i })), () => { if (!ac.signal.aborted) setInfos((p) => ({ ...p, [k]: "none" })); });
    }
  }, [live, target.ms, curKey, nextKey, armed, ws, W, cameraId]);
  useEffect(() => { const reqs = infoReq.current; return () => { for (const ac of reqs.values()) ac.abort(); reqs.clear(); }; }, []);
  // Media time 0 is `leadMs` before the window (the export began on an earlier keyframe). Without a
  // lead, the clip starts at the window start or at the first recorded moment inside it.
  const lead = info && info !== "none" ? info.leadMs : 0, missing = !live && (noRec || info === "none");
  const clipStart = useMemo(() => { if (lead) return ws - lead; if (rec?.precision !== "exact") return ws; const r = rec.ranges.find(([a, b]) => b > ws && a < ws + W); return r ? Math.max(ws, r[0]) : ws; }, [rec, ws, W, lead]);
  const url = (at: number, high = false) => mediaUrl(`/api/cameras/${cameraId}/playback?t=${at}${high ? "&layer=high" : ""}`);
  const src = !live && target.ms && info && info !== "none" ? url(ws) : undefined, hiSrc = src && info !== "none" && info?.overlay.length ? url(ws, true) : undefined;
  // The following window loads in hidden elements while this one plays (armed once it is fully recorded).
  const nextOk = src && nextInfo && nextInfo !== "none" ? nextInfo : null;
  const nextSrc = nextOk ? url(ws + W) : undefined, nextHiSrc = nextOk?.overlay.length ? url(ws + W, true) : undefined;
  /** At the end of a window, the buffered next one takes over in place (same keys, so React keeps the elements). */
  const advance = () => {
    if (handed.current === curKey) return;
    handed.current = curKey;
    const nx = ws + W;
    if (nextSrc && !nextVideo.current?.error && nx < now() - 5000) { setT(nx); setTarget((p) => ({ ms: nx, n: p.n })); }
    else seek(nx);
  };
  // Every animation frame: hand over when the base reaches the window's end (it runs on past it by the
  // next window's lead), and keep the high-resolution overlay in step with the base, shown only
  // inside its stretches and only once it has the right frame.
  useEffect(() => { frame.current = () => {
    const v = video.current, h = hiVideo.current;
    if (!v || live) return;
    if (!v.paused && !v.seeking && v.readyState >= 2 && clipStart + v.currentTime * 1000 >= ws + W) advance();
    if (!h) return;
    const spans = info && info !== "none" ? info.overlay : [], m = v.currentTime, sp = spans.find((x) => m >= x.at && m < x.at + x.len);
    let show = false;
    if (sp && !h.error) {
      const want = sp.from + (m - sp.at);
      if (h.readyState >= 1 && !h.seeking && Math.abs(h.currentTime - want) > 0.25) h.currentTime = want;
      if (h.playbackRate !== v.playbackRate) h.playbackRate = v.playbackRate;
      if (v.paused || v.seeking) { if (!h.paused) h.pause(); } else if (h.paused) void h.play().catch(() => {});
      show = h.readyState >= 2 && !h.seeking && Math.abs(h.currentTime - want) <= 0.25;
    } else {
      if (!h.paused) h.pause();
      // Wait at the start of the next stretch so it can be shown the moment the base gets there.
      const up = spans.find((x) => x.at > m);
      if (up && h.readyState >= 1 && !h.seeking && Math.abs(h.currentTime - up.from) > 0.05) h.currentTime = up.from;
    }
    h.style.visibility = show ? "visible" : "hidden";
  }; });
  useEffect(() => { if (live) return; let id = 0; const tick = () => { frame.current(); id = requestAnimationFrame(tick); }; id = requestAnimationFrame(tick); return () => cancelAnimationFrame(id); }, [live]);
  useEffect(() => { const v = video.current; if (v) v.playbackRate = speed; }, [speed, src]);
  useEffect(() => { const v = video.current; if (!v || live) return; if (playing) void v.play().catch(() => {}); else v.pause(); }, [playing, live, src]);
  const nextRange = rec?.ranges.find(([a]) => a > t);

  const zoomBy = (d: number) => {
    const z = clamp(zoom + d, 0, ZOOMS.length - 1);
    if (z === zoom) return;
    setZoom(z); setView(null); setZoomNote((p) => ({ text: ZOOMS[z][1], n: (p?.n ?? 0) + 1 }));
  };
  useEffect(() => { if (!zoomNote) return; const i = setTimeout(() => setZoomNote(null), 1200); return () => clearTimeout(i); }, [zoomNote]);
  const back = () => (history.length > 1 ? history.back() : nav("/"));
  const toggle = () => { if (live) { seek(Date.now() - 6000, false); setPlaying(false); } else setPlaying((p) => !p); };
  useEffect(() => {
    const move = () => { lastMove.current = Date.now(); setIdle(false); };
    const key = (e: KeyboardEvent) => {
      move();
      if (trim) { if (e.key === "Escape" && !job) setTrim(null); return; }
      if (e.defaultPrevented || (e.target as HTMLElement).closest("input,select,textarea,[role=dialog]")) return;
      if (e.key === "Escape") { if (jump) setJump(false); else if (!document.fullscreenElement) back(); return; }
      if (e.key === " ") { e.preventDefault(); toggle(); } else if (e.key === "ArrowLeft") seek(t - 10000); else if (e.key === "ArrowRight") seek(t + 10000);
      else if (e.key === "-") zoomBy(-1); else if (e.key === "=" || e.key === "+") zoomBy(1);
    };
    if (!lastMove.current) lastMove.current = Date.now();
    const i = setInterval(() => setIdle(playing && !jump && !trim && Date.now() - lastMove.current > 3500), 500);
    addEventListener("pointermove", move); addEventListener("keydown", key);
    return () => { clearInterval(i); removeEventListener("pointermove", move); removeEventListener("keydown", key); };
  });

  if (cam === "gone") return <Empty icon={<Lock />} title="Camera unavailable">You don&apos;t have access to this camera.<div><Button variant="outline" className="mt-4" onClick={() => nav("/")}>Back to cameras</Button></div></Empty>;
  if (!cam) return <div className="flex-1 bg-black" />;

  let a = dayStart, b = dayEnd;
  // Zoomed in, the timeline shows a stretch of the day around the playhead. It holds still while the
  // playhead is inside it and re-centres when the playhead leaves (live sits near the right edge).
  const span = ZOOMS[zoom][0];
  if (trim) [a, b] = trim.view;
  else if (span) {
    const fits = view !== null && view >= dayStart && view + span <= dayEnd && t >= view && t <= view + span;
    a = fits ? view : clamp(t - span * (live ? 0.9 : 0.5), dayStart, dayEnd - span); b = a + span;
    if (a !== view) setView(a);
  }
  const step = TICKS.find((s) => (b - a) / s <= 6) ?? TICKS[TICKS.length - 1];
  const ticks: number[] = [];
  for (let m = dayStart + Math.ceil((a - dayStart) / step) * step; m <= b; m += step) ticks.push(m);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, ((ms - a) / (b - a)) * 100))}%`;
  const at = (el: HTMLElement, clientX: number) => { const r = el.getBoundingClientRect(); return a + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (b - a); };
  const down = me.recorder === "down";

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-black text-white">
      {live ? <LiveVideo cameraId={cameraId} quality="focus" active={!down} online={cam.online && !down} onTransport={setVia} />
        : [<video ref={video} key={curKey} src={src} playsInline muted className="absolute inset-0 size-full object-contain"
            onLoadedMetadata={(e) => { const v = e.currentTarget; v.currentTime = Math.max(0, (target.ms - clipStart) / 1000); v.playbackRate = speed; if (playing) void v.play().catch(() => {}); }}
            onTimeUpdate={(e) => { setT(clipStart + e.currentTarget.currentTime * 1000); if (armed !== ws + W && ws + 2 * W < now() - 2000) setArmed(ws + W); }}
            onEnded={advance} onError={() => setNoRec(true)} />,
          hiSrc && <video ref={hiVideo} key={`${curKey}:hi`} src={hiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className="absolute inset-0 size-full object-contain" />,
          nextSrc && <video ref={nextVideo} key={nextKey} src={nextSrc} preload="auto" playsInline muted aria-hidden className="invisible absolute inset-0 size-full object-contain"
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = (nextOk?.leadMs ?? 0) / 1000; }} />,
          nextHiSrc && <video key={`${nextKey}:hi`} src={nextHiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className="absolute inset-0 size-full object-contain"
            onLoadedMetadata={(e) => { const at = (nextOk?.leadMs ?? 0) / 1000, sp = nextOk?.overlay.find((x) => x.at + x.len > at); e.currentTarget.currentTime = sp ? sp.from + Math.max(0, at - sp.at) : 0; }} />]}
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
        {live ? <LiveLabel via={via} /> : <span className="text-xs text-zinc-300">Recorded</span>}
        <span className="flex-1" />
        {recording.has(cameraId) && <RecMark />}
        <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => setJump((j) => !j)}><CalendarDays />{fmtDay(t, tz)}</Button>
        {!live && <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => seek(Date.now())}>Go live</Button>}
      </div>
      {jump && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setJump(false)} />
          <div role="dialog" aria-label="Jump to a time" className="absolute top-14 right-4 z-20 grid w-64 gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl">
            <Input type="date" aria-label="Date" value={dateInput(t, tz)} onChange={(e) => { if (!e.target.value) return; const [y, m, d] = e.target.value.split("-").map(Number), p = zonedParts(t, tz); seek(zonedToUtc(y, m, d, p.hour, p.minute, p.second, tz)); }} />
            <Input type="time" step={1} aria-label="Time" value={timeInput(t, tz)} onChange={(e) => { if (!e.target.value) return; const [h, mi, s = 0] = e.target.value.split(":").map(Number), p = zonedParts(t, tz); seek(zonedToUtc(p.year, p.month, p.day, h, mi, s, tz)); }} />
            <Select aria-label="Time zone" value={typeof me.preferences.tz === "string" ? me.preferences.tz : "local"} onChange={(e) => setPref("tz", e.target.value)}>{ZONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </div>
        </>
      )}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-4 pt-12 pb-[max(0.9rem,env(safe-area-inset-bottom))] transition-opacity ${idle ? "opacity-0" : ""}`}>
        {zoomNote && <div key={zoomNote.n} role="status" className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-xs font-semibold whitespace-nowrap">{zoomNote.text}</div>}
        <div ref={tl} className="relative h-8 cursor-pointer touch-none select-none" role="slider" aria-label="Timeline" aria-valuemin={a} aria-valuemax={b} aria-valuenow={Math.round(t)} aria-valuetext={fmtTime(t, tz)} tabIndex={0}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const ms = at(e.currentTarget, e.clientX); if (trim) dragTrim(Math.abs(ms - trim.a) <= Math.abs(ms - trim.b) ? "a" : "b", ms); else seek(ms); }}
          onPointerUp={(e) => { if (trim?.grab) dragTrim(trim.grab, at(e.currentTarget, e.clientX), true); }}
          onPointerCancel={() => { if (trim?.grab) dragTrim(trim.grab, trim[trim.grab], true); }}
          onPointerMove={(e) => { const ms = at(e.currentTarget, e.clientX), y = e.currentTarget.getBoundingClientRect().top; if (trim) { if (e.buttons && trim.grab) dragTrim(trim.grab, ms); } else if (e.buttons) seek(ms); if (e.pointerType === "mouse") setHover((h) => ({ x: e.clientX, y, ms, img: h && Math.abs(h.img - ms) < (b - a) / 150 ? h.img : ms })); }}
          onPointerLeave={() => setHover(null)}>
          <div className="absolute inset-x-0 bottom-2 h-[5px] overflow-hidden rounded-full bg-white/20" title={rec?.precision === "bounds" ? "Some gaps in the recording may not be shown" : undefined}>
            {!down && rec?.ranges.map(([s, e], i) => e > a && s < b ? <i key={i} className={`absolute inset-y-0 ${rec.precision === "exact" ? "bg-white/80" : "bg-white/50"}`} style={{ left: pct(s), right: `calc(100% - ${pct(e)})` }} /> : null)}
          </div>
          {!down && events.filter((e) => e.startMs > a && e.startMs < b).map((e) => <i key={e.id} title={`${EVENT_LABEL[e.type] ?? e.type}, ${fmtShort(e.startMs, tz)}`} className="absolute bottom-[17px] size-1.5 -translate-x-1/2 rounded-full" style={{ left: pct(e.startMs), background: EVENT_COLOR[e.type] ?? "#a3a3a3" }} />)}
          {trim ? <>
            <i className="pointer-events-none absolute bottom-[1px] h-[19px] border-y-2 border-yellow-400 bg-yellow-400/30" style={{ left: pct(trim.a), right: `calc(100% - ${pct(trim.b)})` }} />
            {(["a", "b"] as const).map((g) => <i key={g} className="pointer-events-none absolute -bottom-0.5 h-[25px] w-3 -translate-x-1/2 rounded-[4px] bg-yellow-400 shadow" style={{ left: pct(trim[g]) }} />)}
            {trim.grab && <span className="pointer-events-none absolute bottom-8 -translate-x-1/2 rounded bg-yellow-400 px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-black" style={{ left: pct(trim[trim.grab]) }}>{fmtTime(trim[trim.grab], tz)}</span>}
          </> : <i className="pointer-events-none absolute bottom-[3px] size-[15px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgba(255,255,255,.25)]" style={{ left: pct(t) }} />}
        </div>
        <div className="relative mt-0.5 h-4 text-[11px] text-zinc-400">{ticks.map((m) => { const f = (m - a) / (b - a); return <span key={m} className={`absolute top-0 whitespace-nowrap ${f < 0.04 ? "" : f > 0.96 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: pct(m) }}>{fmtShort(m, tz)}</span>; })}</div>
        {trim ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(["a", "b"] as const).map((g) => <input key={g} type="time" step={1} aria-label={g === "a" ? "Clip starts" : "Clip ends"} value={timeInput(trim[g], tz)} onChange={(e) => typeTrim(g, e.target.value)} className="h-9 rounded-lg border border-white/30 bg-transparent px-2 text-sm text-white tabular-nums outline-none [color-scheme:dark] focus-visible:border-white" />)}
            <span className="text-sm text-zinc-300">{fmtLen(trim.b - trim.a)}</span>
            <span className="flex-1" />
            <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={() => setTrim(null)}>Cancel</Button>
            <Button className="bg-white text-black hover:bg-white/90" onClick={saveClip}><Download />Save clip</Button>
          </div>
        ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon" className={ghost} aria-label="Back 10 seconds" onClick={() => seek(t - 10000)}><RotateCcw /></Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause /> : <Play />}</Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label="Forward 10 seconds" onClick={() => seek(t + 10000)}><RotateCw /></Button>
          <span className="ml-2 text-base font-semibold tabular-nums">{fmtTime(t, tz)}</span>
          <span className="flex-1" />
          <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom out" title="Zoom out (−)" disabled={zoom === 0} onClick={() => zoomBy(-1)}><ZoomOut /></Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label="Zoom in" title="Zoom in (+)" disabled={zoom === ZOOMS.length - 1} onClick={() => zoomBy(1)}><ZoomIn /></Button>
          {!live && <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="h-9 rounded-lg bg-transparent px-1 text-sm text-white outline-none hover:bg-white/15 [&>option]:text-black">{[0.5, 1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}</select>}
          <Button variant="ghost" className={ghost} disabled={down} onClick={startTrim}><Download /><span className="max-sm:hidden">Save clip</span></Button>
          <Button variant="ghost" size="icon" className={ghost} aria-label="Full screen" onClick={() => { const el = box.current!, v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (document.fullscreenElement) void document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast("Full screen isn't available")); else v?.webkitEnterFullscreen?.(); }}><Maximize /></Button>
        </div>
        )}
      </div>
      {hover && !down && (
        <div className="pointer-events-none fixed z-30 w-36 -translate-x-1/2 rounded-lg border bg-popover p-1 text-center text-xs text-popover-foreground shadow-xl" style={{ left: Math.max(hover.x, 80), top: hover.y - 108 }}>
          <div className="mb-0.5 aspect-video overflow-hidden rounded bg-black">{<img alt="" key={Math.round(hover.img / 1000)} src={mediaUrl(`/api/cameras/${cameraId}/snapshot?w=240&at=${Math.round(hover.img)}`)} className="size-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />}</div>
          {fmtTime(hover.ms, tz)}
        </div>
      )}
      {job && trim && <ClipDialog name={cam.name} startMs={trim.a} endMs={trim.b} first={job} onClose={(saved) => { setJob(null); if (saved) setTrim(null); }} />}
    </div>
  );
}

/** Progress and download for a clip that has already been requested. Closing after a failure returns to the selection. */
function ClipDialog({ name, startMs, endMs, first, onClose }: { name: string; startMs: number; endMs: number; first: Job; onClose: (saved: boolean) => void }) {
  const { tz } = useApp();
  const [job, setJob] = useState<Job>(first);
  useEffect(() => {
    if (job.status !== "running") return;
    const i = setInterval(() => api<Job>(`/exports/${job.id}`).then(setJob).catch(() => setJob({ ...job, status: "failed", error: "This clip is no longer available." })), 700);
    return () => clearInterval(i);
  }, [job]);
  const close = () => { if (job.status === "running") void api(`/exports/${job.id}`, { method: "DELETE" }).catch(() => {}); onClose(job.status === "ready"); };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{job.status === "running" ? "Preparing clip…" : job.status === "ready" ? "Clip ready" : "Couldn't save clip"}</DialogTitle>
          <DialogDescription>{job.status === "running" || job.status === "ready" ? `${name} · ${fmtDay(startMs, tz)}, ${fmtTime(startMs, tz)} · ${fmtLen(endMs - startMs)}` : job.error ?? "Something went wrong. Try again."}</DialogDescription>
        </DialogHeader>
        {job.status === "running" && <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
        <DialogFooter>
          <Button variant="outline" onClick={close}>{job.status === "running" ? "Cancel" : job.status === "ready" ? "Done" : "Back"}</Button>
          {job.status === "ready" && <a href={mediaUrl(`/api/exports/${job.id}/download`)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"><Download className="size-4" />Download</a>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const VIA: Record<Transport | "none", [string, string]> = {
  webrtc: ["Real-time", "Direct connection (WebRTC). Under a second behind."],
  hls: ["A few seconds behind", "Real-time isn't reachable from this network, so this uses standard streaming (HLS)."],
  none: ["Connecting", "Live video is starting."],
};

/** "Live" in the player's top bar. A ring around the dot means real-time (WebRTC); hover or tap explains. */
function LiveLabel({ via }: { via: Transport | null }) {
  const [title, text] = VIA[via ?? "none"];
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} aria-label={`Live: ${title}`} className="flex cursor-default items-center gap-1.5 rounded text-xs text-zinc-300 underline decoration-white/40 decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-white">
        <i className={`size-1.5 rounded-full bg-red-500 ${via === "webrtc" ? "outline-[1.5px] outline-offset-[1.5px] outline-red-500/60 outline-solid" : ""}`} />Live
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-60">
        <PopoverHeader><PopoverTitle>{title}</PopoverTitle><PopoverDescription>{text}</PopoverDescription></PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
