# Verification

This file separates what was actually checked from what was not. Nothing below marked "not verified"
should be assumed to work.

## Versions

| Component | Version | How it was used |
| --- | --- | --- |
| Node.js | 26.13 (local); image uses 24 | Tests and local runs |
| Next.js / React | 16.4.6 / 19.3.0 | Built and run locally |
| drizzle-orm / better-sqlite3 | 0.45.4 / 13.2.0 | Tests |
| openid-client / jose | 6.9.0 / 6.2 | Tests against a test identity provider |
| unifi-protect | 5.4.2 | Compiled against its types only |
| MediaMTX | 1.21.4 (macOS binary) | Run locally with `docker/mediamtx.yml` |
| UniFi Protect / UNVR Pro | none | Not available |
| OIDC provider | none (only the test provider) | Not available |
| Docker image, Compose | Docker Engine with Compose v2 on a Linux VM | Built and run with `compose.yaml` against a real UNVR |

## Verified

**Automated tests (`pnpm test`, 127 tests):**

The media tests run against an in-memory relay that asks the real auth hook before admitting a
reader. They show what the gateway decides, not how MediaMTX behaves.

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
- Media tickets: single use, bound to path and transport, refused without the hook secret, RTSP
  readers refused, WHEP resource tied to its session; active sessions kicked on grant removal,
  account disablement and session revocation; unknown readers kicked on both transports; a
  revocation arriving during a sweep is swept straight after it; a sweep with nothing revoked kicks
  nobody.
- HLS fallback through the gateway: playlist then segment, the hook asked for each file; 401
  without a session; 404 once the grant is removed, without the relay being asked; HLS readers
  kicked on grant removal and session revocation, and the gateway's HLS state dropped with them.
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
- Long clips in pieces (`tests/api.test.ts`, "long clip exports"): a 10.5-minute clip is exported as
  three pieces, reports progress and a time left, and, with every piece starting 2.5 s early as the
  recorder does, joins to the requested length plus only the first piece's lead. It also runs with a
  relative cache folder, which once broke the join.
- UniFi export streaming, against a mocked recorder (undici `MockAgent`, `tests/unifi-export.test.ts`):
  the separate sign-in (root CSRF token, login, `TOKEN` cookie), the body streamed to disk, one
  re-sign-in after a 401, and refusals or tiny bodies reported as nothing recorded. This pins what
  Unifeye sends, not what a real UNVR answers.
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
are now pinned by the stub tests above, but nothing below has been repeated against a real MediaMTX
since the move.

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
  and the motion event. The full player was not run against the real recorder.
- Adaptive playback in mock mode (headless Chromium, 10-second windows, `MOCK_ADAPTIVE=mock-06`, so
  motion crosses window boundaries): over a minute and six handovers, wall-clock time never jumped
  or repeated. The overlay appeared within about 0.1 s of motion starting and disappeared within
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
  web port returns 404. That check was local, not in the Compose stack.

## Not verified

| Area | Why | What could go wrong |
| --- | --- | --- |
| Real UNVR: login, camera discovery, snapshots, events, thumbnails, video export, RTSPS relay | No recorder available | Private endpoint shapes or required privileges differ on your Protect version |
| "Recording now" indicator on a real UNVR | No recorder available | Relies on the camera `isRecording` field and realtime camera updates; a wrong assumption shows a stale or missing REC mark, never extra access |
| Recording gaps on a real UNVR | No known endpoint | Timeline shows only the overall recorded period |
| A real OIDC provider: login, admission claim, logout, back-channel logout, deactivation detection | No instance available | Claim placement, refresh-token or back-channel behaviour, or error codes differ by provider |
| Cloudflare Access against a real team | No Access application available | Token claims (`sub`, `email`) or key rotation behave differently from the stub; the Transform Rule header not reaching the origin through the tunnel; the 30-second `/me` reload not reaching Unifeye often enough behind Access |
| Password sign-in and password links in a browser | Checked through the API tests and a production build only | Password-manager autofill, the set-password page on phones |
| The hook port inside the Compose stack | Checked locally, not yet in Compose | MediaMTX cannot reach `app:3001`, so no video plays |
| Browser test suite | Not written | Screens were checked by hand in one desktop browser |
| Phones and tablets | No device testing | Layout or touch problems |
| HLS playback in a browser | Only the gateway responses were checked | Player-level issues |
| Sound from a real UNVR in Unifeye end to end | The retiming relay was checked outside Unifeye only (see Verified) | HLS sound, wall-quality streams, other camera models; recordings from Protect may lack audio |
| Sound in Safari and Firefox | Only Chromium was used | "No audio" shown wrongly, or the speaker missing; no level meter in Safari for HLS and recordings |
| Clip export in the browser | Checked by hand in Chromium with mock cameras: zooming and panning the clip timeline, and a 2-hour clip (prepared in about 2.5 minutes, 7200 s long). Long clips in pieces (mock mode, headless Chromium): a 21-minute clip showed the sweep, then 57% and 76% with a time left, then "Putting the pieces together", started its download by itself and came out 1260.0 s long | Not checked on a phone or with touch |
| Long clips from a real UNVR | One 1 h 55 min clip from one camera with adaptive recording (see Verified); fourteen of its pieces joined outside Unifeye after the fix | How long Protect takes before sending the first byte of an hour-long export (Unifeye waits up to 15 minutes), whether it caps export length, the disk space a clip needs, whether exporting pieces in parallel is faster than one long export on your recorder, and whether the joins between pieces are seamless on real camera streams |
| Activity live updates in the browser | Checked through the API tests only | UI wiring |
| Revocation bound under load | Checked with three streams | Slower with many sessions |
| MediaMTX after the relay refactor | Not re-run against a real process | A request that differs from the hand-checked one in a way the stub tests do not catch |
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
