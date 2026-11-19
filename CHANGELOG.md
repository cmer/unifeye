# Changelog

What changed in each release of Unifeye, for the people who run it and use it.
Changes waiting for the next release are in `.changelog/`; `scripts/release.sh` gathers
them into the new version's section here and uses it as the GitHub release notes.

## 1.2.2 - 2026-11-18

### Added
- When playback skips a few seconds the recorder didn't record, a short note says so.
- Zoomed in, the timeline shows short breaks in the recording around the parts you've watched.
- When playback reaches a minute or more with nothing recorded, it pauses and says when the
  recording picks up again, with a button to keep playing. Shorter gaps are skipped on their own.

### Fixed
- Recordings from cameras that record in two qualities (adaptive recording) no longer jump back and
  forth in time or repeat moments. Unifeye now reads the recorder's own time for every piece of
  footage, so playback follows the camera's clock and the time under the video matches it. Where the
  recorder itself has no footage, playback skips ahead, as before.
- Saved clips from those cameras follow the same order.

## 1.2.1 - 2026-11-18

### Fixed
- When Unifeye is added to the Dock from Safari, the title bar now matches the light or dark look you
  picked in Unifeye, instead of following the Mac's setting.

## 1.2.0 - 2026-11-18

### Added
- `scripts/update.sh` takes a version number: `1.1.2` for that release, `1.3` for the newest
  1.3.x, or `2` for the newest 2.x.x.
- The camera wall can rewind: press the clock button to open a timeline, and every camera on
  screen plays the same moment. Drag to look back, with pictures as you go. Clips can't be
  saved from the wall; open a camera to save one.
- New `WALL_PLAYBACK_STREAMS` setting: how many cameras on the wall play recorded video at once
  when rewinding (default 4). The rest show a picture every few seconds.
- New `SCRUB_PRELOAD_MS` setting: how long someone pauses while dragging a camera's timeline
  before that moment starts loading (default 500; 0 turns it off).

### Changed
- Dragging along a camera's timeline shows pictures from each moment as you go, and the video
  starts where you let go. Pausing on a moment while dragging starts loading it, so it plays
  sooner when you let go.
- Times in recordings, the timeline and activity now show in the recorder's time zone by default,
  so they match the clock on the video. "My time zone" and others are still in the time zone menu.
- The People list in Admin is more compact and fits without scrolling sideways. View as, sign-in
  settings and password links are in the ⋯ menu on each row.
- Sign out and the light or dark switch are now in the menu that opens when you click your name.

### Fixed
- Activity shows a picture for each motion and detection event again.
- If activity markers fail to load on a camera's timeline, the player tries again on its own.
- Recorded video no longer sometimes jumps back a few seconds as it plays on from one
  minute to the next.
- Saved clips no longer lose a second where part of the clip couldn't be fetched from the recorder.
- Saved clips and playback no longer repeat a moment where the recording switches to high quality.

## 1.1.1 - 2026-11-18

### Fixed
- Live video no longer shows "The server turned some requests away" after reloading the page,
  switching views or opening a second tab.

## 1.1.0 - 2026-11-18

### Fixed
- Recorded video from cameras that record in both low and high resolution now shows
  every moment the recorder kept, in the right order, including moments recorded only
  in high resolution.
- High-resolution footage now lines up with the rest of the recording even when the
  camera has no sound, instead of falling back to low resolution.
- Clips from these cameras keep every recorded frame.

## 1.0.0 - 2026-11-18

### Added
- Live video from your UniFi Protect cameras on a wall of tiles, in real time where the
  network allows and a few seconds behind where it doesn't. Cameras that support it are
  streamed directly, with the recorder as the fallback.
- Recorded video with a rolling 24-hour timeline, activity markers and camera sound.
- Clips: trim a stretch of recorded video and download it. Administrators choose which
  groups may export.
- An Activity page listing what the cameras detected.
- Shared views that administrators build, and private views anyone can make for themselves.
- Camera access by person or group, with tags to organise cameras and switches to grant
  many cameras at once. Nobody sees a camera they weren't given.
- "See as staff", so an administrator can check exactly what someone else sees.
- Sign-in through your identity provider (OIDC), Cloudflare Access, password accounts or
  a code sent by email.
- An audit log of every administrative change, and a daily database backup.
- Diagnostics, under your name in the sidebar: checks the connection, real-time video over
  UDP and TCP, standard video, refused requests and what each tile is doing, with a report
  to copy and send to your administrator.
- Diagnostics shows the version and commit that are running, and whether a newer version
  is available.
- `scripts/update.sh` updates a Docker Compose installation and backs up the database first.
