"use client";
import { ArrowDown, ArrowUp, ListChecks, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type Camera } from "./api";
import { Empty, fail, Page, PageHeader, Select, useApp } from "./app";

export interface Overview {
  users: { id: string; name: string; email: string | null; role: "admin" | "staff"; status: "active" | "disabled"; allowPrivateViews: boolean; lastLoginAt: number | null; providerGroups: string[]; groupIds: string[]; cameraCount: number; landing: { viewId: string | null; reason: string; viewName: string | null; groupName: string | null } }[];
  groups: { id: string; name: string; defaultPriority: number; isAllStaff: boolean; providerValues: string[]; memberIds: string[]; syncedMemberIds: string[] }[];
  groupSync: { claim: string | null };
  cameras: Camera[];
  tags: { id: string; name: string }[];
  cameraTags: { cameraId: string; tagId: string }[];
  userGrants: { userId: string; cameraId: string }[];
  groupGrants: { groupId: string; cameraId: string }[];
  views: { id: string; name: string; sharedWithAll: boolean }[];
  defaults: { scope: string; userId: string | null; groupId: string | null; viewId: string }[];
}
interface Detail { id: string; name: string; type: "dynamic" | "static"; visibility: "private" | "curated"; columns: number; version: number; editable: boolean; cameras: Camera[]; definition: { tagIds: string[]; cameraIds: string[] }; sharing: { all: boolean; userIds: string[]; groupIds: string[] } | null }
export const Card = ({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) => <section className="mb-3.5 rounded-xl border p-4"><h3 className="text-[15px] font-semibold">{title}</h3>{hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}{children && <div className="mt-3">{children}</div>}</section>;
export const Row = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="my-2.5 flex flex-wrap items-center gap-2"><span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>{children}</div>;
export const Pill = ({ on, disabled, onChange, children }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: React.ReactNode }) => <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} className={`m-0.5 inline-flex h-7 items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{children}</button>;
export const Seg = <T extends string | number>({ value, options, onChange, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) => <div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">{options.map(([k, l]) => <button key={k} type="button" disabled={disabled} onClick={() => onChange(k)} className={`rounded-md px-3 py-1 text-sm font-medium disabled:opacity-60 ${value === k ? "bg-background shadow-sm" : "text-muted-foreground"}`}>{l}</button>)}</div>;
const REASON: Record<string, string> = { user: "Set by an administrator", group: "From their group", personal: "Their choice", org: "Default for everyone", wall: "No starting view set", none: "No cameras yet" };
const YOUR_REASON: Record<string, string> = { user: "Set by an administrator.", group: "Set for your group.", personal: "Your choice.", org: "Default for everyone.", wall: "", none: "" };
/** Why someone starts where they do. `you` words it for the person reading. */
export const landingReason = (l: { reason: string; groupName?: string | null }, you = false) => (l.reason === "group" && l.groupName ? (you ? `Set for ${l.groupName}.` : `From ${l.groupName}`) : (you ? YOUR_REASON : REASON)[l.reason] ?? "");

export function ManageViews() {
  const { me, loc, nav, reload } = useApp();
  const [tab, setTab] = useState("views");
  const [sel, setSel] = useState<string | null>(loc.query.get("id"));
  const [loaded, setD] = useState<Detail | null>(null);
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [cams, setCams] = useState<Camera[]>([]);
  const [ov, setOv] = useState<Overview | null>(null);
  const id = sel && me.views.some((v) => v.id === sel) ? sel : me.views[0]?.id ?? null;

  const d = loaded && loaded.id === id ? loaded : null;
  const load = useCallback(() => { if (id) api<Detail>(`/views/${id}`).then(setD).catch(fail); }, [id]);
  const loadOv = useCallback(() => { if (me.isAdmin) api<Overview>("/admin/overview").then(setOv).catch(fail); }, [me.isAdmin]);
  useEffect(load, [load]);
  useEffect(() => { api<{ tags: typeof tags }>("/tags").then((r) => setTags(r.tags)).catch(fail); api<{ cameras: Camera[] }>("/cameras").then((r) => setCams(r.cameras)).catch(fail); loadOv(); }, [loadOv]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); await reload(); load(); loadOv(); } catch (e) { fail(e); load(); } };
  const save = (patch: Partial<{ name: string; type: "dynamic" | "static"; columns: number; tagIds: string[]; cameraIds: string[] }>) => {
    if (!d) return;
    const next = { name: d.name, type: d.type, columns: d.columns, tagIds: d.definition.tagIds, cameraIds: d.definition.cameraIds, ...patch };
    return act(() => api(`/views/${d.id}`, { method: "PUT", body: { ...next, tagIds: next.type === "dynamic" ? next.tagIds : [], cameraIds: next.type === "static" ? next.cameraIds : [], version: d.version } }));
  };
  const create = () => act(async () => { const r = await api<{ id: string }>("/views", { method: "POST", body: { name: "Untitled view", type: "dynamic", tagIds: [], visibility: me.isAdmin ? "curated" : "private" } }); setSel(r.id); });
  const convert = (type: "dynamic" | "static") => {
    if (!d || d.type === type) return;
    // Switching kinds is always an explicit, confirmed choice. Unifeye never converts a view on its own.
    if (type === "static") { if (confirm("Switch to a fixed list? The current cameras stay, but tag changes will no longer update this view.")) void save({ type, cameraIds: d.cameras.map((c) => c.id), tagIds: [] }); }
    else if (confirm("Switch to tags? The cameras you picked will be cleared.")) void save({ type, cameraIds: [], tagIds: [] });
  };
  const move = (i: number, by: number) => { if (!d) return; const ids = [...d.definition.cameraIds], j = i + by; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; void save({ cameraIds: ids }); };
  const canCreate = me.subject.canCreateViews && !me.preview, ro = !d?.editable;
  const share = (patch: Partial<NonNullable<Detail["sharing"]>>) => d?.sharing && act(() => api(`/views/${d.id}/sharing`, { method: "PUT", body: { ...d.sharing, ...patch } }));
  const flip = (list: string[], x: string, on: boolean) => (on ? [...list, x] : list.filter((y) => y !== x));

  return (
    <Page>
      <PageHeader title="Manage views">{canCreate && <Button onClick={create}><Plus />New view</Button>}</PageHeader>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="mb-4"><TabsList><TabsTrigger value="views">Views</TabsTrigger><TabsTrigger value="start">Starting view</TabsTrigger></TabsList></Tabs>
      {tab === "start" ? <StartingView ov={ov} act={act} /> : !d ? <Empty icon={<ListChecks />} title="No views yet">{canCreate ? "Create one, or save a filter from the camera wall." : "No views have been shared with you."}</Empty> : (
        <div className="grid items-start gap-4 md:grid-cols-[15rem_1fr]">
          <div className="rounded-xl border p-1.5">{me.views.map((v) => <button key={v.id} onClick={() => setSel(v.id)} className={`flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm ${v.id === d.id ? "bg-accent font-medium" : "hover:bg-accent/60"}`}><span className="flex-1 truncate">{v.name}</span><span className="text-xs text-muted-foreground">{v.visibility === "private" ? "Private" : v.type === "dynamic" ? "Follows tags" : "Fixed list"}</span></button>)}</div>
          <div key={`${d.id}:${d.version}`}>
            <Card title={d.name} hint={ro ? "You can't edit this view." : undefined}>
              <Row label="Name"><Input aria-label="View name" defaultValue={d.name} disabled={ro} className="max-w-xs" onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== d.name) void save({ name: n }); }} /></Row>
              <Row label="Cameras"><Seg value={d.type} disabled={ro} onChange={convert} options={[["dynamic", "Follow tags"], ["static", "Fixed list"]]} /><span className="text-sm text-muted-foreground">{d.type === "dynamic" ? "Updates as tags change." : "Only the cameras you pick."}</span></Row>
              <Row label="Columns"><Seg value={d.columns} disabled={ro} onChange={(columns) => save({ columns })} options={[[2, "2"], [3, "3"], [4, "4"]]} /></Row>
              {d.type === "dynamic" ? (
                <>
                  <div className="my-2.5 flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Has all of</span><div className="flex-1">{tags.map((t) => <Pill key={t.id} on={d.definition.tagIds.includes(t.id)} disabled={ro} onChange={(on) => save({ tagIds: flip(d.definition.tagIds, t.id, on) })}>{t.name}</Pill>)}</div></div>
                  <p className="text-sm text-muted-foreground">{!d.definition.tagIds.length ? "No tags selected, so every camera is included." : d.cameras.length ? `Includes ${d.cameras.map((c) => c.name).join(", ")}.` : "No cameras match."}</p>
                </>
              ) : (
                <div className="my-2.5 flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">In this order</span>
                  <div className="max-w-md flex-1">
                    {d.cameras.map((c, i) => (
                      <div key={c.id} className="mb-1.5 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3 text-sm"><i className={`size-1.5 rounded-full ${c.missing ? "bg-zinc-400" : c.online ? "bg-green-500" : "bg-red-500"}`} /><span className="flex-1 truncate">{c.name}{c.missing && <span className="text-muted-foreground"> (removed)</span>}</span>
                        <Button variant="ghost" size="icon-sm" disabled={ro} aria-label="Move up" onClick={() => move(d.definition.cameraIds.indexOf(c.id), -1)}><ArrowUp /></Button><Button variant="ghost" size="icon-sm" disabled={ro} aria-label="Move down" onClick={() => move(d.definition.cameraIds.indexOf(c.id), 1)}><ArrowDown /></Button><Button variant="ghost" size="icon-sm" disabled={ro} aria-label="Remove" onClick={() => save({ cameraIds: d.definition.cameraIds.filter((x) => x !== c.id) })}><X /></Button></div>
                    ))}
                    {!d.cameras.length && <p className="pb-2 text-sm text-muted-foreground">No cameras added.</p>}
                    {!ro && <Select aria-label="Add a camera" value="" onChange={(e) => e.target.value && save({ cameraIds: [...d.definition.cameraIds, e.target.value] })}><option value="">Add a camera…</option>{cams.filter((c) => !d.definition.cameraIds.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
                  </div></div>
              )}
              <div className="mt-3 flex gap-2"><Button variant="outline" onClick={() => nav(`/view/${d.id}`)}>Open</Button><span className="flex-1" />{!ro && <Button variant="outline" className="text-destructive" onClick={() => confirm(`Delete "${d.name}"? This can't be undone.`) && act(async () => { await api(`/views/${d.id}`, { method: "DELETE" }); setSel(null); }, "View deleted")}>Delete</Button>}</div>
            </Card>
            {d.visibility === "private" ? <Card title="Sharing" hint="Only you can see this view." />
              : d.sharing && ov ? (
                <>
                  <Card title="Sharing" hint="People only see cameras they already have access to.">
                    <Row label="Everyone"><Switch checked={d.sharing.all} onCheckedChange={(all) => share({ all })} aria-label="Share with all staff" /><span className="text-sm text-muted-foreground">All staff</span></Row>
                    <div className="my-2.5 flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Groups</span><div className="flex-1">{ov.groups.filter((g) => !g.isAllStaff).map((g) => <Pill key={g.id} on={d.sharing!.groupIds.includes(g.id)} onChange={(on) => share({ groupIds: flip(d.sharing!.groupIds, g.id, on) })}>{g.name}</Pill>)}</div></div>
                    <div className="my-2.5 flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">People</span><div className="flex-1">{ov.users.filter((u) => u.role === "staff").map((u) => <Pill key={u.id} on={d.sharing!.userIds.includes(u.id)} onChange={(on) => share({ userIds: flip(d.sharing!.userIds, u.id, on) })}>{u.name || u.email}</Pill>)}</div></div>
                  </Card>
                </>
              ) : <Card title="Sharing" hint="Shared with you by an administrator." />}
          </div>
        </div>
      )}
    </Page>
  );
}

