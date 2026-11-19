#!/usr/bin/env bash
# Tag and publish a Unifeye release.
#
#   scripts/release.sh patch            # 0.3.1 -> 0.3.2
#   scripts/release.sh minor            # 0.3.1 -> 0.4.0
#   scripts/release.sh major            # 0.3.1 -> 1.0.0
#   scripts/release.sh 0.5.0            # exactly this version (1.0.0-beta.1 makes a prerelease)
#
# Options:
#   --dry-run   Show the version and the release notes. Changes nothing.
#   --draft     Create the GitHub release as a draft. Publish it on GitHub when ready.
#   --yes       Don't ask before releasing.
#
# What it does:
#   1. Checks: clean tree, at origin/main, the tag is new, gh is signed in, and .changelog/ has
#      well-formed entries (see scripts/changelog.mjs).
#   2. Sets "version" in package.json, writes the .changelog/ entries into CHANGELOG.md as
#      "## X.Y.Z - date" and deletes them.
#   3. Runs typecheck, lint and the tests.
#   4. Commits "Release vX.Y.Z", creates the annotated tag vX.Y.Z and pushes both to main.
#   5. Creates the GitHub release, with that version's CHANGELOG.md section as its notes.
#
# The current version is the newest vX.Y.Z tag, or package.json's version before the first tag.
# Nothing is committed or pushed until the checks pass; a failure before that puts package.json,
# CHANGELOG.md and .changelog/ back. It runs from any checkout or worktree whose HEAD is origin/main.
#
# Running servers learn about the release from GitHub's "latest release" (src/server/version.ts)
# and show it in Diagnostics. Drafts and prereleases don't count as latest.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHANGELOG=CHANGELOG.md
ENTRIES=.changelog
REMOTE="${REMOTE:-origin}"
BRANCH=main

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# ---- arguments
WANT="" DRY=0 YES=0 DRAFT=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --draft) DRAFT=(--draft) ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $a (see --help)" ;;
    *) [[ -z "$WANT" ]] || die "one version or one of major, minor, patch, please"; WANT="${a#v}" ;;
  esac
done
[[ -n "$WANT" ]] || die "usage: scripts/release.sh <major|minor|patch|X.Y.Z> [--dry-run] [--draft] [--yes]"

# ---- which version
git fetch --quiet --tags "$REMOTE"
# Newest final release tag; prerelease tags (v1.0.0-beta.1) don't count as the current version.
PREV_TAG="$(git tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
PKG_VERSION="$(node -p "require('./package.json').version")"
CURRENT="${PREV_TAG#v}"
[[ -n "$CURRENT" ]] || CURRENT="$PKG_VERSION"
IFS=. read -r MA MI PA <<< "$CURRENT"
case "$WANT" in
  major) VERSION="$((MA + 1)).0.0" ;;
  minor) VERSION="$MA.$((MI + 1)).0" ;;
  patch) VERSION="$MA.$MI.$((PA + 1))" ;;
  *) VERSION="$WANT" ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "\"$WANT\" isn't major, minor, patch or a version like 1.2.3 or 1.2.3-beta.1"
TAG="v$VERSION"
PRERELEASE=()
[[ "$VERSION" == *-* ]] && PRERELEASE=(--prerelease)
if [[ -n "$PREV_TAG" ]]; then
  # A release must move forward. Compare the x.y.z parts; a prerelease of the current version is behind it.
  NEWEST="$(printf '%s\n%s\n' "$CURRENT" "${VERSION%%-*}" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)"
  [[ "$NEWEST" == "${VERSION%%-*}" && ( "${VERSION%%-*}" != "$CURRENT" ) ]] || die "$VERSION isn't newer than the current release, $CURRENT"
fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"

# The body of a CHANGELOG.md version section, blank lines trimmed.
changelog_section() {
  awk -v h="## $1" '
    index($0, h) == 1 && (length($0) == length(h) || substr($0, length(h) + 1, 1) == " ") { on = 1; next }
    on && /^## / { exit }
    on { print }
  ' "$CHANGELOG" | awk 'NF { for (; blank > 0; blank--) print ""; print; seen = 1; next } seen { blank++ }'
}

