# Verification

This file separates what was actually checked from what was not. Nothing below marked "not verified"
should be assumed to work.

## Versions

| Component | Version | How it was used |
| --- | --- | --- |
| Node.js | 26.13 (local); image uses 24 | Tests and local runs |
| Next.js / React | 16.4.6 / 19.3.0 | Built and run locally |
| drizzle-orm / better-sqlite3 | 0.45.4 / 13.2.0 | Tests |
| openid-client / jose | 6.9.0 / 6.2 | Tests against a test identity provider; Zitadel in production |
| unifi-protect | 5.4.2 | In production against a real UNVR |
| MediaMTX | 1.21.4 (macOS binary; `1.21.4-ffmpeg` image) | Run locally with `docker/mediamtx.yml`, and in production with Compose |
| UniFi Protect | 7.3.74 on one UNVR, 42 cameras | In production, through a read-only account |
| OIDC provider | Zitadel (self-hosted), plus the test provider | In production, with a project role as the admission claim |
| Docker image, Compose | Docker Engine with Compose v2 on a Linux VM | In production with `compose.yaml`, behind Cloudflare Tunnel |

## Verified

**Automated tests (`pnpm test`, 326 tests):**

The media tests run against an in-memory relay that asks the gateway (`Media.admit`) before
admitting a reader. They show what the gateway decides, not how MediaMTX behaves. How the MediaMTX
auth hook is answered (the hook secret, the control API, MediaMTX's own FFmpeg from loopback or
private addresses and its `_src` paths, RTSP and other protocols refused, viewers handed to the
gateway) is pinned separately in
`tests/mediamtx.test.ts`.

- Permissions: deny by default, individual and group grants, overlapping groups, disabled users,
  group removal, grant revocation, cache invalidation, new cameras ungranted, rename and missing
  cameras.
- Views: AND tag filtering (`indoors` + `upper_level` gives four cameras), dynamic membership after
  tag edits, static order and stability, a newly tagged but unauthorized camera staying hidden,
  duplicate shares, revocation with another share remaining, sanitized responses, concurrent-edit
  rejection.
- Starting view: precedence, competing group defaults and the tie-break, validation on assignment,
  deleted and unshared defaults, empty views.
- API boundary: every data and media route returns 401 without a session; a forbidden camera is
  byte-for-byte the same as a missing one for snapshots, recordings, playback, live setup, HLS
  files, events and exports; event IDs and export IDs do not bypass camera checks; counts and
  "has more" reflect authorized cameras only.
- Media tickets: single use, bound to path and transport, WHEP resource tied to its session; through
  the hook listener with the real gateway (`tests/hook-server.test.ts`), a viewer admitted with an
  issued ticket and refused with the wrong secret, ticket, stream or transport, and MediaMTX's own
  login refused as a viewer; active sessions kicked on grant removal,
  account disablement and session revocation; unknown readers kicked on both transports; a
  revocation arriving during a sweep is swept straight after it; a sweep with nothing revoked kicks
  nobody.
- HLS fallback through the gateway: playlist then segment, the hook asked when the playlist opens a session; 401
  without a session; 404 once the grant is removed, without the relay being asked; HLS readers
  kicked on grant removal and session revocation, and the gateway's HLS state dropped with them.
- Diagnostics: `/api/diagnostics` and the speed-test route refuse a request without a session;
  stream counts and the stream list cover only the caller's session, and during a preview name only
  cameras the previewed person can see; the speed-test sample is capped at 4 MB, uncached, counted as
  `media` and refused after 10 a minute per session. The window's logic is unit-tested in Node
  (`tests/diagnostics.test.ts`): candidate filtering, playlist parsing, 429 grouping, the verdict,
  the report, user agents, statistics parsing, the Version row and which stream the tests use. The
  update check's decisions are tested against a stand-in for GitHub (`tests/version.test.ts`); it
  has not been run from a built image, and never against a repository that has releases. The browser side of
  the window (peer connections, `getStats`, codec queries, clipboard) is not covered by tests.
- Relay outage: WHEP setup, trickle, teardown and HLS answer 503 `relay_unavailable`; a sweep
  survives it; `/ready` reports the relay as down and as up again.
- MediaMTX adapter, against a local HTTP stub that records requests: path add and replace bodies,
  control API credentials, reader listing with paging, kick endpoints, the WHEP offer with the
  ticket as a Bearer token and the resource read from `location`, trickle and teardown forwarding,
  HLS redirect following with the session cookie carried per reader, and the configured-path cache
  being dropped when MediaMTX is unreachable, unhealthy or answers 404. The stub is not MediaMTX:
  this pins what Unifeye sends, not that MediaMTX accepts it.
- Standing access: a grant stops holding, and the signal fires, when the session is revoked,
  replaced, idle-expired or past its absolute limit, the preview ends or times out, the subject is
  disabled, a grant or group membership is removed, or the camera is gone; unknown ids never hold;
  camera sync signals only when the inventory changes.
- Clip exports: bound to session and camera; an export made during a preview is refused and its
  file deleted when that preview ends or times out; at most two prepare at once per session.
