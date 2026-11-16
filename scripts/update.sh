#!/usr/bin/env bash
# Updates a Compose deployment of Unifeye to the latest code and restarts it.
#
#   scripts/update.sh            update to origin/main (does nothing if already there)
#   scripts/update.sh --force    rebuild and restart even if already up to date
#   scripts/update.sh <commit>   switch to a specific commit or tag, e.g. to go back a version
#
# Run it on the server, from the checkout that holds .env and compose.yaml. UNIFEYE_BRANCH picks
# another branch than main.
#
# Order: fetch, back up the database, check out the code, build the new image while the current
# version keeps running, then restart and wait until both containers are healthy. If the build
# fails, the running version is left untouched. Local edits to tracked files (git diff) are carried
# over to the new code: dropped if the new code already has them, and if they conflict nothing is
# changed. Going back to a version from before a database migration also needs that version's
# database: see "Upgrades and rollback" in docs/deployment.md.
set -euo pipefail

# Everything runs inside main: checking out new code replaces this file, and bash reads a script as
# it goes, so the rest of a running update must already be parsed.
main() {
  cd "$(dirname "$(readlink -f "$0")")/.."
  [[ -f compose.yaml && -d .git ]] || die "Run this from a Unifeye checkout (scripts/update.sh)."

  local force=0 target=""
  case "${1:-}" in
    --force) force=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
    -*) die "Unknown option: $1 (see --help)" ;;
    "") ;;
    *) target="$1" ;;
  esac

  say "Fetching"
  git fetch --quiet --tags origin
  local current next
  current=$(git rev-parse HEAD)
  next=$(git rev-parse --verify --quiet "${target:-origin/${UNIFEYE_BRANCH:-main}}^{commit}") || die "Unknown commit: ${target:-origin/${UNIFEYE_BRANCH:-main}}"
  if [[ "$current" == "$next" && $force -eq 0 ]]; then
    echo "Already at $(git log --oneline -1 HEAD). Use --force to rebuild anyway."
    return 0
  fi
  echo "Current: $(git log --oneline -1 "$current")"
  echo "New:     $(git log --oneline -1 "$next")"
  if [[ "$current" != "$next" ]]; then echo; git log --oneline "$current..$next" | head -20; fi
  if ! git diff --quiet "$current" "$next" -- drizzle; then
    echo; echo "This update includes a database migration. It runs at start-up, after an automatic backup."
  fi

  say "Backing up the database"
  if [[ -n "$(docker compose ps -q --status running app 2>/dev/null)" ]]; then
    docker compose exec -T app node cli.mjs backup | tail -1
  else
    echo "The app is not running; skipping the backup."
  fi

  say "Checking out $(git rev-parse --short "$next")"
  local patch=""
  if ! git diff --quiet; then
    patch=".local-changes-$(date +%Y%m%d-%H%M%S).diff"
    git diff > "$patch"
    echo "Local changes found; saved a copy as $patch"
  fi
  git checkout --quiet -- .
  git checkout --quiet --detach "$next"
  if [[ -n "$patch" ]]; then
    if git apply --check "$patch" 2>/dev/null; then
      git apply "$patch"; echo "Local changes re-applied."
    elif git apply --reverse --check "$patch" 2>/dev/null; then
      echo "The new code already has the local changes; dropping them."
    else
      git checkout --quiet --detach "$current"; git apply "$patch"
      die "The local changes no longer apply to the new code. Nothing was changed; still at $(git rev-parse --short "$current"). See $patch."
    fi
  fi

  say "Building (the current version keeps running)"
  if ! docker compose build --pull; then
    git checkout --quiet -- .
    git checkout --quiet --detach "$current"
    if [[ -n "$patch" ]]; then git apply "$patch"; fi
    die "The build failed. Back on the previous code; the running version was not touched."
  fi

  say "Restarting"
  docker compose up -d --remove-orphans

  say "Waiting for both containers to be healthy"
  local deadline=$((SECONDS + 180))
  until [[ "$(health app)" == healthy && "$(health mediamtx)" == healthy ]]; do
    if (( SECONDS > deadline )); then
      docker compose ps; docker compose logs --tail 40 app
      die "Not healthy after 3 minutes. To go back: scripts/update.sh $(git rev-parse --short "$current")"
    fi
    sleep 3
  done
  docker compose ps --format 'table {{.Name}}\t{{.Status}}'
  echo; docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>r.text()).then(console.log)"

  docker image prune -f > /dev/null
  say "Done: $(git log --oneline -1 HEAD)"
  echo "To go back: scripts/update.sh $(git rev-parse --short "$current")"
}

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }
health() { docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$1")" 2>/dev/null || echo missing; }

main "$@"
exit
