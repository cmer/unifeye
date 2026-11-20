# CHANGELOG

## 1.4.2 - 2026-11-20

### Fixed
- Live video that falls back to the slower connection no longer freezes for good. If it stops, it catches up to live, and reconnects if it's still stuck.
- Live video now plays in Safari and on iPhone for cameras with a microphone, when it can't use the faster connection.

## 1.4.1 - 2026-11-20

### Added
- On the camera wall, pointing at a camera that isn't playing starts it.

### Changed
- When you rewind the camera wall, up to 24 cameras on screen now play their recordings, instead of only the first four. Wall tiles play the lower-resolution recording so they keep up; open a camera to see it in full detail.
- When you rewind the camera wall, cameras just below or above the screen get ready ahead, so they start right away when you scroll to them.
- The camera wall now plays up to 24 cameras at once, live or rewound, up from 9 live. Only cameras on screen play. Set MAX_WALL_STREAMS to change the limit.

### Fixed
- Video no longer shows a black screen while it starts, live or recorded. A still image stays up with a spinner until the video appears.

### Removed
- The WALL_PLAYBACK_STREAMS setting is gone: MAX_WALL_STREAMS now sets how many cameras play on the wall, live or rewound.

## 1.4.0 - 2026-11-20

### Added
- Addresses at chosen email domains can be sent straight to your sign-in provider: set OIDC_EMAIL_DOMAINS, and people who type one on the sign-in page skip the password step.
- Add ?stream=webrtc or ?stream=hls to a camera's address to choose how its live video is sent, which helps test a network.
- Diagnostics now checks the browser. It warns when video can't start on its own, for example in Low Power Mode on iPhone, and when the browser is out of date.

### Changed
- Scrolling or pinching on a timeline now zooms smoothly instead of jumping between fixed levels, and can zoom in as close as one minute.
- The sign-in pages have a roomier new design, in light or dark to match your device.
- People stay signed in for 30 days instead of being signed out after 12 hours without use. Set `SESSION_DAYS` to change how long. `SESSION_ABSOLUTE_HOURS` is replaced by `SESSION_DAYS`, and the idle sign-out (`SESSION_IDLE_MINUTES`) is now off unless you set it.
- Live video plays more evenly. It is now held for a second before it shows, which hides the short pauses many cameras make every couple of seconds. Set LIVE_BUFFER_MS to change how long (0 turns it off).

### Fixed
- Recorded video built during a brief recorder hiccup is fetched again later instead of being kept. It no longer plays out of order or flips between low and high quality every second or two. Where the recorder itself is missing footage in one quality, playback still switches quality there.

## 1.3.0 - 2026-11-19

### Added
- Scrolling or pinching on the timeline zooms it in and out.
- Click a colored event mark on the timeline to jump to that moment. Pointing at one shows what happened and when.

### Changed
- Clicking “Now” at the end of the timeline goes back to live video.
- The timeline is easier to grab: you no longer need to land right on the dot.

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
