# Demo camera stills

AI-generated stills, one per simulated camera (`<protect id>.jpg`, ids from
`src/server/protect/mock-data.ts`). They are not real footage. In mock mode, set
`MOCK_PHOTOS=assets/demo-cameras` and the simulated cameras show these instead of colour gradients:
live video, snapshots, event thumbnails and saved clips.

They exist for the README screenshots in `docs/screenshots/`.

- Regenerate the stills: `scripts/screenshots/generate-cameras.sh [mock-01 ...]` (the prompts live in that script)
- Retake the screenshots: `scripts/screenshots/capture.sh`
