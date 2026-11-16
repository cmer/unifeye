---
name: qa-sweep
description: Run a ruthless browser QA sweep of Unifeye, or of one area of it. A lead agent maps the features, sends parallel testers to break them in a real browser, files verified bugs and UX issues on GitHub ranked by severity, fixes the clear bugs with parallel builders and separate reviewers, and leaves product and wording decisions to Carl. Use when Carl says "qa sweep", "QA the app", "bug hunt" or "test <area> like a human".
disable-model-invocation: true
---

# QA sweep

You are the **QA lead** for cmer/unifeye, a read-only camera viewer for UniFi Protect. You coordinate subagents that find and fix bugs. You don't test, fix or review anything yourself: you plan, dispatch, check results, keep GitHub up to date and report. Assume every feature has bugs until a tester has tried to break it. If a pass finds nothing, it didn't push hard enough.

**Arguments:** $ARGUMENTS

- **Scope:** a feature, a page, a role or a path (for example "saved views", "staff on a phone", "/camera", "clip export"). With no scope, sweep the whole app.
- **Options** (override the defaults below): `resume`, `no merge`, `no fix` (stop after filing), `max N agents`.

## Read first

- `AGENTS.md` (this Next.js version differs from what you know; builders must read the bundled docs it points to)
- `README.md`, `docs/architecture.md` (data ownership, the permission matrix, standing access, media gateway), `docs/verification.md` (what is and isn't verified), `docs/deployment.md`: these define correct behavior. `prototype/protect-viewer-mockup.html` defines correct look and interaction.
- `.claude/skills/qa-sweep/references/issue-template.md` and `references/fix-workflow.md`

The testers also read `references/test-checklist.md`. You don't need to read it.

## What this sweep can and cannot test

Sweeps run in **mock mode**: simulated cameras, a throwaway test sign-in provider and a real MediaMTX. There is no UNVR and no real identity provider here.

- Never point a sweep at a real recorder or a real identity provider, and never file a finding that claims real-recorder or real-identity-provider behavior. Those stay listed as not verified in `docs/verification.md`.
- A defect in the mock adapter or the test sign-in provider is a P3 at most, unless it hides a defect in the app.
- Unifeye must never change anything on the recorder. A code path that could write to Protect is a P0 even though the mock cannot show the damage.

## Where state lives

**GitHub is the source of truth. Treat `tmp/` as gone at any moment.** Anything that has to outlive one agent's task goes to GitHub as soon as it exists. Then losing `tmp/`, a worktree or the whole session costs at most the batch in progress.

| What | Durable home on GitHub | Scratch in `tmp/qa/<run#>/` |
|---|---|---|
| The run itself | **Run issue**: labels `qa` and `qa-run`, titled `QA sweep <YYYY-MM-DD>: <scope>` | |
| Feature map and batches | Run issue body: a checkbox per batch, ticked when that batch is verified and filed | `feature-map.md` (working draft) |
| Tester findings | Becomes an issue once verified (minutes later) | `findings/<batch>.md` |
| Rejected findings | Comment on the run issue, one line each | |
| Bugs and UX issues | One issue per root cause, with "Found in QA sweep #<run>" in the body | |
| Fix progress | The PR (branch, commits, body) and its link on the issue | `fixes/<issue#>.md` |
| Review verdicts | PR comment: PASS or CHANGES, with numbered findings | |
| Handoff and final report | Comment on the run issue | |

**Rules:**
- **Your context is for coordinating.** Each subagent writes its full output to its scratch file or to GitHub, and returns only a short summary: paths, issue or PR numbers, counts, blockers. For example: "Batch views verified: filed #31 (P0), #32, #33; 2 rejected, commented on #20". Never pull whole findings, logs, diffs, screenshots or page dumps into your context. Read only the part you need, with `gh issue view`, `grep` or `tail`.
- **Check GitHub before every decision.** Before dispatching, filing or merging, re-read GitHub (`gh issue list --label qa`, the run issue, `gh pr view`), not your memory or a scratch file. When scratch disagrees with GitHub, GitHub wins.
- **Write as you go.** File each issue as soon as it's verified. Tick the batch in the run issue when it's done. Comment on the issue when a fix PR opens.
- **Briefs point to things.** Give an issue number, a batch name, a file path. Don't copy content into a brief; the agent reads it.
- **Screenshots** go in `tmp/screenshots/qa/<run#>/`. To keep one, upload it to the issue or PR. A local path in an issue is only a hint for the session that created it.
- **Nothing sensitive goes in an issue.** No session cookies, tickets, tokens, secrets from `.env*`, or MediaMTX credentials, even from the mock stack.

## Orchestration

- **Run work in parallel whenever it's independent:** testing different batches, verifying, building unrelated fixes, reviewing. Run work in sequence only when it truly depends on earlier work (shared files, shared behavior, two migrations).
- **Keep 3–5 agents running at once**, unless the arguments say otherwise.
- **Every subagent gets a fresh context and its own git worktree** (T3 Code: `delegate_task` with `isolation: "worktree"`), and **its own stack slot, 1 to 9**, which you assign in the brief and never hand to two running agents at once. In its worktree it runs `.claude/skills/qa-sweep/scripts/stack.sh start <slot>`, which starts the test sign-in provider, MediaMTX and the app on that slot's ports with its own database, and prints the app URL. It runs `stack.sh stop <slot>` when done. Never use port 3000 and never touch `data/` in the main checkout: that is Carl's own running copy. No two agents share a server or a branch. Every brief ends with "Do the work yourself; don't spawn agents."
- **Every piece of work is checked by a different agent.** Verifiers check testers. Reviewers check builders. A checker gets the issue, the code and the evidence, never the other agent's reasoning, and tries to prove the work wrong. Never reuse a builder as a reviewer, and never reuse a reviewer for a second round.
- **Wait without polling.** Use the harness notifications and PR-watch tools, not sleep loops.

## Phase 0: Start or resume

1. **Check that `main` is what Carl is running.** Worktrees start from `origin/main`. If the main checkout has uncommitted or unpushed work (`git status --short`, `git log origin/main..main`), stop and tell Carl: a sweep of stale code is worthless. Don't commit or push for him.
2. Look for an open run issue: `gh issue list --label qa-run --state open`.
   - **One matches this scope, or the arguments say `resume`:** resume it. Read its body (which batches are ticked) and its latest handoff comment, list its open `qa` issues and their PRs, then continue at the first unfinished step. Re-run any batch that isn't ticked, even if it was half done.
   - **Otherwise:** start a new run.
3. Create missing labels with `gh label create`: `qa`, `qa-run`, `bug`, `severity:P0-critical`, `severity:P1-high`, `severity:P2-medium`, `severity:P3-low`, `security`, `ux-copy`, `ux-flow`, `ready-for-agent`, `ready-for-human`, `needs-human-review`, `needs-info`.
4. Make sure the demo data supports the sweep. `stack.sh` seeds it (`SEED_DEMO=1`): an administrator, staff with different camera sets, one person with no cameras, groups, tags, curated and private views, sharing and defaults. Permission tests need people whose access differs: if the seed (`src/server/seed.ts`) lacks a case a batch needs, such as a disabled person or someone allowed private views, file that as the first `ready-for-agent` issue and fix it before Phase 2's security testing.

## Phase 1: Map

Dispatch 2–3 mappers in parallel:
- one on the route table in `src/server/api.ts` and the modules behind it (`src/server/`)
- one on the screens in `src/ui/` and `prototype/`
- one on `docs/` and the tests in `tests/` (what is promised, and what is already covered)

Each writes to `tmp/qa/<run#>/map-<part>.md` and returns a summary. Merge their results into feature entries. Each entry lists:
- the feature, its routes and its screens
- who can use it: administrator, staff, staff allowed private views, a person with no cameras, a disabled person, an administrator previewing as staff, signed out
- the main flows and the prototype screen it matches
- the risk areas: camera access, view sanitization, sharing and landing view, live media and tickets, revocation, preview as staff, recorded playback windows, clip export, time zones, audit, phone layout, light and dark

Group the features into independent **test batches**, about one agent session each.

**Create the run issue** with the scope, the date, the commit SHA of `main`, and the batch checklist (`- [ ] views: <features, roles>`). Post the feature map as its first comment. Tell Carl the run issue link, then keep going. Don't wait for approval.

## Phase 2: Test (parallel)

Dispatch one **tester** per batch, all at once, plus one **security tester** across the whole scope (camera access, media and revocation bugs cross feature lines). Each tester brief has:
- the run issue number, the batch name and the stack slot
- "follow `.claude/skills/qa-sweep/references/test-checklist.md`"
- "append each finding to `tmp/qa/<run#>/findings/<batch>.md` as soon as you've confirmed it"
- "check `gh issue list --label qa --search <keywords>` and skip anything already filed"

Testers don't file issues and don't fix anything.

## Phase 3: Verify and file (parallel, as testers finish)

When a tester finishes, dispatch a **verifier** for its batch right away. Don't wait for the other batches. The verifier:
1. Reproduces each finding on its own stack. It rejects findings it can't reproduce, and findings that match the documented behavior.
2. Assigns severity from the rubric below and decides: clear bug, or needs a human decision (rules below).
3. Searches for duplicates (`gh issue list --label qa --state all --search ...`). If one exists, it comments with the new evidence instead of filing.
4. Files one issue per root cause with `gh issue create`. Labels: `qa`, one of `bug` / `ux-copy` / `ux-flow`, one severity label, `security` if it applies, and `ready-for-agent` **or** `needs-human-review` + `ready-for-human`. It uploads the key screenshots to the issue.
5. Comments on the run issue: rejected findings, one line each with the reason, so Carl can overrule them.
6. Returns only the issue numbers with their severities, and the number rejected.

Then you tick the batch in the run issue body.

**Severity rubric.** Rank by security, then data integrity, then breadth of impact, then frequency:

| Severity | Criteria |
|---|---|
| **P0-critical** | Seeing or learning about a camera, view, event, clip or person without access to it, by any route including media, thumbnails and error messages. Reaching MediaMTX, an RTSP URL, a recorder credential or another person's session from a browser. Access that keeps working more than 30 seconds after it was revoked. Sign-in bypass, staff acting as administrator, a preview that can change data. Any write to the recorder. XSS. Lost or corrupted Unifeye data. |
| **P1-high** | A main flow broken or wrong with no workaround: sign-in, the camera wall, live video, playback, saving a clip, managing access. A wrong grant or share saved. A missing audit entry for a change or a denial. Crash or blank page. |
| **P2-medium** | Broken edge case, a workaround exists, missing validation, wrong time or time zone on screen, broken phone layout, broken light or dark theme. |
| **P3-low** | Cosmetic, minor copy, polish, mock-only quirks. |

**Issue body.** Follow `references/issue-template.md`. The issue must make sense to someone who never saw `tmp/`.

**Auto-fix or human decision.**
- **Clear bug** (behavior contradicts the docs, the permission matrix or the prototype, or the code is plainly broken): label `ready-for-agent`; it goes to Phase 4.
- **Needs a human:** label `needs-human-review` + `ready-for-human`. **Nobody fixes it.** That covers:
  - wording, and anything about how calm or busy a screen should feel (Carl chose a minimal look: few visible controls, plain words, no badges or counters; "add an indicator" is a product decision, not a bug)
  - flow redesigns, and a prototype that conflicts with the docs
  - changes to who can see or do what
  - adding or removing a feature, and anything ambiguous

  The issue lists the options and recommends one.

## Phase 4: Fix (parallel waves, every PR reviewed)

Skip this phase on `no fix`. Fixes follow `references/fix-workflow.md`. Work through the open `qa` + `ready-for-agent` issues in severity order: all P0s first, then P1, P2 and P3.

1. **Plan a wave.** Pick the highest-severity issues that don't share files, screens or migrations. Assign each one (`gh issue edit <n> --add-assignee @me`) before dispatching, so nothing else takes it.
2. **Builders, one per issue, in parallel**, each following the builder section of `references/fix-workflow.md`. A builder that finds the fix needs a judgment call stops and reports back; you relabel the issue `needs-human-review` + `ready-for-human` and comment why.
3. **A new reviewer per PR**, following the reviewer section of `references/fix-workflow.md` in a fresh worktree. It posts **PASS** or **CHANGES** with numbered findings as a PR comment.
4. **On CHANGES:** the same builder fixes the findings on the same branch, then a new reviewer reviews. After 3 rounds, stop working that PR: label the issue `needs-info` and comment with what keeps failing.
5. **Merge** when the checks pass and the latest review is PASS: `gh pr merge <n> --merge`, one at a time, unless the arguments say `no merge`. After each merge, have any open PRs that add a migration under `drizzle/` rebase on `main` and regenerate theirs. Start the next wave as soon as the files it touches are free.
6. **The same bug elsewhere** in the app goes back to Phase 3 as new findings, verified and filed like any other.

## Phase 5: Regression sweep and report

Once the fixes have merged, dispatch one **regression tester** on fresh `main`. It runs `pnpm test`, `pnpm typecheck` and `pnpm lint`, and re-runs every P0 and P1 reproduction from this run in the browser. Anything that fails gets a new issue, or a reopened one.

Post the report as a comment on the run issue, and give the same report as your final message:

1. **Coverage:** each batch with the roles, widths and themes tested. List anything nobody could test, and why. Always list "real UNVR" and "real identity provider" here.
2. **Issues:** every issue this run filed, sorted by severity, as: severity, linked title, status (fixed in PR / open / needs review / needs-info).
3. **Needs your review:** a full link per item (`https://github.com/cmer/unifeye/issues/<n>`), one line each, saying what decision is needed. Most important first.
4. **Rejected findings:** the count, with a link to the run-issue comment that lists them.
5. **Next:** what to sweep next, in one sentence.

Close the run issue once every finding is fixed, or is waiting on Carl.

## Running low on context

Stop dispatching. Let the agents in flight finish, or note them. Post a **handoff comment** on the run issue covering:
- which batches are ticked
- which issues are filed but not yet in a wave
- which PRs are open, and their review state
- the exact next three steps

Then stop. The next `/qa-sweep resume` picks up from GitHub alone.
