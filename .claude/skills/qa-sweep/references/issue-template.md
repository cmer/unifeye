# QA issue template

Title: what is wrong, from the user's point of view, in one line. Not the fix.

```markdown
Found in QA sweep #<run>

## Severity
<P0–P3> — <one sentence on why, using the rubric>

## Steps to reproduce
Stack: mock mode, commit <sha>.
1. Sign in as <person> (<administrator | staff with … | no cameras>).
2. Open <URL path> at <390 | 1280> px, <light | dark>.
3. …

## Expected
<what should happen>, per <docs/architecture.md section | permission matrix row | prototype screen>.

## Actual
<what happens>. <Console or log excerpt, a few lines, secrets removed.>

## Screenshots
<uploaded images>

## Acceptance criteria
- Given <state>, when <action>, then <result>. [test: api | policy | access | oidc | ops | mediamtx | browser]
- …

## Verification protocol
1. <exact steps a reviewer runs, in the browser or with curl, to prove the fix>
2. `pnpm test`, `pnpm typecheck`, `pnpm lint` pass.

## Decision needed (only for needs-human-review)
Options: A … / B … . Recommended: <one>, because <reason>.
```

Rules:
- One issue per root cause. The same cause seen on three screens is one issue listing three places.
- Name people, cameras and views as the demo data names them, so anyone can reproduce it.
- Never paste cookies, tickets, tokens or values from `.env*`.
- Never describe behavior of a real UNVR or real Zitadel: sweeps run in mock mode only.
