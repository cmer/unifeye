# Adaptive matching harness

Measures how well Unifeye puts an adaptive recording back together on real recorder footage, so the
matching can be tuned against numbers instead of guesses. With adaptive recording, Protect keeps a
low-resolution and a high-resolution channel that take turns, with gaps in both. Unifeye's placement
module (`src/server/media/placement/`) places each high-resolution GOP on the low-resolution file by
its picture, gives keyframes wall-clock times from the recorder's segment lists, and builds the
playback order. `docs/architecture.md` ("Recorded playback") describes the rules.

These scripts are not part of the product or of `pnpm test`. They call the module the way the product
does (`placeStretch`, from `placeDataset` in `dataset.mts`) on saved exports, and compare the result
and its trace with the clock each camera draws on its picture. The product
never reads that clock (not every camera shows one); here it is only the answer key. The scripts find
each keyframe's picture, and so its clock reading, through the trace (`baseFrames`, `high.keys`), the
pairing the placement itself made, rather than pairing GOPs and pictures again.

## The footage

The footage lives in the **private** repository
[`cmer/unifeye-test-footage`](https://github.com/cmer/unifeye-test-footage), under `adaptive/`. It is
real footage of people on private premises, and this repository is public. Never copy footage,
stills, camera names or ids, capture times or clock readings into this repository, an issue or a
pull request. Refer to datasets by folder name (`d0` to `d7`). `.gitignore` blocks `*.mp4` as a
safety net.

```sh
gh repo clone cmer/unifeye-test-footage ../unifeye-test-footage
```

Each dataset is one window of one camera (`dataset.mts` has the details):

| File | What it holds |
| --- | --- |
| `lo.mp4`, `hi.mp4` | The recorder's exports of the window: channel 2 (low) and channel 0 (high) |
| `segs.json` | The recorder's segment lists for both channels (`playback-history`) |
| `meta.json` | Camera, window, UTC offset, and where the camera draws its clock. `highExtendMs` (new captures) says the high file runs that long past the window |
| `stamps.json` | Optional: the recorder's wall-clock ms for each GOP of each file (`{ lo, hi }`), read from Protect's playback stream. The high channel is stamped up to ~35 s late, so new captures export it 60 s past the window |
| `labels_lo.json`, `labels_hi.json` | The clock read off every low frame and every high keyframe, in seconds since local midnight |

## Running

FFmpeg and ffprobe must be on the path. Each script takes dataset folders:

```sh
pnpm tsx scripts/adaptive-eval/placement.mts ../unifeye-test-footage/adaptive/d*
```

| Script | What it measures |
| --- | --- |
| `placement.mts` | Where each high GOP is laid over the low file: on the right moment, on a wrong one, left out although the low file shows it (that moment then plays twice), or rightly left out (it becomes an insert). Also how well the pictures alone separate the right moment from others. |
| `order.mts` | The whole order: walks the entries and counts moments shown after a later one. `V=1` lists them, `E=1` prints the entries. |
| `clock.mts` | How far the keyframe times are from the clock, for the low file and for the high one. |
| `segments.mts` | What the recorder's segment lists mean, against the clock (`which=hi` for the high channel). Rerun after a Protect update. |
| `label.mts` | Reads the clocks and writes the two label files (macOS only; builds `ocr.swift` with `swiftc` on first use). |
| `lag.mts` | With `stamps.json`: how close the time given to each high GOP is to the clock. `V=1` lists every GOP. |
| `windows.mts` | With `stamps.json`: plays each dataset as the product does, one minute at a time with context either side, and counts clock seconds shown out of order, shown twice and recorded but never shown. `V=1` lists every entry. This is the number that matters for placement with stamps. |
| `capture.mjs` | Captures a new dataset from the recorder (see below). |
| `player-check.mjs` | Watches adaptive playback in headless Chrome on a mock-mode stack (no footage needed; see below). |

## Baseline

Measured on 2026-11-18 on `d0` to `d7` (eight five-minute windows from six cameras on one recorder,
Protect 7.3). Placement changes should keep or beat these; record new numbers in `docs/verification.md`.

| Script | Result |
| --- | --- |
| `placement.mts` | 330 high GOPs, 315 with a readable clock: 120 on the right moment, 24 on a wrong one, 28 left out although shown, 143 rightly left out. For 10 of the 154 GOPs the low file shows, another moment looks more alike than the right one. |
| `order.mts` | 42 moments shown after a later one |
| `clock.mts` | Low keyframe times within 4.1 s of the clock at the median, 16.1 s at p90, 35.7 s at worst |

With the recorder's stamps (the product's normal path since 2026-11-18), measured that day on `d0`
to `d13` (fourteen five-minute windows from twelve cameras, Protect 7.3.74):

