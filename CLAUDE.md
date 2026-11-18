# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

Unifeye is a read-only viewer for UniFi Protect cameras. Staff sign in through OIDC, Cloudflare Access or administrator-issued password accounts (`SIGN_IN_METHODS`; passwords are off by default), administrators grant cameras, tag them and build shared views. Unifeye must never write to the recorder: no camera settings, recordings, events or Protect users. Enabling an RTSP stream on a camera counts as a write and is out of bounds.

`docs/architecture.md` is the authoritative description of the permission model, standing access, views, sign-in and media enforcement. Read the relevant section before changing any of those areas, and update it when behaviour changes. `docs/verification.md` records what has and has not been verified; keep it honest when adding tests or checking against real hardware.

## Commands

Package manager is pnpm; Node 22.20 or newer.

| Task | Command |
| --- | --- |
| Dev server | `pnpm dev` |
| Test sign-in provider on :9911 (needed to sign in locally) | `pnpm dev:idp` |
| All tests | `pnpm test` |
| One test file | `pnpm test tests/policy.test.ts` |
| One test by name | `pnpm test -t "part of the test name"` |
| Type-check | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Production build (Next standalone plus the bundled CLI) | `pnpm build` |
| Generate a migration after editing `src/server/db/schema.ts` | `pnpm db:generate` |
| Release a version (`major`, `minor`, `patch` or `X.Y.Z`; `--dry-run` to preview) | `scripts/release.sh <version>` |
| Ops CLI: `migrate`, `backup`, `verify <file>`, `restore <file> [--force]` | `pnpm unifeye <command>` |

Local setup: `cp .env.development.example .env.development.local`, then run `pnpm dev:idp` and `pnpm dev` in separate terminals. Sign in as "Avery Chen", the bootstrap administrator; demo data is seeded on that first sign-in. Live video also needs FFmpeg and a MediaMTX 1.21.4 binary started with `docker/mediamtx.yml` (the exact command is in `README.md`).

The `qa-sweep` skill in `.claude/skills/` brings up the whole stack and runs a browser test checklist. The `release` skill tags and publishes a version with `scripts/release.sh`.

## Architecture

### Next.js is only a shell

There are two real routes:

- `src/app/[[...slug]]/page.tsx` renders the client app in `src/ui/`. It carries no data. Routing is client-side inside `src/ui/app.tsx` (`loc` / `nav` from `useApp()`), not the App Router.
- `src/app/api/[...path]/route.ts` forwards every method to `handleApi` in `src/server/api.ts`.

`src/server/api.ts` holds a hand-rolled router: every endpoint is a `route(method, path, opts, handler)` call in that one file. `handleApi` does authentication, CSRF, rate limiting, the admin gate and error mapping, so handlers stay thin. New endpoints go there, not in new `route.ts` files. The UI calls them through `api()` in `src/ui/api.ts`, which adds the CSRF and preview headers.

Errors are matched by shape (`status` + `code`), not `instanceof`, because the server bundles these modules more than once. For the same reason, process-wide singletons (`services()`, `db()`) live on `globalThis`.

### Services

`buildServices(db, adapter, relay)` in `src/server/services.ts` wires everything around one SQLite connection, one `ProtectAdapter` and one `Relay`. `services()` returns the process singleton. `startRuntime()` runs once from `src/instrumentation.ts`: migrations first (a failure aborts start-up), then camera sync and the background timers (revocation sweep, identity re-validation, housekeeping, daily backup).

Two seams have a real and a fake implementation:

- `ProtectAdapter` (`src/server/protect/types.ts`): `unifi.ts` for a real UNVR, `mock.ts` for simulated cameras. `UNIFEYE_MODE` (`mock` by default) picks one.
- `Relay` (`src/server/media/relay.ts`): `mediamtx.ts` is the only file that knows MediaMTX's URLs and conventions; `src/server/testing/relay.ts` is the in-memory one used by tests.

### Authorization invariants

These are the rules most likely to be broken by an innocent-looking change:

