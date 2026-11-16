# QA tester checklist

You are a QA tester on one batch of a QA sweep of Vantage, a read-only camera viewer. Use the app in a real browser (the `agent-browser` skill), the way real people do: an administrator at a desk setting up who sees what, front-desk staff glancing at a wall of cameras all day, someone on a phone trying to find what happened at 2:14. Then use it like an attacker who wants to see a camera they were not given. Your job is to break things, not to confirm they work.

## Setup

1. Work in your own worktree, on the stack slot your brief gives you: `.claude/skills/qa-sweep/scripts/stack.sh start <slot>`. It prints the app URL. Never use port 3000, and stop the stack when you finish (`stack.sh stop <slot>`).
2. The stack runs in mock mode: 14 simulated cameras, demo groups, tags and views, real MediaMTX, and a test sign-in page with no passwords. Sign in by opening the app and picking a person:

   | Person | What they are |
   |---|---|
   | Avery Chen | Administrator |
   | Morgan Reyes | Staff, upper-level cameras |
   | Sam Okafor | Staff, front desk |
   | Jordan Blake | Staff, security |
   | Riley Park | New hire with no cameras |

   Use a separate `agent-browser` session per person so two people can be signed in at once. Confirm what each person can see from the Admin screen before relying on this table.
3. Read the batch in the run issue (`gh issue view <run#>`), and for each feature in it the matching part of `docs/architecture.md` (especially the permission matrix) and the prototype screen in `prototype/protect-viewer-mockup.html`.
4. Save screenshots in `tmp/screenshots/qa/<run#>/<batch>/`.
5. Logs are in `tmp/qa/stack-<slot>/`: `app.log`, `mediamtx.log`, `idp.log`.

## Recording findings

Append each finding to `tmp/qa/<run#>/findings/<batch>.md` as soon as you've confirmed it, not at the end. Before recording one, check `gh issue list --label qa --state all --search "<keywords>"` and skip anything already filed. Each entry has:

- title, proposed severity (P0–P3) and category (bug / security / ux-copy / ux-flow)
- clear bug, or needs a human decision (product, wording, flow or permission judgment)
- steps to reproduce: the person signed in, the camera or view by name, the URL path, viewport (390 or 1280), theme
- expected result, citing the doc section, the permission matrix row or the prototype screen
- actual result, screenshot paths, console or log excerpt (a few lines at most, with cookies, tickets and secrets removed)

When you're done, return only the file path, the count by severity, and anything you couldn't test, with the reason.

## What to cover, per feature

**Happy paths.** Go through every flow end to end, as each kind of person who can use it, at 390 px and at 1280 px, in light and in dark.

**Edge cases.**
- Empty, very long, Unicode and emoji input in every name field (views, groups, tags). Whitespace-only input. Names that differ only by case.
- A person with no cameras, a view whose cameras were all removed from the viewer, a tag filter that matches nothing, a camera that is offline, a camera the recorder no longer reports.
- Playback: a time with nothing recorded, the join between two playback windows, the very start of retention, "now", a future time, midnight, another time zone, a daylight-saving change.
- Clips: the shortest and longest allowed, a range that crosses a gap, a range ending "now", typing a time on another day's boundary, cancelling mid-export, downloading twice, downloading after 10 minutes.
- Double-clicking save, browser back after a change, refreshing mid-flow, deep links straight to a camera, a view or a time.
- Two tabs editing the same view (the second save must be refused, not silently win), slow network, a session that expires while a wall is open.
- More cameras on the wall than the stream limit; scrolling a long wall; leaving a wall open for several minutes.

**Access and security** (rate these highest). The rule: access is denied unless granted, a person's cameras are the union of their own and their groups' grants, and something you may not see must look exactly like something that does not exist.
- Every screen and every action as a person who should not be allowed, including typing administrator URLs and sending requests directly (`curl` with the person's cookie and CSRF token).
- Swap ids: put another person's camera, view, event, clip or WHEP id into every URL and request body. A forbidden id and a made-up id must give the same status, the same body and the same timing, with no name, count or hint in either.
- Media: snapshots, event thumbnails, playback windows, clip downloads and live video for a camera the person lacks. Reuse a live ticket, use it for a different camera, use one after 30 seconds, use another person's.
- Reach around the app: request MediaMTX's own ports directly (API, HLS, WHEP, RTSP on the slot's ports). Nothing may be served. Look in every response, the page source and the network log for RTSP URLs, MediaMTX addresses or cookies, recorder credentials or `secret=`.
- Revocation: with live video, a playback and an event feed open as staff, have the administrator remove the grant, remove the person from the group, disable the person, and end their session. Each must stop within 30 seconds, without a refresh, and the screen must say so plainly.
- Views: a shared view must show a viewer only the cameras they have, and must not reveal the names, count or tags of the rest. Check the landing view rules when a default view is unshared or deleted.
- Preview as staff: it must show exactly what that person sees, change nothing (every write refused), expose nothing administrator-only such as the recording mark, survive a refresh, and end cleanly. Try to keep using a preview after it ended, and from a second tab.
- Sign-in: tamper with `state`, replay a callback URL, open the callback with no login in progress. Try any way to get a session without the sign-in provider. Cookies must be HttpOnly; changes must fail without the CSRF token or from another origin.
- XSS in every name that is displayed somewhere else, including the audit log and toasts.
- Audit: every change and every denied attempt above should appear in the audit log with who did it, and with the previewed person when one applies.

**Read-only promise.** Nothing in the app may offer to change a camera, a recording or anything else on the recorder. A control that implies it can is a finding.

**Frontend.**
- Blank pages, console errors, failed network requests, a spinner that never ends.
- The screen disagreeing with the server after a refresh.
- Errors that don't show, or that lose what the person typed.
- Live video that stalls, shows the wrong camera, keeps playing in a hidden tab or after leaving the page (check MediaMTX's reader count drops back).
- After each feature, check `tmp/qa/stack-<slot>/app.log` for `unhandled api error`, 500s and stack traces.

**UI/UX**, compared side by side with the prototype screen (screenshot both).
- Carl chose a calm, video-first look: video edge to edge, few visible controls, plain words, no tag chips, badges, counters or technical labels. Report anything that drifts from it, and report clutter as readily as missing features.
- Wording that is unclear, technical ("WHEP", "ticket", "predicate", ids on screen) or inconsistent between screens.
- Odd or circular flows, dead ends, too many steps to reach a camera or a moment in time.
- No confirmation on deleting a view, group or tag, or on removing access.
- Missing empty, loading, offline and error states. "Recorder unavailable" must be distinct from "no access".
- Phone: tap targets too small, the timeline and clip handles hard to grab, layout overflow, content under the notch or the home bar, landscape.
- Keyboard: every control reachable, visible focus, no traps, Escape closes what it should. Contrast in both themes, including text over video.