| Script | Result |
| --- | --- |
| `windows.mts` | 42 one-minute windows holding 1393 s of footage by the clock: 65 s shown out of order (about a dozen misplaced runs, nearly all in still scenes), 8 s shown twice, 86 s never shown. Shown time is within 0.4 s of the clock at the median and 5.5 s at p90. |
| `lag.mts` | 731 high GOPs with a readable clock: 552 placed within 1.5 s of it, 650 within 4 s. The high channel's stamps ran late by 16 s at the median and 32.5 s at most. |

Both counts include a few misread clocks (`d5` and `d11` have keyframe labels that are minutes off),
and the two channels draw their clocks up to two seconds apart, so small steps are not all real.

## Tuning

The settings for placement with stamps are `PLACEMENT.lag` (`lag.absent=0.65` and so on); `STAMPS=0`
runs `placement.mts`, `order.mts` and `clock.mts` the old way, as the product does when the recorder
gives no stamps. Every setting of the placement is in `PLACEMENT` (`src/server/media/placement/index.ts`), which
explains each one. `placement.mts`, `order.mts` and `clock.mts` take overrides by dotted path before
the dataset folders, for example:

```sh
pnpm tsx scripts/adaptive-eval/order.mts match.threshold=0.75 holes.open=1.2 thumb=96x72 ../unifeye-test-footage/adaptive/d*
```

A name that is not a setting stops the script. When a change helps, set it in `PLACEMENT`, rerun all
three scripts, run `pnpm test`, and record the numbers in `docs/verification.md`.

The scripts skip one step of `fetchRecorded`: repairing a low file whose video clock runs fast
(`retimeVideoToAudio`). The baseline was measured without it.

## Adding a dataset

The capture script only reads from the recorder: it signs in with Unifeye's recorder account and asks
for exports and segment lists. It runs inside the Unifeye app container, which holds that account.
`<server>` and `<compose dir>` are the production host and its Compose folder.

1. Find a camera that records in adaptive mode:
   ```sh
   ssh <server> 'cd <compose dir> && docker compose exec -T app node --input-type=module - list' < scripts/adaptive-eval/capture.mjs
   ```
2. Capture a window where both channels recorded, ideally with still stretches and with moments that
   look alike, since those are the hard cases. Times are ms since the epoch; the default length is 5 minutes:
   ```sh
   ssh <server> 'cd <compose dir> && docker compose exec -T app node --input-type=module - <camera id> <start ms> 5 /tmp/adaptive-eval-new' < scripts/adaptive-eval/capture.mjs
   ```
   The capture also writes `stamps.json`, and exports the high channel 60 s past the window
   (`highExtendMs` in `meta.json`). For a dataset captured earlier, print its stamps (both channels over
   exactly the window) with `... - stamps <camera id> <start ms> <end ms>` and check there are as many
   as keyframes in each file (`ffprobe -select_streams v -show_entries packet=flags -of csv=p=0 file | grep -c K`).
3. Copy it into the footage clone and delete it from the server in the same step. Never leave
   captures on the server:
   ```sh
   mkdir ../unifeye-test-footage/adaptive/d8
   ssh <server> 'cd <compose dir> && docker compose exec -T app sh -c "tar cf - -C /tmp/adaptive-eval-new . && rm -rf /tmp/adaptive-eval-new"' | tar xf - -C ../unifeye-test-footage/adaptive/d8
   ```
4. Set `clockCrop` in its `meta.json` (an FFmpeg crop around the clock in each file; `label.mts` says
   how to find it), then run `label.mts` on it and spot-check a few readings by eye.
5. Commit it to the footage repository, rerun the scripts, and update the baseline.

Footage without a burned-in clock cannot be labelled this way. The recorder drops the connection when
asked for many exports at once; the capture script paces its requests.

`label.mts` can leave a few more readings empty than the saved labels have (on `d0`'s high file it
reads 22 of 24 keyframes; the saved file has all 24). The saved labels are the answer key.

## Checking the player in a browser

`player-check.mjs` needs no footage. It runs against a mock-mode stack whose simulated "Upper Lounge"
camera records adaptively, signs in, opens a recording just before motion and prints what the player
shows every half second, then any moment the picture stopped. It needs Playwright and Chrome; point
`PLAYWRIGHT` at Playwright's `index.mjs` (for example after `npm i --prefix ~/.cache/pw playwright`):

```sh
MOCK_ADAPTIVE=mock-06 PLAYBACK_WINDOW_SECONDS=15 bash .claude/skills/qa-sweep/scripts/stack.sh start 4
PLAYWRIGHT=~/.cache/pw/node_modules/playwright/index.mjs node scripts/adaptive-eval/player-check.mjs http://localhost:3140
bash .claude/skills/qa-sweep/scripts/stack.sh stop 4
```

Fifteen-second windows make motion cross the handover between windows, and the window at second 15
of each half minute opens inside the GOP the window before ended with (as on a real recorder). The
script's header says what the output should look like. Stack ports are shared by every checkout on the machine: pick a slot no other
session is using, or the stacks stop each other.
