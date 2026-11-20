"use client";
import { useEffect, useRef, useState } from "react";
import type { WindowInfo as WinInfo } from "@/server/media/recordings";
import { api, mediaUrl } from "./api";
import { canHandOver, carryOnAt, handOver, positionAt, shouldArm, skipped, stepPlayback, windowHoles, windowStart, type Playback, type Shown } from "./recorded-playback";
import { applySound, play, watchAudio } from "./sound";

/** Wall-clock time, for event handlers and animation frames only (never called while rendering). */
const now = () => Date.now();

export interface RecordedVideoProps {
  cameraId: string;
  /** Window length in ms (`PLAYBACK_WINDOW_SECONDS`). */
  W: number;
  /** The moment to start from. Mount a fresh one (a new `key`) for every seek. */
  startMs: number;
  playing: boolean;
  speed: number;
  /** Play the recording's sound (when it has any). */
  sound?: boolean;
  /**
   * The low-resolution recording alone (a wall tile): cheaper for the recorder, the server and the
   * browser, at the cost of moments only the high-resolution recording holds.
   */
  low?: boolean;
  /** `object-contain` letterboxes (the player), `object-cover` fills (a wall tile). */
  fit?: "object-contain" | "object-cover";
  /** The wall-clock time on screen, at most every 250 ms. */
  onTime?: (ms: number) => void;
  /** The next window could not take over in place: seek to `ms` (which remounts this). */
  onEnd?: (ms: number) => void;
  /** Whether there is nothing recorded here (or it failed to load). */
  onMissing?: (missing: boolean) => void;
  /** Whether the recording carries sound (null while unknown). */
  onAudio?: (has: boolean | null) => void;
  /** The element playing, for the level meter and full screen. */
  onMedia?: (el: HTMLVideoElement | null) => void;
  /** The video started playing (after a seek, or after a stall). */
  onPlaying?: () => void;
  /** Playing on skipped from `fromMs` to `toMs`, which were not recorded (see `skipped`). */
  onSkip?: (fromMs: number, toMs: number) => void;
  /** What was not recorded in the window starting at `windowMs`, once its description is final (see `windowHoles`). */
  onHoles?: (windowMs: number, holes: [number, number][]) => void;
}

/**
 * Recorded video from one camera, starting at `startMs` and playing on. Recorded video is fetched in
 * short windows: only the window around the start loads, and the next one buffers in hidden elements
 * and takes over when this one ends. Shared by the player and the camera wall.
 */
