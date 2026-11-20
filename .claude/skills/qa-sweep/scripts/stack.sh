#!/usr/bin/env bash
# Runs one isolated Unifeye stack (test sign-in provider, MediaMTX, app) in mock mode for QA.
#   stack.sh start <slot 1-9>   starts it in the background and prints the app URL when everything answers
#   stack.sh run   <slot 1-9>   the same in the foreground: shows the app log, and Ctrl-C stops everything
#   stack.sh stop  <slot>
#   stack.sh url   <slot>
# Run it from the root of your own worktree. Each slot has its own ports; each worktree its own data.
#
# A real recorder instead of simulated cameras (read-only, as always; no demo data is seeded): put
#   UNIFEYE_MODE=real
#   PROTECT_HOST=...  PROTECT_USERNAME=...  PROTECT_PASSWORD=...
#   PROTECT_TLS_INSECURE=1   (or PROTECT_TLS_CA_FILE=...) for the recorder's own certificate
# in .env.stack.local at the root of the worktree (git ignores it), or set them in the environment.
# Sign-in still uses the test provider; "Avery Chen" is the administrator.
#
# A TURN relay for live video: put TURN_HOST, TURN_SECRET (and TURN_RELAY_ONLY=1 to force it) in
# .env.stack.local; MediaMTX is given the relay as well. docs/turn.md has a coturn to run.
set -euo pipefail
cmd="${1:-}"; slot="${2:-}"
[[ "$cmd" =~ ^(start|run|stop|url)$ && "$slot" =~ ^[1-9]$ ]] || { echo "usage: stack.sh start|run|stop|url <slot 1-9>" >&2; exit 2; }
[[ -f package.json && -f docker/mediamtx.yml ]] || { echo "run from the root of a Unifeye checkout" >&2; exit 2; }
base=$((3100 + slot * 10)); app=$base; idp=$((base+1)); api=$((base+2)); hls=$((base+3)); whep=$((base+4)); rtsp=$((base+5)); media=$((base+6)); hook=$((base+7))
dir="tmp/qa/stack-$slot"; url="http://localhost:$app"
[[ "$cmd" == url ]] && { echo "$url"; exit 0; }
stop() { [[ -f "$dir/pids" ]] && while read -r p; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done < "$dir/pids"; rm -f "$dir/pids"; for p in $app $idp $api $hook; do lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; done; }
[[ "$cmd" == stop ]] && { stop; echo "stopped slot $slot"; exit 0; }

mtx_bin() {
  [[ -n "${MEDIAMTX_BIN:-}" ]] && { echo "$MEDIAMTX_BIN"; return; }
  command -v mediamtx 2>/dev/null && return
  local cache="$HOME/.cache/unifeye-qa" v=v1.21.4 os arch
  [[ -x "$cache/mediamtx" ]] && { echo "$cache/mediamtx"; return; }
  os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m); [[ "$arch" == x86_64 ]] && arch=amd64; [[ "$arch" == aarch64 ]] && arch=arm64
  mkdir -p "$cache" && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/$v/mediamtx_${v}_${os}_${arch}.tar.gz" | tar -xz -C "$cache" mediamtx
  echo "$cache/mediamtx"
}

stop; mkdir -p "$dir"; : > "$dir/pids"
# In the foreground, Ctrl-C stops everything, even while it is still starting.
[[ "$cmd" == run ]] && trap 'echo; stop; echo "stopped slot $slot"; exit 0' INT TERM
[[ -d node_modules ]] || pnpm install --frozen-lockfile >/dev/null
if [[ -f .env.stack.local ]]; then set -a; source .env.stack.local; set +a; fi
export UNIFEYE_MODE="${UNIFEYE_MODE:-mock}"
if [[ "$UNIFEYE_MODE" == real ]]; then
  for k in PROTECT_HOST PROTECT_USERNAME PROTECT_PASSWORD; do [[ -n "${!k:-}" ]] || { echo "$k is needed for a real recorder (see the top of stack.sh)" >&2; exit 2; }; done
  export SEED_DEMO=0
else
  export SEED_DEMO=1
fi
export APP_URL="$url" OIDC_ISSUER="http://localhost:$idp" OIDC_ALLOW_INSECURE_ISSUER=1 OIDC_CLIENT_ID=unifeye-dev OIDC_ADMIT_CLAIM=groups OIDC_ADMIT_VALUES=unifeye
export BOOTSTRAP_ADMIN_ISSUER="http://localhost:$idp" BOOTSTRAP_ADMIN_SUBJECT=dev-admin TOKEN_ENC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= MEDIAMTX_HOOK_SECRET=qa-hook MEDIAMTX_API_SECRET=qa-api
export DATABASE_PATH="$dir/data/unifeye.sqlite" BACKUP_DIR="$dir/data/backups" MEDIA_CACHE_DIR="$dir/data/cache"
export MEDIAMTX_API_URL="http://127.0.0.1:$api" MEDIAMTX_HLS_URL="http://127.0.0.1:$hls" MEDIAMTX_WHEP_URL="http://127.0.0.1:$whep" HOOK_PORT=$hook TEST_OIDC_PORT=$idp
mkdir -p "$dir/data"

nohup pnpm exec tsx scripts/test-oidc-provider.ts > "$dir/idp.log" 2>&1 & echo $! >> "$dir/pids"
# A TURN relay (docs/turn.md), when .env.stack.local sets TURN_HOST and TURN_SECRET: MediaMTX uses it too, as in compose.yaml.
turn=(); [[ -n "${TURN_HOST:-}" ]] && turn=(MTX_WEBRTCICESERVERS2_0_URL="turn:$TURN_HOST:${TURN_PORT:-3478}?transport=udp" MTX_WEBRTCICESERVERS2_0_USERNAME=AUTH_SECRET MTX_WEBRTCICESERVERS2_0_PASSWORD="$TURN_SECRET")
MTX_AUTHHTTPADDRESS="http://127.0.0.1:$hook/mediamtx-auth?secret=qa-hook" MTX_WEBRTCADDITIONALHOSTS=127.0.0.1 \
MTX_APIADDRESS=":$api" MTX_HLSADDRESS=":$hls" MTX_WEBRTCADDRESS=":$whep" MTX_RTSPADDRESS="127.0.0.1:$rtsp" MTX_WEBRTCLOCALUDPADDRESS=":$media" MTX_WEBRTCLOCALTCPADDRESS=":$media" \
  nohup env ${turn[@]+"${turn[@]}"} "$(mtx_bin)" docker/mediamtx.yml > "$dir/mediamtx.log" 2>&1 & echo $! >> "$dir/pids"
nohup pnpm exec next dev -p "$app" > "$dir/app.log" 2>&1 & echo $! >> "$dir/pids"

for _ in $(seq 1 60); do
  if curl -fsS -m 3 "$url/api/ready" 2>/dev/null | grep -q '"relay":true'; then
    echo "$url"; echo "logs: $dir/{app,idp,mediamtx}.log   sign in: open $url and pick a test identity ($UNIFEYE_MODE mode)"
    [[ "$cmd" == start ]] && exit 0
    echo "Ctrl-C stops everything."
    tail -n 0 -f "$dir/app.log" & tailer=$!
    wait "$tailer"
  fi
  sleep 1
done
echo "stack did not become ready; see $dir/*.log" >&2; curl -s -m 3 "$url/api/ready" >&2 || true
[[ "$cmd" == run ]] && stop
exit 1
