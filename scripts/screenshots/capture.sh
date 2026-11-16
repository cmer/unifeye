#!/usr/bin/env bash
# Retakes the README screenshots in docs/screenshots/ against a fresh mock stack that shows the
# stills in assets/demo-cameras/. Needs what the QA stack needs (pnpm, FFmpeg, MediaMTX) plus the
# agent-browser CLI (npm i -g agent-browser).
#   scripts/screenshots/capture.sh [slot]    slot 1-9 picks the ports (default 8); see stack.sh
# The slot's data in tmp/qa/stack-<slot>/data is wiped first so the demo data is seeded fresh.
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v agent-browser >/dev/null || { echo "needs agent-browser (npm i -g agent-browser)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "needs FFmpeg" >&2; exit 1; }
slot="${1:-8}"; stack=.claude/skills/qa-sweep/scripts/stack.sh; shots=tmp/screenshots; out=docs/screenshots
ab() { agent-browser --session unifeye-screenshots "$@" >/dev/null; }
js() { agent-browser --session unifeye-screenshots eval "$1"; }
cleanup() { agent-browser --session unifeye-screenshots close >/dev/null 2>&1 || true; bash "$stack" stop "$slot" >/dev/null || true; }
trap cleanup EXIT

rm -rf "tmp/qa/stack-$slot/data"; mkdir -p "$shots" "$out"
MOCK_PHOTOS="$PWD/assets/demo-cameras" bash "$stack" start "$slot" >/dev/null
url=$(bash "$stack" url "$slot")
# Keeps the pointer over the sidebar so no camera tile shows its hover outline.
park() { ab mouse move 120 600; sleep 1; }
# Thumbnails of events that arrive while the page is open can stay blank in a headless browser
# (lazy images that never load), so re-request any that are missing until all visible ones are in.
thumbs() {
  for _ in $(seq 1 60); do
    n=$(js "[...document.images].forEach(i=>{if(!i.complete||!i.naturalWidth){i.loading='eager';const s=i.src;i.src='';i.src=s;}}); [...document.images].slice(0,16).filter(i=>!i.complete||!i.naturalWidth).length")
    [[ "$n" == "0" ]] && return; sleep 1
  done
  echo "some thumbnails did not load" >&2
}

echo "signing in as Avery Chen"
ab set viewport 1600 1000
ab open "$url"
ab find role link click --name "Avery Chen"; sleep 6
js "localStorage.setItem('theme','dark'); localStorage.setItem('unifeye.sidebar','1'); 1" >/dev/null

echo "01 camera wall"
ab set viewport 1600 758   # exactly three rows of tiles at this width
ab open "$url/?all"; sleep 10; park
ab screenshot "$shots/01-wall.png"

echo "02 one camera"
ab set viewport 1600 1000
ab find role button click --name "Open Loading Dock"; sleep 8; park
ab screenshot "$shots/02-camera.png"

echo "03 activity"
ab open "$url/activity"; sleep 8; thumbs; park
ab screenshot "$shots/03-activity.png"

echo "04 camera access"
ab set viewport 1600 800
ab open "$url/admin"; sleep 3
ab find role tab click --name "Camera access"; sleep 2; park
ab screenshot "$shots/04-access.png"

echo "05 phone, light"
js "localStorage.setItem('theme','light'); 1" >/dev/null
ab set device "iPhone 14"
ab open "$url/"; sleep 10   # lands on the Building Overview view
ab screenshot "$shots/05-phone.png"

for f in 01-wall 02-camera 03-activity 04-access; do ffmpeg -loglevel error -y -i "$shots/$f.png" -q:v 3 "$out/$f.jpg"; done
ffmpeg -loglevel error -y -i "$shots/05-phone.png" -vf scale=585:-2 -q:v 3 "$out/05-phone.jpg"
echo "saved to $out/ (raw captures in $shots/). Look at each one before committing."
