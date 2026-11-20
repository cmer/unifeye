"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Muted colours for the blurred tiles behind the sign-in card: a hint of a camera wall, nothing recognisable. */
const WALL = ["0.055 160", "0.07 260", "0.07 70", "0.04 200", "0.055 160", "0.055 40", "0.07 260", "0.04 120", "0.055 220", "0.07 70", "0.055 260", "0.07 160", "0.055 30", "0.055 200", "0.04 100", "0.07 260", "0.055 160", "0.07 60", "0.04 220", "0.055 140"];

/**
 * The frame for every signed-out page: a frosted card over a blurred wall of camera tiles.
 * It follows the light or dark appearance like the rest of the app; the tiles take their lightness from it.
 */
export function AuthBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative isolate grid h-full place-items-center overflow-auto bg-background p-6">
      <div aria-hidden className="pointer-events-none fixed -inset-10 -z-10 grid grid-cols-4 gap-2 opacity-60 blur-2xl [--wall-from:0.93] [--wall-to:0.82] sm:grid-cols-5 dark:opacity-80 dark:[--wall-from:0.5] dark:[--wall-to:0.26]">
        {WALL.map((c, i) => <div key={i} style={{ background: `linear-gradient(150deg, oklch(var(--wall-from) ${c}), oklch(var(--wall-to) ${c}))` }} />)}
      </div>
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,transparent_30%,var(--background)_95%)]" />
      <div className="w-full max-w-sm rounded-2xl border bg-card/70 p-8 shadow-2xl shadow-black/10 backdrop-blur-xl max-sm:px-6 dark:shadow-black/50">{children}</div>
    </main>
  );
}

/** Pages a signed-out person sees. They talk to the sign-in routes directly; there is no session yet. */
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AuthBackdrop>
      <div className="flex items-center gap-2.5">
        <BrandMark className="size-9 rounded-[10px]" />
        <span className="text-lg font-semibold tracking-tight">Unifeye</span>
      </div>
      <h1 className="mt-7 mb-6 text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </AuthBackdrop>
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
const Field = ({ id, label, ...p }: { id: string; label: string } & React.ComponentProps<"input">) => <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label><Input id={id} name={id} className="h-10" {...p} /></div>;

/** The username last signed in with a code on this device (a shared front-desk computer), to fill in step one. */
const REMEMBER = "unifeye.sign-in";
const recall = () => { try { return (JSON.parse(localStorage.getItem(REMEMBER) ?? "{}") as { username?: string }).username ?? ""; } catch { return ""; } };
const remember = (username: string) => { try { localStorage.setItem(REMEMBER, JSON.stringify({ username })); } catch { /* private mode: nothing to remember */ } };
const RESEND_SECONDS = 60;
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Two steps: the username, then what that account needs. Accounts that sign in only by email code
 * get a code straight away; every other username, real or not, gets the same password step, which
 * offers a code instead when email is set up.
 */