# ---- preflight
step "Checking"
problems=()
[[ -f "$CHANGELOG" ]] || die "$CHANGELOG is missing"
UNRELEASED="$(node scripts/changelog.mjs notes)" || die "fix the $ENTRIES/ entries above first"
! grep -q '^## Unreleased' "$CHANGELOG" || problems+=("$CHANGELOG has an \"## Unreleased\" section; move each of its lines into a $ENTRIES/ file and delete the section")
[[ -n "$UNRELEASED" ]] || problems+=("no entries in $ENTRIES/; add this release's changes first (node scripts/changelog.mjs add ...)")
[[ -z "$(git status --porcelain)" ]] || problems+=("the working tree isn't clean; commit or stash first")
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "$REMOTE/$BRANCH")" ]] || problems+=("HEAD isn't $REMOTE/$BRANCH; releases are cut from the tip of $BRANCH (git switch --detach $REMOTE/$BRANCH)")
command -v gh >/dev/null || problems+=("GitHub CLI not found (brew install gh)")
gh auth status >/dev/null 2>&1 || problems+=("GitHub CLI isn't signed in; run: gh auth login")

echo "    ${CURRENT}${PREV_TAG:+ ($PREV_TAG)} -> $VERSION${PRERELEASE[0]:+ (prerelease)}${DRAFT[0]:+ (draft)}"
echo
echo "    Release notes, from $ENTRIES/:"
printf '%s\n' "$UNRELEASED" | sed 's/^/    | /'

if [[ $DRY == 1 ]]; then
  echo
  if [[ ${#problems[@]} -gt 0 ]]; then
    echo "Dry run. A real release would stop on:"; printf '  - %s\n' "${problems[@]}"
  else
    echo "Dry run. Everything is ready: scripts/release.sh $WANT"
  fi
  exit 0
fi
[[ ${#problems[@]} -eq 0 ]] || { printf 'error: %s\n' "${problems[@]}" >&2; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

if [[ $YES == 0 ]]; then
  echo
  read -r -p "Release $TAG to $REPO? [y/N] " answer
  [[ "$answer" == [yY]* ]] || die "stopped; nothing was changed"
fi

# ---- version and changelog (undone on failure until committed)
START="$(git rev-parse HEAD)"
COMMITTED=0
restore() { [[ $COMMITTED == 1 ]] || git checkout --quiet -- package.json "$CHANGELOG" "$ENTRIES"; }
trap restore EXIT
node -e '
  const fs = require("fs"), s = fs.readFileSync("package.json", "utf8");
  const out = s.replace(/("version":\s*")[^"]*(")/, `$1${process.argv[1]}$2`);
  if (JSON.parse(out).version !== process.argv[1]) throw new Error("could not set the version in package.json");
  fs.writeFileSync("package.json", out);
' "$VERSION"
# The .changelog/ entries become the new version's section, above the previous release, and are deleted.
node scripts/changelog.mjs apply "$VERSION" "$(date +%Y-%m-%d)"

# ---- checks
step "Running typecheck, lint and tests"
pnpm typecheck
pnpm lint
pnpm test

# ---- commit, tag, push
step "Tagging $TAG"
git add package.json "$CHANGELOG" "$ENTRIES"
git commit --quiet -m "Release $TAG"
COMMITTED=1
git tag -a "$TAG" -m "$TAG"
if ! git push --quiet --atomic "$REMOTE" "HEAD:refs/heads/$BRANCH" "$TAG"; then
  # Nothing reached GitHub (the push is all or nothing), so put this checkout back as it was.
  git tag -d "$TAG" >/dev/null
  git reset --quiet --hard "$START"
  die "the push was refused (did $BRANCH move?). Nothing was released; fetch and run it again."
fi

# ---- GitHub release
step "Creating the GitHub release"
NOTES="$(mktemp)"
{
  changelog_section "$VERSION"
  if [[ -n "$PREV_TAG" ]]; then echo; echo "All changes: https://github.com/$REPO/compare/$PREV_TAG...$TAG"; fi
} > "$NOTES"
# Servers look at "latest release" to offer updates, so only a final, published release takes that spot.
LATEST=()
[[ ${#DRAFT[@]} -eq 0 && ${#PRERELEASE[@]} -eq 0 ]] && LATEST=(--latest)
if ! gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes-file "$NOTES" --verify-tag \
    ${DRAFT[@]+"${DRAFT[@]}"} ${PRERELEASE[@]+"${PRERELEASE[@]}"} ${LATEST[@]+"${LATEST[@]}"}; then
  die "$TAG is tagged and pushed, but the GitHub release wasn't created. Finish with:
  gh release create $TAG --repo $REPO --title $TAG --notes-file $NOTES --verify-tag"
fi
rm -f "$NOTES"

step "Released $TAG"
gh release view "$TAG" --repo "$REPO" --json url -q .url
