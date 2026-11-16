# Architecture

## Components and data flow

```mermaid
flowchart LR
  B[Browser] -- HTTPS: pages, API, WHEP signalling, HLS, playback --> P[HTTPS reverse proxy]
  P --> A[Vantage app<br/>Next.js on Node]
  B -. WebRTC media, UDP/TCP 8189 .-> M[MediaMTX]
  A -- control API, WHEP, HLS (internal) --> M
  M -- auth hook for every reader --> A
  A -- OIDC: discovery, token, JWKS --> Z[OIDC provider]
  Z -- back-channel logout --> A
  A -- read-only HTTPS + WebSocket --> N[UNVR Pro / Protect]
  M -- RTSPS pull, on demand --> N
  A --- D[(SQLite /data)]
  A --- C[(bounded cache /cache)]
```

Only the reverse proxy and MediaMTX's WebRTC media port face the network. MediaMTX's API, WHEP,
HLS and RTSP listeners are internal. Protect credentials and RTSPS URLs never leave the server.

| Data | Owner | What Vantage does |
| --- | --- | --- |
| Cameras, names, capabilities, live video, recordings, events | UniFi Protect | Reads and relays. Stores only a stable reference `(nvr id, Protect camera id)` and a disposable metadata cache. |
| Identity, credentials, MFA, recovery | OIDC provider | Authenticates through OIDC. |
| Profiles, roles, groups, tags, grants, views, sharing, defaults, sessions, preferences, audit | Vantage (SQLite) | Authoritative. |

No video, snapshot or recording is stored in SQLite. Playback windows and clips live in a
size- and age-bounded directory.

## Code map

| Path | Purpose |
| --- | --- |
| `src/server/authz/policy.ts` | The one place that decides who may see which camera. |
| `src/server/authz/access.ts` | Standing access: whether access already handed out still holds, and the signal to re-check it. |
| `src/server/authz/views.ts` | Saved views, sanitized resolution, landing precedence. |
| `src/server/authz/preview.ts` | "See as staff". |
| `src/server/admin.ts` | Every change to Vantage data: validation, transaction, audit, cache invalidation. |
| `src/server/auth/` | OIDC sign-in, sessions, back-channel logout, lifecycle re-validation. |
| `src/server/protect/` | Adapter contract, the real `unifi-protect` adapter, the mock adapter. |
| `src/server/media/` | Media gateway and revocation sweep (`gateway.ts`), the relay interface (`relay.ts`) and its MediaMTX adapter (`mediamtx.ts`), playback windows, clip export. |
| `src/server/testing/` | Test fixture and the in-memory relay used by the automated tests. |
| `src/server/api.ts` | All HTTP endpoints, authentication, CSRF, rate limits. |
| `src/ui/` | The React interface. |
| `drizzle/` | Versioned SQL migrations. |

## Camera permissions

- Deny by default. A new or disabled user sees nothing.
- Staff see the union of cameras granted to them directly and to any group they belong to,
  including the built-in "All Staff" group. Grants are allow-only; there are no deny rules.
- Administrators see every camera through an explicit rule in the policy.
- Tags and view sharing never grant a camera.
- A newly discovered camera has no grants, so only administrators see it.
- A forbidden camera returns exactly what a non-existent one does (404), on every route.

| Capability | Admin | Staff |
| --- | --- | --- |
| Cameras and media | All | Granted cameras only |
| See which cameras are recording right now (REC mark) | Yes, but not while previewing as staff | No |
| Open views | All curated views and their own | Their own private views and views shared with them |
| Create private views | Yes | When an administrator allows it |
| Create, edit and share curated views | Yes | No |
| Set other people's starting view | Yes | No |
| Tags, people, groups, grants | Yes | No |
| See as staff | Yes | No |
| Change Protect | No | No |

The policy caches results in memory and drops the cache on every change to users, groups, grants
or the camera inventory.

## Standing access

The policy answers for one moment. Live streams, WHEP resources, clip downloads and the event feed
outlive the request that authorized them, so each keeps a small grant record: session, effective
subject, preview (when made during "See as staff") and camera (none for the event feed). Clip
exports store theirs in `export_jobs`; the others keep it in memory.

