/**
 * A throwaway OpenID Connect provider for local development and browser tests ONLY.
 * It is a separate process, never part of the Vantage app or its container image, and Vantage
 * refuses an http:// issuer when NODE_ENV=production, so it cannot become a production login.
 *
 *   pnpm exec tsx scripts/test-oidc-provider.ts        # listens on http://localhost:9911
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.TEST_OIDC_PORT ?? 9911), ISS = `http://localhost:${PORT}`, CLIENT = process.env.OIDC_CLIENT_ID ?? "vantage-dev", ORG = "org-dev";
const PEOPLE = [["dev-admin", "Avery Chen"], ["dev-upper", "Morgan Reyes"], ["dev-front", "Sam Okafor"], ["dev-security", "Jordan Blake"], ["dev-newhire", "Riley Park"]];
const codes = new Map<string, { sub: string; nonce: string; challenge: string }>();

const main = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256", use: "sig" };
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", ISS), json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/keys`, end_session_endpoint: `${ISS}/end_session`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/keys") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams, pick = q.get("login");
      if (!pick) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<body style="font:16px system-ui;max-width:420px;margin:60px auto"><h2>Test sign-in (development only)</h2><p>Pick a test identity:</p>${PEOPLE.map(([sub, name]) => `<p><a href="${url.pathname}?${q}&login=${sub}">${name}</a></p>`).join("")}</body>`);
      }
      const code = randomUUID();
      codes.set(code, { sub: pick, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "" });
      res.writeHead(302, { location: `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state") ?? "")}` });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token") return json(200, { access_token: randomUUID(), token_type: "Bearer", refresh_token: p.get("refresh_token") });
      const c = codes.get(p.get("code") ?? "");
      codes.delete(p.get("code") ?? "");
      if (!c || createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000), name = PEOPLE.find(([s]) => s === c.sub)?.[1] ?? c.sub;
      const id_token = await new SignJWT({ nonce: c.nonce, name, email: `${c.sub}@example.test`, sid: randomUUID(), "urn:zitadel:iam:user:resourceowner:id": ORG }).setProtectedHeader({ alg: "RS256", kid: "dev" }).setIssuer(ISS).setAudience(CLIENT).setSubject(c.sub).setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
      return json(200, { access_token: randomUUID(), token_type: "Bearer", refresh_token: `rt-${c.sub}`, id_token });
    }
    if (url.pathname === "/end_session") { res.writeHead(302, { location: url.searchParams.get("post_logout_redirect_uri") ?? "/" }); return res.end(); }
    json(404, {});
  }).listen(PORT, () => console.log(`test OIDC provider on ${ISS} (client ${CLIENT}, org ${ORG}, bootstrap subject dev-admin)`));
};
void main();