function StartingView({ ov, act }: { ov: Overview | null; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const { me } = useApp();
  const mine = me.landing.viewId ? me.views.find((v) => v.id === me.landing.viewId)?.name : null;
  const set = (body: object) => act(() => api("/defaults", { method: "PUT", body }));
  const cur = (scope: string, key?: "userId" | "groupId", id?: string) => ov?.defaults.find((x) => x.scope === scope && (!key || x[key] === id))?.viewId ?? "";
  const opts = (list: { id: string; name: string }[]) => <><option value="">None</option>{list.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</>;
  return (
    <>
      <Card title="Your starting view" hint={me.landing.reason === "none" ? "You don't have any cameras yet." : `Unifeye opens to ${mine ?? "all your cameras"}. ${landingReason(me.landing, true)}`.trim()}>
        {me.subject.canCreateViews && !me.preview && <Row label="My choice"><Select aria-label="My starting view" defaultValue="" onChange={(e) => set({ scope: "personal", viewId: e.target.value || null })}>{opts(me.views)}</Select><span className="text-sm text-muted-foreground">Used unless an administrator sets one for you.</span></Row>}
      </Card>
      {me.isAdmin && ov && (
        <>
          <Card title="Default for everyone" hint="Each person starts on the first view that applies: one set for them, one set for their group, their own choice, then this default.">
            <Row label="View"><Select aria-label="Starting view for everyone" value={cur("org")} onChange={(e) => set({ scope: "org", viewId: e.target.value || null })}>{opts(ov.views)}</Select></Row>
          </Card>
          <Card title="For each group" hint="If someone is in more than one group, the highest priority wins.">
            <div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Group</th><th className="pb-2 font-medium">Priority</th><th className="pb-2 font-medium">Starting view</th></tr></thead><tbody>
              {[...ov.groups].sort((a, b) => b.defaultPriority - a.defaultPriority).map((g) => <tr key={g.id} className="border-t"><td className="py-2 pr-3">{g.name}</td><td className="py-2 pr-3"><Input type="number" aria-label="Priority" className="w-20" defaultValue={g.defaultPriority} onBlur={(e) => Number(e.target.value) !== g.defaultPriority && act(() => api(`/admin/groups/${g.id}`, { method: "PATCH", body: { defaultPriority: Number(e.target.value) || 0 } }))} /></td><td className="py-2"><Select aria-label="Starting view" value={cur("group", "groupId", g.id)} onChange={(e) => set({ scope: "group", groupId: g.id, viewId: e.target.value || null })}>{opts(ov.views)}</Select></td></tr>)}
            </tbody></table></div>
          </Card>
          <Card title="For each person">
            <div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Set for them</th><th className="pb-2 font-medium">Starts on</th></tr></thead><tbody>
              {ov.users.map((u) => <tr key={u.id} className="border-t"><td className="py-2 pr-3">{u.name || u.email}</td><td className="py-2 pr-3"><Select aria-label="Set for them" value={cur("user", "userId", u.id)} onChange={(e) => set({ scope: "user", userId: u.id, viewId: e.target.value || null })}>{opts(ov.views)}</Select></td><td className="py-2">{u.landing.viewName ?? "All cameras"}<div className="text-xs text-muted-foreground">{landingReason(u.landing)}</div></td></tr>)}
            </tbody></table></div>
          </Card>
        </>
      )}
    </>
  );
}
