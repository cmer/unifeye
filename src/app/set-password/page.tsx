import { SetPasswordForm } from "@/ui/auth";

export const dynamic = "force-dynamic";

/** Opened from a one-time password link. The link's secret stays in the #fragment and is read in the browser. */
export default function SetPassword() {
  return <SetPasswordForm />;
}