export function RecordedVideo(props: RecordedVideoProps) {
  const { cameraId, W, startMs, playing, speed, sound = false, fit = "object-contain", low = false } = props;
  const lowQ = low ? "&low=1" : "";
  const cb = useRef(props);
  useEffect(() => { cb.current = props; });
  /** The window playing: where the seek landed, then each window handed over to. */
  const [pos, setPos] = useState(startMs);
  const [noRec, setNoRec] = useState(false);
  /** Start of the window being buffered in the background so the next one starts without a black gap. */
  const [armed, setArmed] = useState<number | null>(null);
  /** Window descriptions by window start; "none" when the window has no recording. */
  const [infos, setInfos] = useState<Record<number, WinInfo | "none">>({});
  const infoReq = useRef(new Map<number, AbortController>()), handed = useRef(-1), frame = useRef<() => void>(() => {});
  /** Where recorded playback stands, stepped every animation frame (`stepPlayback`). */
  const cur = useRef<Playback | null>(null);
  /** The wall-clock time on screen, and the last one reported (which re-renders the parent, so it is held back). */
  const shown = useRef(0), shownSet = useRef(0);
  /** The last step that showed a time, to tell a skip over time not recorded (`skipped`). */
  const last = useRef<Shown | null>(null);
  const video = useRef<HTMLVideoElement>(null), hiVideo = useRef<HTMLVideoElement>(null), nextVideo = useRef<HTMLVideoElement>(null);

  const ws = windowStart(pos, W);
  const info = infos[ws], nextInfo = armed === ws + W ? infos[ws + W] : undefined;
  // Fetch the descriptions of this window and, once armed, the next. A description no longer wanted
  // is cancelled, which also cancels its export on the server. The first answer comes as soon as the
  // base file is ready; an adaptive window then says `pending`, and a second request brings the order
  // with the high-resolution file.
  useEffect(() => {
    const want = new Set([ws, ...(armed === ws + W ? [ws + W] : [])]), reqs = infoReq.current;
    for (const [k, ac] of reqs) if (!want.has(k)) { ac.abort(); reqs.delete(k); }
    for (const at of want) {
      if (reqs.has(at)) continue;
      const ac = new AbortController();
      reqs.set(at, ac);
      const get = (early: boolean) => api<WinInfo>(`/cameras/${cameraId}/playback/info?t=${at}${lowQ}${early ? "&early=1" : ""}`, { signal: ac.signal });
      get(true).then((i) => {
        setInfos((p) => ({ ...p, [at]: i }));
        // Without the high-resolution order, the base plays on alone.
        if (i.pending) get(false).then((f) => setInfos((p) => ({ ...p, [at]: f })), () => {});
      }, () => { if (!ac.signal.aborted) setInfos((p) => ({ ...p, [at]: "none" })); });
    }
  }, [ws, armed, W, cameraId, lowQ]);
  useEffect(() => { const reqs = infoReq.current; return () => { for (const ac of reqs.values()) ac.abort(); reqs.clear(); }; }, []);
  // Each window's holes, reported once its description is final.
  const holesSent = useRef(new Set<number>());
  useEffect(() => {
    for (const [k, i] of Object.entries(infos)) {
      const at = Number(k);
      // A window that failed to load is not marked: it may only be the recorder being busy, and the
      // timeline's own ranges already show a minute with nothing recorded.
      if (i !== "none" && !i.pending && !holesSent.current.has(at)) { holesSent.current.add(at); cb.current.onHoles?.(at, windowHoles(at, W, i)); }
    }
  }, [infos, W]);
  const missing = noRec || info === "none";
  useEffect(() => { cb.current.onMissing?.(missing); }, [missing]);

  const url = (at: number, high = false) => mediaUrl(`/api/cameras/${cameraId}/playback?t=${at}${lowQ}${high ? "&layer=high" : ""}`);
  const ok = info && info !== "none" ? info : null, withHigh = (i: WinInfo | null) => !!i?.high && !i.pending;
  const src = ok ? url(ws) : undefined, hiSrc = src && withHigh(ok) ? url(ws, true) : undefined;
  // The following window loads in hidden elements while this one plays (armed once it is fully recorded),
  // each file already waiting where that window will start.
  const nextOk = src && nextInfo && nextInfo !== "none" ? nextInfo : null;
  const nextSrc = nextOk ? url(ws + W) : undefined, nextHiSrc = withHigh(nextOk) ? url(ws + W, true) : undefined;
  const nextAt = ok && nextOk ? positionAt(nextOk.entries, carryOnAt(ok, nextOk)) : null;
  /** At the end of a window, the buffered next one takes over in place (same keys, so React keeps the elements). */
  const advance = () => {
    if (handed.current === ws) return;
    handed.current = ws;
    const nx = ws + W;
    if (ok && nextOk && canHandOver(nextSrc ? nextVideo.current : null, nx, now())) {
      cur.current = handOver({ key: String(ws), info: ok }, { key: String(nx), info: nextOk });
      cb.current.onTime?.(nx); setPos(nx);
    } else cb.current.onEnd?.(nx);
  };
  // Every animation frame: play the window's entries in order and hand over at their end (see `stepPlayback`).
  useEffect(() => { frame.current = () => {
    const v = video.current, h = hiVideo.current;
    if (!v || !ok) return;
    const r = stepPlayback(cur.current, { key: String(ws), info: ok }, v, h, { target: pos, shown: shown.current }, { playing, rate: speed, start: (m) => play(m as HTMLVideoElement) });
    if (!r) return;
    cur.current = r.s;
    const k = skipped(last.current, r.s, r.step.wall, performance.now(), { playing, rate: speed });
    last.current = k.last;
    if (k.skip) cb.current.onSkip?.(...k.skip);
    if (h) h.style.visibility = r.step.showHigh ? "visible" : "hidden";
    if (r.step.wall != null) {
      shown.current = r.step.wall;
      if (Math.abs(r.step.wall - shownSet.current) >= 250) { shownSet.current = r.step.wall; cb.current.onTime?.(r.step.wall); }
    }
    if (r.step.handOver) advance();
  }; });
  useEffect(() => { let id = 0; const tick = () => { frame.current(); id = requestAnimationFrame(tick); }; id = requestAnimationFrame(tick); return () => cancelAnimationFrame(id); }, []);
  // Pausing takes effect at once, even where animation frames are held back (a tab in the background).
  useEffect(() => { if (!playing) { video.current?.pause(); hiVideo.current?.pause(); } }, [playing, src]);
  // Each recorded window is its own element: find out whether it has sound, and apply the sound setting to it.
  const [hasAudio, setHasAudio] = useState<boolean | null>(null);
  useEffect(() => { const v = video.current; if (!v) return; cb.current.onMedia?.(v); return watchAudio(v, (h) => { setHasAudio(h); cb.current.onAudio?.(h); }); }, [ws]);
  useEffect(() => { const v = video.current; if (v) applySound(v, sound && hasAudio === true); }, [sound, hasAudio, ws]);
  useEffect(() => () => cb.current.onMedia?.(null), []);

  const cls = `absolute inset-0 size-full ${fit}`;
  return <>
    <video ref={video} key={ws} src={src} playsInline muted className={cls}
      onTimeUpdate={() => { if (armed !== ws + W && shouldArm(ws, W, now())) setArmed(ws + W); }}
      onPlaying={() => cb.current.onPlaying?.()}
      onError={() => setNoRec(true)} />
    {hiSrc && <video ref={hiVideo} key={`${ws}:hi`} src={hiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className={cls} />}
    {nextSrc && <video ref={nextVideo} key={ws + W} src={nextSrc} preload="auto" playsInline muted aria-hidden className={`invisible ${cls}`}
      onLoadedMetadata={(e) => { if (nextAt) e.currentTarget.currentTime = nextAt.base; }} />}
    {nextHiSrc && <video key={`${ws + W}:hi`} src={nextHiSrc} preload="auto" playsInline muted aria-hidden style={{ visibility: "hidden" }} className={cls}
      onLoadedMetadata={(e) => { if (nextAt?.high != null) e.currentTarget.currentTime = nextAt.high; }} />}
  </>;
}
