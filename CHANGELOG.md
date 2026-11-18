# Changelog

What changed in each release of Unifeye, for the people who run it and use it.
`scripts/release.sh` turns the Unreleased section into the new version's section
and uses it as the GitHub release notes.

## Unreleased

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