- `Policy` (`src/server/authz/policy.ts`) is the only place that decides who sees which camera. Deny by default; grants are allow-only; tags and view sharing never grant a camera. It caches in memory, so anything that changes users, groups, grants, tags, views or the camera inventory must call `policy.invalidate()`.
- A forbidden camera must be indistinguishable from a missing one (same 404, same body) on every route, including media, events and exports. Counts and "has more" flags reflect authorized cameras only.
- All changes to Unifeye data go through `Admin` (`src/server/admin.ts`): validation, transaction, audit entry, cache invalidation.
- Anything that outlives its request (live streams, WHEP sessions, HLS state, clip exports, the event feed) keeps a grant record, and `Access` (`src/server/authz/access.ts`) is the only place that decides whether it still holds. `Access` also owns the single "access may have changed" signal; holders subscribe to it rather than to `Policy`, `Sessions` or `Previews` directly.
- The actor is built from the server-side session only. Nothing the client sends about identity, role or camera lists is trusted.
- "See as staff" (preview): the administrator stays the actor, reads use the subject's permissions, every write and admin route is refused, and an invalid preview token fails the request rather than falling back to administrator access.
- Identity is the exact `(issuer, subject)` pair. Email is display only and never used to find or link a profile.

### Media

The browser never talks to MediaMTX for authorization. A Unifeye route checks the camera, then issues a short-lived ticket; MediaMTX calls back for every reader on a separate internal port (`HOOK_PORT`, 3001, served by `src/server/media/hook-server.ts`, never published or proxied). `authorizeHook` in `mediamtx.ts` answers MediaMTX's own traffic and hands each viewer to the gateway (`Media.admit` in `src/server/media/gateway.ts`), which decides. Keep MediaMTX names (usernames, `_src` paths, hook fields) out of the gateway. HLS is proxied entirely through Unifeye so each playlist and segment is re-authorized. The gateway sweeps admitted readers on every access signal and on a timer, and kicks any reader it does not know. After a restart it kicks everyone (fail closed).

### Database

SQLite through Drizzle and better-sqlite3, one connection, WAL mode. Schema is `src/server/db/schema.ts`; migrations are checked-in SQL in `drizzle/`, applied by `runMigrations` at start-up with a backup taken first. Never use schema push. After a schema change, run `pnpm db:generate` and commit the generated SQL and snapshot.

### Configuration

All environment variables are declared and validated in `src/server/config.ts` (zod), with stricter rules when `NODE_ENV=production`. Add new settings there and read them through `config()`, not `process.env`.

### UI

React 19 client components in `src/ui/`, shadcn/ui primitives in `src/components/ui/` (built on `@base-ui/react`), Tailwind 4, `next-themes` for dark and light.

### Writing user-facing copy

People who use Unifeye are not technical. Write every label, message, error and empty state the way Apple writes its interface text:

- Keep it short. One idea per sentence; cut any word the reader doesn't need.
- Use plain, everyday words. No jargon or internal terms: say "recorder", never "UNVR", "RTSP", "WHEP", "HLS", "OIDC", "ticket" or "grant".
- Tell people what is happening or what they can do, not how the system works.
- Use a calm, friendly tone. Don't blame the user or alarm them.
- If something fails, say what went wrong and what to try next, in plain words.

For example, "Waiting for the recorder…" is better than "Waiting for the recorder. Time left appears once the first part arrives."

## Changelog

`CHANGELOG.md` lists what changed in each release, written for the people who run and use Unifeye. Keep it current as you work:

- When a change affects them (a feature, a fix, changed behaviour or wording they'd notice, a new setting or requirement), add a line under `## Unreleased` in the same commit. Group lines under `### Added`, `### Changed`, `### Fixed` or `### Removed`, in that order, creating the heading if it's missing.
- One line per change, in plain language, saying what people see, not how the code does it. "Clips can be up to two hours long", not "Raise CLIP_MAX_SECONDS".
- Skip changes nobody can see: refactors, tests, build scripts, docs-only edits.
- If a later change revises something already under Unreleased, edit that line instead of adding another.
- Never add a version heading by hand. `scripts/release.sh` turns Unreleased into the version's section, and running servers compare themselves with the newest GitHub release (`src/server/version.ts`).

## Tests

Vitest, all in `tests/`. `makeFixture()` in `src/server/testing/fixture.ts` builds the full service graph on an in-memory database with the mock adapter and the in-memory relay, plus a fixed cast of users, groups and views. API tests call `handleApi` directly with a constructed `Request`; there is no HTTP server. Use the fixture's `setConfigForTests` / `setServicesForTests` hooks rather than mocking modules.