`Access` (`src/server/authz/access.ts`) is the only place that decides whether a grant still holds:

- the session is live: not revoked, inside its idle and absolute limits, its user active, and
  re-validated with the provider recently enough;
- the preview, if there was one, is live: not ended or timed out, the administrator still an
  administrator, the subject still active staff;
- the subject can still see the camera according to the policy.

Anything that cannot be resolved denies. A grant can only be used by the session and subject it
was made for.

`Access` also owns the one "access may have changed" signal. It fires on:

| Source | When |
| --- | --- |
| Policy | Any cache invalidation: a change to users, roles, groups, memberships, grants, tags or views, or a camera appearing, going missing or returning. |
| Sessions | A session is revoked, replaced at sign-in, or found past its idle or absolute limit. |
| Previews | A preview is exited, times out, or its administrator or subject stops qualifying. |

Time limits pass without an event, so a timer (`REVOCATION_SWEEP_SECONDS`) records due session and
preview expiries, which fires the signal, and sweeps the relay regardless. The camera sync runs
every 30 seconds and signals only when the inventory changed; a new name or recorder metadata
refreshes the description cache without a signal, because neither is an input to any decision.
The inventory holds only cameras adopted by this recorder: one Protect merely sees on the network, or
one adopted by another NVR, is left out, so a camera that is un-adopted goes missing like a removed
one. Missing cameras keep their grants, tags and view slots but are hidden from the camera wall;
administrators still see them, marked removed, in the access matrix and view editor.

A session suspended because the provider could not be reached is not ended and produces no signal. Its
requests fail at once and the timer's relay sweep stops its streams; an open event feed closes at
the next event or signal.

Three holders subscribe. The relay and clip exports are wired in `buildServices`
(`src/server/services.ts`); the event feed subscribes per open connection.

| Holder | On the signal |
| --- | --- |
| Media gateway | Sweeps: kicks relay readers and drops WHEP and HLS state whose grant no longer holds. |
| Clip exports | Aborts and deletes jobs and files whose grant no longer holds. |
| Event feed | Closes the connection if its session or preview is gone. Cameras are filtered per event. |

## Views

- **Follows tags (dynamic):** stores tag IDs in `view_predicate_tags`. A camera matches when it has
  every tag. Membership is recomputed on each request, sorted by name then ID.
- **Fixed list (static):** stores camera IDs and positions in `view_cameras`. Tags do not affect it.

The two kinds are stored separately and converting between them is an explicit, confirmed action.
A tag used by a view cannot be deleted until it is removed from that view.

What anyone sees is `view selection ∩ their camera grants`, computed every time. Staff receive a
sanitized view: no IDs, names or counts for cameras they cannot see. Sharing with a person and a
group at once lists the view once; removing one share keeps access if another remains.

### Starting view

The first match the person can still open wins:

1. A view an administrator picked for that person.
2. A view picked for one of their groups: highest `default_priority`, ties to the lower group ID.
3. The person's own choice, if personal views are enabled for them.
4. The view for everyone.
5. All their cameras, or a "no cameras yet" message.

Assignments are validated when set (the target must be able to open the view) and again at every
sign-in. A deleted or unshared default is skipped. A default that resolves to zero cameras opens
empty with a way to other views; nothing is borrowed to fill it.

## Sign-in and sessions

- Authorization Code with PKCE (S256), state and nonce, in a single-use transaction that expires in
  ten minutes. The code is exchanged on the server.
- The ID token is checked by `openid-client` and its signature is verified again explicitly against
  the issuer's JWKS, because the library skips the signature check for tokens that arrive directly
  from the token endpoint.
- Admission: the ID token claim named by `OIDC_ADMIT_CLAIM` must carry one of
  `OIDC_ADMIT_VALUES` (or just be non-empty when no values are listed). Production requires a
  claim unless `OIDC_ADMIT_ANY` is set.
- Identity is the exact `(issuer, subject)` pair. Email is a display attribute and is never used to
  find or link a profile.
