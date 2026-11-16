"use client";
import { Bell, Lock, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, EVENT_COLOR, EVENT_LABEL, fmtDay, fmtShort, mediaUrl, type ActivityEvent, type Camera } from "./api";
import { Empty, fail, Page, PageHeader, Select, useApp } from "./app";

const RANGES: [number, string][] = [[1, "Last hour"], [6, "Last 6 hours"], [24, "Last 24 hours"], [72, "Last 3 days"], [168, "Last 7 days"]];
const ALL_TYPES = ["motion", "person", "vehicle", "package", "animal", "ring", "licensePlate", "audio"];

/** Motion and detections from the cameras this person may see. Clicking one opens the recording a few seconds earlier. */
export function Activity() {
  const { me, nav, tz } = useApp();
  const [cams, setCams] = useState<Camera[]>([]);
  const [cam, setCam] = useState("");
  const [hours, setHours] = useState(24);
  const [type, setType] = useState("");
  const [limit, setLimit] = useState(48);
  const [res, setRes] = useState<{ events: ActivityEvent[]; hasMore: boolean; supportedTypes: string[] } | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => { api<{ cameras: Camera[] }>("/cameras").then((r) => setCams(r.cameras)).catch(fail); }, [me.preview?.subject.id]);
  useEffect(() => {
    let off = false;
    const load = () => api<NonNullable<typeof res>>(`/events?from=${Date.now() - hours * 3600e3}&limit=${limit}${cam ? `&cameraId=${cam}` : ""}${type ? `&type=${type}` : ""}`)
      .then((r) => { if (!off) { setRes(r); setDown(false); } }).catch((e) => { if (!off) { if (e.code === "nvr_unavailable") setDown(true); else fail(e); } });
    load();
    // Live updates: the server sends only activity this person is allowed to see.
    const es = new EventSource(mediaUrl("/api/events/stream"));
    es.addEventListener("activity", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as ActivityEvent;
      if ((cam && e.cameraId !== cam) || (type && e.type !== type)) return;
      setRes((r) => (r && !r.events.some((x) => x.id === e.id) ? { ...r, events: [e, ...r.events] } : r));
    });
    es.addEventListener("ended", () => es.close());
    return () => { off = true; es.close(); };
  }, [cam, hours, type, limit, me.preview?.subject.id]);

  const supported = res?.supportedTypes ?? [];
  return (
    <Page>
      <PageHeader title="Activity">
        <Select aria-label="Camera" value={cam} onChange={(e) => { setCam(e.target.value); setLimit(48); }}><option value="">All cameras</option>{cams.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Time range" value={hours} onChange={(e) => { setHours(Number(e.target.value)); setLimit(48); }}>{RANGES.map(([h, l]) => <option key={h} value={h}>{l}</option>)}</Select>
        <Select aria-label="Kind of activity" value={type} onChange={(e) => { setType(e.target.value); setLimit(48); }}>
          <option value="">All activity</option>
          {ALL_TYPES.map((t) => <option key={t} value={t} disabled={!supported.includes(t)}>{EVENT_LABEL[t]}{supported.includes(t) ? "" : " (not available)"}</option>)}
        </Select>
      </PageHeader>
      {down ? <Empty icon={<WifiOff />} title="Activity unavailable">Try again in a moment.</Empty>
        : !res ? <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3.5">{Array.from({ length: 8 }, (_, i) => <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-muted" />)}</div>
        : !cams.length ? <Empty icon={<Lock />} title="No cameras yet">Ask an administrator for access.</Empty>
        : !res.events.length ? <Empty icon={<Bell />} title="No activity">Try a longer time range.</Empty>
        : <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3.5">
              {res.events.map((e) => (
                <button key={e.id} onClick={() => nav(`/camera/${e.cameraId}?t=${e.startMs - me.limits.prerollSeconds * 1000}`)} className="overflow-hidden rounded-xl border text-left outline-none hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <div className="relative aspect-video bg-black">
                    <img alt="" loading="lazy" src={mediaUrl(e.hasThumbnail ? `/api/events/${encodeURIComponent(e.id)}/thumbnail` : `/api/cameras/${e.cameraId}/snapshot?w=480&at=${e.startMs}`)} className="size-full object-cover" onError={(ev) => { ev.currentTarget.style.visibility = "hidden"; }} />
                    <i className="absolute top-2 left-2 size-2 rounded-full ring-2 ring-black/40" style={{ background: EVENT_COLOR[e.type] }} />
                  </div>
                  <div className="grid px-3 pt-2 pb-2.5"><b className="text-sm font-medium">{EVENT_LABEL[e.type] ?? "Activity"}</b><span className="truncate text-xs text-muted-foreground">{e.cameraName} · {fmtDay(e.startMs, tz)}, {fmtShort(e.startMs, tz)}</span></div>
                </button>
              ))}
            </div>
            {res.hasMore && <div className="pt-5 text-center"><Button variant="outline" onClick={() => setLimit((n) => Math.min(n + 48, 200))}>Show more</Button></div>}
          </>}
    </Page>
  );
}
