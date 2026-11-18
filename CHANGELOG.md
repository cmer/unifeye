# Changelog

What changed in each release of Unifeye, for the people who run it and use it.
`scripts/release.sh` turns the Unreleased section into the new version's section
and uses it as the GitHub release notes.

## Unreleased

### Added
- `scripts/update.sh` takes a version number: `1.1.2` for that release, `1.3` for the newest
  1.3.x, or `2` for the newest 2.x.x.

### Changed
- Times in recordings, the timeline and activity now show in the recorder's time zone by default,
  so they match the clock on the video. "My time zone" and others are still in the time zone menu.
- Sign out and the light or dark switch are now in the menu that opens when you click your name.

### Fixed
- Activity shows a picture for each motion and detection event again.
- If activity markers fail to load on a camera's timeline, the player tries again on its own.

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
