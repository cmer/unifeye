"use client";
import { Camera as CameraIcon, Lock, Maximize, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, ApiError, type Camera } from "./api";
import { Empty, fail, RecMark, SidebarOpener, useApp, useRecording } from "./app";
import { LiveVideo } from "./live";
import { useSidebar } from "@/components/ui/sidebar";

interface ViewData { id: string; name: string; type: string; columns: number; cameras: Camera[] }
const GRID: Record<number, string> = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" };

/**
 * The camera wall: video edge to edge, a floating dock for switching views, and one button for
 * search, tags and layout. Only tiles on screen connect, up to the configured maximum; the rest
 * show a still image.
 */
export function Wall({ viewId }: { viewId?: string }) {
  const { me, nav, loc, setPref, reload } = useApp();
  const { open: sidebarOpen, isMobile } = useSidebar();
  const recording = useRecording();
  const [data, setData] = useState<{ cameras: Camera[]; view?: ViewData } | null>(null);
  const [gone, setGone] = useState(false);
  const [panel, setPanel] = useState(false);
  const [visible, setVisible] = useState<string[]>([]);
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
  const shown = useMemo(() => (data?.cameras ?? []).filter((c) => tags.every((t) => c.tags.includes(t)) && (!needle || c.name.toLowerCase().includes(needle) || c.tags.some((t) => t.includes(needle)))), [data, tags, needle]);
  const facet = useMemo(() => { const m = new Map<string, number>(); shown.forEach((c) => c.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1))); tags.forEach((t) => m.has(t) || m.set(t, 0)); return [...m].sort((a, b) => a[0].localeCompare(b[0])); }, [shown, tags]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const seen = new Set<string>();
    const io = new IntersectionObserver((es) => { for (const e of es) { const id = (e.target as HTMLElement).dataset.cam!; if (e.isIntersecting) seen.add(id); else seen.delete(id); } setVisible([...seen]); }, { root: el, threshold: 0.2 });
    el.querySelectorAll("[data-cam]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [shown, cols]);
  const streaming = useMemo(() => new Set(shown.filter((c) => visible.includes(c.id)).slice(0, me.limits.maxStreams).map((c) => c.id)), [shown, visible, me.limits.maxStreams]);

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
  else if (!data.cameras.length) body = viewId
    ? <Empty icon={<CameraIcon />} title="No cameras to show">You don&apos;t have access to any cameras in this view.<div><Button variant="outline" className="mt-4" onClick={() => nav("/?all")}>Show all cameras</Button></div></Empty>
    : <Empty icon={<Lock />} title="No cameras yet">Ask an administrator for access.</Empty>;
  else if (!shown.length) body = <Empty icon={<Search />} title="No matching cameras">Try removing a tag or changing your search.<div><Button variant="outline" className="mt-4" onClick={() => setFilter({ tags: [], q: "" })}>Clear filters</Button></div></Empty>;
  else body = (
    <div className={`grid grid-cols-1 gap-0.5 ${GRID[cols]}`}>
      {shown.map((c) => (
        <button key={c.id} data-cam={c.id} onClick={() => nav(`/camera/${c.id}`)} aria-label={`Open ${c.name}`} className="group relative aspect-video overflow-hidden bg-black text-left text-white outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset">
          {c.missing ? <div className="absolute inset-0 grid place-items-center bg-zinc-900 p-4 text-center text-sm text-zinc-400"><div className="font-medium text-zinc-50">Camera removed</div></div>
            : <LiveVideo cameraId={c.id} quality="wall" active={streaming.has(c.id) && me.recorder !== "down"} online={c.online && me.recorder !== "down"} onGone={() => { setTick((n) => n + 1); void reload(); }} />}
          <span className="absolute top-2.5 left-2.5 flex max-w-[calc(100%-4.5rem)] items-center gap-1.5 truncate rounded-md bg-black/65 px-2 py-0.5 text-xs font-medium"><i className={`size-1.5 shrink-0 rounded-full ${c.missing ? "bg-zinc-500" : c.online ? "bg-green-500" : "bg-red-500"}`} />{c.name}</span>
          {recording.has(c.id) && <RecMark className="absolute top-2.5 right-2.5" />}
          <span className="pointer-events-none absolute inset-0 ring-2 ring-white/0 transition ring-inset group-hover:ring-white" />
        </button>
      ))}
    </div>
  );

  const dockViews = !sidebarOpen || isMobile;
  return (
    <>
      <div ref={root} className="flex min-h-0 flex-1 flex-col overflow-auto">{body}</div>
      {filtered && shown.length > 0 && !panel && (
        <div className="absolute bottom-[4.4rem] left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-full border bg-background py-1 pr-1 pl-4 text-sm font-medium whitespace-nowrap shadow-lg">
          <span className="truncate">{[...tags, needle && `"${q.trim()}"`].filter(Boolean).join(" + ")}</span><span className="font-normal text-muted-foreground">{shown.length} camera{shown.length === 1 ? "" : "s"}</span>
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setFilter({ tags: [], q: "" })}>Clear</Button>
        </div>
      )}
      {panel && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setPanel(false)} />
          <div role="dialog" aria-label="Filter and layout" className="absolute bottom-[4.4rem] left-1/2 z-20 max-h-[calc(100%-6rem)] w-[min(19rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl">
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
      <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border bg-background/90 p-1 shadow-lg backdrop-blur-md">
        <SidebarOpener />
        {dockViews && (
          <>
            <i className="mx-1 h-5 w-px shrink-0 bg-border" />
            <DockTab on={!viewId} onClick={() => nav("/?all")}>All</DockTab>
            {me.views.slice(0, 4).map((v) => <DockTab key={v.id} on={viewId === v.id} onClick={() => nav(`/view/${v.id}`)}>{v.name}</DockTab>)}
            <i className="mx-1 h-5 w-px shrink-0 bg-border" />
          </>
        )}
        <Button variant="ghost" size="icon" className="relative" aria-label="Filter and layout" title="Filter and layout" onClick={() => setPanel((p) => !p)}><SlidersHorizontal />{filtered && <i className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-blue-500" />}</Button>
        <Button variant="ghost" size="icon" aria-label="Full screen" title="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => toast("Full screen isn't available")))}><Maximize /></Button>
      </div>
    </>
  );
}
function DockTab({ on, children, ...p }: { on: boolean } & React.ComponentProps<"button">) {
  return <button {...p} className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{children}</button>;
}
