"use client";
import { Volume2, VolumeOff, VolumeX } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "cn";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

/**
 * Which camera is playing sound, if any. Only one at a time, across the wall and the player, so a
 * wall of cameras never plays over itself.
 *
 * Whether the viewer wants sound at all is remembered in this browser: turning a camera's sound on
 * or off sets it, and opening a camera while it is on gives that camera the sound (`claimSound`).
 * When the browser refuses to play with sound (no recent click, e.g. after a reload), the camera
 * plays muted and gets its sound back on the viewer's next click or key press anywhere on the page.
 */
const KEY = "unifeye.sound";
let current: string | null = null;
let wanted = (() => { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } })();
/** The camera that lost its sound to the browser's autoplay rules, waiting for the next gesture. */
let blocked: string | null = null;
const subs = new Set<() => void>();
function publish(cameraId: string | null) {
  if (current === cameraId) return;
  current = cameraId;
  for (const f of subs) f();
}
/** The viewer's choice: sound on for this camera, or off. Remembered for next time. */
export function setSound(cameraId: string | null) {
  unblock();
  if (wanted !== (cameraId !== null)) { wanted = cameraId !== null; try { localStorage.setItem(KEY, wanted ? "on" : "off"); } catch { /* not remembered */ } }
  publish(cameraId);
}
/** Gives this camera the sound if the viewer has sound on; leaves it muted otherwise. */
export function claimSound(cameraId: string) {
  if (!wanted || current === cameraId) return;
  unblock();
  publish(cameraId);
}
const gesture = (e: Event) => {
  if ((e.target as Element | null)?.closest?.("[data-sound]")) return; // the speaker button decides for itself
  const id = blocked;
  unblock();
  if (id && wanted && current === null) publish(id);
};
function unblock() {
  if (blocked === null) return;
  blocked = null;
  document.removeEventListener("pointerdown", gesture, true); document.removeEventListener("keydown", gesture, true);
}
/** The browser would not play with sound: mute for now, and try again on the next gesture. */
function block() {
  if (current === null) return;
  if (blocked === null) { document.addEventListener("pointerdown", gesture, true); document.addEventListener("keydown", gesture, true); }
  blocked = current;
  publish(null);
}
export const useSound = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current, () => null);

type MediaEl = HTMLVideoElement & { audioTracks?: { length: number }; mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; captureStream?: () => MediaStream };

/** Whether a playing element has an audio track: true or false once the browser can say, null while it can't yet. */
function elementHasAudio(el: MediaEl): boolean | null {
  if (el.srcObject instanceof MediaStream) return el.srcObject.getAudioTracks().length > 0;
  if (el.audioTracks) return el.audioTracks.length > 0; // Safari
  if (typeof el.mozHasAudio === "boolean") return el.mozHasAudio; // Firefox
  // Chrome only reveals it by decoding some audio, so "none" is decided after a little playback.
  if (typeof el.webkitAudioDecodedByteCount === "number") return el.webkitAudioDecodedByteCount > 0 ? true : null;
  return null;
}

/** Reports once whether the element's media has sound, after it starts playing. Returns a cancel function. */
export function watchAudio(el: HTMLVideoElement, report: (has: boolean) => void): () => void {
  let done = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { done = true; clearTimeout(timer); el.removeEventListener("playing", playing); el.removeEventListener("timeupdate", check); };
  const check = () => { if (done) return; const h = elementHasAudio(el); if (h !== null) { stop(); report(h); } };
  const playing = () => { check(); if (!done && !timer) timer = setTimeout(() => { if (!done) { const h = elementHasAudio(el); stop(); report(h ?? false); } }, 2500); };
  el.addEventListener("playing", playing); el.addEventListener("timeupdate", check);
  if (!el.paused && el.readyState > 2) playing();
  return stop;
}

/**
 * Applies the sound setting to a playing element. If the browser refuses to play with sound (no
 * recent click), the video carries on muted and sound is switched off rather than the video stopping.
 */
export function applySound(el: HTMLVideoElement, on: boolean) {
  el.muted = !on;
  if (on && el.paused && el.readyState > 2) play(el);
}
/**
 * `play()` that falls back to muted when the browser won't play it with sound. Only a refusal
 * (NotAllowedError) counts: a play interrupted by a seek or a new source (AbortError) is not one.
 */
