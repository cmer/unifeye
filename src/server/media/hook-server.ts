import { createServer, type Server } from "node:http";
import type { HookBody, Media } from "./gateway";
import { log } from "../util";

export const HOOK_PATH = "/mediamtx-auth";
const MAX_BODY = 64 * 1024;

/**
 * The listener MediaMTX calls for every reader, publisher and API action (`authHTTPAddress`).
 *
 * It is a separate port from the web app on purpose. The web port sits behind whatever reverse
 * proxy or tunnel the deployment uses; this one is never published or proxied, so the hook is not
 * reachable from the internet whatever is in front of Unifeye. The shared secret is still checked
 * (by `Media.hook`), so a process on the same network cannot use it either.
 *
 * Only `POST /mediamtx-auth` exists. Anything else is a 404; a refused or malformed call is a 401,
 * which MediaMTX treats as a denial.
 */
export function startHookServer(media: Pick<Media, "hook">, opts: { host: string; port: number }): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hook");
    if (req.method !== "POST" || url.pathname !== HOOK_PATH) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      let body: HookBody = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* denied below */ }
      let ok = false;
      try { ok = typeof body === "object" && body !== null && media.hook(url.searchParams.get("secret"), body); } catch (e) { log("error", "media hook failed", { error: e }); }
      res.writeHead(ok ? 200 : 401).end();
    });
    req.on("error", () => { if (!res.headersSent) res.writeHead(400).end(); });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(server); });
  });
}
