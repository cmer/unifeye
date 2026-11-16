<img src="assets/icon.svg" width="64" height="64" alt="">

# Unifeye

A read-only viewer for UniFi Protect cameras on a UNVR Pro. Administrators organize cameras with
tags, build saved views, decide who sees which camera and share views with people and groups.
Staff sign in through your OpenID Connect provider and land on the cameras relevant to their job.

Unifeye never changes anything on the recorder: no camera settings, recordings, retention, events
or Protect users.

| | |
| --- | --- |
| Stack | Node.js, TypeScript, Next.js 16, React 19, shadcn/ui, SQLite + Drizzle, MediaMTX |
| Sign-in | OpenID Connect only, with any standards-compliant provider. No local accounts or passwords exist. |
| Deployment | One Docker Compose stack: the app and MediaMTX, SQLite on a volume |

## Where things are

- [docs/architecture.md](docs/architecture.md): how it fits together, the permission model, view and landing rules, media enforcement.
- [docs/deployment.md](docs/deployment.md): where to run it, registering Unifeye with your identity provider, configuration reference, networking, backups, restore, upgrades.
- [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md): running behind Cloudflare Tunnel, and what that means for live video.
- [docs/identity-providers.md](docs/identity-providers.md): step-by-step sign-in setup for Zitadel, Keycloak, Microsoft Entra ID and Google Workspace.
- [docs/verification.md](docs/verification.md): what has been verified and what has not, tested versions, and the steps to check a real UNVR and a real identity provider.
- [prototype/protect-viewer-mockup.html](prototype/protect-viewer-mockup.html): the standalone clickable prototype. Open it in a browser; everything in it is simulated.

## Status

Automated tests cover permissions, views, sign-in, preview, media tickets, migrations and backups
against a mock recorder and an isolated test identity provider. Live video, the HLS fallback and
revocation of a playing stream were also exercised against a real MediaMTX 1.21.4 process.

**Not yet verified: a real UNVR, a real identity provider, and the Docker image and Compose stack.**
See [docs/verification.md](docs/verification.md) before relying on this in production.

## Run it locally with simulated cameras

Needs Node.js 22.20 or newer, pnpm, FFmpeg, and a MediaMTX 1.21.4 binary for live video.

```sh
pnpm install
cp .env.development.example .env.development.local

pnpm dev:idp        # terminal 1: throwaway test sign-in provider on :9911 (development only)
pnpm dev            # terminal 2: the app on http://localhost:3000

# terminal 3, for live video: MediaMTX with the project's configuration
MTX_AUTHHTTPADDRESS="http://127.0.0.1:3001/mediamtx-auth?secret=dev-hook" \
MTX_WEBRTCADDITIONALHOSTS=127.0.0.1 mediamtx docker/mediamtx.yml
```

Open http://localhost:3000 and pick "Avery Chen" (the bootstrap administrator). Demo tags, groups
and views are created on that first sign-in. Sign in as the other test identities to see staff
access; they start with no cameras until you add them to a group in Admin.

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Develop | `pnpm dev` |
| Test | `pnpm test` |
| Type-check, lint | `pnpm typecheck`, `pnpm lint` |
| Production build | `pnpm build` |
| New migration after a schema change | `pnpm db:generate` |
| Apply migrations | `pnpm unifeye migrate` (container: `node cli.mjs migrate`) |
| Back up now | `pnpm unifeye backup` |
| Check a backup | `pnpm unifeye verify <file>` |
| Restore | `pnpm unifeye restore <file> [--force]` |
| Deploy | `docker compose up -d` (see [docs/deployment.md](docs/deployment.md)) |
