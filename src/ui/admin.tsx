"use client";
import { Eye, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, fmtDay, fmtTime, setPreviewToken } from "./api";
import { fail, Page, PageHeader, Select, useApp } from "./app";
import { Card, landingReason, Pill, Row, type Overview } from "./manage-views";

const TH = "px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted-foreground", TD = "border-t px-3 py-2.5 align-middle";
const ACTION: Record<string, string> = { "auth.login": "Signed in", "auth.logout": "Signed out", "auth.backchannel_logout": "Signed out by the sign-in provider", "auth.provider_revoked": "Access ended by the sign-in provider", "user.provisioned": "First sign-in", "admin.bootstrap": "Became the first administrator", "user.update": "Changed a person", "group.create": "Added a group", "group.update": "Changed a group", "group.delete": "Deleted a group", "group.member.add": "Added to a group", "group.member.remove": "Removed from a group", "grant.add": "Gave camera access", "grant.revoke": "Removed camera access", "tag.create": "Added a tag", "tag.rename": "Renamed a tag", "tag.delete": "Removed a tag", "camera.tag": "Tagged a camera", "camera.untag": "Untagged a camera", "view.create": "Created a view", "view.update": "Changed a view", "view.convert": "Changed a view's kind", "view.delete": "Deleted a view", "view.share": "Changed sharing", "default.set": "Set a starting view", "preview.start": "Started seeing as staff", "preview.exit": "Stopped seeing as staff", "preview.end": "Seeing as staff ended", "preview.mutation": "Tried to change something while seeing as staff", "preview.use": "Used an invalid preview", "clip.export": "Saved a clip", "admin.access": "Tried to open Admin", "system.start": "Vantage started" };

