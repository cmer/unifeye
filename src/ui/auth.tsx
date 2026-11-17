"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Pages a signed-out person sees. They talk to the sign-in routes directly; there is no session yet. */
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="grid h-full place-items-center overflow-auto p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark className="size-8 rounded-lg" />
          <span className="text-lg font-semibold">Unifeye</span>
        </div>
        <h1 className="mb-5 text-center text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { message: "Can't connect. Check your connection and try again." } };
  }
}
const message = (d: Record<string, unknown>) => (typeof d.message === "string" ? d.message : "Something went wrong. Try again.");
const Field = ({ id, label, ...p }: { id: string; label: string } & React.ComponentProps<"input">) => <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label><Input id={id} name={id} {...p} /></div>;

export function SignInForm({ oidcName, passwords, returnTo }: { oidcName: string | null; passwords: boolean; returnTo: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const oidcHref = `/api/auth/login?with=oidc&returnTo=${encodeURIComponent(returnTo)}`;
  // eslint-disable-next-line @next/next/no-html-link-for-pages -- an API redirect, not a page
  if (!passwords) return <a href="/api/auth/login" className={buttonVariants({ className: "w-full" })}>Sign in</a>;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    const r = await post("/auth/password", { username: f.get("username"), password: f.get("password"), returnTo });
    // A full load on purpose, so the app starts with the new session cookie.
    if (r.ok) return void location.assign(typeof r.data.redirect === "string" ? r.data.redirect : "/");
    setBusy(false); setError(message(r.data));
  };
  return (
    <div className="grid gap-4">
      {oidcName && (
        <>
          {/* A plain link: this is an API redirect to the identity provider, not a page route. */}
          <a href={oidcHref} className={buttonVariants({ className: "w-full" })}>Continue with {oidcName}</a>
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or use a password<span className="h-px flex-1 bg-border" /></div>
        </>
      )}
      <form className="grid gap-3" onSubmit={submit}>
        <Field id="username" label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required aria-invalid={!!error} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" variant={oidcName ? "outline" : "default"} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask an administrator.</p>
    </div>
  );
}

/** Opened from a one-time link. The secret is in the address's #fragment, so it never reaches server logs. */
export function SetPasswordForm() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<{ username: string; firstTime: boolean } | "gone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = location.hash.slice(1);
    history.replaceState(null, "", location.pathname); // keep the secret out of history and bookmarks
    /* eslint-disable react-hooks/set-state-in-effect -- the secret is only readable in the browser, once */
    if (!t) return void setInfo("gone");
    setToken(t);
    /* eslint-enable react-hooks/set-state-in-effect */
    void post("/auth/password-link/check", { token: t }).then((r) => setInfo(r.ok ? (r.data as { username: string; firstTime: boolean }) : "gone"));
  }, []);
  if (!info) return <AuthShell title="Choose a password"><p className="text-center text-sm text-muted-foreground">Loading…</p></AuthShell>;
  if (info === "gone") return (
    <AuthShell title="This link has expired">
      <p className="mb-5 text-center text-sm text-muted-foreground">Each link works once, for 24 hours. Ask an administrator to send you a new one.</p>
      <Link href="/sign-in" className={buttonVariants({ variant: "outline", className: "w-full" })}>Go to sign in</Link>
    </AuthShell>
  );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), password = String(f.get("password") ?? "");
    if (password !== f.get("again")) return setError("The passwords don't match.");
    setBusy(true); setError(null);
    const r = await post("/auth/password-link", { token, password });
    if (r.ok) return void location.assign("/");
    setBusy(false);
    if (r.data.error === "link_expired") setInfo("gone"); else setError(message(r.data));
  };
  return (
    <AuthShell title={info.firstTime ? "Choose a password" : "Choose a new password"}>
      <p className="-mt-3 mb-5 text-center text-sm text-muted-foreground">Signing in as <b className="text-foreground">{info.username}</b></p>
      <form className="grid gap-3" onSubmit={submit}>
        <input type="text" name="username" autoComplete="username" value={info.username} readOnly hidden />
        <Field id="password" label="New password" type="password" autoComplete="new-password" minLength={10} required />
        <Field id="again" label="Type it again" type="password" autoComplete="new-password" required />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save and sign in"}</Button>
      </form>
      <p className="mt-4 text-center text-xs text-muted-foreground">Use at least 10 characters. A short phrase works well.</p>
    </AuthShell>
  );
}
