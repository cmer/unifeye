# Deployment

The Docker image and Compose stack run in production against a real UNVR. See
[verification.md](verification.md) for what has and hasn't been checked.

## Where to run it

Run Unifeye on the same site network as the recorder: a small machine or VM on the recorder's LAN.
Give remote viewers access through a reverse proxy or [Cloudflare Tunnel](cloudflare-tunnel.md)
rather than moving Unifeye off site.

- **The recorder stays private.** Unifeye holds Protect credentials that can read every camera, and
  it pulls the camera streams from the recorder. On a hosted server (a VPS, for example), the
  recorder would have to be reachable from there, through a site-to-site VPN or by exposing it.
  On-site, nothing about the recorder leaves the LAN.
- **On-site viewers get the best video.** People on the office network get WebRTC straight from
  MediaMTX, which starts almost at once and never touches the internet. With a hosted server, their
  video would leave the site and come back.
- **Recorded video reads from the recorder a lot.** Playback fetches video in
  `PLAYBACK_WINDOW_SECONDS` windows, and clip exports copy roughly 1–4 GB per hour of video. Over the
  LAN this costs nothing. From a hosted server, all of it crosses the site's upload link.
- **Fewer moving parts.** The app and MediaMTX must run on one host (see
  [Sizing and limits](#8-sizing-and-limits)). Off site, a VPN tunnel sits between them and the
  recorder, and when it drops, cameras look offline.

A hosted server can make sense in one case: most viewers are off site, many of them watch at the
same time, and the site's upload speed is the bottleneck. MediaMTX pulls each camera from the
recorder once and sends a copy to every viewer. If Unifeye runs on-site, the site uploads one copy
per remote viewer. If it runs off site, the site uploads each camera once. For example, ten remote
people each watching four cameras at about 2 Mbps per stream need around 80 Mbps of upload from an
on-site host, but only about 8 Mbps if Unifeye runs off site. Before moving it, check the site's
upload speed and make sure each camera has a low-quality stream for the wall (see
[Prepare Protect](#2-prepare-protect)). That often stretches an on-site host far enough.

## 1. Choose how people sign in

`SIGN_IN_METHODS` lists the ways in, comma separated. The default is `oidc`.

| Value | People sign in with | Set up |
| --- | --- | --- |
| `oidc` | Your organization's identity provider | [Register Unifeye](#register-unifeye-with-your-identity-provider) below |
| `cloudflare` | Cloudflare Access, already in front of Unifeye | [Cloudflare Access](#cloudflare-access) below |
| `local` | A username and password an administrator hands out | [Password accounts](#password-accounts) below |

`oidc` and `cloudflare` cannot be combined. Either can be combined with `local`: with `oidc,local`
the sign-in page offers both; with `cloudflare,local`, people coming through Cloudflare are signed in
by Access and password accounts are for the local network.

**Send a company's addresses to the identity provider.** With `oidc,local`, set
`OIDC_EMAIL_DOMAINS` (comma separated, for example `OIDC_EMAIL_DOMAINS=example.com`). Someone who
types an address at one of those domains on the sign-in page goes straight to the provider, with the
address filled in where the provider supports it, and is never asked for a password. Password and
code sign-in refuse those addresses, and administrators can't add password accounts with them.
Domains match exactly: `example.com` does not cover `mail.example.com`, so list each one.

A person belongs to one method for good. Nothing links a work account to a password account, even
with the same name or email. Turning a method off (and restarting) locks its people out at once;
they come back if it is turned on again.

### Password accounts

Add `local` to `SIGN_IN_METHODS`. Administrators then see **Add person** under Admin › People. Adding
someone gives a one-time link (24 hours) for them to choose a password; send it however suits you.
For a forgotten password, choose **Password link** next to the person.

**Email codes.** With `local` on, set `SMTP_URL` and `MAIL_FROM` and administrators can give a person addresses that
sign-in codes go to, instead of a password or as well as one. The person types their username and
chooses **Email a code**; a 6-digit code goes to those addresses and works for 10 minutes in that
browser only. The addresses can be someone else's: for a shared account such as `office` at a front
desk, send codes to the manager, who reads the code out to whoever asked. Unifeye sends no other
email. If mail stops working, Admin › People says so; people with a password can still use it, and
`password-link` (below) turns a password on for anyone.

```sh
SMTP_URL=smtps://user:password@smtp.example.com:465   # or smtp://...:587, upgraded with STARTTLS
MAIL_FROM="Unifeye <cameras@example.com>"
```

With `local` as the only method there is nobody to sign in as at first. Create the first
administrator on the server:

```sh
docker compose exec app node cli.mjs create-admin <username> "<Full name>"   # or: pnpm unifeye create-admin ...
docker compose exec app node cli.mjs password-link <username>               # a new link, if one is lost
```

When people reach Unifeye at a second address (for example on the local network while `APP_URL`
goes through Cloudflare), set `LOCAL_APP_URL` to it. Sign-in from that address is then accepted and
password links point there. In production it must use https; a local DNS name with its own
certificate, or the same hostname resolved to the local address, both work. The second option needs
no `LOCAL_APP_URL` at all.

Password sign-in is open to anyone who can reach that address. Do not publish it on the internet.

### Cloudflare Access

Use this when Cloudflare Access (Zero Trust) already sits in front of Unifeye, usually with
[Cloudflare Tunnel](cloudflare-tunnel.md).

1. In Zero Trust, create a **self-hosted** Access application for the Unifeye hostname, covering the
   whole hostname, with the policies that decide who gets in. Add no Bypass rules.
2. From the application's overview, copy the **Application Audience (AUD) tag**.
3. Set `SIGN_IN_METHODS=cloudflare` (or `cloudflare,local`), `CF_ACCESS_TEAM_DOMAIN` (for example
   `acme.cloudflareaccess.com`) and `CF_ACCESS_AUD`.
4. Generate a secret (`openssl rand -hex 24`) and set it as `CF_ACCESS_ORIGIN_SECRET`. In the
   Cloudflare dashboard for the zone, add a **Transform Rule** › **Modify Request Header** for the
   Unifeye hostname that **sets** the static header `X-Unifeye-Origin-Secret` to the same value.
   This proves a request really passed through Cloudflare; without it, a person could send their own
   Access token straight to the server and keep access after Cloudflare revoked them. It is required
   with `cloudflare,local` and strongly recommended otherwise.
5. Make sure Unifeye cannot be reached from outside except through Cloudflare. A request without
   Access's token is treated as local: with `local` on it may use a password account, otherwise it
   is refused.
6. First administrator: open Unifeye through Cloudflare once, then run `node cli.mjs users` on the
   server, copy the issuer and subject on your row into `BOOTSTRAP_ADMIN_ISSUER` and
   `BOOTSTRAP_ADMIN_SUBJECT`, restart, and open Unifeye again.

Unifeye checks Access's signed token on every request. When Cloudflare stops letting someone
through, their session is suspended within `CF_ACCESS_RECHECK_SECONDS` (default 5 minutes, at most
an hour) and any video they are watching stops. Signing out of Unifeye also signs out of Access. A
shorter Access session duration also shortens how long a copied token stays usable.

Cloudflare Access can also act as an ordinary OpenID Connect provider ("Access for SaaS"). That works
with `oidc` and the steps below, with no Cloudflare-specific settings.

### Register Unifeye with your identity provider

Unifeye signs in through any OpenID Connect provider that supports the Authorization Code flow with
PKCE (Keycloak, Authentik, Zitadel, Authelia, Entra ID, Okta and so on). It does not embed one.

Step-by-step setup for Zitadel, Keycloak, Microsoft Entra ID and Google Workspace is in
[identity-providers.md](identity-providers.md). For any other provider, create a client (often
called an application) for Unifeye:

1. Type: web application, Authorization Code flow with PKCE (S256). A public client is enough; for a
   confidential client, also set `OIDC_CLIENT_SECRET`.
2. Redirect URI: `https://<unifeye host>/api/auth/callback`
3. Post-logout redirect URI: `https://<unifeye host>/signed-out`
4. Back-channel logout URI, if the provider supports it: `https://<unifeye host>/api/auth/backchannel-logout`
5. Allow refresh tokens. Unifeye requests `offline_access` and uses the refresh token only to
   re-check sessions (see [Session re-checks](#session-re-checks)).
6. Put the claim you want to admit on (a group or role list, for example) into the **ID token**.
   Many providers only add group or role claims to the access token or userinfo by default.
7. If the provider can restrict which users may use a client, do that too, so unrelated users are
   refused before they reach Unifeye.

Then collect:

| Setting | Where it comes from |
| --- | --- |
| `OIDC_ISSUER` | The `issuer` value from `<issuer>/.well-known/openid-configuration`, exactly |
| `OIDC_CLIENT_ID` | The client's ID |
| `OIDC_ADMIT_CLAIM`, `OIDC_ADMIT_VALUES` | The admission rule, below |
| `OIDC_SCOPES` | `openid profile email offline_access` plus anything the provider needs to include the admission claim |
| `BOOTSTRAP_ADMIN_ISSUER`, `BOOTSTRAP_ADMIN_SUBJECT` | The issuer and the `sub` of the first administrator |

### Admission rule

Authenticating at the provider is not enough to get in. At each sign-in Unifeye reads one claim from
the ID token and refuses the user unless it matches:

- `OIDC_ADMIT_CLAIM` names the claim. If no claim has that exact name, a dotted path is followed,
  so `realm_access.roles` reads `roles` inside `realm_access`.
- The claim may be a string, an array of strings, or an object whose keys are the values.
- With `OIDC_ADMIT_VALUES` set, at least one value must be in that list. With it empty, the claim
  only has to be present and non-empty.
- `OIDC_ADMIT_ANY=1` turns the rule off. Use it only when the provider already limits who can use
  this client. Production refuses to start with neither a claim nor `OIDC_ADMIT_ANY`.

A refused user lands on the signed-out page with "not set up for Unifeye", and no profile is created.

Examples:

| Provider puts... | Settings |
| --- | --- |
| Group names in `groups` | `OIDC_ADMIT_CLAIM=groups`, `OIDC_ADMIT_VALUES=unifeye-users` |
| Role names under `realm_access.roles` | `OIDC_ADMIT_CLAIM=realm_access.roles`, `OIDC_ADMIT_VALUES=unifeye` |
| An organization ID in a custom claim | `OIDC_ADMIT_CLAIM=<claim name>`, `OIDC_ADMIT_VALUES=<org id>,<org id>` |

Check the exact claim names against an ID token from your provider before going live.

### Session re-checks

Back-channel logout tells Unifeye when a provider session ends, but most providers do not send it
when a user is disabled or deleted. Unifeye therefore exercises each session's refresh token every
`OIDC_RECHECK_SECONDS`: a rejected token revokes the session. If the provider issues no refresh
token (some need extra request parameters, set with `OIDC_AUTH_PARAMS`), that check cannot run and a disabled user keeps access until back-channel logout or the
session's own limits end it.

## 2. Prepare Protect

Create a dedicated **local** Protect user for Unifeye with a view-only role. Whether view-only is
enough for snapshots, events and video export on your Protect version is unverified; if something
returns "not allowed", widen the role in Protect and note it. Unifeye's adapter only issues GET
requests regardless of the role.

Enable an RTSP stream in Protect on each camera you want live video from (at least one low and one
high quality stream is ideal). Unifeye will not enable streams itself.

TLS: export the UNVR's certificate to `./certs/unvr.pem`, set `PROTECT_TLS_CA_FILE=/certs/unvr.pem`
and use a `PROTECT_HOST` that matches the certificate. For the RTSPS relay, set
`PROTECT_RTSPS_FINGERPRINT` to the certificate's SHA-256 fingerprint:

```sh
openssl s_client -connect <unvr>:7441 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':'
```

Cameras made by someone else (adopted over ONVIF) can instead be read directly, for cameras whose
live video through the recorder stutters. Turn it on per camera under Admin > Live video. Set
`DEFAULT_CAMERA_USERNAME` and `DEFAULT_CAMERA_PASSWORD` to the login most of your cameras share; a
camera can have its own, saved encrypted with `TOKEN_ENC_KEY`. Unifeye must be able to reach the
cameras on their RTSP port (usually 554). Each camera then serves at most two extra connections (the
high and the low stream), shared by every viewer and closed 10 seconds after the last one leaves.

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
- Proxy only port 3000. MediaMTX calls Unifeye's auth hook on port 3001 over the Compose network;
  never publish or proxy that port. Nothing needs blocking at the proxy.
- Forward the client address in `X-Forwarded-For`, appended as the last entry (sign-in rate limits
  use the last address; signed-in requests are limited per session).
- Open port **8189 UDP and TCP** from viewers to the host, and set `WEBRTC_PUBLIC_HOST` to the
  address they use (a comma-separated list is allowed, for example a LAN IP and a public name). To
  use another port, set `WEBRTC_PORT`; Compose publishes it and MediaMTX listens on it, and the
  port must be the same on the outside as inside (no remapping, including on a router). A
  viewer who cannot reach it gets HLS through the HTTPS proxy after about 4 seconds, and that tab
  uses HLS directly for the next 10 minutes.
- Cloudflare Tunnel can take the place of the reverse proxy: see [cloudflare-tunnel.md](cloudflare-tunnel.md).
- Nothing else is published. Do not publish 8554, 8888, 8889 or 9997.

## 5. Configuration reference

`.env.example` lists every setting with its default. The ones that change behaviour most:

| Setting | Default | Meaning |
| --- | --- | --- |
| `UNIFEYE_MODE` | `mock` in code, `real` in `.env.example` | `mock` serves simulated cameras; sign-in works the same |
| `SIGN_IN_METHODS` | `oidc` | Ways to sign in: `oidc`, `local`, `cloudflare` (see [section 1](#1-choose-how-people-sign-in)) |
| `OIDC_EMAIL_DOMAINS` | unset | Email domains that always sign in with the identity provider; needs `oidc,local` |
| `LOCAL_APP_URL` | unset | A second address for password sign-in; password links point there |
| `SMTP_URL` / `MAIL_FROM` | unset | Outgoing mail; set both or neither. Email sign-in codes also need `local` |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | unset | Cloudflare Access team and application, required with `cloudflare` |
| `CF_ACCESS_ORIGIN_SECRET` | unset | Secret Cloudflare adds as `X-Unifeye-Origin-Secret`; required with `cloudflare,local` |
| `CF_ACCESS_RECHECK_SECONDS` | 300 | How quickly someone Cloudflare stops letting through loses access |
| `SESSION_DAYS` | 30 | How long people stay signed in before they must sign in again |
| `SESSION_IDLE_MINUTES` | 0 (off) | Also sign people out after this many minutes without use |
| `OIDC_RECHECK_SECONDS` | 300 | How quickly a user disabled at the provider is noticed |
| `OIDC_MAX_STALE_SECONDS` | 1800 | How long a session survives without a successful re-check |
| `REVOCATION_SWEEP_SECONDS` | 10 | Worst-case delay before revoked media stops (max 30) |
| `MAX_WALL_STREAMS` | 9 | Simultaneous live tiles; the rest show stills |
| `WALL_PLAYBACK_STREAMS` | 4 | Tiles that play recorded video at once when someone rewinds the wall; the rest show a still every few seconds. Each asks the recorder for an export every minute, so raise it only if your recorder keeps up |
| `PLAYBACK_WINDOW_SECONDS` | 60 | Size of each recorded-video window |
| `SCRUB_PRELOAD_MS` | 500 | While someone drags a camera's timeline, how long the playhead must rest before that moment's video starts loading, so letting go there plays sooner. Lower is snappier but asks the recorder for more video that may go unwatched; 0 turns it off |
| `LIVE_BUFFER_MS` | 1000 | How long a browser holds live video before showing it. Cameras and recorders send in bursts, with a pause around each keyframe; without something in hand the picture freezes and jumps every couple of seconds. Live video runs this far behind real time. Raise it (up to 4000) if video still stutters, lower it for less delay, 0 to turn it off. Takes effect when people reload the page |
| `CLIP_MAX_SECONDS` | 7200 | Longest clip a person can save. Clips stream from the recorder to disk, so `/cache` needs room for them (roughly 1–4 GB per hour of video, depending on the camera) |
| `CLIP_EXPORT_PARALLEL` | 3 | How many five-minute pieces of a long clip are fetched from the recorder at once. Higher is faster if the recorder keeps up |
| `CLIP_MATCH_RESOLUTION` | on | With adaptive recording, re-encode the parts of a clip recorded only in low resolution at the high-resolution size, so players don't resize the picture partway. Off joins them as recorded |
| `VIDEO_ENCODER` | `auto` | Encoder for that resize: `auto` uses a GPU if one works and the CPU otherwise; `cpu`, `vaapi`, `nvenc` or `videotoolbox` pick one (a named GPU that fails still falls back to the CPU) |
| `VAAPI_DEVICE` | every `/dev/dri/renderD*` | VAAPI render node to use |
| `BACKUP_RETENTION_DAYS` | 14 | How long daily backups are kept |
| `MEDIA_CACHE_MAX_MB` | 2048 | Playback cache size limit |
| `AUDIT_RETENTION_DAYS` | 365 | How long history is kept |

## 6. Backups

- A consistent backup is written to `/data/backups` once a day after `BACKUP_HOUR_UTC`, using
  SQLite's online backup API, verified with `integrity_check`, written under a temporary name and
  renamed, mode 0600. Daily backups older than the retention period are removed.
- A backup is also taken automatically before any migration of an existing database.
- Manual: `docker compose exec app node cli.mjs backup`
- `docker compose exec app node cli.mjs users` lists everyone who has signed in, with their issuer
  and subject.
- Do not copy `unifeye.sqlite` on its own while the app runs; recent changes live in the `-wal`
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
`unifeye.sqlite.replaced-<time>`), restores, and invalidates every session, preview and pending
download so that everyone signs in again. It prints counts of users, cameras, tags, views and
grants for a quick sanity check. `.env`, certificates and your identity provider are not in the backup; restore
them separately. To restore into a clean volume, omit `--force`.

## 7. Upgrades and rollback

On the server, from the checkout:

```sh
scripts/update.sh
```

It fetches `origin/main`, backs up the database, builds the new image while the current version
keeps running, then restarts and waits until both containers are healthy. If the build fails,
nothing is restarted. Local edits to tracked files (for example a changed `compose.yaml`) are carried
over; if they conflict with the new code, the update stops before changing anything. Settings that
only this server needs belong in `compose.override.yaml`, which the update never touches.
To pick a release instead, pass its version: `scripts/update.sh 1.1.2` goes to that release,
`scripts/update.sh 1.3` to the newest 1.3.x and `scripts/update.sh 2` to the newest 2.x.x.
`scripts/update.sh --help` lists the options.

The update records the commit it built in the image (the `GIT_SHA` build argument). Diagnostics
shows that commit and whether a newer version exists: a few times a day Unifeye asks api.github.com
for the newest release and how the running commit compares with it, sending nothing but that commit.
`UPDATE_CHECK=off` turns the check off. An image built by hand with plain `docker compose build`
has no commit, so it can only compare version numbers with the newest release; to include it, run
`GIT_SHA=$(git rev-parse HEAD) docker compose build`.

The server needs read access to the repository. For a private repository, add a read-only deploy
key: create one with `ssh-keygen -t ed25519 -f ~/.ssh/unifeye_deploy`, add the `.pub` file under
the repository's Settings > Deploy keys, then in the checkout switch to the SSH address and use that key:
`git remote set-url origin git@github.com:<owner>/unifeye.git` and
`git config core.sshCommand "ssh -i ~/.ssh/unifeye_deploy -o IdentitiesOnly=yes"`.

1. Migrations apply at start-up after an automatic backup. `node cli.mjs migrate` runs the same step
   on its own.
2. If a migration fails the app does not start and the database is unchanged.
3. To roll back, run `scripts/update.sh <previous version or commit>`; the update prints the command when it
   finishes. If the update included a migration (it says so before building), also restore the
   `-pre-migration` backup it took: a database newer than the running build is refused at start-up.

## 8. Sizing and limits

- One app container, one MediaMTX container, one host. Do not run replicas and do not put `/data`
  on NFS or SMB.
- The database stays small (tens of megabytes). Size `/data` for the database plus
  `BACKUP_RETENTION_DAYS` copies of it.
- `/cache` needs `MEDIA_CACHE_MAX_MB` plus room for clips being prepared.
- Video is relayed, not transcoded, so CPU use is low in real mode. Sound from cameras with a
  microphone is re-encoded by an FFmpeg in the MediaMTX container (one small process per stream
  being watched) because Protect's audio timestamps are unusable as sent. Mock mode encodes test
  video and uses noticeably more.
- No GPU is needed. Live video and recorded playback are copied as the recorder sends them, and
  snapshots come ready-made from the recorder. The only video encoding is in saved clips from
  cameras with adaptive recording. A five-minute piece with some motion is rebuilt at full size from
  the low and high recordings so no time is missing (about 14 s at 2688x1512 on a fast desktop CPU,
  run as each piece downloads), and a piece recorded only in low resolution is resized to match
  (`CLIP_MATCH_RESOLUTION`, about 8 s). Expect a few times those on a small server, so a two-hour
  clip from such a camera can take noticeably longer to prepare. A GPU is used when available
  (below), though most of the time goes to scaling, which stays on the CPU. For the host, the link to the recorder, upload speed for
  remote viewers and room on `/cache` matter more than CPU.
- **GPU.** With `VIDEO_ENCODER=auto` (the default) Unifeye tries, once per start, a short test encode
  on VAAPI (Intel Quick Sync and AMD), then NVIDIA NVENC, and uses the first that works, or the CPU.
  The first clip that needs it logs the choice (`clip resizing uses the GPU`, or `… uses the CPU`
  with the reason). Each clip piece logs `clip piece ready` (time spent downloading, and combining
  when it was rebuilt, with the encoder used) or `clip piece resized`, and each saved clip logs
  `clip saved` with its total time and how much of it went to encoding. The image includes the Intel and AMD VAAPI
  drivers. To pass an Intel or AMD GPU in, uncomment `devices` and `group_add` in `compose.yaml` and
  set `RENDER_GID` in `.env` to the host's `render` group id (`getent group render | cut -d: -f3`).
  For NVIDIA, install the NVIDIA Container Toolkit on the host and uncomment the `deploy` block.
- Because video is not transcoded, browsers get each camera's own codec. H.265 cameras play only in
  browsers that support it. If that's a problem, set those cameras to H.264 in Protect.