export function SignInForm({ oidcName, passwords, emailCodes, ssoEmails = false, returnTo }: { oidcName: string | null; passwords: boolean; emailCodes: boolean; ssoEmails?: boolean; returnTo: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [step, setStep] = useState<"username" | "password" | "code">("username");
  /** Where Back goes from the code step. */
  const [from, setFrom] = useState<"username" | "password">("username");
  const [wait, setWait] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount; the server can't see this device's storage
    if (emailCodes) setUsername(recall());
  }, [emailCodes]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const oidcHref = `/api/auth/login?with=oidc&returnTo=${encodeURIComponent(returnTo)}`;
  // eslint-disable-next-line @next/next/no-html-link-for-pages -- an API redirect, not a page
  if (!passwords) return <a href="/api/auth/login" className={buttonVariants({ className: "h-10 w-full" })}>Sign in</a>;
  const go = (to: typeof step) => { setStep(to); setError(null); };
  const done = (r: { data: Record<string, unknown> }) => location.assign(typeof r.data.redirect === "string" ? r.data.redirect : "/"); // a full load, so the app starts with the new session cookie

  const next = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await post("/auth/start", { username, timeZone: timeZone() });
    // An address at a domain that signs in with the identity provider: straight there, address filled in.
    if (r.ok && r.data.next === "sso") return void location.assign(`${oidcHref}&hint=${encodeURIComponent(username.trim())}`);
    setBusy(false);
    if (!r.ok) return setError(message(r.data));
    if (r.data.next === "code") { setFrom("username"); setWait(RESEND_SECONDS); go("code"); } else go("password");
  };
  const signInPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await post("/auth/password", { username, password: new FormData(e.currentTarget).get("password"), returnTo });
    if (r.ok) return void done(r);
    setBusy(false); setError(message(r.data));
  };
  const sendCode = async (back: "username" | "password") => {
    setBusy(true); setError(null);
    const r = await post("/auth/email", { username, timeZone: timeZone() });
    setBusy(false);
    if (!r.ok) return setError(message(r.data));
    setFrom(back); setWait(RESEND_SECONDS); go("code");
  };
  const signInCode = async (code: string) => {
    setBusy(true); setError(null);
    const r = await post("/auth/email/verify", { code, returnTo });
    if (r.ok) { remember(username.trim()); return void done(r); }
    setBusy(false); setError(message(r.data));
  };
  const who = (
    <p className="-mt-4 text-sm text-muted-foreground">
      <b className="text-foreground">{username.trim()}</b>{" · "}<Button variant="link" size="sm" className="h-auto p-0 align-baseline text-sm" onClick={() => go("username")}>Not you?</Button>
    </p>
  );
  const err = error && <p role="alert" className="text-sm text-destructive">{error}</p>;

  if (step === "code") return (
    <div className="grid gap-5">
      <p className="-mt-4 text-sm text-muted-foreground">We emailed a 6-digit code for <b className="text-foreground">{username.trim()}</b>. If the email goes to someone else, ask them for the code.</p>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void signInCode(String(new FormData(e.currentTarget).get("code") ?? "")); }}>
        <Label htmlFor="code" className="sr-only">Code</Label>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="000 000" autoFocus required aria-invalid={!!error}
          className="h-12 text-center font-mono text-2xl tracking-[0.3em]"
          onChange={(e) => { const d = e.currentTarget.value.replace(/\D/g, ""); if (d.length === 6 && !busy) void signInCode(d); }} />
        {err}
        <Button type="submit" className="h-10" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="flex items-center justify-center gap-3 text-sm">
        <Button variant="link" size="sm" className="h-auto p-0" disabled={busy || wait > 0} onClick={() => void sendCode(from)}>Send a new code{wait > 0 && ` (0:${String(wait).padStart(2, "0")})`}</Button>
        <span className="text-muted-foreground">·</span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => go(from)}>Back</Button>
      </div>
    </div>
  );

  if (step === "password") return (
    <div className="grid gap-5">
      {who}
      <form className="grid gap-4" onSubmit={signInPassword}>
        {/* For password managers: the username this password belongs to. */}
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
        <Field id="password" label="Password" type="password" autoComplete="current-password" autoFocus required aria-invalid={!!error} />
        {err}
        <Button type="submit" className="h-10" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      {emailCodes && <Button variant="link" size="sm" className="h-auto justify-self-center p-0" disabled={busy} onClick={() => void sendCode("password")}>Email a code instead</Button>}
      <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask an administrator.</p>
    </div>
  );

  return (
    <div className="grid gap-5">
      {oidcName && (
        <>
          {/* A plain link: this is an API redirect to the identity provider, not a page route. */}
          <a href={oidcHref} className={buttonVariants({ className: "h-10 w-full" })}>Continue with {oidcName}</a>
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
        </>
      )}
      <form className="grid gap-4" onSubmit={next}>
        <Field id="username" label={ssoEmails ? "Email or username" : "Username"} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!oidcName} required value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        {err}
        <Button type="submit" className="h-10" variant={oidcName ? "outline" : "default"} disabled={busy}>{busy ? "One moment…" : "Continue"}</Button>
      </form>
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
  if (!info) return <AuthShell title="Choose a password"><p className="text-sm text-muted-foreground">Loading…</p></AuthShell>;
  if (info === "gone") return (
    <AuthShell title="This link has expired">
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">Each link works once, for 24 hours. Ask an administrator to send you a new one.</p>
      <Link href="/sign-in" className={buttonVariants({ variant: "outline", className: "h-10 w-full" })}>Go to sign in</Link>
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
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">Signing in as <b className="text-foreground">{info.username}</b></p>
      <form className="grid gap-4" onSubmit={submit}>
        <input type="text" name="username" autoComplete="username" value={info.username} readOnly hidden />
        <Field id="password" label="New password" type="password" autoComplete="new-password" minLength={10} required />
        <Field id="again" label="Type it again" type="password" autoComplete="new-password" required />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-10" disabled={busy}>{busy ? "Saving…" : "Save and sign in"}</Button>
      </form>
      <p className="mt-4 text-center text-xs text-muted-foreground">Use at least 10 characters. A short phrase works well.</p>
    </AuthShell>
  );
}
