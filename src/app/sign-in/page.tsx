import { safeReturnTo } from "@/server/auth/oidc";
import { config, emailCodesOn, signInMethods } from "@/server/config";
import { AuthShell, SignInForm } from "@/ui/auth";

export const dynamic = "force-dynamic";

/** Shown only when passwords are on; otherwise sign-in goes straight to the identity provider or Cloudflare. */
export default async function SignIn({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams, m = signInMethods();
  return (
    <AuthShell title="Sign in">
      <SignInForm oidcName={m.oidc ? config().OIDC_DISPLAY_NAME : null} passwords={m.local} emailCodes={emailCodesOn()} returnTo={safeReturnTo(returnTo)} />
    </AuthShell>
  );
}
