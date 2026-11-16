# Install Unifeye on a server (instructions for an AI agent)

You are an AI coding agent. A person has asked you to install Unifeye, a read-only viewer for UniFi
Protect cameras, on a Linux machine they control. Follow this file from top to bottom. It is written
so that the person only has to answer questions and do the few steps that need their own accounts
(their identity provider, their recorder, their router or DNS). You do everything else over SSH.

The authoritative references are in this repository: `docs/deployment.md`,
`docs/identity-providers.md`, `docs/cloudflare-tunnel.md` and `.env.example`. When this file and
those disagree, those win. Read the relevant section before each phase.

## Rules

- **Ask with your harness's question tool** (for example `AskUserQuestion` in Claude Code), one
  phase at a time, with concrete options and a recommended one listed first. Ask only what you
  cannot find out yourself. If you can detect an answer (the server's LAN IP, the OS, whether Docker
  is installed), detect it and ask the person to confirm.
- **Write for someone who is not technical.** Say "recorder", not "UNVR"; "sign-in provider", not
  "OIDC". Explain why you need each answer in one short sentence.
- **Never write to the recorder.** Unifeye must not change camera settings, recordings, events or
  Protect users, and neither may you. Turning on a camera's RTSP stream is something the person
  does in Protect; you only tell them how.
- **Secrets.** Generate Unifeye's own secrets on the server and never print them. For secrets the
  person has (the Protect password, a client secret, a tunnel token), use the harness's secret input
  if it has one. If it doesn't, offer two choices: paste it in the chat (it will be in the
  transcript), or type it into `.env` on the server themselves while you wait. Never put a secret
  on a command line that ends up in shell history or `ps`; write it to the file with a heredoc
  read from stdin or edit the file in place.
- **Confirm before anything hard to undo or outside the server:** installing packages, opening
  firewall ports, overwriting an existing `.env` or `compose.override.yaml`, deleting volumes, or
  touching any other host.
- **This deployment path is new.** `docs/deployment.md` says the Docker stack has not been run in
  production before. Treat this install as a test. If something in the repository is wrong, stop,
  explain what you saw, and suggest the fix rather than working around it silently.

## Phase 1: Reach the server

1. Ask for the server's address (host name or IP) and the SSH user. Default user: the person's
   usual one; suggest `root` only if they say so.
2. Test with `ssh -o BatchMode=yes -o ConnectTimeout=10 <user>@<host> true`. If it fails because of
   keys or passwords, help the person set up key access (`ssh-copy-id`); do not ask for an SSH
   password in the chat.
3. Check whether the user can run `sudo -n true`. If sudo needs a password, use the harness's
   secret input if it has one; otherwise ask the person to run the privileged commands you give
   them.

Collect, without asking:

```sh
uname -m; cat /etc/os-release; nproc; free -h; df -h /
docker --version; docker compose version
ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p'   # the server's LAN IP
ss -ltnup | grep -E ':(80|443|3000|8189)\b' || true                # ports already in use
timedatectl show -p NTPSynchronized --value 2>/dev/null           # clock sync matters for sign-in
```

Requirements: 64-bit Linux (x86_64 or arm64), Docker Engine with the Compose v2 plugin, about 2 GB
of RAM for the image build, and at least 10 GB free disk (more if people will save long clips:
roughly 1–4 GB per hour of video). Ports 3000 (on 127.0.0.1) and 8189 must be free.

If Docker is missing, ask before installing it. Use the distribution's documented method (Docker's
official `apt`/`dnf` repository), add the SSH user to the `docker` group only if the person agrees.

Tell the person in one or two sentences what you found (OS, LAN IP, Docker, free space), and any
blocker.

## Phase 2: Ask how Unifeye will be used

Ask these together where the tool allows several questions at once:

1. **Recorder or demo?** "Connect to your recorder now" (recommended) or "Try it with simulated
   cameras first" (`UNIFEYE_MODE=mock`, `SEED_DEMO=1`; sign-in still needs a real provider).
2. **How will people open Unifeye?** It must be on HTTPS, even on the office network.
   - "Cloudflare Tunnel" (recommended when the server isn't reachable from the internet; no router
     changes). See `docs/cloudflare-tunnel.md`.
   - "This server, with its own domain name" (you add Caddy, which gets a certificate
     automatically; the domain must point at this server and ports 80 and 443 must reach it).
   - "I already have a reverse proxy" (you print exactly what it must do and they set it up).
3. **The web address** people will type, for example `https://cameras.example.com`. This becomes
   `APP_URL`, exactly, with `https://` and no trailing slash.
