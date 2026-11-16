# Deployment

The Docker image and Compose stack in this repository have **not been built or run yet** (Docker was
not available where they were written). Treat the first deployment as a test.

## 1. Register Vantage in Zitadel

Use an existing Zitadel deployment (v4.11 or newer for back-channel logout). Vantage does not embed
Zitadel.

1. In your project, create an application of type **Web**.
2. Authentication method: **PKCE**. ("Code" with a client secret also works: set
   `OIDC_CLIENT_SECRET`.)
3. Redirect URI: `https://<vantage host>/api/auth/callback`
4. Post-logout redirect URI: `https://<vantage host>/signed-out`
5. Back-channel logout URI: `https://<vantage host>/api/auth/backchannel-logout`
6. Enable the refresh token grant. Vantage requests `offline_access` to re-validate sessions.
7. Token settings: turn on "User Roles inside ID Token" if you set `OIDC_PROJECT_ID`.
8. On the project, consider "Check Role Assignment on Authentication" and "Check for Project on
   Authentication" so Zitadel refuses unrelated users before they reach Vantage.

Then collect:

| Setting | Where it comes from |
| --- | --- |
| `OIDC_ISSUER` | Your Zitadel instance URL, exactly as in its discovery document |
| `OIDC_CLIENT_ID` | The application's client ID |
| `OIDC_ALLOWED_ORG_IDS` | Resource ID of each organization whose users may sign in |
| `OIDC_PROJECT_ID` | Optional. The project's resource ID |
| `BOOTSTRAP_ADMIN_ISSUER`, `BOOTSTRAP_ADMIN_SUBJECT` | The issuer and the user ID of the first administrator |

Scopes requested: `openid profile email offline_access urn:zitadel:iam:user:resourceowner`, plus
`urn:zitadel:iam:org:id:<id>` when exactly one organization is allowed and
`urn:zitadel:iam:org:projects:roles` when a project is configured.

## 2. Prepare Protect

Create a dedicated **local** Protect user for Vantage with a view-only role. Whether view-only is
enough for snapshots, events and video export on your Protect version is unverified; if something
returns "not allowed", widen the role in Protect and note it. Vantage's adapter only issues GET
requests regardless of the role.

Enable an RTSP stream in Protect on each camera you want live video from (at least one low and one
high quality stream is ideal). Vantage will not enable streams itself.

TLS: export the UNVR's certificate to `./certs/unvr.pem`, set `PROTECT_TLS_CA_FILE=/certs/unvr.pem`
and use a `PROTECT_HOST` that matches the certificate. For the RTSPS relay, set
`PROTECT_RTSPS_FINGERPRINT` to the certificate's SHA-256 fingerprint:

```sh
openssl s_client -connect <unvr>:7441 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':'
```

`PROTECT_TLS_INSECURE=1` skips verification for the Protect connection only, is meant for a first
local trial, and is refused when `NODE_ENV=production`.

## 3. Configure and start

```sh
cp .env.example .env        # fill in every REQUIRED value
docker compose up -d
docker compose logs -f app  # migrations run first; a migration error stops start-up
```

Sign in as the bootstrap administrator. Everyone else who signs in appears under Admin > People with
no cameras until you add them to a group or grant cameras.

Health: `GET /api/health` (process and routing) and `GET /api/ready` (database, recorder state,
relay, last backup). Neither exposes configuration or secrets.

## 4. Network

- Terminate HTTPS in a reverse proxy in front of `127.0.0.1:3000`. WebRTC, installable-app support
  and secure cookies all need HTTPS.
- Disable response buffering for `/api/events/stream` and `/api/media/`.
- Block `/api/internal/` at the proxy. MediaMTX reaches it over the Compose network; it is also
  protected by `MEDIAMTX_HOOK_SECRET`.
- Forward the client address in `X-Forwarded-For` (rate limiting uses the first address).
- Open port **8189 UDP and TCP** from viewers to the host, and set `WEBRTC_PUBLIC_HOST` to the
  address they use. If neither is reachable, video falls back to HLS through the HTTPS proxy.
- Nothing else is published. Do not publish 8554, 8888, 8889 or 9997.

## 5. Configuration reference

`.env.example` lists every setting with its default. The ones that change behaviour most:

| Setting | Default | Meaning |
| --- | --- | --- |
| `VANTAGE_MODE` | `mock` in code, `real` in `.env.example` | `mock` serves simulated cameras; sign-in is still Zitadel |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | 720 / 168 | Session lifetimes |
| `OIDC_RECHECK_SECONDS` | 300 | How quickly a user deactivated in Zitadel is noticed |
| `OIDC_MAX_STALE_SECONDS` | 1800 | How long a session survives without a successful re-check |
| `REVOCATION_SWEEP_SECONDS` | 10 | Worst-case delay before revoked media stops (max 30) |
| `MAX_WALL_STREAMS` | 9 | Simultaneous live tiles; the rest show stills |
| `PLAYBACK_WINDOW_SECONDS` | 60 | Size of each recorded-video window |
| `CLIP_MAX_SECONDS` | 300 | Longest clip a person can save |
| `BACKUP_RETENTION_DAYS` | 14 | How long daily backups are kept |
| `MEDIA_CACHE_MAX_MB` | 2048 | Playback cache size limit |
| `AUDIT_RETENTION_DAYS` | 365 | How long history is kept |

## 6. Backups

- A consistent backup is written to `/data/backups` once a day after `BACKUP_HOUR_UTC`, using
  SQLite's online backup API, verified with `integrity_check`, written under a temporary name and
  renamed, mode 0600. Daily backups older than the retention period are removed.
- A backup is also taken automatically before any migration of an existing database.
- Manual: `docker compose exec app node cli.mjs backup`
- Do not copy `vantage.sqlite` on its own while the app runs; recent changes live in the `-wal`
  file and the copy can be incomplete.
- Backups contain user, session and permission data. Copy them off the host and protect them.
- `/api/ready` reports whether the last backup succeeded.

### Restore

```sh
docker compose stop app
docker compose run --rm app node cli.mjs verify /data/backups/<file>
docker compose run --rm app node cli.mjs restore /data/backups/<file> --force
docker compose up -d app
```

`restore` checks the backup, moves the current database aside (it is kept as
`vantage.sqlite.replaced-<time>`), restores, and invalidates every session, preview and pending
download so that everyone signs in again. It prints counts of users, cameras, tags, views and
grants for a quick sanity check. `.env`, certificates and Zitadel are not in the backup; restore
them separately. To restore into a clean volume, omit `--force`.

## 7. Upgrades and rollback

1. `docker compose pull` or rebuild, then `docker compose up -d`. Migrations apply at start-up after
   an automatic backup. `node cli.mjs migrate` runs the same step on its own.
2. If a migration fails the app does not start and the database is unchanged.
3. To roll back, start the previous image and restore the `-pre-migration` backup taken by the
   upgrade. A database newer than the running build is refused at start-up.

## 8. Sizing and limits

- One app container, one MediaMTX container, one host. Do not run replicas and do not put `/data`
  on NFS or SMB.
- The database stays small (tens of megabytes). Size `/data` for the database plus
  `BACKUP_RETENTION_DAYS` copies of it.
- `/cache` needs `MEDIA_CACHE_MAX_MB` plus room for clips being prepared.
- Video is relayed, not transcoded, so CPU use is low in real mode. Mock mode encodes test video
  and uses noticeably more.
