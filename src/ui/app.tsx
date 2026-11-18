"use client";
import { Bell, Camera as CameraIcon, KeyRound, LayoutGrid, ListChecks, LogOut, Moon, PanelLeft, ShieldCheck, Star, Sun, Eye, WifiOff } from "lucide-react";
import { useTheme } from "next-themes";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Activity } from "./activity";
import { Admin } from "./admin";
import { api, ApiError, localZone, setCsrf, setPreviewToken, type Me } from "./api";
import { ManageViews } from "./manage-views";
import { Player } from "./player";
import { Wall } from "./wall";

interface Loc { path: string; query: URLSearchParams }
interface Ctx { me: Me; reload: () => Promise<void>; loc: Loc; nav: (to: string, replace?: boolean) => void; tz: string; setPref: (key: string, value: unknown) => void }
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;
const NONE: ReadonlySet<string> = new Set();
/** Cameras recording right now. Administrators only: everyone else (and any preview) gets an empty set and asks nothing. */
export function useRecording(): ReadonlySet<string> {
  const { me } = useApp();
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!me.isAdmin) return;
    let off = false;
    const load = () => api<{ cameraIds: string[] }>("/recording").then((r) => { if (!off) setIds(new Set(r.cameraIds)); }).catch(() => { if (!off) setIds(NONE); });
    load();
    const t = setInterval(load, 5000);
    return () => { off = true; clearInterval(t); };
  }, [me.isAdmin]);
  return me.isAdmin ? ids : NONE;
}
/** The small "REC" mark shown to administrators on a camera that is recording. */
export const RecMark = ({ className = "" }: { className?: string }) => <span className={`flex items-center gap-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-white ${className}`} title="Recording now"><i className="size-1.5 rounded-full bg-red-500" />REC</span>;
export const fail = (e: unknown) => { if (!(e instanceof ApiError && e.status === 401)) toast.error(e instanceof Error ? e.message : "Something went wrong"); };
const here = (): Loc => ({ path: location.pathname, query: new URLSearchParams(location.search) });

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loc, setLoc] = useState<Loc | null>(null);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});

  const reload = useCallback(async () => {
    const m = await api<Me>("/me");
    setCsrf(m.csrf);
    setMe(m);
    setPrefs((p) => ({ ...m.preferences, ...p }));
  }, []);
  const nav = useCallback((to: string, replace = false) => { history[replace ? "replaceState" : "pushState"](null, "", to); setLoc(here()); }, []);
  useEffect(() => {
    // Browser-only values (address, saved sidebar state) are read once after hydration.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoc(here());
    setOpen(localStorage.getItem("unifeye.sidebar") === "1");
    /* eslint-enable react-hooks/set-state-in-effect */
    const pop = () => setLoc(here());
    addEventListener("popstate", pop);
    reload().catch(fail);
    const t = setInterval(() => reload().catch(() => {}), 30_000); // picks up permission and recorder changes
    return () => { removeEventListener("popstate", pop); clearInterval(t); };
  }, [reload]);
  // Opening the app lands on the view chosen for this person.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-off redirect to the landing view
  useEffect(() => { if (me && loc?.path === "/" && me.landing.viewId && !loc.query.has("all")) nav(`/view/${me.landing.viewId}`, true); }, [me, loc, nav]);

  const setPref = useCallback((key: string, value: unknown) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    if (!me?.preview) api("/preferences", { method: "PUT", body: { key, value } }).catch(() => {}); // a preview never writes the subject's preferences
  }, [me?.preview]);
  const ctx = useMemo(() => (me && loc ? { me: { ...me, preferences: prefs }, reload, loc, nav, setPref, tz: typeof prefs.tz === "string" && prefs.tz !== "local" ? prefs.tz : localZone() } : null), [me, loc, prefs, reload, nav, setPref]);
  if (!ctx) return <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading…</div>;

  const { path } = ctx.loc, seg = path.split("/").filter(Boolean);
  const page = seg[0] === "camera" && seg[1] ? <Player key={seg[1]} cameraId={seg[1]} />
    : seg[0] === "activity" ? <Activity />
    : seg[0] === "views" ? <ManageViews />
    : seg[0] === "admin" && ctx.me.isAdmin ? <Admin />
    : <Wall key={seg[1] ?? "all"} viewId={seg[0] === "view" ? seg[1] : undefined} />;
  return (
    <AppCtx.Provider value={ctx}>
      <SidebarProvider open={open} onOpenChange={(o) => { setOpen(o); localStorage.setItem("unifeye.sidebar", o ? "1" : "0"); }}>
        <AppSidebar />
        <SidebarInset className="relative flex h-svh min-w-0 flex-col overflow-hidden">
          {ctx.me.preview && (
            <div className="flex shrink-0 items-center gap-3 border-b bg-muted px-4 py-2 text-sm">
              <Eye className="size-4 shrink-0" />
              <span>Viewing as <b>{ctx.me.preview.subject.name}</b>. Changes are turned off.</span>
              <Button size="sm" variant="outline" className="ml-auto" onClick={async () => { await api("/preview", { method: "DELETE" }).catch(() => {}); setPreviewToken(null); location.assign("/admin"); }}>Exit</Button>
            </div>
          )}
          {ctx.me.recorder === "down" && (
            <div className="flex shrink-0 items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
              <WifiOff className="size-4 shrink-0" /><span><b>Can&apos;t reach the recorder.</b> Video and activity are unavailable right now.</span>
            </div>
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">{page}</div>
        </SidebarInset>
      </SidebarProvider>
    </AppCtx.Provider>
  );
}

function AppSidebar() {
  const { me, loc, nav } = useApp();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { isMobile, setOpenMobile } = useSidebar();
  const [pw, setPw] = useState(false);
  const go = (to: string) => { nav(to); if (isMobile) setOpenMobile(false); };
  const at = (p: string) => loc.path === p || loc.path.startsWith(p + "/");
  void theme;
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <BrandMark className="size-7 rounded-md" />
          <span className="font-semibold">Unifeye</span>
          {me.mode === "mock" && <span className="ml-auto rounded-full border px-2 py-0.5 text-xs text-muted-foreground" title="Cameras, recordings and activity are simulated">Demo cameras</span>}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Cameras</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive={loc.path === "/"} onClick={() => go("/?all")}><CameraIcon /><span>All cameras</span></SidebarMenuButton></SidebarMenuItem>
              {me.views.map((v) => (
                <SidebarMenuItem key={v.id}>
                  <SidebarMenuButton isActive={loc.path === `/view/${v.id}`} onClick={() => go(`/view/${v.id}`)}>
                    <LayoutGrid /><span>{v.name}</span>
                    {me.landing.viewId === v.id && <Star className="ml-auto !size-3.5 fill-amber-400 text-amber-400" aria-label="Opens when you sign in" />}
                  </SidebarMenuButton>
                  {me.landing.viewId !== v.id && <SidebarMenuBadge>{v.count}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Browse</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive={at("/activity")} onClick={() => go("/activity")}><Bell /><span>Activity</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton isActive={at("/views")} onClick={() => go("/views")}><ListChecks /><span>Manage views</span></SidebarMenuButton></SidebarMenuItem>
              {me.isAdmin && <SidebarMenuItem><SidebarMenuButton isActive={at("/admin")} onClick={() => go("/admin")}><ShieldCheck /><span>Admin</span></SidebarMenuButton></SidebarMenuItem>}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{me.user.name.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{me.user.name}</span>
          {me.user.hasPassword && !me.preview && <Button variant="ghost" size="icon" aria-label="Change password" title="Change password" onClick={() => setPw(true)}><KeyRound /></Button>}
          <Button variant="ghost" size="icon" aria-label="Switch between light and dark" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? <Sun /> : <Moon />}</Button>
          <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={async () => { try { setPreviewToken(null); const r = await api<{ redirect: string }>("/auth/logout", { method: "POST" }); location.assign(r.redirect); } catch (e) { fail(e); } }}><LogOut /></Button>
        </div>
      </SidebarFooter>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </Sidebar>
  );
}

/** For people who sign in with a password. Their other devices are signed out afterwards. */
function ChangePassword({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), next = String(f.get("next") ?? "");
    if (next !== f.get("again")) return setError("The new passwords don't match.");
    setBusy(true); setError(null);
    try { await api("/me/password", { method: "POST", body: { current: f.get("current"), next } }); toast.success("Password changed. Your other devices are signed out."); onClose(); }
    catch (err) { setBusy(false); setError(err instanceof Error ? err.message : "Something went wrong. Try again."); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Change password</DialogTitle><DialogDescription>Use at least 10 characters. A short phrase works well.</DialogDescription></DialogHeader>
        <form id="change-password" className="grid gap-3" onSubmit={submit}>
          {[["current", "Current password", "current-password"], ["next", "New password", "new-password"], ["again", "Type it again", "new-password"]].map(([id, label, ac]) => <div key={id} className="grid gap-1.5"><Label htmlFor={id}>{label}</Label><Input id={id} name={id} type="password" autoComplete={ac} required /></div>)}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" form="change-password" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Button that shows the sidebar when it is hidden. Rendered by pages in their own header or dock. */
export function SidebarOpener({ className = "" }: { className?: string }) {
  const { open, toggleSidebar, isMobile } = useSidebar();
  if (open && !isMobile) return null;
  return <Button variant="ghost" size="icon" className={className} aria-label="Show sidebar" onClick={toggleSidebar}><PanelLeft /></Button>;
}
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="mb-4 flex min-h-9 flex-wrap items-center gap-2"><SidebarOpener className="-ml-2" /><h1 className="text-xl font-semibold">{title}</h1><span className="flex-1" />{children}</div>;
}
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto"><div className="mx-auto w-full max-w-6xl px-4 pt-4 pb-24 sm:px-6">{children}</div></div>;
}
export function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="m-auto max-w-sm px-4 py-16 text-center text-sm text-muted-foreground [&_svg]:mx-auto [&_svg]:size-7"><div>{icon}</div><h3 className="mt-3 mb-1 text-base font-semibold text-foreground">{title}</h3>{children}</div>;
}
/** A native select styled like the other inputs: reliable on phones and with keyboards. */
export function Select({ className = "", ...p }: React.ComponentProps<"select">) {
  return <select {...p} className={`select-chevron h-9 max-w-full rounded-lg border border-input bg-background pr-8 pl-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 ${className}`} />;
}
