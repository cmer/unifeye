import { App } from "@/ui/app";

export const dynamic = "force-dynamic";

/** The shell carries no data. Everything it shows comes from the API, which enforces permissions. */
export default function Page() {
  return <App />;
}
