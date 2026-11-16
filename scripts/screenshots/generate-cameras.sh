#!/usr/bin/env bash
# Regenerates the AI-generated stills in assets/demo-cameras/ that the simulated cameras show when
# MOCK_PHOTOS is set (and that the README screenshots use). Needs the Codex CLI, signed in, and FFmpeg.
#   scripts/screenshots/generate-cameras.sh               all cameras
#   scripts/screenshots/generate-cameras.sh mock-04 ...   only these
# Each still is generated from the prompt below, then cropped to 1280x720 JPEG. Look at every result
# before committing: generated images can have odd details (hands, text, warped objects).
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v codex >/dev/null || { echo "needs the Codex CLI (codex), signed in" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "needs FFmpeg" >&2; exit 1; }

STYLE="Wide-angle lens with only slight barrel distortion, no black vignette or fisheye ring, mild sensor noise, realistic modern IP camera look with natural colours, 16:9 landscape, no text, no timestamp, no overlay, no watermark. All cameras are in the same small modern office building."

# One line per camera in src/server/protect/mock-data.ts: protect id, then what the camera sees.
CAMERAS=(
  "mock-01|a ceiling-mounted camera above the glass front entrance, daytime, looking down at the doors and the sidewalk outside, one person walking in"
  "mock-02|a modern office lobby front desk seen from above and behind, a receptionist at the desk and a visitor standing in front, daytime"
  "mock-03|a reception waiting area with a few armchairs, a coffee table and plants, one person sitting reading a phone"
  "mock-04|a long upper-floor office hallway with doors and carpet, bright fluorescent lighting, empty, looking east toward a window"
  "mock-05|an upper-floor office corridor with glass meeting rooms on one side, one person walking away, carpet floor"
  "mock-06|an upper-floor staff lounge with sofas, a kitchenette and a large window, two people chatting"
  "mock-07|a concrete stairwell with metal handrails seen from the landing above, empty, cool lighting"
  "mock-08|a rooftop terrace with outdoor furniture, planters and a city skyline, overcast daytime"
  "mock-09|an outdoor office parking lot from a pole-mounted camera high up, a dozen parked cars, daytime, painted lines"
  "mock-10|the south side of an outdoor office parking lot from a pole-mounted camera, a row of parked cars, a curb with shrubs and a walkway to the building, overcast daytime"
  "mock-11|an outdoor loading dock behind a building with a box truck backed up to an open roller door, a worker with a hand truck"
  "mock-12|a rear exit door of an office building opening onto an alley with dumpsters and a bike rack, late afternoon"
  "mock-13|a stock room with metal shelving full of boxes and supplies, overhead lighting, one person checking shelves"
  "mock-14|a small server closet with a network rack, blinking switches and cable management, dim cool lighting, empty"
)

work="tmp/demo-cameras"; mkdir -p "$work" assets/demo-cameras
gen() {
  local id="$1" subject="$2"
  ( cd "$work" && codex exec --skip-git-repo-check --sandbox workspace-write \
      "Generate one photorealistic image with your image generation tool and save it as $id.png in the current directory (copy it there). Subject: a still frame from a security camera: $subject. $STYLE" > "$id.log" 2>&1 ) \
    && ffmpeg -loglevel error -y -i "$work/$id.png" -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -q:v 4 "assets/demo-cameras/$id.jpg" \
    && echo "ok      $id" || echo "FAILED  $id (see $work/$id.log)"
}
for line in "${CAMERAS[@]}"; do
  id="${line%%|*}"
  [[ $# -eq 0 || " $* " == *" $id "* ]] || continue
  gen "$id" "${line#*|}" &
done
wait
