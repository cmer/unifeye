# Running Unifeye behind Cloudflare Tunnel

Cloudflare Tunnel can stand in for the HTTPS reverse proxy described in
[deployment.md](deployment.md#4-network): `cloudflared` makes an outbound connection to Cloudflare,
and Cloudflare terminates HTTPS for your hostname. Nothing on your network needs an inbound port for
the app.

This page has not been checked against a live Cloudflare account yet. The behaviour it describes
comes from the code and from a local test with WebRTC made unreachable.

## What works and what does not

| | Through the tunnel |
| --- | --- |
| Pages, API, sign-in, live updates (`/api/events/stream`) | Works. The event stream sends a keep-alive every 20 seconds, well inside Cloudflare's idle limit. |
| Recorded playback, snapshots, event thumbnails, clip downloads | Works. All are sent `no-store`, so Cloudflare does not cache them. |
| Live video over **WebRTC** | **Does not go through the tunnel.** WebRTC media goes straight to port 8189 (UDP or TCP), and a tunnel only carries HTTP. |
| Live video over **HLS** | Works, through the tunnel. Viewers who cannot reach port 8189 get this automatically. |

### What viewers see

Each live tile tries WebRTC first. If no media arrives within 4 seconds, the tile switches to HLS.
The browser tab then remembers this for 10 minutes, and every other tile, view and reload in that tab
goes straight to HLS. So a viewer who cannot reach port 8189 waits about 4 seconds once, not on every
tile or every page.

Compared with WebRTC, HLS:

- runs a few seconds behind live instead of under a second,
- sends all of its video through Cloudflare.

## Choose how live video reaches people

Pick one. `WEBRTC_PUBLIC_HOST` is required either way.

1. **WebRTC on site, HLS elsewhere (recommended).** Set `WEBRTC_PUBLIC_HOST` to the host's LAN IP
   and do not forward port 8189. People on the office network get WebRTC; everyone else gets HLS
   through the tunnel.
2. **WebRTC everywhere.** Forward port 8189 UDP and TCP on your router to the host, and list both
   the LAN address and a public name:
   `WEBRTC_PUBLIC_HOST=192.168.1.10,media.example.com`. The public name must be a **DNS only** (grey
   cloud) record pointing at your public IP, never the tunnel's hostname, which resolves to
   Cloudflare. This opens one inbound port, which is often what a tunnel was meant to avoid.
3. **HLS only.** Set `WEBRTC_PUBLIC_HOST` to the LAN IP and accept HLS for everyone off site. This
   is the same setup as option 1.

## Set it up

### 1. Create the tunnel

In the Cloudflare dashboard, go to **Zero Trust > Networks > Tunnels** and create a tunnel of
type **Cloudflared**. Copy its token.

Add a **public hostname** to the tunnel:

| Field | Value |
| --- | --- |
| Hostname | `unifeye.example.com` |
| Service type | `HTTP` |
| URL | `app:3000` when `cloudflared` runs in the Compose stack (below), `localhost:3000` when it runs on the host |

Under the hostname's **Additional application settings > HTTP Settings**, leave **HTTP Host
Header** empty and **Disable Chunked Encoding** off.

### 2. Run `cloudflared` next to Unifeye

Create `compose.override.yaml` next to `compose.yaml`. Docker Compose reads it automatically:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest   # pin a specific version once it works
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?set CLOUDFLARE_TUNNEL_TOKEN}
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [unifeye]
    depends_on: [app]
```

Add the token to `.env`:

```sh
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

`cloudflared` reaches the app as `app:3000` over the Compose network. The app's own port stays bound
to `127.0.0.1`, so the tunnel is the only way in from outside the host.

### 3. Configure Unifeye

In `.env`:

```sh
APP_URL=https://unifeye.example.com   # exactly the tunnel hostname, with https://
WEBRTC_PUBLIC_HOST=192.168.1.10       # see "Choose how live video reaches people"
```

`APP_URL` must match the hostname people use. Unifeye rejects data-changing requests whose `Origin`
header does not match it, and your identity provider's redirect URIs are built from it.

Then `docker compose up -d`.

