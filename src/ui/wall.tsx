"use client";
import { Camera as CameraIcon, History, Lock, Maximize, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, ApiError, fmtTime, type Camera } from "./api";
import { Empty, fail, RecMark, SidebarOpener, useApp, useRecording } from "./app";
import { LiveVideo } from "./live";
import { SoundButton, useSound } from "./sound";
import { RecordedVideo } from "./recorded-video";
import { ScrubStill } from "./scrub-still";
import { RewindBar, useRewind } from "./wall-rewind";
import { useSidebar } from "@/components/ui/sidebar";

interface ViewData { id: string; name: string; type: string; columns: number; cameras: Camera[] }
const GRID: Record<number, string> = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" };

/**
 * The camera wall: video edge to edge, a floating dock for switching views, and one button for
 * search, tags and layout. Only tiles on screen connect, up to the configured maximum; the rest
 * show a still image.
 */
export function Wall({ viewId }: { viewId?: string }) {
  const { me, nav, loc, tz, setPref, reload } = useApp();
  const { open: sidebarOpen, isMobile } = useSidebar();
  const recording = useRecording();
  const [data, setData] = useState<{ cameras: Camera[]; view?: ViewData } | null>(null);
  const [gone, setGone] = useState(false);
  const [panel, setPanel] = useState(false);
  const [visible, setVisible] = useState<string[]>([]);
  /** Tiles within a screen of the visible area (on screen included), for warming while rewinding. */
  const [near, setNear] = useState<string[]>([]);
  /**
   * Tiles started by pointing at them (most recent last): one past the stream limit, or one the
   * visibility check missed. Each stays until it scrolls off screen or two newer ones replace it.
   */
  const [hovered, setHovered] = useState<string[]>([]);
  /** Which streaming tiles carry sound (missing or null while unknown), and the one camera playing it. */
  const [audio, setAudio] = useState<Record<string, boolean | null>>({});
  const sound = useSound();
  const root = useRef<HTMLDivElement>(null);
  const tags = useMemo(() => (loc.query.get("tags") ?? "").split(",").filter(Boolean), [loc.query]);
  const q = loc.query.get("q") ?? "";
  // Filters live in the address, so going to a camera and back restores exactly this wall.
  const setFilter = (next: { tags?: string[]; q?: string }) => {
    const p = new URLSearchParams(loc.query), t = next.tags ?? tags, s = next.q ?? q;
    if (t.length) p.set("tags", t.join(",")); else p.delete("tags");
    if (s) p.set("q", s); else p.delete("q");
    nav(`${loc.path}${p.size ? `?${p}` : ""}`, true);
  };

  const [tick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    const load = () => (viewId ? api<ViewData>(`/views/${viewId}`).then((v) => ({ cameras: v.cameras, view: v })) : api<{ cameras: Camera[] }>("/cameras"))
      .then((d) => { if (!off) { setData(d); setGone(false); } })
      .catch((e) => { if (!off) { if (e instanceof ApiError && e.status === 404) setGone(true); else fail(e); } });
    load();
    const t = setInterval(load, 30_000);
    return () => { off = true; clearInterval(t); };
  }, [viewId, me.preview?.subject.id, tick]);

  const prefKey = `cols:${viewId ?? "all"}`;
  const cols = [2, 3, 4].includes(Number(me.preferences[prefKey])) ? Number(me.preferences[prefKey]) : data?.view?.columns ?? 3;
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (data?.cameras ?? []).filter((c) => !c.missing && tags.every((t) => c.tags.includes(t)) && (!needle || c.name.toLowerCase().includes(needle) || c.tags.some((t) => t.includes(needle)))), [data, tags, needle]);
  const facet = useMemo(() => { const m = new Map<string, number>(); shown.forEach((c) => c.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1))); tags.forEach((t) => m.has(t) || m.set(t, 0)); return [...m].sort((a, b) => a[0].localeCompare(b[0])); }, [shown, tags]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const seen = new Set<string>();
    // A tile counts as on screen from a fifth showing; one started by pointing at it stops once none of it shows.
    const io = new IntersectionObserver((es) => {
      const gone: string[] = [];
      for (const e of es) { const id = (e.target as HTMLElement).dataset.cam!; if (e.isIntersecting && e.intersectionRatio >= 0.2) seen.add(id); else seen.delete(id); if (!e.isIntersecting) gone.push(id); }
      setVisible([...seen]);
      if (gone.length) setHovered((h) => (h.some((x) => gone.includes(x)) ? h.filter((x) => !gone.includes(x)) : h));
    }, { root: el, threshold: [0, 0.2] });
    // Tiles within a screen above or below, warmed while rewinding so scrolling to them is quick.
    const nearSet = new Set<string>();
    const nearIo = new IntersectionObserver((es) => { for (const e of es) { const id = (e.target as HTMLElement).dataset.cam!; if (e.isIntersecting) nearSet.add(id); else nearSet.delete(id); } setNear([...nearSet]); }, { root: el, rootMargin: "100% 0px" });
    el.querySelectorAll("[data-cam]").forEach((n) => { io.observe(n); nearIo.observe(n); });
    return () => { io.disconnect(); nearIo.disconnect(); };
  }, [shown, cols]);
  const extra = useMemo(() => hovered.filter((id) => shown.some((c) => c.id === id)), [hovered, shown]);
  // Live and rewound alike: the first MAX_WALL_STREAMS tiles on screen play, plus any started by pointing
  // at them. Rewound tiles play the recording in low resolution (`RecordedVideo`'s `low`).
  const playIds = useMemo(() => { const first = shown.filter((c) => visible.includes(c.id)).slice(0, me.limits.maxStreams).map((c) => c.id); return shown.map((c) => c.id).filter((id) => first.includes(id) || extra.includes(id)); }, [shown, visible, extra, me.limits.maxStreams]);
  const streaming = useMemo(() => new Set(playIds), [playIds]);
  const shownIds = useMemo(() => shown.map((c) => c.id), [shown]);
  // Opening a camera from a rewound wall keeps the moment in the address (`at`), so coming back carries on from there.
  const [startAt] = useState(() => Number(loc.query.get("at")) || undefined);
  const rw = useRewind({ playIds, shownIds, nearIds: near, W: me.limits.windowSeconds * 1000, preloadMs: me.limits.scrubPreloadMs, startAt });
  useEffect(() => { if (!loc.query.has("at")) return; const p = new URLSearchParams(loc.query); p.delete("at"); nav(`${loc.path}${p.size ? `?${p}` : ""}`, true); }, [loc, nav]);
  const open = (id: string) => {
    if (!past) { nav(`/camera/${id}`); return; }
    const p = new URLSearchParams(loc.query), at = Math.round(rw.t);
    p.set("at", String(at));
    nav(`${loc.path}?${p}`, true);
    nav(`/camera/${id}?t=${at}`);
  };
  const past = rw.open && !rw.live, down = me.recorder === "down";
  // Space plays and pauses while rewinding.
  useEffect(() => {
    if (!rw.open) return;
    const key = (e: KeyboardEvent) => { if (e.key !== " " || e.defaultPrevented || (e.target as HTMLElement).closest("input,select,textarea,button,[role=dialog]")) return; e.preventDefault(); rw.toggle(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const filtered = tags.length > 0 || !!needle;
  const saveView = async () => {
    try {
      const body = tags.length ? { name: tags.join(" + "), type: "dynamic", tagIds: (await api<{ tags: { id: string; name: string }[] }>("/tags")).tags.filter((t) => tags.includes(t.name)).map((t) => t.id), columns: cols } : { name: "New view", type: "static", cameraIds: shown.map((c) => c.id), columns: cols };
      const r = await api<{ id: string }>("/views", { method: "POST", body: { ...body, visibility: me.isAdmin ? "curated" : "private" } });
      await reload();
      toast.success("View saved");
      nav(`/views?id=${r.id}`);
    } catch (e) { fail(e); }
  };

  let body: React.ReactNode;
  if (gone) body = <Empty icon={<Lock />} title="View unavailable">It may have been deleted or is no longer shared with you.<div><Button variant="outline" className="mt-4" onClick={() => nav("/?all")}>Show all cameras</Button></div></Empty>;
  else if (!data) body = <div className={`grid gap-0.5 ${GRID[cols]}`}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="aspect-video animate-pulse bg-muted" />)}</div>;
  else if (!data.cameras.some((c) => !c.missing)) body = viewId
    ? <Empty icon={<CameraIcon />} title="No cameras to show">You don&apos;t have access to any cameras in this view.<div><Button variant="outline" className="mt-4" onClick={() => nav("/?all")}>Show all cameras</Button></div></Empty>
    : <Empty icon={<Lock />} title="No cameras yet">Ask an administrator for access.</Empty>;
  else if (!shown.length) body = <Empty icon={<Search />} title="No matching cameras">Try removing a tag or changing your search.<div><Button variant="outline" className="mt-4" onClick={() => setFilter({ tags: [], q: "" })}>Clear filters</Button></div></Empty>;
  else body = (
    <div className={`grid grid-cols-1 gap-0.5 ${GRID[cols]}`}>
      {shown.map((c) => {
        const st = past ? rw.tileStart(c.id) : null, playRec = !!st && !down && playIds.includes(c.id), onScreen = visible.includes(c.id);
        const still = rw.open && onScreen && !down ? rw.stillAt(c.id) : null, onAudio = (h: boolean | null) => setAudio((a) => (a[c.id] === h ? a : { ...a, [c.id]: h }));
        return (
        <div key={c.id} data-cam={c.id} className="group relative aspect-video overflow-hidden bg-black text-white"
          onPointerEnter={() => { if (!(past ? playIds.includes(c.id) : streaming.has(c.id))) setHovered((h) => [...h.filter((x) => x !== c.id), c.id].slice(-2)); }}>
          <button onClick={() => open(c.id)} aria-label={`Open ${c.name}`} className="peer absolute inset-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset">
            {!past ? <LiveVideo cameraId={c.id} quality="wall" active={streaming.has(c.id) && !down} online={c.online && !down} sound={sound === c.id} onAudio={onAudio} onGone={() => { setTick((n) => n + 1); void reload(); }} />
              : playRec ? <RecordedVideo key={st.key} cameraId={c.id} W={me.limits.windowSeconds * 1000} startMs={st.ms} playing={rw.playing && !rw.dragging} speed={rw.speed} fit="object-cover" low sound={sound === c.id} onAudio={onAudio} {...rw.tile(c.id)} />
              : onScreen && !down && <ScrubStill cameraId={c.id} ms={Math.floor(rw.t / 5000) * 5000} close={4000} width={640} gap={1000} className="absolute inset-0 size-full object-cover" />}
            {playRec && rw.missing[c.id] && still === null && <span className="absolute inset-0 grid place-items-center bg-zinc-900 p-3 text-center text-sm text-zinc-300">No recording at this time</span>}
            {still !== null && (
              <span className="absolute inset-0 bg-black/60">
                {!rw.recorded(c.id, still) ? <span className="absolute inset-0 grid place-items-center bg-zinc-900 p-3 text-center text-sm text-zinc-300">No recording at {fmtTime(still, tz)}</span>
                  : still < rw.clock - 10_000 && <ScrubStill key={rw.scrub?.n} cameraId={c.id} ms={still} close={2000} width={640} gap={rw.stillGap} className="absolute inset-0 size-full object-cover" />}
              </span>
            )}
            <span className="absolute top-2.5 left-2.5 flex max-w-[calc(100%-4.5rem)] items-center gap-1.5 truncate rounded-md bg-black/65 px-2 py-0.5 text-xs font-medium"><i className={`size-1.5 shrink-0 rounded-full ${past || rw.dragging ? "bg-zinc-400" : c.online ? "bg-green-500" : "bg-red-500"}`} />{c.name}</span>
            {!past && !rw.dragging && recording.has(c.id) && <RecMark className="absolute top-2.5 right-2.5" />}
          </button>
          <span className={`pointer-events-none absolute inset-0 ring-2 transition ring-inset ${sound === c.id && audio[c.id] ? "ring-green-400" : "ring-white/0 group-hover:ring-white"}`} />
          <span className="absolute right-2 bottom-2"><SoundButton cameraId={c.id} has={audio[c.id] ?? null} className="size-7 rounded-md bg-black/65 opacity-0 group-hover:opacity-100 peer-focus-visible:opacity-100 focus-visible:opacity-100 hover:bg-black/80 [&_svg]:size-3.5" onClassName="bg-white text-black opacity-100 hover:bg-white/90" /></span>
        </div>
        );
      })}
    </div>
  );

  const dockViews = !sidebarOpen || isMobile;
  const lift = rw.open ? "bottom-[8.5rem]" : "bottom-[4.4rem]";
  const dockTabs = dockViews && <>
    <i className="mx-1 h-5 w-px shrink-0 bg-border" />
    <DockTab on={!viewId} onClick={() => nav("/?all")}>All</DockTab>
    {me.views.slice(0, 4).map((v) => <DockTab key={v.id} on={viewId === v.id} onClick={() => nav(`/view/${v.id}`)}>{v.name}</DockTab>)}
  </>;
  const dockLeft = <><SidebarOpener />{dockTabs}</>;
  const dockTools = <>
    <Button variant={rw.open ? "secondary" : "ghost"} size="icon" aria-label={rw.open ? "Back to live" : "Rewind"} title={rw.open ? "Back to live" : "Rewind"} aria-pressed={rw.open} disabled={down && !rw.open} onClick={() => (rw.open ? rw.close() : rw.setOpen(true))}><History /></Button>
    <Button variant="ghost" size="icon" className="relative" aria-label="Filter and layout" title="Filter and layout" onClick={() => setPanel((p) => !p)}><SlidersHorizontal />{filtered && <i className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-blue-500" />}</Button>
    <Button variant="ghost" size="icon" aria-label="Full screen" title="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => toast("Full screen isn't available")))}><Maximize /></Button>
  </>;
  return (
    <>
      <div ref={root} className={`flex min-h-0 flex-1 flex-col overflow-auto ${rw.open ? "pb-32" : ""}`}>{body}</div>
      {filtered && shown.length > 0 && !panel && (
        <div className={`absolute ${lift} left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-full border bg-background py-1 pr-1 pl-4 text-sm font-medium whitespace-nowrap shadow-lg`}>
          <span className="truncate">{[...tags, needle && `"${q.trim()}"`].filter(Boolean).join(" + ")}</span><span className="font-normal text-muted-foreground">{shown.length} camera{shown.length === 1 ? "" : "s"}</span>
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setFilter({ tags: [], q: "" })}>Clear</Button>
        </div>
      )}
      {panel && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setPanel(false)} />
          <div role="dialog" aria-label="Filter and layout" className={`absolute ${lift} left-1/2 z-20 max-h-[calc(100%-6rem)] w-[min(19rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl`}>
            <Input autoFocus type="search" placeholder="Search cameras" value={q} onChange={(e) => setFilter({ q: e.target.value })} aria-label="Search cameras" />
            <div className="px-0.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">Tags</div>
            {facet.length ? facet.map(([t, n]) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={tags.includes(t)} onCheckedChange={(on) => setFilter({ tags: on ? [...tags, t] : tags.filter((x) => x !== t) })} />{t}<span className="ml-auto text-xs text-muted-foreground">{n}</span>
              </label>
            )) : <div className="px-0.5 text-sm text-muted-foreground">No tags</div>}
            <div className="px-0.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">Columns</div>
            <div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">{[2, 3, 4].map((n) => <button key={n} onClick={() => setPref(prefKey, n)} className={`rounded-md px-3 py-1 text-sm font-medium ${cols === n ? "bg-background shadow-sm" : "text-muted-foreground"}`}>{n}</button>)}</div>
            <div className="mt-3 flex items-center gap-2">
              {filtered && <Button size="sm" variant="outline" onClick={() => setFilter({ tags: [], q: "" })}>Clear</Button>}
              <span className="flex-1" />
              {me.subject.canCreateViews && !me.preview && shown.length > 0 && <Button size="sm" variant="outline" onClick={saveView}>Save as view</Button>}
            </div>
          </div>
        </>
      )}
      {rw.open ? <RewindBar rw={rw} tz={tz} prerollMs={me.limits.prerollSeconds * 1000} dock={<><SidebarOpener /><span className="contents max-lg:hidden">{dockTabs}</span><i className="mx-1 h-5 w-px shrink-0 bg-border" /></>} tools={<><i className="mx-1 h-5 w-px shrink-0 bg-border" />{dockTools}</>} />
        : <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border bg-background/90 p-1 shadow-lg backdrop-blur-md">
          {dockLeft}
          {dockViews && <i className="mx-1 h-5 w-px shrink-0 bg-border" />}
          {dockTools}
        </div>}
    </>
  );
}
function DockTab({ on, children, ...p }: { on: boolean } & React.ComponentProps<"button">) {
  return <button {...p} className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{children}</button>;
}