- First sign-in creates a profile with no cameras and no administrator rights.
- Group sync: when a group lists values for the group claim (`OIDC_GROUPS_CLAIM`, default
  `OIDC_ADMIT_CLAIM`), people whose ID token carries one of them are added to it. These memberships
  are marked `provider` and are removed when the value goes away, checked at sign-in and on every
  refresh-token re-check (only from an ID token verified against the issuer's keys for the same
  subject). Manual memberships are never removed by the sync. The values last seen for each person
  are stored, so a mapping change applies immediately.
- The first administrator is the `(issuer, subject)` named in deployment configuration, promoted
  once on a normal sign-in, and audited.
- Sessions are random opaque tokens, stored hashed, in an HttpOnly cookie (Secure over HTTPS,
  SameSite=Lax), rotated at every sign-in, with idle and absolute limits. Writes need a per-session
  CSRF token and a same-origin request.
- Provider tokens are encrypted with `TOKEN_ENC_KEY` (AES-256-GCM). Only the ID token (for logout)
  and a refresh token (for re-validation) are kept.

### How revocation reaches Vantage

| Event | Mechanism | Delay until Vantage knows |
| --- | --- | --- |
| Sign out in Vantage | Session revoked directly | Immediate |
| Provider session ended or user signed out | Back-channel logout, if the provider sends it | The provider's delivery time |
| User disabled or deleted at the provider | Refresh-token check on a schedule; providers usually send no back-channel logout for these | Up to `OIDC_RECHECK_SECONDS` (default 5 minutes) |
| Disabled in Vantage, grant or group change | Policy invalidation | Immediate |
| "See as staff" exited or no longer allowed | Preview ended directly | Immediate |
| Session or preview time limit passes | Noticed by the next request, or by the timer | Up to `REVOCATION_SWEEP_SECONDS` |