4. **Live video away from the office.** Explain: on the office network live video is real-time;
   away from it, it is a few seconds behind unless the router forwards one port.
   - "Real-time in the office, slightly delayed elsewhere" (recommended; no router changes).
   - "Real-time everywhere" (forward port 8189 UDP and TCP on the router to this server, and give a
     DNS name or fixed public IP that points at the router; with Cloudflare it must be a DNS-only,
     grey-cloud record).
5. **Where to install:** default `/opt/unifeye`.

## Phase 3: Get the code

```sh
sudo mkdir -p /opt/unifeye && sudo chown "$USER": /opt/unifeye
git clone https://github.com/cmer/unifeye.git /opt/unifeye
cd /opt/unifeye && git log -1 --oneline
```

If the directory already holds an install, stop and ask: upgrade it (see Phase 10), or leave it.
Never delete an existing `.env`, `data` volume or `certs` folder.

## Phase 4: Sign-in provider

Unifeye has no passwords of its own. People sign in through the organization's OpenID Connect
provider. Read `docs/deployment.md` section 1 and `docs/identity-providers.md`.

1. Ask which provider they use: Microsoft Entra ID, Google Workspace, Keycloak, Zitadel, or other.
2. Walk the person through creating the client using the matching section of
   `docs/identity-providers.md`. Give them these values, filled in with their `APP_URL`:
   - Redirect URI: `<APP_URL>/api/auth/callback`
   - Post-logout redirect URI: `<APP_URL>/signed-out`
   - Back-channel logout URI (if offered): `<APP_URL>/api/auth/backchannel-logout`
3. Collect: the issuer URL, the client ID, and the client secret if it is a confidential client.
4. Check the issuer from the server:
   `curl -fsS <issuer>/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'`.
   `OIDC_ISSUER` must equal that `issuer` value exactly, including any trailing slash.
5. **Who may sign in.** Ask: "Everyone your provider lets use this app" (`OIDC_ADMIT_ANY=1`, only if
   the provider restricts the client to assigned users) or "Only members of a group or role" (ask
   for the claim name and value; examples are in `docs/deployment.md` under "Admission rule").
   The claim must be in the ID token. Make sure `OIDC_SCOPES` includes whatever scope the provider
   needs for it.
6. For Google, set `OIDC_AUTH_PARAMS=access_type=offline&prompt=consent` (see
   `docs/identity-providers.md`).

Leave `BOOTSTRAP_ADMIN_ISSUER` and `BOOTSTRAP_ADMIN_SUBJECT` empty for now unless the person already
knows their exact subject (`sub`) at the provider. Phase 8 fills them in.

## Phase 5: The recorder

Skip this phase in mock mode. Read `docs/deployment.md` section 2.

1. Ask for the recorder's address on the network. Check that the server can reach it:
   `curl -sk -o /dev/null -w '%{http_code}\n' https://<recorder>/` (any HTTP code means reachable).
2. Ask the person to create a **local** Protect user just for Unifeye with a view-only role, in
   Protect's user settings, and give you the username and password (secret rules above).
3. Ask them to turn on an RTSP stream in Protect for each camera they want live video from (one low
   and one high quality is ideal). Tell them Unifeye never does this itself.
4. Fetch the recorder's certificate so Unifeye can verify it instead of skipping TLS checks:

   ```sh
   mkdir -p /opt/unifeye/certs
   openssl s_client -connect <recorder>:443 -showcerts </dev/null 2>/dev/null \
     | openssl x509 > /opt/unifeye/certs/unvr.pem
   openssl x509 -in /opt/unifeye/certs/unvr.pem -noout -subject -ext subjectAltName
   openssl s_client -connect <recorder>:7441 </dev/null 2>/dev/null \
     | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':'
   ```

   - `PROTECT_TLS_CA_FILE=/certs/unvr.pem` and `PROTECT_RTSPS_FINGERPRINT=<last command's output>`.
   - `PROTECT_HOST` must match a name or IP in the certificate. If the address the person gave isn't
     in it, use a name that is, and map it to the recorder's IP for the app container in
     `compose.override.yaml` (`extra_hosts: ["<name>:<ip>"]` under `app`). Explain this to the
     person before doing it.
   - This trusts whatever answered on the network at that moment. Say so, and offer to compare the
     fingerprint with the one shown in the recorder's settings.

## Phase 6: Write `.env`

Start from `.env.example` and fill in every line marked REQUIRED. `chmod 600 .env`.

- Generate on the server, never shown in the chat:
  - `TOKEN_ENC_KEY`: `openssl rand -base64 32`
  - `MEDIAMTX_HOOK_SECRET` and `MEDIAMTX_API_SECRET`: `openssl rand -hex 24` each