export function play(el: HTMLVideoElement) {
  void el.play().catch((e: unknown) => {
    if (el.muted || (e as { name?: string } | null)?.name !== "NotAllowedError") return;
    el.muted = true; block(); void el.play().catch(() => {});
  });
}

/** A media stream carrying the element's audio, for the level meter. Null where the browser can't provide one. */
function audioStream(el: MediaEl): { stream: MediaStream; own: boolean } | null {
  if (el.srcObject instanceof MediaStream) return { stream: el.srcObject, own: false };
  if (typeof el.captureStream !== "function") return null; // Safari; Firefox's mozCaptureStream would silence the element
  try { return { stream: el.captureStream(), own: true }; } catch { return null; }
}

const BARS = [0.55, 1, 0.75, 0.9];
/**
 * Four small bars that move with the sound actually arriving. Moving bars and nothing heard means the
 * viewer's own speakers; flat bars mean the camera is sending silence.
 */
function LevelMeter({ media }: { media: HTMLVideoElement }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const src = audioStream(media as MediaEl);
    if (!src || !src.stream.getAudioTracks().length) return;
    let ctx: AudioContext | undefined, raf = 0, last = 0;
    try {
      ctx = new AudioContext();
      const an = ctx.createAnalyser(), sink = ctx.createGain();
      an.fftSize = 512; sink.gain.value = 0;
      ctx.createMediaStreamSource(src.stream).connect(an);
      an.connect(sink).connect(ctx.destination); // silent, but keeps every browser pulling audio through the analyser
      const buf = new Float32Array(an.fftSize);
      const tick = (t: number) => {
        raf = requestAnimationFrame(tick);
        if (t - last < 60 || !bars.current) return;
        last = t;
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6), level = Math.min(1, Math.max(0, (db + 55) / 40));
        bars.current.style.visibility = "visible";
        [...bars.current.children].forEach((b, i) => { (b as HTMLElement).style.height = `${Math.max(2, Math.round(12 * level * BARS[i]))}px`; });
      };
      raf = requestAnimationFrame(tick);
    } catch { /* no meter, sound still plays */ }
    return () => { cancelAnimationFrame(raf); void ctx?.close(); if (src.own) for (const t of src.stream.getTracks()) t.stop(); };
  }, [media]);
  return <span ref={bars} aria-hidden className="invisible mr-1 flex h-3 items-end gap-[1.5px]">{BARS.map((_, i) => <i key={i} className="h-0.5 w-[2px] rounded-[1px] bg-green-400" />)}</span>;
}

/**
 * The speaker control for one camera. `has` is whether its stream carries sound: null while unknown
 * (nothing is shown), false for a camera with no audio (a greyed-out speaker that explains why).
 */
export function SoundButton({ cameraId, has, media, recorded = false, className = "", onClassName = "" }: { cameraId: string; has: boolean | null; media?: HTMLVideoElement | null; recorded?: boolean; className?: string; /** Extra classes while sound is on. */ onClassName?: string }) {
  const on = useSound() === cameraId;
  if (has === null) return null;
  if (!has) return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} aria-label="No audio" onClick={(e) => e.stopPropagation()} className={cn("grid size-9 place-items-center rounded-lg text-white/40 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white [&_svg]:size-4", className)}>
        <VolumeOff />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-60">
        <PopoverHeader><PopoverTitle>No audio</PopoverTitle><PopoverDescription>{recorded ? "This recording has no sound." : "This camera doesn't send sound."}</PopoverDescription></PopoverHeader>
      </PopoverContent>
    </Popover>
  );
  return (
    <span data-sound className="flex items-center">
      <button type="button" aria-label={on ? "Turn sound off" : "Turn sound on"} aria-pressed={on} title={on ? "Sound off (M)" : "Sound on (M)"} onClick={(e) => { e.stopPropagation(); setSound(on ? null : cameraId); }}
        className={cn("grid size-9 place-items-center rounded-lg text-white outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white [&_svg]:size-4", className, on && onClassName)}>
        {on ? <Volume2 /> : <VolumeX />}
      </button>
      {on && media && <LevelMeter media={media} />}
    </span>
  );
}
