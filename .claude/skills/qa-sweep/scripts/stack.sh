#!/usr/bin/env bash
# Runs one isolated Unifeye stack (test sign-in provider, MediaMTX, app) in mock mode for QA.
#   stack.sh start <slot 1-9>   prints the app URL when everything answers
#   stack.sh stop  <slot>
#   stack.sh url   <slot>
# Run it from the root of your own worktree. Each slot has its own ports; each worktree its own data.
set -euo pipefail
cmd="${1:-}"; slot="${2:-}"
[[ "$cmd" =~ ^(start|stop|url)$ && "$slot" =~ ^[1-9]$ ]] || { echo "usage: stack.sh start|stop|url <slot 1-9>" >&2; exit 2; }
[[ -f package.json && -f docker/mediamtx.yml ]] || { echo "run from the root of a Unifeye checkout" >&2; exit 2; }
base=$((3100 + slot * 10)); app=$base; idp=$((base+1)); api=$((base+2)); hls=$((base+3)); whep=$((base+4)); rtsp=$((base+5)); media=$((base+6))
dir="tmp/qa/stack-$slot"; url="http://localhost:$app"
[[ "$cmd" == url ]] && { echo "$url"; exit 0; }
stop() { [[ -f "$dir/pids" ]] && while read -r p; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done < "$dir/pids"; rm -f "$dir/pids"; for p in $app $idp $api; do lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; done; }
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
[[ -d node_modules ]] || pnpm install --frozen-lockfile >/dev/null
export UNIFEYE_MODE=mock SEED_DEMO=1 APP_URL="$url" OIDC_ISSUER="http://localhost:$idp" OIDC_ALLOW_INSECURE_ISSUER=1 OIDC_CLIENT_ID=unifeye-dev OIDC_ADMIT_CLAIM=groups OIDC_ADMIT_VALUES=unifeye
export BOOTSTRAP_ADMIN_ISSUER="http://localhost:$idp" BOOTSTRAP_ADMIN_SUBJECT=dev-admin TOKEN_ENC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= MEDIAMTX_HOOK_SECRET=qa-hook MEDIAMTX_API_SECRET=qa-api
export DATABASE_PATH="$dir/data/unifeye.sqlite" BACKUP_DIR="$dir/data/backups" MEDIA_CACHE_DIR="$dir/data/cache"
export MEDIAMTX_API_URL="http://127.0.0.1:$api" MEDIAMTX_HLS_URL="http://127.0.0.1:$hls" MEDIAMTX_WHEP_URL="http://127.0.0.1:$whep" TEST_OIDC_PORT=$idp
mkdir -p "$dir/data"

nohup pnpm exec tsx scripts/test-oidc-provider.ts > "$dir/idp.log" 2>&1 & echo $! >> "$dir/pids"
MTX_AUTHHTTPADDRESS="http://127.0.0.1:$app/api/internal/mediamtx-auth?secret=qa-hook" MTX_WEBRTCADDITIONALHOSTS=127.0.0.1 \
MTX_APIADDRESS=":$api" MTX_HLSADDRESS=":$hls" MTX_WEBRTCADDRESS=":$whep" MTX_RTSPADDRESS="127.0.0.1:$rtsp" MTX_WEBRTCLOCALUDPADDRESS=":$media" MTX_WEBRTCLOCALTCPADDRESS=":$media" \
  nohup "$(mtx_bin)" docker/mediamtx.yml > "$dir/mediamtx.log" 2>&1 & echo $! >> "$dir/pids"
nohup pnpm exec next dev -p "$app" > "$dir/app.log" 2>&1 & echo $! >> "$dir/pids"

for _ in $(seq 1 60); do
  if curl -fsS -m 3 "$url/api/ready" 2>/dev/null | grep -q '"relay":true'; then echo "$url"; echo "logs: $dir/{app,idp,mediamtx}.log   sign in: open $url and pick a test identity"; exit 0; fi
  sleep 1
done
echo "stack did not become ready; see $dir/*.log" >&2; curl -s -m 3 "$url/api/ready" >&2 || true; exit 1