- Who may save clips (`tests/api.test.ts`, "who may save clips"): the built-in Everyone group allows
  it by default; with it off, staff without a group that allows it get 403 while a hidden camera
  still answers exactly like a missing one; administrators always may; See as staff uses the
  subject's setting; turning it off removes a finished clip (unless another group still allows it)
  and stops one being prepared; only administrators can change it and the change is audited. The
  `0006` migration was checked by hand on a database with no built-in group, one with a
  differently named one, one where a plain group already used the name "Everyone", and a demo
  database whose "All Staff" group is renamed. The admin switches
  and the hidden player button have not been checked in a browser.
- Long clips in pieces (`tests/api.test.ts`, "long clip exports"): a 10.5-minute clip is exported as
  three pieces, reports progress and a time left. With every piece cut from one recording as the
  recorder does (from the last keyframe at or before its start, so its first GOP is byte for byte the
  last one of the piece before), the joins drop each repeated lead by keyframe hash and the clip comes
  out the requested length plus half a GOP at each end. It also runs with a relative cache folder,
  which once broke the join.
- One picture size across a clip (`tests/match-size.test.ts`, and "play at one size" in
  `tests/api.test.ts`): with synthetic files, pieces at 640x480 (4:3), 960x540 and one that changes
  from 640x480 to 1280x720 partway, added before the 1280x720 piece, all come out 1280x720 with every
  frame at its original time, the sound kept and the timescale unchanged, and join into one size.
  H.265 stays H.265. A cancelled clip stops resizing. In mock mode, a 10.5-minute clip whose middle
  piece came from the low stream downloads at one size and the right length. Passed with libx264,
  libx265 and VideoToolbox on macOS (FFmpeg 9.0) and with libx264 and libx265 in Debian bookworm
  (FFmpeg 5.1, the image's), where a VAAPI device that does not exist falls back to the CPU. FFmpeg's
  join of pieces from different encoders (different SPS and profile) decoded cleanly on both versions.
  On the same bookworm run, `tests/retime.test.ts` "spreads a too-fast video clock" fails because
  FFmpeg 5.1 builds that test's fast-clock sample with 0.2 s of video instead of 7.7 s; the test input
  is wrong there, not the retiming.
- Saving adaptive recordings in full (`tests/api.test.ts`, "keep every minute of an adaptive
  recording" and "keep a stretch the recorder only has in low resolution"; `tests/match-size.test.ts`,
  "rendering an adaptive recording's two exports in playback order"): in mock mode, a six-minute clip
  from a camera with high resolution in seconds 12-21 of every 30 and low resolution everywhere but
  seconds 15-18 came out 361 s long (the 1 s low-resolution lead included) at 1280x720. With synthetic
  files (low red then yellow, high blue then green), `renderEntries` shows each colour exactly where
  its entries put it, inserts included, keeps the high stretches at 15 fps and keeps sound. A piece
  whose channel 0 export has nothing is taken from the low channel instead. The earlier combine
  (overlay by audio) passed on FFmpeg 9.0 (macOS) and 5.1 (Debian bookworm) and took 14 s with
  libx264 and 16 s with VideoToolbox for a five-minute piece (640x480 7 fps base, 90 s of 2688x1512
  15 fps stretches) on an Apple M5 Max; `renderEntries` has been run on FFmpeg 9.0 only, and its speed
  on real five-minute pieces has not been measured. In mock mode a one-minute piece rendered in about
  1 s with VideoToolbox.
- Adaptive recording decisions (`tests/recorded.test.ts`), with a fake recorder and fake media
  operations (GOPs and thumbnails made up per moment), no FFmpeg: which channels the segment lists
  call for (`channelsFor`: high alone when the low one lists nothing, low alone when the high one
  lists nothing within a minute, both otherwise); with both, the low file as base, matched high GOPs laid over it and the ones it lacks
  inserted into its hole, every second of both files played once, wall-clock times from the
  segments, and the early answer with the base alone; the low file alone when channel 0 hands back
  the same low pictures, has nothing or is busy (then "may be missing time"); channel 0 alone when the
  low channel keeps failing; without segment lists, the old size and length rules; which error wins
  when both channels fail; a retime failure kept, a cancel during one stopping the fetch; a clip piece
  rendered without its leads after the first piece and without its high lead on the first, or saved
  from the low file with its lead and covered time when rendering fails. `tests/placement.test.ts`
  drives the placement module through `placeStretch` on made-up recordings of made-up scenes (a room
  whose picture changes smoothly, and a still one) and checks what the player would show against
  each frame's true time: segment times, a lead from an earlier segment, hidden time put at a picture
  jump, the order cut where time skips; with adaptive recording, overs and inserts with every frame
  played once and time moving forward, an over cut where the base jumps, the high file's times pinned
  by placed GOPs, a later moment that looks like an earlier one placed forward, a lone GOP laid over
  only when no other moment looks like it, a still scene left to recorder times, and the pictures at
  a hole's edges weighed against recorder times. Breaking each of these rules in the code fails a
  test (checked once by hand), except the order's own check against backward placements, which the
  matcher already prevents. `tests/timeline.test.ts` covers reading entries (`entryFor`, `wallAt`,
  `skipLead`).
  `tests/playback.test.ts` checks a mock adaptive window's order second by second, its early answer
  and the cache, with real files.
- Placing adaptive recordings on real exports (read-only exports of eight five-minute windows from six
  adaptive-recording cameras on the production UNVR, 2026-11-18; 330 high GOPs beside about 19 minutes
  of low-resolution video). The cameras' burned-in clocks, read by OCR, were used to check results
  only; nothing in Unifeye reads them. The footage and clock readings are in the private repository
  `cmer/unifeye-test-footage`; the numbers below come from `scripts/adaptive-eval` (`placement.mts`,
  `order.mts`, `clock.mts`), which reruns them on the current code. Of the 315 high GOPs with a readable clock, 144 were placed on
  the low file: 120 within a second of the right moment and 24 elsewhere. Of the 171 left unplaced
  and played as inserts, 143 show moments the low file lacks (right) and 28 moments it also has
  (shown twice in effect). Base keyframe times from the segment lists were within 4.1 s of the clock
  at the median and 16 s at the 90th percentile (worst 36 s); four of the eight stretches had a
  steady offset of 5 to 20 s. About half of that error comes from deciding which GOPs belong to which
  segment: with that read off the clock instead (seven of the eight stretches; one had unreadable
  segment starts), the times would be within 1.1 s at the median, 9.1 s at the 90th percentile and
  28.5 s at worst (measured once on 2026-11-18; the scripts no longer include this check). Played in order, the entries stepped back in time 42 times across the
  eight stretches, mostly by 3 to 37 s and twice by about 80 s (inserts placed in the wrong hole); one
  of the 42, a step of 354 s, came from a misread clock, not from the order. No moment of either file was
  left out. Placing took 0.2 to 0.4 s per stretch. After the placement became one module
  (`placeStretch`), the scripts gave exactly the same numbers. After keyframes were paired with their
  pictures once inside `placeStretch` (the scripts now read that pairing from its trace instead of
  pairing by time themselves), `placement.mts`, `order.mts`, `clock.mts` and `segments.mts` (both
  channels) gave the same output line for line, the entries and keyframe times of all eight stretches
  were unchanged, and no GOP or picture was left unpaired (rechecked 2026-11-18).
- Recorded playback and clip choice in the player (`tests/player.test.ts`), with fake video
  elements, no browser: when the next window is buffered and when it may take over; where a seek
  lands (the entry showing the moment, the high file waiting where it is next needed, a moment only
  the high file has); where playing on starts (past both leads when the keyframes match, else on the
  base lead); carrying on from the base when the full order arrives; and `stepEntries` frame by frame:
  the high file parked and hidden under base entries, kept in step under overs (moved past 0.25 s of
  drift, matched in speed, shown only with the right frame), playing alone through an insert with the
  base paused and parked, waiting for a high file still loading, inserts skipped and overs played as
  the base without a usable high file, seeks applied once each file can move, the handover at the
  end of the entries only while playing, and pausing. Across frames (`stepPlayback`): a new window
  starts with a seek; when the full order arrives, playback restarts from the moment asked for within
  10 seconds of a seek (or while the seek is not yet carried out) and otherwise carries on from the
  base; a hand-over carries on where `carryOnAt` says, past a lead that starts half a second before
  the window, rather than where a seek to the window's start would land (inside that lead); and a
  frame of the window handed over from, run before the player catches up, changes nothing. Before,
  such a frame rebuilt the next window's cursor as a seek, which on a lead that crosses the window
  start played the last moments of the window before again; that race was found by reading the code
  and was not reproduced in a browser. A clip's ends dragged and typed within the length limits and
  never past two seconds ago, and the timeline's zoom, pan and refitting. What remains untested is
  the thin React wiring: refs, the animation-frame loop and the hidden elements of the next window.
- Resize speed (synthetic 640x480 7 fps source, five minutes, Apple M5 Max, 4 threads): 8.5 s to
  2688x1512 with libx264 `veryfast`, 7.6 s with VideoToolbox. Reading the picture sizes of a
  five-minute 2688x1512 piece took about 1 s.
- UniFi export streaming, against a mocked recorder (undici `MockAgent`, `tests/unifi-export.test.ts`):
  the separate sign-in (root CSRF token, login, `TOKEN` cookie), the body streamed to disk, one
  re-sign-in after a 401, refusals or tiny bodies reported as nothing recorded, and 500, 503, 429 and
  408 answers reported as busy without marking the recorder down. This pins what Unifeye sends, not
  what a real UNVR answers.
- Recorder failures during a long clip (`tests/api.test.ts`, "clip exports when the recorder fails
  part of the clip", mock mode): a piece that fails twice as busy and then succeeds is kept, and the
  clip comes out the full length with no warning. A piece that keeps failing is tried three times
  per channel, left out, and the clip is marked `busy` with its real (five minutes shorter) length.
  A piece with nothing recorded is not retried and is marked `unrecorded`. A clip where every piece
  fails ends with "The recorder is busy. Try again in a few minutes."
- Video straight from the camera (`tests/api.test.ts`, "video straight from the camera", and
  `tests/rtsp-check.test.ts` against a pretend camera on a local socket): administrators only, only
  cameras that offer it, refused while viewing as someone else; the login is checked with the camera
  before saving and a wrong one saves nothing; the password is stored encrypted and appears in no
  response or audit entry; the default login is used when a camera has none; live video uses the
  camera's address, falls back to the recorder after a failed attempt, tries the camera again after
  the settings are saved, and stops asking the camera once turned off. The check sends only DESCRIBE
  on one connection, answers Digest (with and without qop) and Basic, and tells a wrong login, H.265,
  a missing stream and an unreachable camera apart. Cameras that only stream through the recorder are
  never offered it and the camera is never asked; one that stops offering it after being switched on
  plays through the recorder and can still be switched off.
- Preview: subject's permissions on data and media, administrator stays the actor, all mutations and
  admin routes blocked, forged, foreign and expired contexts rejected, two tabs kept apart, both
  identities audited, subject's profile untouched.
- Sign-in against an isolated test provider: PKCE S256, state and nonce, replayed callback, wrong
  issuer, wrong audience, bad signature, expired token, organization and project admission, exact
  issuer and subject mapping, no linking by email, zero-access provisioning, one-time bootstrap,
  session rotation and expiry, CSRF, safe redirects, provider outage, back-channel logout including
  replay and malformed tokens, and lifecycle re-validation.
- Password accounts off (the default): no password, registration or link routes; admin creation
  refused; mock mode in production with `oidc` still requires OIDC settings.
- Password accounts on (`tests/local-accounts.test.ts`): admin-only creation, zero-access profiles
  keyed by their own id, link secrets stored hashed and kept out of the audit log, one use per link
  (also under a race), expiry, superseded links, weak passwords refused without using the link,
  scrypt storage, identical answers for unknown usernames, wrong passwords and unset passwords,
  lockout for real and unknown usernames (audited, not flushable by flooding the tracker), the
  concurrency cap on password checks, body size limits, return addresses with stripped characters,
  a password change cancelling unused links and having its own lock, Origin and JSON checks, `LOCAL_APP_URL`, session rotation,
  sessions ending on a new password and on disable, changing your own password, and turning `local`
  or `oidc` off locking those people out.
- Email codes (`tests/email-codes.test.ts`, with an in-memory mailer): accounts with codes only get
  no password or link, at least one way in, address validation and the three-address limit, codes
  refused without outgoing mail, codes sent to every address and kept out of the subject, a code
  working only with the asking browser's cookie and only once, identical answers (and no email) for
  unknown, password-only and disabled accounts, five tries per code for real and unknown usernames
  alike, the send cooldown, a new code replacing the old one, expiry, a disabled account refused
  after a right code, failed mail audited and flagged to administrators, turning the password off
  (hash removed, sessions ended, password sign-in refused), removing an address cancelling pending
  codes and ending sessions, and code-only people unable to set a password. The two-step page: only code-only accounts go to a code (unknown, disabled, password and both get an identical password answer), a held code reused instead of a second email, and no code step without outgoing mail. Not yet checked against
  a real mail server.
- Cloudflare Access against a stubbed key endpoint (`tests/cloudflare.test.ts`): sign-in from a
  valid token, refusal of forged, foreign-issuer, foreign-audience, expired, unknown-key and
  subject-less tokens, the token re-checked on every request and bound to the session's identity,
  Cloudflare sessions refused without the header, tokens sent without Cloudflare's origin secret
  refused (and not refreshing the session), password sessions and password sign-in refused
  with it, no fallback to passwords on a bad token, suspension after `CF_ACCESS_RECHECK_SECONDS`,
  sign-out through Access, bootstrap, no takeover of another method's profile, and turning the
  method off.
- Operations: clean install, upgrade from the previous schema with a pre-migration backup, failed
  migration leaving data intact, newer-database refusal, backup integrity under WAL, restore into a
  clean location with permissions preserved and sessions revoked, corrupt backup rejection.
- Time zones: 23- and 25-hour days, the repeated autumn hour, the skipped spring hour.

**Checked by hand against a real MediaMTX 1.21.4 process, mock cameras:**

These checks were made before the MediaMTX calls were moved behind the relay interface
(`src/server/media/relay.ts`, `mediamtx.ts`). The requests were moved without intended change and
are now pinned by the stub tests above. Production has since run live video through the moved code
(see "In production" below), but the individual checks below were not repeated.

- Sign-in through the test provider, bootstrap administrator, demo seed, landing view.
- Eight simultaneous WebRTC streams admitted through the auth hook.
- Direct requests to MediaMTX refused: WHEP without or with a guessed ticket (401), HLS (401), RTSP
  read (401), control API without credentials (401).
- Removing a staff member from a group stopped their three playing streams in about 4 seconds.
- HLS fallback through the gateway: master playlist, variant playlist, init segment, media segment;
  a segment request without a session returns 401.
- Recorded playback: a seek two hours back loaded one 60-second window and played from the right
  offset.
- Window handoff, mock mode only (headless Chromium, 10-second windows): across four boundaries the
  visible video never dropped below "current frame available", and the next window started straight
  away.
- Adaptive recording on a real UNVR (one camera, Low channel 640x480 at 7 fps): Protect's exports
  held about 38 s of video beside 61 s of audio, so the player raced, then froze for about 20 s
  before each window ended. The burned-in camera clock confirmed that the video was simply fast.
  After retiming, the same files have matching video and audio lengths, and the clock reads the
  right second at 1 s, 31 s and 61 s. High-resolution and correctly timed exports are left
  byte-identical (`tests/retime.test.ts` covers both cases with synthetic files).
- Long clip with a retimed piece on a real UNVR (Entrance Door, 1 h 55 min requested): the
  downloaded clip claimed 2 h 46 min and would not play through. The retimed Low channel piece had
  been rewritten on a 1/16000 video timescale while Protect's pieces use 1/1000; the join reads
  every piece on the first one's timescale, so that piece stretched 16 times (frames 2.35 s apart)
  and every piece after it was squeezed into 1.4 s. Retiming now keeps the original timescale, and
  the join rewrites any piece whose timescale differs. Fourteen raw pieces from the same recorder
  (one retimed) now join to 1249.7 s, the sum of their lengths, with no frame steps out of order.
  `tests/retime.test.ts` reproduces both cases with synthetic files.
- Adaptive high-resolution stretches on a real UNVR (same camera): a channel 0 export of 20:22-20:23
  held only 18 s (the motion, 20:22:32-20:22:50 by the camera's clock), and a 50 s request around
  the start of the motion returned 8 s. Matching their audio against the low channel placed both at
  the same moment (correlation 0.99 or better in every chunk), which agrees with the burned-in clock
  and the motion event. The full player was not run against the real recorder. Later exports showed
  that this does not hold in general: channel 0 returns low pictures where it has no high ones, the
  high channel's sound drifts from its picture, and both channels have gaps, so placement by audio
  was replaced by placement by picture (see "Placing adaptive recordings on real exports").
- Adaptive playback in mock mode with the entry-based player (headless Chrome through Playwright,
  10-second windows, `MOCK_ADAPTIVE=mock-06`, 2026-11-18): opened 8 s before motion and watched for
  42 s across four handovers. The low file played alone, the high file showed over it at 12 s, the
  low file held still while the high file played the 3 s it alone has, then both ran together to the
  end of motion, including across a handover. Each new window started just past its 1 s lead (the
  seams matched), and the picture never stopped except for 0.3 s at the start. This run found two
  bugs, both fixed: windows with motion at an edge were sent the high file alone, losing low-only
  seconds (`channelsFor`), and the simulated recorder's high exports did not repeat GOPs byte for byte,
  so a handover replayed its lead. Clips, seeking by hand and slow connections were not tried. In
  that run the simulated recorder's GOPs sat on whole seconds, so every lead ended exactly at its
  window's start, and carrying on from the window before and seeking to the window's start landed on
  the same entry: the run could not tell them apart.
- Adaptive playback in mock mode after the simulated GOPs moved to half a second past each whole
  second (headless Chrome through Playwright, 15-second windows, `MOCK_ADAPTIVE=mock-06`,
  2026-11-18, twice for 50 s each): the window at second 15 of each half minute opens with the low
  file's last GOP before its gap, which `tests/playback.test.ts` shows is dated from half a second
  before the window to half a second into it, so a seek to that window's start lands inside the lead.
  At every handover into such a window (four across both runs) the base carried on at 1.00 s, just
  past its 1 s lead, with the high file playing the gap from just past its own lead; the low file
  played alone, then under the high file from about 12.5 s, held still for the 3 s only the high
  file has, and ran on with it to the end of motion. The picture stopped for 0.2 s at the start of
  one run and for one 0.1 s sample in the other. The same check with the earlier player code gave
  the same handovers: the stale-frame race it had depends on frame timing and did not occur there,
  so only `tests/player.test.ts` covers it.
- Adaptive playback in mock mode with the earlier overlay player (headless Chromium, 10-second
  windows, `MOCK_ADAPTIVE=mock-06`, so motion crosses window boundaries): over a minute and six handovers, wall-clock time never
  jumped or repeated. The overlay appeared within about 0.1 s of motion starting and disappeared within
  0.1 s of it ending, stayed up across a boundary, and each window started at its 2 s lead. Opened
  mid-motion and paused, the overlay showed the matching frame. `tests/playback.test.ts` checks
  placement for two joined stretches in a 60-second window.
- Each screen (wall, player, activity, manage views, admin) rendered in light and dark mode at
  1440 px wide, and the wall at 390 px wide (one column, no sideways scrolling) in a desktop
  browser's narrow window. This is not a test on a real phone.
- Sound, mock mode only (headless Chromium, mock cameras sending AAC and Opus like Protect, three
  without a microphone): over WebRTC, HLS and recorded playback, cameras with sound offered the
  speaker and played unmuted with the level meter moving, and cameras without showed "No audio".
  Turning sound on for one wall tile turned it off on the other; the M key toggled it in the player.
  Not heard through speakers, and not checked in Safari or Firefox, whose audio detection takes a
  different path.
- Live sound from a real UNVR camera (one camera, 2560×1920 with AAC 16 kHz and Opus tracks), in
  headless Chromium over WebRTC against MediaMTX 1.21.4, outside Unifeye: pulled directly, Chrome
  discarded 430 of 560 audio packets and concealed 95% of the samples (the garble-then-silence
  heard in Chrome and Safari), because Protect's audio timestamps advance in milliseconds against a
  16 or 48 kHz clock. Through the retiming FFmpeg command `mediamtx.ts` generates: 0 packets
  discarded, 0 samples concealed, no video freezes, about 1 s to start. A video-only source through
  the same command played video with no audio track. Not heard through speakers; HLS not played.

**Docker image and Compose stack (2026-11-16, Linux VM, real UNVR, behind a Cloudflare tunnel):**

- The first build of the image failed (`better-sqlite3` had no compiler), the ops CLI could not load
  `better-sqlite3` in the image, and the MediaMTX health check never passed. All three are fixed in
  the Dockerfile and `compose.yaml`; the image build now loads `better-sqlite3` from the CLI's path.
- Both containers start healthy, the app connects to the UNVR with TLS verification
  (`PROTECT_TLS_CA_FILE`), and `cli.mjs backup` and `restore` work inside the app container.
- The data volume survived `docker compose down` and `up`.
- MediaMTX's auth hook on its own port (`HOOK_PORT`) was checked with a real MediaMTX 1.21.4 in the
  QA stack: the control API is admitted through it, and `POST /api/internal/mediamtx-auth` on the
  web port returns 404. The production check below covers the hook in the Compose stack.

**In production (checked 2026-11-17 on `5a3fd7e`, Compose, real UNVR, Zitadel, Cloudflare Tunnel):**

Read from the running stack, its audit log and its logs. Nothing was changed.

- `/api/ready` reports the recorder in real mode and connected, the relay up, and a recent camera
  sync. All 42 cameras are synced.
- Live video through the hook port in Compose, after the relay refactor: over 8 hours MediaMTX
  logged 178 admitted readers and 134 WebRTC sessions, plus HLS. No authentication failures.
- Zitadel: 19 sign-ins, sign-out, 2 back-channel logouts, profiles created on first sign-in,
  admission by project role, and group membership synced from the provider's claims.
- 9 clip exports from the real recorder, and one restore.

**Wall tiles refused with 429 after a restart (2026-11-17):**

- On production, after the app restarted, most wall tiles got 429 on WebRTC setup and two got 502.
  MediaMTX logs for the minute after: 26 WebRTC sessions closed with "deadline exceeded while
  waiting connection" (offered, never used) against 9 that connected; the two 502s were cameras
  whose source timed out. Each unused session kept a stream slot until MediaMTX dropped it and a
  sweep noticed (30 s or more), so the session reached its limit of 12 streams.
- Two leaks fixed. A tile that stopped while its offer was in flight never tore the session down;
  it now does when the answer arrives (`src/ui/live.tsx`, not checked in a browser). An offer that
  failed after the hook admitted its reader kept that reader's slot; `tests/api.test.ts` ("does not
  hold a stream slot for a WebRTC offer that failed") fails on the previous code.
  Not yet checked on production.

**HLS stopping after 25 seconds (2026-11-17):**

- On production, a camera's enlarged view on HLS showed repeated 502s for `video1_stream.m3u8` and
  `audio2_stream.m3u8`. MediaMTX 1.21.4 (`internal/servers/hls/http_server.go`) starts a session
  only on the top playlist and finds it again by cookie for every other file, answering 401
  "session not found" without one. The gateway replaced its relay reader, and so lost that cookie,
  each time it renewed the ticket (every 25 seconds). A player only ever asks for the top playlist
  once, so from then on every request failed, and the 401 reached the browser as a 502.
- `tests/api.test.ts` ("keeps an HLS stream playing past the ticket's renewal") fails on the
  previous code. The in-memory relay now asks the hook only when the top playlist opens a session,
  as MediaMTX does. `tests/mediamtx.test.ts`: a renewed ticket is sent with the same cookie.
  Not yet checked on production.

**HLS stream slots and timeline previews (2026-11-17):**

- On production, after the rate-limit change, HLS tiles still got 429: the response was
  `too_many_streams`. MediaMTX logs over 30 minutes: 98 HLS readers closed as inactive, most 30 to
  60 s after they were created, so a stopped tile's stream kept its slot that long.
- `tests/api.test.ts` ("releases an HLS stream's slot"): with a 2-stream limit, a third stream is
  refused, then accepted at once after the player releases one; the release kicks only that
  session's reader, another person's stream on the same camera keeps playing, and the answer is
  the same for any camera id. The player's side (release on stop, waiting on 429) is not yet
  checked in a browser.
- Protect 7.3.74 `recording-snapshot`, asked for every camera at 30 minutes ago: 200 for the four
  Dahua intercoms and one IPC-BO camera, "Recording not found" for the other 37 (IPC-BO, Reolink),
  while a 2-second export of the same moment worked. `tests/unifi-stills.test.ts`: a camera that
  never gives a still is skipped after three misses and tried again after 30 minutes; a camera that
  has given one is never skipped.

**Rate limits and HLS walls (2026-11-17):**

- On production, a tab using HLS on a full wall got 429s. Measured in Chrome: 9 HLS tiles made 29
  playlist requests per tile per minute (video and sound playlists every 4 s), with segments at
  the same rate, plus about 100 still-image refreshes a minute for the other tiles: about 620
  against a 600 limit per address.
- `tests/api.test.ts` ("rate limits"): 700 HLS requests a minute from one session pass with the
  default stream limit, and snapshots keep their own budget; the HLS limit follows
  `MAX_WALL_STREAMS`; two people at one address each get the full limit, and a new address does not
  reset a session; failed authentication is limited per address without refusing a valid session
  there; a client changing the first `X-Forwarded-For` entry does not get a fresh sign-in budget.
  All four fail on the previous code. Not yet checked on production.

**Camera check against real cameras (2026-11-17, production network, read-only):**

- Protect reports a plain `rtsp://` address without a login for all 42 cameras (Reolink
  `h264Preview_01_main` / `_sub`, Dahua door stations `cam/realmonitor`). On the door stations
  Protect's low-quality address is the main stream (`subtype=0`), so their wall tiles would pull the
  full stream.
- `checkRtsp` against Polar Bears (Reolink, 10.48.20.205): both streams answered H.264 with AAC sound
  for the right login, and "login" for a wrong one.
- Not yet checked: playing a camera this way in the browser through MediaMTX and the retiming FFmpeg.

**Live start-up with retimed sound (2026-11-17, real UNVR, MediaMTX 1.21.4 on macOS, read-only):**

- Production logs over four hours: about two thirds of cold starts had the retiming FFmpeg exit with
  "dimensions not set" (exit 234), then ready only after MediaMTX's 5 s restart pause (6 to 9 s in
  all, against 1 to 2 s otherwise); some passed MediaMTX's 10 s start limit and never played.
- Reproduced locally with one real camera's low stream through `<path>_src`: with the old half-second
  probe, FFmpeg failed every time and the stream never became ready in 15 s. With the 10 s probe and
  `-fpsprobesize 0`, it was ready in 3.1 to 4.0 s over four cold starts with no failures. Not yet
  checked in the Compose stack.

**Diagnostics window (2026-11-18, mock mode, real MediaMTX 1.21.4 on macOS, Chromium in the T3 preview):**

- Opened from the menu on the name with the keyboard (arrow down, Enter) and with the mouse, as the
  administrator with eight WebRTC tiles playing. Every check finished in about 7 seconds: server, recorder,
  download sample, WebRTC over UDP and over TCP (each connected through the filtered candidates, on
  the WebRTC port), HLS (playlist, video playlist and segment through the gateway), codecs, open streams,
  every tile's statistics, clock and version. "Copy report" produced the plain-text report with
  status codes, request ids and candidate pairs.
- The WebRTC pause row appeared when the pause was set, and "Try now" cleared it. "Check again" and then
  closing the window mid-run left the session's open stream count where it was. The window fits and
  scrolls inside itself at 375×667, in light and dark.
- Not checked: a network where UDP or TCP is actually blocked (only loopback, where both connect), a
  real UNVR, Safari and Firefox (their statistics and codec reports differ), the native HLS player's
  error reports, real 429s shown in the window (only through the unit tests), and whether fetching the
  top playlist again through a reader a tile is using ever disturbs that tile in MediaMTX.

## Not verified

| Area | Why | What could go wrong |
| --- | --- | --- |
| Other Protect versions and recorder models | Only Protect 7.3.74 on one UNVR | Private endpoint shapes or required privileges differ on your Protect version |
| "Recording now" indicator on a real UNVR | Not checked against the recorder | Relies on the camera `isRecording` field and realtime camera updates; a wrong assumption shows a stale or missing REC mark, never extra access |
| Camera filter on the events query (`cameras=`) | Not checked against the recorder | If Protect ignores it, a busy recorder's other cameras use up the page budget and the player shows markers only for the latest hours; if Protect refuses it with a 400, Unifeye logs a warning and filters locally |
| Recording gaps on a real UNVR | No known endpoint | Timeline shows only the overall recorded period |
| Identity providers other than Zitadel, and deactivation detection on any provider | Only Zitadel was used | Claim placement, refresh-token or back-channel behaviour, or error codes differ by provider; a person disabled at the provider keeps access longer than expected |
| Cloudflare Access against a real team | No Access application available | Token claims (`sub`, `email`) or key rotation behave differently from the stub; the Transform Rule header not reaching the origin through the tunnel; the 30-second `/me` reload not reaching Unifeye often enough behind Access |
| Password sign-in and password links in a browser | Checked through the API tests and a production build only | Password-manager autofill, the set-password page on phones |
| Browser test suite | Not written | Screens were checked by hand in one desktop browser |
| Phones and tablets | No device testing | Layout or touch problems |
| HLS playback in a browser | Used in Chrome in production, where it turned up the HLS bugs above; the fixes are not yet checked there | Player-level issues |
| Sound from a real UNVR in Unifeye end to end | The retiming relay was checked outside Unifeye only (see Verified) | HLS sound, wall-quality streams, other camera models; recordings from Protect may lack audio |
| Sound in Safari and Firefox | Only Chromium was used | "No audio" shown wrongly, or the speaker missing; no level meter in Safari for HLS and recordings |
| Clip export in the browser | Checked by hand in Chromium with mock cameras: zooming and panning the clip timeline, and a 2-hour clip (prepared in about 2.5 minutes, 7200 s long). Long clips in pieces (mock mode, headless Chromium): a 21-minute clip showed the sweep, then 57% and 76% with a time left, then "Putting the pieces together", started its download by itself and came out 1260.0 s long | Not checked on a phone or with touch |
| Long clips from a real UNVR | One 1 h 55 min clip from one camera with adaptive recording (see Verified); fourteen of its pieces joined outside Unifeye after the fix. A 2 h clip from the same camera, saved before adaptive pieces were combined, came out 1 h 17 min: the burned-in clock showed 15 fps throughout but skipped between motion stretches, and about four minutes of low-resolution night footage were missing too | How long Protect takes before sending the first byte of an hour-long export (Unifeye waits up to 15 minutes), whether it caps export length, the disk space a clip needs, whether exporting pieces in parallel is faster than one long export on your recorder, whether the joins between pieces are seamless on real camera streams, and which status a real UNVR answers when it is overloaded or has nothing recorded (a 5xx for "nothing recorded" would be retried, then reported as busy) |
| Clip resizing on a GPU in Linux (VAAPI with Intel Quick Sync or AMD, NVENC) | No such GPU available; only "no device, so the CPU" was checked | The driver rejects the settings and every clip resizes on the CPU (logged at start-up of the first clip), or a driver encodes at a quality that looks worse |
| Adaptive playback and clips in a browser and on the real recorder | The entry-based player is checked with fake video elements and in mock mode in headless Chrome; placement was measured on saved exports (see Verified), not through Unifeye | Stalls at entry changes on slow connections (the high file must be loaded before an insert can play); how quickly a seek starts on the real recorder, whose high-resolution exports are larger; whether `playback-history` answers the same on other Protect versions; CPU use of matching on a small server; moments shown out of order where placement is wrong (measured above) |
| Clip resizing and combining with real adaptive recordings | Synthetic files and mock mode only | Real low-resolution pieces that are not 4:3 or change size in a way the keyframe scan misses; players that still resize on a real joined file; file size; whether Protect's channel 0 export of a piece with no motion is low resolution, empty or an error (each case is handled, but only the mock was seen); how long combining takes on a small server |
| Diagnostics on blocked or slow networks | Only loopback with the mock stack; the verdict, report, candidate filtering and statistics parsing are unit-tested | A blocked transport reported differently than expected; browsers other than Chromium report statistics or codecs differently; the download sample under-reads very fast or very slow links |
| Activity live updates in the browser | Checked through the API tests only | UI wiring |
| Revocation bound under load | Checked with three streams | Slower with many sessions |
| Video straight from the camera, end to end | Only the camera check ran against real cameras | The camera refuses a second reader or drops frames under the extra connection; MediaMTX logs the camera address (without the password); door stations' swapped stream addresses |
| Recovery after a MediaMTX restart | Cache invalidation tested against the stub only | Which status MediaMTX returns for a path it no longer has; whether re-adding an identical path disturbs readers |

## Checking a real UNVR (read-only)

With `.env` pointing at the recorder and the app running, signed in as an administrator:

1. `curl -s https://<host>/api/ready` shows `"recorder":{"mode":"real","state":"connected"}`.
2. Admin > Camera access lists your cameras by their Protect names.
3. Open a camera: a still image appears, then live video. If it says "No live video", enable an
   RTSP stream for that camera in Protect.
4. Activity shows recent motion with thumbnails.
5. Click an activity card: playback starts about five seconds before the event.
6. Drag the timeline to several times of day, including one before the camera was installed.
7. Save a 15-second clip and play the downloaded file.
8. In Protect, confirm nothing changed: no new users, settings or streams.

Record the Protect version and the role the Unifeye user needed in the table above.

## Checking a real identity provider

1. Sign in as the bootstrap administrator; Admin > History shows "Became the first administrator".
2. Sign in as a user whose admission claim does not match: you land on the signed-out page with
   "not set up".
3. Sign in as a new user whose claim matches: no cameras, role Staff.
4. Sign out in Unifeye: you are returned to the signed-out page and the provider's session ends.
5. If the provider supports back-channel logout: with a camera playing, end that user's session at
   the provider. Video stops and the next click asks for sign-in. Note how long it took.
6. With a camera playing, disable the user at the provider: the stream stops within
   `OIDC_RECHECK_SECONDS` plus `REVOCATION_SWEEP_SECONDS`. Note the time.
7. Reactivate the user and confirm they must sign in again.
