"use client";
import { Copy, Eye, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { api, fmtDay, fmtShort, fmtTime, setPreviewToken } from "./api";
import { fail, Page, PageHeader, Select, useApp } from "./app";
import { Card, landingReason, Pill, Row, type Overview } from "./manage-views";

const TH = "px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted-foreground", TD = "border-t px-3 py-2.5 align-middle";
const ACTION: Record<string, string> = { "auth.login": "Signed in", "auth.logout": "Signed out", "auth.password_set": "Chose a password", "auth.locked": "Too many wrong passwords", "user.create": "Added a person", "user.password_link": "Made a password link", "auth.backchannel_logout": "Signed out by the sign-in provider", "auth.provider_revoked": "Access ended by the sign-in provider", "user.provisioned": "First sign-in", "admin.bootstrap": "Became the first administrator", "user.update": "Changed a person", "group.create": "Added a group", "group.update": "Changed a group", "group.delete": "Deleted a group", "group.member.add": "Added to a group", "group.member.remove": "Removed from a group", "group.member.sync_add": "Added to a group by the sign-in provider", "group.member.sync_remove": "Removed from a group by the sign-in provider", "grant.add": "Gave camera access", "grant.revoke": "Removed camera access", "tag.create": "Added a tag", "tag.rename": "Renamed a tag", "tag.delete": "Removed a tag", "camera.tag": "Tagged a camera", "camera.untag": "Untagged a camera", "camera.direct": "Changed where a camera streams from", "view.create": "Created a view", "view.update": "Changed a view", "view.convert": "Changed a view's type", "view.delete": "Deleted a view", "view.share": "Changed sharing", "default.set": "Set a starting view", "preview.start": "Started viewing as", "preview.exit": "Stopped viewing as", "preview.end": "Viewing as ended", "preview.mutation": "Tried to make a change while viewing as", "preview.use": "Used an expired view-as session", "clip.export": "Saved a clip", "admin.access": "Tried to open Admin", "system.start": "Unifeye started" };

/** Unifeye's own data only: people's access, groups, camera grants and tags. Nothing here changes the recorder or the identity provider. */
export function Admin() {
  const { tz, reload } = useApp();
  const [tab, setTab] = useState("people");
  const [ov, setOv] = useState<Overview | null>(null);
  const [log, setLog] = useState<{ id: number; at: number; actor: string; previewSubject: string | null; action: string; outcome: string; detail: Record<string, unknown> | null }[]>([]);
  const [pick, setPick] = useState("");
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string; expiresAt: number } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>("/admin/overview").then(setOv).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (tab === "history") api<{ entries: typeof log }>("/admin/audit").then((r) => setLog(r.entries)).catch(fail); }, [tab]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { fail(e); } await load(); void reload(); };
  const put = (path: string, body: object, method = "PUT") => act(() => api(path, { method, body }));
  const seeAs = async (userId: string) => { try { const r = await api<{ token: string }>("/preview", { method: "POST", body: { userId } }); setPreviewToken(r.token); location.assign("/"); } catch (e) { fail(e); } };
  if (!ov) return <Page><PageHeader title="Admin" /></Page>;
  const staff = ov.users.filter((u) => u.role === "staff"), nameOf = (u: Overview["users"][number]) => u.name || u.email || "Unnamed";
  const claim = ov.groupSync.claim;
  /** Membership toggle. A synced membership is locked here: it follows the sign-in provider. */
  const member = (g: Overview["groups"][number], userId: string, label: string) => claim && g.syncedMemberIds.includes(userId)
    ? <span key={g.id + userId} title="Added by your sign-in provider. Change it there."><Pill on disabled onChange={() => {}}>{label}<RefreshCw aria-label="synced" className="ml-1 size-3" /></Pill></span>
    : <Pill key={g.id + userId} on={g.memberIds.includes(userId)} onChange={(on) => put("/admin/members", { groupId: g.id, userId, on })}>{label}</Pill>;
  /** Every value seen in someone's group claim, plus any already mapped, for picking. */
  const seenValues = [...new Set([...ov.users.flatMap((u) => u.providerGroups), ...ov.groups.flatMap((g) => g.providerValues)])].sort();
  const setValues = (g: Overview["groups"][number], values: string[]) => put(`/admin/groups/${g.id}`, { providerValues: values }, "PATCH");
  const subjects = [...ov.groups.map((g) => ({ key: `g${g.id}`, name: g.name, kind: g.isAllStaff ? "Everyone" : "Group", body: { groupId: g.id }, has: (c: string) => ov.groupGrants.some((x) => x.groupId === g.id && x.cameraId === c) })), ...staff.map((u) => ({ key: `u${u.id}`, name: nameOf(u), kind: "Person", body: { userId: u.id }, has: (c: string) => ov.userGrants.some((x) => x.userId === u.id && x.cameraId === c) }))];
  /** Why someone can save clips, for the People table: their role, or the groups that allow it. */
  const clipsVia = (u: Overview["users"][number]) => {
    if (!u.canExportClips) return <span className="text-muted-foreground">No</span>;
    const via = u.role === "admin" ? "Admin" : ov.groups.filter((g) => g.canExportClips && (g.isAllStaff || g.memberIds.includes(u.id))).map((g) => g.name).join(", ");
    return <>Yes{via && <span className="text-muted-foreground"> · {via}</span>}</>;
  };
  const setClips = (g: Overview["groups"][number], on: boolean) => {
    if (!on && !confirm(`Stop ${g.isAllStaff ? "everyone" : `"${g.name}"`} from saving clips?\n\nClips being saved now will stop, and clips ready to download will be removed. People in another group that allows it can still save clips.`)) return;
    void put(`/admin/groups/${g.id}`, { canExportClips: on }, "PATCH");
  };
  const preview = staff.filter((u) => u.status === "active"), chosen = preview.find((u) => u.id === pick) ?? preview[0];

  return (
    <Page>
      <PageHeader title="Admin" />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="mb-4"><TabsList className="h-auto flex-wrap">{[["people", "People"], ["groups", "Groups"], ["access", "Camera access"], ["tags", "Tags"], ["live", "Live video"], ["see", "View as"], ["signin", "Sign-in"], ["history", "History"]].map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList></Tabs>

      {tab === "people" && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm text-muted-foreground">{ov.signIn.local ? (ov.signIn.oidc || ov.signIn.cloudflare ? "People with work accounts appear here after they first sign in. Add people who sign in with a password." : "Add people here. Each one gets a link to choose a password.") : "People appear here after they first sign in. Passwords are managed by your sign-in provider."}</p>
            {ov.signIn.local && <Button size="sm" onClick={() => setAdding(true)}><Plus />Add person</Button>}
          </div>
          <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>Person</th><th className={TH}>Signs in with</th><th className={TH}>Role</th><th className={TH}>Groups</th><th className={TH}>Cameras</th><th className={TH}>Can save clips</th><th className={TH}>Can create views</th><th className={TH}>Active</th><th className={TH} /></tr></thead><tbody>
            {ov.users.map((u) => (
              <tr key={u.id}><td className={TD}>{nameOf(u)}<div className="text-xs text-muted-foreground">{u.signsInWith === "local" ? <>{u.username}{!u.passwordSet && " · hasn't chosen a password yet"}</> : u.email}</div></td>
                <td className={TD}><span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${u.methodOn ? "" : "border-amber-500/60 text-amber-700 dark:text-amber-400"}`} title={u.methodOn ? undefined : "This way of signing in is turned off, so they can't sign in."}>{METHOD[u.signsInWith]}{!u.methodOn && " · turned off"}</span></td>
                <td className={TD}><Select aria-label="Role" value={u.role} onChange={(e) => put(`/admin/users/${u.id}`, { role: e.target.value }, "PATCH")}><option value="staff">Staff</option><option value="admin">Admin</option></Select></td>
                <td className={TD}>{ov.groups.filter((g) => !g.isAllStaff).map((g) => member(g, u.id, g.name))}</td>
                <td className={TD}>{u.cameraCount}</td>
                <td className={`${TD} whitespace-nowrap`} title="Comes from their groups. To change it, change their groups or the group's setting.">{clipsVia(u)}</td>
                <td className={TD}><Switch checked={u.allowPrivateViews} onCheckedChange={(v) => put(`/admin/users/${u.id}`, { allowPrivateViews: v }, "PATCH")} aria-label="Can create views" /></td>
                <td className={TD}><Switch checked={u.status === "active"} onCheckedChange={(v) => put(`/admin/users/${u.id}`, { status: v ? "active" : "disabled" }, "PATCH")} aria-label="Active" /></td>
                <td className={`${TD} whitespace-nowrap`}>
                  {u.signsInWith === "local" && ov.signIn.local && <Button size="sm" variant="outline" className="mr-1.5" onClick={() => act(async () => { const r = await api<{ link: { url: string; expiresAt: number } }>(`/admin/users/${u.id}/password-link`, { method: "POST" }); setLink({ name: nameOf(u), ...r.link }); })}><KeyRound />Password link</Button>}
                  {u.role === "staff" && u.status === "active" && u.methodOn && <Button size="sm" variant="outline" onClick={() => seeAs(u.id)}>View as</Button>}
                </td></tr>
            ))}
          </tbody></table></div>
        </>
      )}

      {tab === "groups" && (
        <>
          <form className="mb-3.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, n = new FormData(f).get("name"); if (n) void put("/admin/groups", { name: n }, "POST").then(() => f.reset()); }}><Input name="name" placeholder="New group name" aria-label="New group name" className="max-w-xs" /><Button variant="outline"><Plus />Add group</Button></form>
          {ov.groups.map((g) => (
            <Card key={`${g.id}:${g.name}`} title={g.name} hint={g.isAllStaff ? "Every person is in this group automatically." : undefined}>
              <div className="flex items-start gap-2"><span className="w-28 shrink-0 pt-0.5 text-sm text-muted-foreground">Saving clips</span><div className="flex-1">
                <Switch checked={g.canExportClips} onCheckedChange={(on) => setClips(g, on)} aria-label={`${g.name} can save clips`} />
                <p className="mt-1 text-xs text-muted-foreground">{g.isAllStaff ? (g.canExportClips ? "Everyone can save clips from recordings." : "Off. Only groups that allow it can save clips.") : g.canExportClips ? "Members can save clips from recordings." : "Members can't save clips unless another of their groups allows it."}</p>
              </div></div>
              {!g.isAllStaff && <>
                <Row label="Name"><Input aria-label="Group name" defaultValue={g.name} className="max-w-xs" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && put(`/admin/groups/${g.id}`, { name: e.target.value.trim() }, "PATCH")} /><span className="flex-1" /><Button size="sm" variant="outline" className="text-destructive" onClick={() => confirm(`Delete "${g.name}"? Members will lose access to its cameras.`) && act(() => api(`/admin/groups/${g.id}`, { method: "DELETE" }))}>Delete</Button></Row>
                {claim && <div className="flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Sync from</span><div className="flex-1">
                  {seenValues.map((v) => <Pill key={v} on={g.providerValues.includes(v)} onChange={(on) => setValues(g, on ? [...g.providerValues, v] : g.providerValues.filter((x) => x !== v))}>{v}</Pill>)}
                  <form className="mt-1.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, v = String(new FormData(f).get("value") ?? "").trim(); if (v && !g.providerValues.includes(v)) void setValues(g, [...g.providerValues, v]).then(() => f.reset()); }}><Input name="value" placeholder={`Another "${claim}" value`} aria-label="Add a value to sync from" className="h-8 max-w-xs" /><Button size="sm" variant="outline"><Plus />Add</Button></form>
                  <p className="mt-1.5 text-xs text-muted-foreground">People whose <code>{claim}</code> claim includes a selected value join this group when they sign in, and leave it when the value goes away.</p>
                </div></div>}
                <div className="flex items-start gap-2"><span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Members</span><div className="flex-1">{staff.map((u) => member(g, u.id, nameOf(u)))}</div></div>
              </>}
            </Card>
          ))}
        </>
      )}

      {tab === "access" && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">People only see cameras checked here, for them or their group. New cameras stay hidden until you check them.</p>
          <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={`${TH} sticky left-0 bg-background`}>Camera</th>{subjects.map((s) => <th key={s.key} className={`${TH} text-center`}>{s.name}<div className="font-normal">{s.kind}</div></th>)}</tr></thead><tbody>
            {ov.cameras.map((c) => <tr key={c.id}><td className={`${TD} sticky left-0 bg-background whitespace-nowrap`}><i className={`mr-2 inline-block size-1.5 rounded-full align-middle ${c.missing ? "bg-zinc-400" : c.online ? "bg-green-500" : "bg-red-500"}`} />{c.name}</td>{subjects.map((s) => <td key={s.key} className={`${TD} text-center`}><Checkbox className="align-middle" checked={s.has(c.id)} aria-label={`${s.name}: ${c.name}`} onCheckedChange={(on) => put("/admin/grants", { ...s.body, cameraId: c.id, on: !!on })} /></td>)}</tr>)}
          </tbody></table></div>
        </>
      )}

      {tab === "tags" && (
        <>
          <form className="mb-3.5 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, n = String(new FormData(f).get("name") ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"); if (n) void put("/admin/tags", { name: n }, "POST").then(() => f.reset()); }}><Input name="name" placeholder="New tag" aria-label="New tag" className="max-w-xs" /><Button variant="outline"><Plus />Add tag</Button></form>
          <div className="mb-3.5 overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>Camera</th><th className={TH}>Tags</th></tr></thead><tbody>
            {ov.cameras.map((c) => <tr key={c.id}><td className={`${TD} whitespace-nowrap`}>{c.name}</td><td className={TD}>{ov.tags.map((t) => <Pill key={t.id} on={ov.cameraTags.some((x) => x.cameraId === c.id && x.tagId === t.id)} onChange={(on) => put("/admin/camera-tags", { cameraId: c.id, tagId: t.id, on })}>{t.name}</Pill>)}</td></tr>)}
          </tbody></table></div>
          <Card title="Rename or remove">{ov.tags.map((t) => <div key={`${t.id}:${t.name}`} className="my-2 flex items-center gap-2"><Input aria-label="Tag name" defaultValue={t.name} className="w-48" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && put(`/admin/tags/${t.id}`, { name: e.target.value.trim() }, "PATCH")} /><span className="text-sm text-muted-foreground">{((n) => `${n} camera${n === 1 ? "" : "s"}`)(ov.cameraTags.filter((x) => x.tagId === t.id).length)}</span><span className="flex-1" /><Button size="sm" variant="outline" className="text-destructive" onClick={() => confirm(`Remove "${t.name}"?`) && act(() => api(`/admin/tags/${t.id}`, { method: "DELETE" }))}>Remove</Button></div>)}</Card>
        </>
      )}

      {tab === "live" && (() => {
        const setting = (id: string) => ov.direct.cameras.find((d) => d.cameraId === id);
        // Cameras that can send video on their own, plus any switched on that no longer can (so it can be turned off).
        const cams = ov.cameras.filter((c) => ov.direct.capable.includes(c.id) || setting(c.id)?.enabled);
        const toggle = async (id: string, on: boolean) => { setChecking(id); await put(`/admin/cameras/${id}/direct`, { enabled: on }); setChecking(null); };
        const who = (id: string) => { const d = setting(id); return d?.username || d?.ownPassword ? `Its own login${d.username ? ` (${d.username})` : ""}` : ov.direct.defaultUsername ? `Default login (${ov.direct.defaultUsername})` : "No login yet"; };
        return (
          <>
            <p className="mb-3 text-sm text-muted-foreground">Live video normally comes through the recorder. If a camera&apos;s live video stutters, Unifeye can get it from the camera instead. Recordings always come from the recorder.</p>
            {!cams.length ? <p className="text-sm text-muted-foreground">None of your cameras can do this right now. Only some cameras can send video on their own; UniFi cameras always use the recorder.</p> : (
              <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>Camera</th><th className={TH}>From the camera</th><th className={TH}>Login</th><th className={TH} /></tr></thead><tbody>
                {cams.map((c) => (
                  <tr key={c.id}>
                    <td className={`${TD} whitespace-nowrap`}><i className={`mr-2 inline-block size-1.5 rounded-full align-middle ${c.missing ? "bg-zinc-400" : c.online ? "bg-green-500" : "bg-red-500"}`} />{c.name}</td>
                    <td className={TD}><span className="inline-flex items-center gap-2"><Switch aria-label={`Get ${c.name} from the camera`} checked={!!setting(c.id)?.enabled} disabled={checking === c.id} onCheckedChange={(on) => void toggle(c.id, on)} />{checking === c.id && <span className="text-xs text-muted-foreground">Checking the camera…</span>}</span></td>
                    <td className={`${TD} text-muted-foreground`}>{ov.direct.capable.includes(c.id) ? who(c.id) : "This camera can't send video on its own anymore, so the recorder is used."}</td>
                    <td className={`${TD} text-right`}>{ov.direct.capable.includes(c.id) && <Button size="sm" variant="outline" onClick={() => setLogin(c.id)}><KeyRound />Change login</Button>}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
            <p className="mt-3 text-sm text-muted-foreground">{ov.direct.defaultUsername ? `Cameras without their own login use "${ov.direct.defaultUsername}"${ov.direct.defaultPassword ? "" : " with no password"}. The default is set on the server.` : "There's no default login. Give each camera its own, or set a default on the server."}</p>
          </>
        );
      })()}

      {tab === "see" && (!chosen ? <p className="text-sm text-muted-foreground">No staff to view as.</p> : (
        <Card title="View as someone else" hint="See exactly what they see. Changes are turned off, and it ends automatically.">
          <Row label="Person"><Select aria-label="Person" value={chosen.id} onChange={(e) => setPick(e.target.value)}>{preview.map((u) => <option key={u.id} value={u.id}>{nameOf(u)}</option>)}</Select><Button onClick={() => seeAs(chosen.id)}><Eye />Start</Button></Row>
          <Row label="Starts on"><span className="text-sm">{chosen.landing.viewName ?? "All cameras"}</span><span className="text-sm text-muted-foreground">{landingReason(chosen.landing)}</span></Row>
          <Row label="Cameras"><span className="text-sm">{chosen.cameraCount}</span></Row>
        </Card>
      ))}

      {tab === "signin" && (
        <>
          <div className="overflow-hidden rounded-xl border">
            {([["oidc", `Work accounts (${ov.signIn.oidcName})`, "People join the first time they sign in."], ["local", "Passwords", "Only people you add here."], ["cloudflare", "Cloudflare Access", "People join the first time they open Unifeye through Cloudflare."]] as const).map(([k, title, hint]) => {
              const n = ov.users.filter((u) => u.signsInWith === k).length, on = ov.signIn[k];
              return (
                <div key={k} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0">
                  <div className="flex-1"><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{on ? hint : n ? `${n} ${n === 1 ? "person" : "people"} can't sign in until this is turned back on.` : "Not in use."}</div></div>
                  <span className={`flex items-center gap-1.5 text-xs ${on ? "" : "text-muted-foreground"}`}><i className={`size-1.5 rounded-full ${on ? "bg-green-500" : "bg-zinc-400"}`} />{on ? "On" : "Off"}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">These are set on the server. To change them, update its settings and restart Unifeye.</p>
        </>
      )}

      {tab === "history" && (
        <div className="overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className={TH}>When</th><th className={TH}>Who</th><th className={TH}>Viewing as</th><th className={TH}>What</th></tr></thead><tbody>
          {log.map((r) => <tr key={r.id}><td className={`${TD} whitespace-nowrap`}>{fmtDay(r.at, tz)}, {fmtTime(r.at, tz)}</td><td className={TD}>{r.actor}</td><td className={TD}>{r.previewSubject}</td><td className={TD}>{ACTION[r.action] ?? r.action}{r.outcome !== "ok" && <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">blocked</span>}</td></tr>)}
          {!log.length && <tr><td className={`${TD} text-muted-foreground`} colSpan={4}>Nothing yet.</td></tr>}
        </tbody></table></div>
      )}
      {adding && <AddPerson onClose={() => setAdding(false)} onAdded={(name, l) => { setAdding(false); setLink({ name, ...l }); void load(); }} />}
      {link && <LinkDialog {...link} onClose={() => setLink(null)} />}
      {login && ((c) => c && <CameraLogin name={c.name} cameraId={c.id} enabled={!!ov.direct.cameras.find((d) => d.cameraId === c.id)?.enabled} current={ov.direct.cameras.find((d) => d.cameraId === c.id)} defaultUsername={ov.direct.defaultUsername} canSavePassword={ov.direct.canSavePassword} onClose={() => setLogin(null)} onSaved={() => { setLogin(null); void load(); }} />)(ov.cameras.find((x) => x.id === login))}
    </Page>
  );
}

const METHOD = { oidc: "Work account", local: "Password", cloudflare: "Cloudflare" } as const;

function AddPerson({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string, link: { url: string; expiresAt: number }) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), name = String(f.get("name") ?? "").trim();
    setBusy(true); setError(null);
    try { const r = await api<{ link: { url: string; expiresAt: number } }>("/admin/users", { method: "POST", body: { name, username: f.get("username"), role: f.get("role") } }); onAdded(name, r.link); }
    catch (err) { setBusy(false); setError(err instanceof Error ? err.message : "Something went wrong. Try again."); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a person</DialogTitle><DialogDescription>They&apos;ll sign in with a username and password.</DialogDescription></DialogHeader>
        <form id="add-person" className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-1.5"><Label htmlFor="ap-name">Name</Label><Input id="ap-name" name="name" required maxLength={80} /></div>
          <div className="grid gap-1.5"><Label htmlFor="ap-username">Username</Label><Input id="ap-username" name="username" required autoCapitalize="none" spellCheck={false} maxLength={64} /></div>
          <div className="grid gap-1.5"><Label htmlFor="ap-role">Role</Label><Select id="ap-role" name="role" defaultValue="staff"><option value="staff">Staff</option><option value="admin">Admin</option></Select></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" form="add-person" disabled={busy}>{busy ? "Adding…" : "Add"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shown once. Only a hash of the link is kept, so it can't be shown again; a new one can always be made. */
function LinkDialog({ name, url, expiresAt, onClose }: { name: string; url: string; expiresAt: number; onClose: () => void }) {
  const { tz } = useApp();
  const copy = () => navigator.clipboard.writeText(url).then(() => toast.success("Link copied"), () => toast.error("Couldn't copy. Select the link and copy it."));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Send this link to {name}</DialogTitle><DialogDescription>They&apos;ll use it to choose a password. It works once and expires {fmtDay(expiresAt, tz)}, {fmtShort(expiresAt, tz)}.</DialogDescription></DialogHeader>
        <div className="flex gap-2"><Input readOnly value={url} aria-label="Password link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} /><Button variant="outline" onClick={copy}><Copy />Copy</Button></div>
        <p className="text-xs text-muted-foreground">You won&apos;t be able to see this link again. You can always make a new one.</p>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The camera's own login. The saved password is never shown; leaving the field empty keeps it. */
function CameraLogin({ name, cameraId, enabled, current, defaultUsername, canSavePassword, onClose, onSaved }: { name: string; cameraId: string; enabled: boolean; current?: { username: string | null; ownPassword: boolean }; defaultUsername: string | null; canSavePassword: boolean; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = !!(current?.username || current?.ownPassword);
  const save = async (body: { username: string | null; password?: string | null }) => {
    setBusy(true); setError(null);
    try { await api(`/admin/cameras/${cameraId}/direct`, { method: "PUT", body: { enabled, ...body } }); onSaved(); }
    catch (err) { setBusy(false); setError(err instanceof Error ? err.message : "Something went wrong. Try again."); }
  };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), password = String(f.get("password") ?? "");
    void save({ username: String(f.get("username") ?? "").trim() || null, ...(password ? { password } : {}) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Login for {name}</DialogTitle><DialogDescription>The username and password you use to sign in to the camera itself.{enabled && " Unifeye checks them with the camera before saving."}</DialogDescription></DialogHeader>
        <form id="camera-login" className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-1.5"><Label htmlFor="cl-username">Username</Label><Input id="cl-username" name="username" defaultValue={current?.username ?? ""} placeholder={defaultUsername ?? ""} autoCapitalize="none" spellCheck={false} maxLength={64} /></div>
          <div className="grid gap-1.5"><Label htmlFor="cl-password">Password</Label><Input id="cl-password" name="password" type="password" autoComplete="new-password" maxLength={128} disabled={!canSavePassword} placeholder={current?.ownPassword ? "Saved. Leave empty to keep it." : ""} /></div>
          {!canSavePassword && <p className="text-xs text-muted-foreground">Unifeye can&apos;t save camera passwords until TOKEN_ENC_KEY is set on the server. The default password is used instead.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          {own && <Button variant="outline" className="mr-auto" disabled={busy} onClick={() => void save({ username: null, password: null })}>Use the default</Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" form="camera-login" disabled={busy}>{busy ? (enabled ? "Checking…" : "Saving…") : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
