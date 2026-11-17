import { rm } from "node:fs/promises";
import { isCodec, withEncoder, type Codec } from "../protect/encoders";
import { fitVideo, videoSizes, type Size } from "../protect/ffmpeg";
import { log } from "../util";

interface Piece { path: string; codec: string; sizes: Size[]; fitted?: { path: string; size: Size } }
const area = (s: Size) => s.w * s.h, same = (a: Size, b: Size) => a.w === b.w && a.h === b.h;

/**
 * Brings the pieces of a clip to one picture size while they are still being downloaded.
 *
 * With adaptive recording, a long clip holds high- and low-resolution stretches, and a player
 * resizes its window at every change. Each piece is added as soon as it arrives. The largest size
 * seen so far is the target, and any piece with a smaller picture is re-encoded to it, one at a
 * time, while the remaining pieces download. If a later piece turns out to be larger still, the
 * pieces already resized are done again from their originals (rare: a camera has one high size).
 *
 * A resized piece keeps every frame at its original time, so it takes the original's place in the
 * join without changing where pieces are cut.
 *
 * Resizing is best effort. A hardware encode that fails is retried on the CPU, and a piece that
 * cannot be resized at all is joined as it was, so the clip still saves.
 */
export class SizeMatcher {
  private pieces: Piece[] = [];
  private scans: Promise<void>[] = [];
  private queue: Promise<void> = Promise.resolve();
  private target: { size: Size; codec: Codec } | null = null;
  /** Resizes waiting or running, resizes finished and the time they took, for progress. */
  pending = 0; done = 0; spentMs = 0;

  constructor(private signal: AbortSignal, private onChange: () => void = () => {}) {}

  /** A downloaded piece. Returns at once; its sizes are read in the background. */
  add(path: string) {
    this.scans.push(videoSizes(path, this.signal).then(({ codec, sizes }) => {
      const p: Piece = { path, codec, sizes };
      this.pieces.push(p);
      const big = sizes.reduce<Size | null>((m, s) => (!m || area(s) > area(m) ? s : m), null);
      if (big && isCodec(codec) && (!this.target || area(big) > area(this.target.size))) {
        this.target = { size: big, codec };
        for (const q of this.pieces) this.schedule(q);
      } else this.schedule(p);
    }, (e) => { if (!this.signal.aborted) log("warn", "could not read the picture size of a clip piece; it is joined as it is", { error: e }); }));
  }

  /** Waits for every resize and returns, for each resized piece, the file to join in its place. */
  async finish(): Promise<Map<string, string>> {
    await Promise.all(this.scans);
    await this.queue;
    this.signal.throwIfAborted();
    return new Map(this.pieces.filter((p) => p.fitted && this.target && same(p.fitted.size, this.target.size)).map((p) => [p.path, p.fitted!.path]));
  }

  /** Waits for running work to stop and deletes the resized files. */
  async cleanup() {
    await Promise.allSettled(this.scans);
    await this.queue;
    await Promise.all(this.pieces.map((p) => rm(`${p.path}.fit.mp4`, { force: true })));
  }

  private needs(p: Piece) {
    const t = this.target;
    return !!t && p.codec === t.codec && !p.sizes.every((s) => same(s, t.size)) && !(p.fitted && same(p.fitted.size, t.size));
  }

  private schedule(p: Piece) {
    if (!this.needs(p)) return;
    this.pending++;
    this.onChange();
    this.queue = this.queue.then(async () => {
      const t = Date.now();
      try {
        if (!this.signal.aborted && this.needs(p)) await this.fit(p);
      } catch (e) {
        if (!this.signal.aborted) log("warn", "could not resize a clip piece; it is joined at its own size", { error: e });
      } finally {
        this.pending--; this.done++; this.spentMs += Date.now() - t;
        this.onChange();
      }
    });
  }

  private async fit(p: Piece) {
    const { size, codec } = this.target!, dest = `${p.path}.fit.mp4`;
    await withEncoder(codec, (enc) => fitVideo(p.path, dest, size, enc, this.signal), this.signal);
    p.fitted = { path: dest, size };
  }
}