### 4. Register the hostname with your identity provider

Use the tunnel hostname in the redirect, post-logout and back-channel logout URIs from
[deployment.md](deployment.md#register-unifeye-with-your-identity-provider).

## Cloudflare settings for the hostname

Point the tunnel at port 3000 only. MediaMTX calls Unifeye's auth hook on port 3001 over the Compose
network, and that port is not served through the tunnel, so there is nothing to block.

### Let the identity provider's back-channel logout through

Your identity provider's server, not a browser, POSTs to `/api/auth/backchannel-logout`. Cloudflare
features that challenge bots can block it:

- **Bot Fight Mode** (Free plan) cannot be skipped per path. If logouts at the provider do not end
  Unifeye sessions straight away, turn Bot Fight Mode off for this zone. Without back-channel logout,
  sessions still end within `OIDC_RECHECK_SECONDS` (default 5 minutes).
- **Super Bot Fight Mode** and WAF challenge rules (paid plans): add a skip rule for
  `starts_with(http.request.uri.path, "/api/auth/backchannel-logout")`.

### Cloudflare Access (optional)

There are two ways to use Access:

- **As the sign-in itself** (`SIGN_IN_METHODS=cloudflare`, optionally `cloudflare,local`). Access
  signs people in and Unifeye trusts its signed token; there is no second sign-in. See
  [Cloudflare Access](deployment.md#cloudflare-access) in the deployment guide, including the
  Transform Rule that adds `X-Unifeye-Origin-Secret`. Do not add any
  Bypass policy in this setup: a request that reaches Unifeye without Access's token is treated as
  coming from outside Cloudflare.
- **As a second gate in front of your identity provider** (`SIGN_IN_METHODS=oidc`). People sign in
  to Cloudflare first and to your identity provider second, unless both use the same provider. Add
  a second Access application for the path `/api/auth/backchannel-logout` with a **Bypass** policy,
  for the same reason as above.

### Leave page rewriting off

Turn off **Rocket Loader** for this hostname (**Speed > Optimization**, or a Configuration Rule).
It rewrites how scripts load and can break the app. For the same reason, turn off **Email Address
Obfuscation** (**Scrape Shield**).

### Caching

Nothing to do. Every API, media and download response is marked `no-store` or `private, no-store`,
and Cloudflare does not cache it. Do not add a "Cache Everything" rule for this hostname.

## Limits to know about

- **100-second response limit.** Cloudflare returns error 524 if the app has not started answering
  within 100 seconds. Clip exports run as background jobs and are not affected. Seeking recorded
  video waits while Unifeye fetches that minute from the recorder. This is normally a few seconds,
  but a slow or overloaded UNVR could exceed the limit and the seek would fail.
- **Rate limits are per client address.** `cloudflared` passes each visitor's address in
  `X-Forwarded-For`, and Unifeye counts requests per address per minute. Video requests are limited
  to 600 per minute. A 9-tile wall on HLS makes about 270 per minute (measured locally at about 30 per
  tile). Off-site viewers usually each have their own address. People behind one office or VPN
  address share the limit, so two full HLS walls from the same address use most of it.
- **Cloudflare's terms on video.** Cloudflare's self-serve terms restrict using its network mainly to
  serve video, outside its own video products. A few people occasionally watching cameras over HLS
  is a small amount of traffic, but a wall streaming HLS all day through the tunnel is more. Keeping
  on-site viewers on WebRTC (option 1 above) keeps most video off Cloudflare.

## Check it

1. From a phone on mobile data, open `https://unifeye.example.com` and sign in.
2. Open a view with live tiles. The first time, tiles show a still image for about 4 seconds, then
   play. Open another view: tiles start without the wait.
3. On the office network, tiles should play almost at once (WebRTC). Hover over a tile and click
   its speaker to check sound.
4. `curl -i -X POST https://unifeye.example.com/api/internal/mediamtx-auth` should return 404: the
   hook is not served through the tunnel.
5. Sign out at your identity provider, then reload Unifeye in another tab. You should be signed out
   (straight away with back-channel logout, otherwise within `OIDC_RECHECK_SECONDS`).