Every row ends in the access signal described under [Standing access](#standing-access). Once
Vantage knows, pages and API calls fail at once and playing media stops within
`REVOCATION_SWEEP_SECONDS` (default 10, maximum 30). Clip downloads and the event feed stop on the
same signal. If the provider is unreachable, no one can sign in,
existing sessions are not extended, and a session that could not be re-validated for
`OIDC_MAX_STALE_SECONDS` is suspended until the provider answers again.

## Media enforcement

1. The browser asks a Vantage route for live video. The route authenticates the session, resolves
   the effective subject and checks the camera with the policy.
2. Vantage calls MediaMTX itself with a random ticket bound to session, subject, camera, path and
   transport, valid for 30 seconds and single-use for WebRTC.
3. MediaMTX runs with `authMethod: http` and asks Vantage's hook before serving any reader. A
   request without a valid ticket is refused even if it reaches MediaMTX directly. The only RTSP
   reader admitted is the relay's own FFmpeg (publisher credentials, internal address), and only on
   the internal `_src` paths described under Sound; no ticket ever names one of those.
4. Each admitted MediaMTX session is recorded with its grant. A sweep re-checks all of them with
   `Access` and kicks failures through the control API. It runs on every access signal and on a
   timer; a signal that arrives during a sweep triggers another one straight after. Readers Vantage
   does not know about are kicked.
5. HLS is proxied entirely by Vantage, so every playlist and segment request is authorized again.

WebRTC signalling is proxied; media flows from MediaMTX to the browser over ICE on port 8189. If no
media arrives within 4 seconds, the player tears the WebRTC session down and switches to HLS, and the
tab skips WebRTC for 10 minutes (`src/ui/live.tsx`). Tearing down a WHEP session frees its slot at
once. The per-session limit (`MAX_WALL_STREAMS` + 3) counts distinct streams (camera and quality),
not relay readers, because HLS takes a new reader every 25 seconds.

### Sound

Video starts muted, and sound plays only after a viewer clicks the speaker (or presses M in the
player), so browsers' autoplay rules never block a stream. One camera plays sound at a time across
the wall and the player (`src/ui/sound.tsx`); turning one on turns the previous one off.

Whether the viewer wants sound is remembered in the browser (local storage): turning a speaker on
or off sets it. Opening a camera while it is on moves the sound to that camera, so a viewer turns
sound on once rather than for every stream; jumping around the timeline keeps it. If the browser
still refuses to play with sound (typically right after a reload, before any click), the video plays
muted and the sound comes back on the viewer's next click or key press. Only that refusal mutes; a
play interrupted by a seek does not.

Whether a stream has sound is decided in the browser once it plays:

- WebRTC: MediaMTX carries Opus, G.711 and LPCM, not AAC. For a stream without any of those it
  still answers with a placeholder audio track that never sends a packet, so sound counts only when
  packets arrive (the track unmutes). Still muted three seconds after connecting means no audio.
- HLS: the playlist's codecs (hls.js), or the browser's own report for native HLS.
- Recorded video: the browser's report for the MP4.

A camera without sound shows a greyed-out speaker that explains "No audio". While sound is on, a
small meter shows the level actually arriving, so a viewer can tell a quiet room from a problem with
their own speakers. The meter is missing where the browser cannot expose an element's audio
(Safari for HLS and recordings).

Protect stamps its live audio in milliseconds while declaring a 16 kHz (AAC) or 48 kHz (Opus)
clock, so its timestamps run 16 to 48 times too slow. Browsers play the first fraction of a second
and then discard nearly every packet as late: a moment of garbled sound, then silence. For a camera
with a microphone (`featureFlags.hasMic`), the relay therefore takes two paths (`mediamtx.ts`):
MediaMTX pulls the camera into `<path>_src` as before, keeping the certificate fingerprint check,
and an FFmpeg it starts on demand reads that path over loopback RTSP, copies the video, decodes the
camera's first audio track and re-encodes it to AAC (for HLS) and Opus (for WebRTC) with timestamps
counted from the samples, then publishes `<path>`, which is what readers get tickets for. It adds
about half a second to start-up and one small FFmpeg process per stream being watched. Cameras
without a microphone are pulled directly, as before.

### The relay seam

Everything Vantage says to MediaMTX goes through one interface, `Relay` (`src/server/media/relay.ts`):
set up a stream, create, trickle and close a WHEP session, fetch an HLS file for a reader, list and
kick readers, report health. The gateway (`Media`) receives a relay through its constructor and
keeps the decisions:

| State | Owner | Why |
| --- | --- | --- |
| Tickets | Gateway | They are the capability the hook checks. |
| Admitted readers (relay reader id and grant) | Gateway | The sweep re-checks them with `Access`. |
| WHEP resource and its grant | Gateway | Only the session that created it may trickle or close it. |
| HLS entry per session, subject, preview and stream: grant, expiry, the relay's reader | Gateway | Re-issued every 25 seconds; dropped by the sweep when its grant stops holding. |
| HLS session cookie, redirect following | MediaMTX adapter, inside that reader | MediaMTX mechanics. The cookie lives exactly as long as the ticket it was obtained with. |
| Which paths are already configured | MediaMTX adapter | Saves a control API call per request. |

The adapter (`src/server/media/mediamtx.ts`) is the only file that knows MediaMTX's URLs, the
Bearer-ticket convention and the WHEP `location` format. Its cache of configured paths is dropped
when MediaMTX may have restarted: all of it when a request cannot connect or the health check
fails, one stream when MediaMTX answers 404 to a WHEP offer or an HLS playlist for it. The path is
then configured again the next time a ticket is issued for it, at most 25 seconds later for HLS.

The other direction, MediaMTX asking the hook, is not part of the interface: it arrives at
`/api/internal/mediamtx-auth` and is answered by the gateway.

Tests use an in-memory relay (`src/server/testing/relay.ts`). It admits no reader without asking
the same hook, tracks readers so listing and kicking work, and can be switched to unreachable. It
is a model of what Vantage can observe, not of MediaMTX itself.

## "See as staff"

The administrator stays the authenticated actor. A preview is a server-side record tied to the
administrator's session, with a token held per browser tab and sent explicitly on each request. All
reads use the subject's permissions through the normal policy, including media. Streams and clip
exports started during a preview carry its id and stop when it ends. All writes are refused. Entry, exit, timeout and denied attempts are audited with both identities. A forged,
foreign or expired token fails the request; it never falls back to the administrator's access.

## Recorded playback

Time is cut into fixed windows (`PLAYBACK_WINDOW_SECONDS`, default 60, aligned to the epoch). A seek
loads only the window containing the chosen moment and starts at the right offset. The player first
asks for the window's description (`GET /api/cameras/:id/playback/info`), then loads its video
(`GET /api/cameras/:id/playback`). While a window plays, the player buffers the next one in hidden
video elements and swaps it in, so playback continues without a black gap (the next window is
buffered only once it is fully recorded; near live, the old load-on-end path still applies). Windows
are cached on disk within a size and age limit. A seek that is abandoned cancels its export if nobody
else is waiting for it. Clicking an event starts `EVENT_PREROLL_SECONDS` (default 5) before it.

The recorder starts an export on the keyframe before the requested time, so a window's file usually
begins a few seconds early. The description's `leadMs` says by how much. The player maps media time to
wall-clock time with it, hands over to the next window when the wall-clock window ends (not when the
file ends), and starts the next window at its own lead, so nothing is replayed or skipped at a
handover. When the file runs out first, the old load-on-end path applies.

Adaptive recording (Protect records the low channel, and the high channel only around motion) needs
two corrections:

- **Video clock.** Some cameras' low channel exports with a video clock that runs fast (a 60-second
  window holds about 38 seconds of video beside 60 seconds of audio), which made the picture race
  ahead and then freeze. After each export, the UniFi adapter spreads the video frames evenly across
  the audio's span with an FFmpeg stream copy (`retimeVideoToAudio` in `src/server/protect/ffmpeg.ts`).
  Files that are already consistent are left alone.