- `UNIFEYE_MODE`, `APP_URL`, the `OIDC_*` values and the `PROTECT_*` values from the phases above.
- `WEBRTC_PUBLIC_HOST`: the server's LAN IP first. If the person chose real-time everywhere, add
  the public name after a comma: `192.168.1.10,cameras-media.example.com`. This is the address
  browsers dial for live video, so it must be one they can reach, never a container address.
- Leave the optional tuning lines commented unless the person asked for something.

Then show the person a summary of the non-secret settings and ask them to confirm.

## Phase 7: HTTPS and start-up

Do the option chosen in Phase 2.

**Cloudflare Tunnel.** Follow `docs/cloudflare-tunnel.md` sections 1–4 and "Cloudflare settings for
the hostname". The person creates the tunnel and the WAF rule in the Cloudflare dashboard; you
write `compose.override.yaml` and add `CLOUDFLARE_TUNNEL_TOKEN` to `.env`.

**Caddy on this server.** Check that the domain resolves to the server
(`getent hosts <domain>`) and that ports 80 and 443 are free. Write `/opt/unifeye/Caddyfile`:

```caddyfile
<domain> {
	@internal path /api/internal/*
	respond @internal 404
	reverse_proxy app:3000 {
		flush_interval -1
	}
}
```

and `/opt/unifeye/compose.override.yaml`:

```yaml
services:
  caddy:
    image: caddy:2.10.2
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks: [unifeye]
    depends_on: [app]
volumes:
  caddy-data:
  caddy-config:
```

**Existing reverse proxy.** Give the person the list from `docs/deployment.md` section 4: proxy to
`127.0.0.1:3000` over HTTPS, no response buffering for `/api/events/stream` and `/api/media/`, block
`/api/internal/`, pass the client address in `X-Forwarded-For`.

Then start it:

```sh
cd /opt/unifeye
docker compose up -d --build        # the first build takes several minutes
docker compose ps
docker compose logs --tail=100 app  # "Invalid configuration" lists every problem; fix .env and retry
curl -fsS http://127.0.0.1:3000/api/health && echo
curl -fsS http://127.0.0.1:3000/api/ready && echo
```

**Firewall.** Ports published by Docker bypass `ufw`/`firewalld` rules on most setups, so 8189 is
already open on the server. If the network between viewers and the server has its own firewall,
tell the person to allow TCP and UDP 8189 from the office network. For "real-time everywhere",
walk them through forwarding 8189 UDP and TCP on their router to the server's LAN IP.

## Phase 8: First administrator

The first administrator is chosen by their exact provider identity, which you usually don't know
yet. Two steps:

1. Ask the person to open `APP_URL` and sign in. They pass the admission rule and arrive with no
   cameras. If they are refused, the admission claim or value is wrong: check the logs and Phase 4.
2. List who has signed in, find the person, and set the bootstrap pair from their row:

   ```sh
   docker compose exec app node cli.mjs users   # role, status, email, name, issuer, subject
   ```

   Set `BOOTSTRAP_ADMIN_ISSUER` and `BOOTSTRAP_ADMIN_SUBJECT` in `.env` to that issuer and subject
   exactly, then `docker compose up -d app`. Ask the person to sign out and sign in again. They are
   now an administrator. This works once; after that, administrators promote others in Admin.

## Phase 9: Check it works

Go through these with the person and report the result of each:

1. `APP_URL` opens from the office network and from a phone on mobile data.
2. The administrator sees Admin, and in real mode the cameras appear. Ask them to give themselves a
   camera or put themselves in a group, then open it.
3. Live video plays. In the office it should start almost at once; elsewhere it may show a still
   image for about 4 seconds first unless they chose real-time everywhere.
4. `curl -s -o /dev/null -w '%{http_code}\n' <APP_URL>/api/internal/mediamtx-auth` from outside the
   server returns 403 or 404, never 200.
5. `curl -fsS http://127.0.0.1:3000/api/ready` on the server reports the recorder and relay as OK.

If something fails, read `docker compose logs app mediamtx`, explain the problem in plain words,
and fix it. If live video never plays in the office, check `WEBRTC_PUBLIC_HOST` and that 8189 is
reachable from the viewer's network.

## Phase 10: Hand-over

Tell the person, briefly:

- Where it is installed, the web address, and who the administrator is.
- What they still need to do: copy backups off the server (they are in the `unifeye-data` volume
  under `/data/backups`), keep `.env` and `certs/` somewhere safe (they are not in the backups),
  and give the server's LAN IP a fixed address or DHCP reservation, because `WEBRTC_PUBLIC_HOST`
  depends on it.
- How to upgrade: `cd /opt/unifeye && git pull && docker compose up -d --build`. Migrations run
  at start-up after an automatic backup (`docs/deployment.md` section 7).
- Anything you could not verify, and anything in the repository that looked wrong.
