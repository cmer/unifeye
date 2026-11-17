# Fix workflow for QA issues

## Builder

One builder per issue, in its own worktree and stack slot.

1. Read `AGENTS.md` first. This Next.js version differs from what you know: read the relevant guide under `node_modules/next/dist/docs/` before changing anything Next-specific.
2. Cut `fix/<issue#>-<slug>` from current `origin/main`.
3. Write a failing test first, at the lowest level that shows the bug:
   - who may see what, views, landing: `tests/policy.test.ts`
   - whether access still holds, revocation: `tests/access.test.ts`
   - anything over HTTP, media tickets, preview: `tests/api.test.ts` (through `handleApi`, with the fixture in `src/server/testing/`)
   - sign-in: `tests/oidc.test.ts`; MediaMTX wire format: `tests/mediamtx.test.ts`; migrations, backup, time zones: `tests/ops.test.ts`
   - There is no browser test suite. For a UI-only bug, move the logic into a testable function where that is natural; otherwise the browser reproduction in step 6 is the test, and the PR says so.
4. Fix the root cause, not the symptom. Keep the fix where the rule lives: camera access in `src/server/authz/policy.ts`, standing access in `authz/access.ts`, views in `authz/views.ts`, every change to Unifeye data in `src/server/admin.ts`, everything said to MediaMTX behind the relay in `src/server/media/`.
5. A schema change needs a new versioned migration from `pnpm db:generate`. Never edit an existing file under `drizzle/`, never push a schema.
6. Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Then re-run the issue's reproduction in the browser on your stack at 390 px and 1280 px.
7. Update `docs/` when behavior the docs describe changed. Never move anything from "not verified" to "verified" in `docs/verification.md` on the strength of mock-mode testing.
8. Open a PR with `Fixes #<n>`, the test names, and uploaded before and after screenshots. End the PR body with the attribution line your harness gives you.
9. Report any place the same bug pattern appears elsewhere in the app.

Never:
- weaken a test, a validation, an access check, the CSRF check or a rate limit to make a bug go away
- add a way to sign in without the identity provider, or anything that stores a password
- add any call that changes the recorder; the adapter contract in `src/server/protect/types.ts` is read-only
- let a browser see an RTSP URL, a MediaMTX address or credential, or a recorder cookie
- make "forbidden" distinguishable from "not found"
- skip hooks, or commit `.env*.local`, `data/` or `tmp/`

If the fix needs a judgment call about wording, layout, flow or who may do what, stop and report back instead of choosing.

## Reviewer

A reviewer is a different agent from the builder, in a fresh worktree and its own stack slot. It gets the issue and the PR, not the builder's reasoning, and tries to prove the fix wrong.

1. Run the issue's verification protocol in the browser.
2. Confirm the new test fails without the fix (revert the fix locally, keep the test) and passes with it.
3. Try to break the fix: neighbouring edge cases, the other kinds of people (administrator, staff, no cameras, disabled, previewing), both widths, both themes.
4. Check the "Never" list above against the diff, line by line.
5. For anything touching access or media: confirm a forbidden id still behaves exactly like a missing one, and that revoked access still stops within 30 seconds on a running stream.
6. Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Check for regressions in the screens the diff touches.
7. Post **PASS** or **CHANGES** as a PR comment, with numbered findings. Each finding says what input or state produces what wrong result.
