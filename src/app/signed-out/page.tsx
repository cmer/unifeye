import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { AuthBackdrop } from "@/ui/auth";

const MESSAGES: Record<string, string> = {
  not_admitted: "Your account doesn't have access yet. Ask an administrator.",
  login_failed: "Couldn't sign in. Try again.",
  sso_unavailable: "Sign-in is unavailable right now. Try again in a moment.",
  cloudflare_required: "Open Unifeye from its usual address, like your bookmark or the link you normally use.",
};

export default async function SignedOut({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <AuthBackdrop>
      <div className="text-center">
        <BrandMark className="mx-auto mb-5 size-11 rounded-xl" />
        <h1 className="text-xl font-semibold">Unifeye</h1>
        <p className="mt-2 text-sm text-muted-foreground">{(error && MESSAGES[error]) || "You're signed out."}</p>
        {/* A plain link on purpose: this API route decides where to sign in (identity provider, Cloudflare or the password page). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/login" className={buttonVariants({ className: "mt-6 h-10 w-full" })}>Sign in</a>
      </div>
    </AuthBackdrop>
  );
}