/** Vantage's own data only: people's access, groups, camera grants and tags. Nothing here changes the recorder or the identity provider. */
export function Admin() {
  const { tz, reload } = useApp();
  const [tab, setTab] = useState("people");
  const [ov, setOv] = useState<Overview | null>(null);
  const [log, setLog] = useState<{ id: number; at: number; actor: string; previewSubject: string | null; action: string; outcome: string; detail: Record<string, unknown> | null }[]>([]);
  const [pick, setPick] = useState("");
  const load = useCallback(() => api<Overview>("/admin/overview").then(setOv).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (tab === "history") api<{ entries: typeof log }>("/admin/audit").then((r) => setLog(r.entries)).catch(fail); }, [tab]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { fail(e); } await load(); void reload(); };
  const put = (path: string, body: object, method = "PUT") => act(() => api(path, { method, body }));
  const seeAs = async (userId: string) => { try { const r = await api<{ token: string }>("/preview", { method: "POST", body: { userId } }); setPreviewToken(r.token); location.assign("/"); } catch (e) { fail(e); } };
  if (!ov) return <Page><PageHeader title="Admin" /></Page>;
  const staff = ov.users.filter((u) => u.role === "staff"), nameOf = (u: Overview["users"][number]) => u.name || u.email || "Unnamed";
  const subjects = [...ov.groups.map((g) => ({ key: `g${g.id}`, name: g.name, kind: g.isAllStaff ? "Everyone" : "Group", body: { groupId: g.id }, has: (c: string) => ov.groupGrants.some((x) => x.groupId === g.id && x.cameraId === c) })), ...staff.map((u) => ({ key: `u${u.id}`, name: nameOf(u), kind: "Person", body: { userId: u.id }, has: (c: string) => ov.userGrants.some((x) => x.userId === u.id && x.cameraId === c) }))];
  const preview = staff.filter((u) => u.status === "active"), chosen = preview.find((u) => u.id === pick) ?? preview[0];

  return (
    <Page>
      <PageHeader title="Admin" />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="mb-4"><TabsList className="h-auto flex-wrap">{[["people", "People"], ["groups", "Groups"], ["access", "Camera access"], ["tags", "Tags"], ["see", "See as staff"], ["history", "History"]].map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList></Tabs>

      {tab === "people" && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">People show up here after their first sign-in, with no cameras. Passwords and sign-in security are managed by your sign-in provider.</p>
          <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>Person</th><th className={TH}>Role</th><th className={TH}>Groups</th><th className={TH}>Cameras</th><th className={TH}>Own views</th><th className={TH}>Active</th><th className={TH} /></tr></thead><tbody>
            {ov.users.map((u) => (
              <tr key={u.id}><td className={TD}>{nameOf(u)}<div className="text-xs text-muted-foreground">{u.email}</div></td>
                <td className={TD}><Select aria-label="Role" value={u.role} onChange={(e) => put(`/admin/users/${u.id}`, { role: e.target.value }, "PATCH")}><option value="staff">Staff</option><option value="admin">Admin</option></Select></td>
                <td className={TD}>{ov.groups.filter((g) => !g.isAllStaff).map((g) => <Pill key={g.id} on={g.memberIds.includes(u.id)} onChange={(on) => put("/admin/members", { groupId: g.id, userId: u.id, on })}>{g.name}</Pill>)}</td>
                <td className={TD}>{u.cameraCount}</td>
                <td className={TD}><Switch checked={u.allowPrivateViews} onCheckedChange={(v) => put(`/admin/users/${u.id}`, { allowPrivateViews: v }, "PATCH")} aria-label="May create their own views" /></td>
                <td className={TD}><Switch checked={u.status === "active"} onCheckedChange={(v) => put(`/admin/users/${u.id}`, { status: v ? "active" : "disabled" }, "PATCH")} aria-label="Active" /></td>
                <td className={TD}>{u.role === "staff" && u.status === "active" && <Button size="sm" variant="outline" onClick={() => seeAs(u.id)}>See as them</Button>}</td></tr>
            ))}
          </tbody></table></div>
        </>
      )}

      {tab === "groups" && (
        <>
          <form className="mb-3.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, n = new FormData(f).get("name"); if (n) void put("/admin/groups", { name: n }, "POST").then(() => f.reset()); }}><Input name="name" placeholder="New group name" aria-label="New group name" className="max-w-xs" /><Button variant="outline"><Plus />Add group</Button></form>
          {ov.groups.map((g) => (
            <Card key={`${g.id}:${g.name}`} title={g.name} hint={g.isAllStaff ? "Everyone who can sign in belongs to this group automatically." : undefined}>
              {!g.isAllStaff && <>
                <Row label="Name"><Input aria-label="Group name" defaultValue={g.name} className="max-w-xs" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && put(`/admin/groups/${g.id}`, { name: e.target.value.trim() }, "PATCH")} /><span className="flex-1" /><Button size="sm" variant="outline" className="text-destructive" onClick={() => confirm(`Delete ${g.name}? Its members lose the cameras and views they had through it.`) && act(() => api(`/admin/groups/${g.id}`, { method: "DELETE" }))}>Delete</Button></Row>
                <div className="flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Members</span><div className="flex-1">{staff.map((u) => <Pill key={u.id} on={g.memberIds.includes(u.id)} onChange={(on) => put("/admin/members", { groupId: g.id, userId: u.id, on })}>{nameOf(u)}</Pill>)}</div></div>
              </>}
            </Card>
          ))}
        </>
      )}

      {tab === "access" && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">Nobody sees a camera until it is ticked here, for them or for one of their groups. Tags and shared views never give access. New cameras start with nothing ticked.</p>
          <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={`${TH} sticky left-0 bg-background`}>Camera</th>{subjects.map((s) => <th key={s.key} className={`${TH} text-center`}>{s.name}<div className="font-normal">{s.kind}</div></th>)}</tr></thead><tbody>
            {ov.cameras.map((c) => <tr key={c.id}><td className={`${TD} sticky left-0 bg-background whitespace-nowrap`}><i className={`mr-2 inline-block size-1.5 rounded-full align-middle ${c.missing ? "bg-zinc-400" : c.online ? "bg-green-500" : "bg-red-500"}`} />{c.name}</td>{subjects.map((s) => <td key={s.key} className={`${TD} text-center`}><Checkbox className="align-middle" checked={s.has(c.id)} aria-label={`${s.name}: ${c.name}`} onCheckedChange={(on) => put("/admin/grants", { ...s.body, cameraId: c.id, on: !!on })} /></td>)}</tr>)}
          </tbody></table></div>
        </>
      )}

      {tab === "tags" && (
        <>
          <form className="mb-3.5 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, n = String(new FormData(f).get("name") ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"); if (n) void put("/admin/tags", { name: n }, "POST").then(() => f.reset()); }}><Input name="name" placeholder="New tag" aria-label="New tag" className="max-w-xs" /><Button variant="outline"><Plus />Add tag</Button><span className="text-sm text-muted-foreground">Tags live in Vantage. The recorder is never changed.</span></form>
          <div className="mb-3.5 overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>Camera</th><th className={TH}>Tags</th></tr></thead><tbody>
            {ov.cameras.map((c) => <tr key={c.id}><td className={`${TD} whitespace-nowrap`}>{c.name}</td><td className={TD}>{ov.tags.map((t) => <Pill key={t.id} on={ov.cameraTags.some((x) => x.cameraId === c.id && x.tagId === t.id)} onChange={(on) => put("/admin/camera-tags", { cameraId: c.id, tagId: t.id, on })}>{t.name}</Pill>)}</td></tr>)}
          </tbody></table></div>
          <Card title="Rename or remove">{ov.tags.map((t) => <div key={`${t.id}:${t.name}`} className="my-2 flex items-center gap-2"><Input aria-label="Tag name" defaultValue={t.name} className="w-48" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && put(`/admin/tags/${t.id}`, { name: e.target.value.trim() }, "PATCH")} /><span className="text-sm text-muted-foreground">{ov.cameraTags.filter((x) => x.tagId === t.id).length} cameras</span><span className="flex-1" /><Button size="sm" variant="outline" className="text-destructive" onClick={() => confirm(`Remove the tag ${t.name}?`) && act(() => api(`/admin/tags/${t.id}`, { method: "DELETE" }))}>Remove</Button></div>)}</Card>
        </>
      )}

      {tab === "see" && (!chosen ? <p className="text-sm text-muted-foreground">There are no active staff to look at.</p> : (
        <Card title="See Vantage as a staff member" hint="Check exactly what someone sees. You stay signed in as yourself, nothing can be changed while looking, it ends by itself after a short while, and it is recorded in History. Their account is not touched.">
          <Row label="Staff member"><Select aria-label="Staff member" value={chosen.id} onChange={(e) => setPick(e.target.value)}>{preview.map((u) => <option key={u.id} value={u.id}>{nameOf(u)}</option>)}</Select><Button onClick={() => seeAs(chosen.id)}><Eye />Start</Button></Row>
          <Row label="Starts on"><span className="text-sm">{chosen.landing.viewName ?? "Camera wall"}</span><span className="text-sm text-muted-foreground">{landingReason(chosen.landing)}</span></Row>
          <Row label="Cameras"><span className="text-sm">{chosen.cameraCount}</span></Row>
        </Card>
      ))}

      {tab === "history" && (
        <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>When</th><th className={TH}>Who</th><th className={TH}>Seeing as</th><th className={TH}>What</th></tr></thead><tbody>
          {log.map((r) => <tr key={r.id}><td className={`${TD} whitespace-nowrap`}>{fmtDay(r.at, tz)}, {fmtTime(r.at, tz)}</td><td className={TD}>{r.actor}</td><td className={TD}>{r.previewSubject}</td><td className={TD}>{ACTION[r.action] ?? r.action}{r.outcome !== "ok" && <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">blocked</span>}</td></tr>)}
          {!log.length && <tr><td className={`${TD} text-muted-foreground`} colSpan={4}>Nothing yet.</td></tr>}
        </tbody></table></div>
      )}
    </Page>
  );
}
