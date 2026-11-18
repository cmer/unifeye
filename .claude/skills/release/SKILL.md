---
name: release
description: Tag and publish a Unifeye release with scripts/release.sh, which updates CHANGELOG.md and package.json, tags, pushes and creates the GitHub release. Use when Carl asks to release, ship, tag or publish a version (e.g. "release minor", "cut a patch release", "release 0.5.0", "/release major").
---

# Release Unifeye

`scripts/release.sh <major|minor|patch|X.Y.Z>` does the work. It sets the version in
`package.json`, turns CHANGELOG.md's `## Unreleased` section into `## X.Y.Z - date`, runs
typecheck, lint and the tests, commits "Release vX.Y.Z", tags, pushes to `main`, and creates
the GitHub release with that changelog section as its notes. Your job is to pick the version,
get the repository ready, run the script, and report.

**Arguments:** $ARGUMENTS

## 1. Pick the version

- Named version (`0.5.0`) or `major`, `minor`, `patch`: pass it to the script as given. The
  script works out the number from the newest `vX.Y.Z` tag (or `package.json` before the
  first tag).
- Nothing named: run `scripts/release.sh patch --dry-run` to see the current version and
  the unreleased entries. Propose `patch` when they are all under `### Fixed`, `minor` when
  anything is under `### Added` or `### Changed`, and `major` only if Carl asks for it.
- A suffix such as `1.0.0-beta.1` becomes a GitHub prerelease.

## 2. Get the repository ready

Start with `scripts/release.sh <version> --dry-run`. It changes nothing, prints the version
and the release notes, and lists everything a real run would stop on. Fix what it lists:

- **Not at `origin/main`.** Releases are cut from the tip of `main`. In a worktree, where
  `main` is checked out elsewhere, run `git fetch origin && git switch --detach origin/main`
  (only with a clean tree). If the work to release is still on a branch or in an open pull
  request, say so and stop: it has to be merged first.
- **Working tree isn't clean.** Show `git status --short` and ask what to do. Don't commit,
  stash or discard anything without a yes.
- **Nothing under `## Unreleased`.** Compare the changelog with `git log <last tag>..HEAD
  --oneline` and draft the missing entries following the Changelog rules in CLAUDE.md. Show
  them to Carl, and get them onto `main` (a commit or a pull request, as he prefers) before
  releasing.
- **Entries are there, but check them anyway.** Compare them with the same `git log`. If a
  change people would notice is missing, or an entry describes something that was later
  reverted, raise it before releasing.
- **`gh` isn't signed in.** Ask Carl to run `! gh auth login`.

## 3. Run it

A release pushes to `main`, publishes a public tag and tells every running server that an
update exists. Show Carl the version and the release notes from the dry run and get a yes
for that exact version first. Once is enough, including when he named the version himself.

```sh
scripts/release.sh <version> --yes      # add --draft to review on GitHub before publishing
```

`--yes` skips the script's own prompt, which is why the confirmation above is yours to get.
The tests take about a minute. Don't skip the checks or work around a failing one: fix the
cause on `main` and run it again.

## 4. Afterwards

- Report the release URL the script prints and the version.
- A draft or prerelease doesn't count as the latest release, so servers won't offer it.
  Say so if Carl used `--draft`; he publishes it on GitHub when ready.
- Production doesn't update itself. If Carl wants it updated, that is `scripts/update.sh`
  on the server, and a separate request.
- If the script failed before "Tagging", nothing was committed or pushed, and
  `package.json` and `CHANGELOG.md` were put back. Fix the cause and run it again.
- If the push was refused, the script undid its commit and tag; `main` moved. Fetch, switch
  to the new `origin/main` and run it again.
- If it failed at "Creating the GitHub release", the tag is already on GitHub. Don't rerun
  the script; run the `gh release create` command it printed.