- **High-resolution stretches.** A channel 0 export of a window containing motion holds only the
  high-resolution stretches, joined, with nothing saying where they belong. When that export is more
  than a second shorter than the window, the window is also exported from the low channel, which
  becomes the base. The high-resolution file becomes an overlay (`?layer=high`), and its stretches are
  placed by matching both files' audio (`alignSpans` in `src/server/media/align.ts`), to within 10 ms.
  The description lists them as overlay spans. The player keeps the base as the clock and, on every
  animation frame, keeps the overlay in step and shows it only inside its spans and only once it has
  the right frame. If the audio cannot place the overlay (no audio, silence), the window plays in low
  resolution rather than at the wrong moment.

Saved clips can be up to `CLIP_MAX_SECONDS` long (default two hours). The UniFi adapter streams
every export (playback windows and clips) from the recorder straight to disk over a second
sign-in of the same Protect account, because the library's transport holds whole responses in
memory. A clip job may run for ten minutes plus the clip's length before it is dropped; once ready it
stays downloadable for ten minutes. Each session prepares at most two clips at a time.

The recorder builds a whole export before it sends the first byte, so one request gives no progress.
A clip longer than five minutes is therefore exported in five-minute pieces,
`CLIP_EXPORT_PARALLEL` at a time (default 3), and joined with an FFmpeg stream copy
(`exportPieces` in `src/server/media/recordings.ts`). Each piece starts on the keyframe before its
start, so the overlap is cut from the end of the piece before it, using the same lead calculation as
playback windows. A piece with nothing recorded is left out. The job reports the share of pieces
done, and the status route adds a rough time left (average piece time, times the pieces left, divided
by the parallel count). When the job is ready the browser starts the download on its own, and the
dialog stays open with a way to download it again.

Times are UTC in storage and transport and shown in a selectable zone. Day boundaries follow the
zone, so a day is 23, 24 or 25 hours long around daylight-saving changes.

## Known risks

- Recorded video, historical events and thumbnails use Protect's private HTTP API, which the
  `unifi-protect` library does not cover and Ubiquiti does not document. They may change between
  Protect releases.
- No endpoint for recording gaps is known. On a real UNVR the timeline shows the overall recorded
  period, and a gap shows up as "Nothing recorded" when you seek into it.
- Live video needs an RTSP stream already enabled on the camera in Protect. Enabling one would be a
  write, so Vantage does not do it.
- Live sound depends on rebuilding Protect's audio timestamps (see Sound). If a Protect release
  fixes them, the rebuild is still correct but no longer needed. Audio timing counts samples from
  the start of each stream, so sound and video may drift apart slightly over a long session. H.265
  cameras play only in browsers that support it.
- SQLite means one application instance on local disk. Running replicas or placing the database on
  a network filesystem is not supported.
