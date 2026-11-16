/**
 * Where a piece of one export sits inside another, found from their audio.
 *
 * With adaptive recording, a channel 0 export of a window that contains motion holds only the
 * high-resolution stretch, with nothing saying where in the window it starts. The low-resolution
 * export of the same window covers all of it, and both carry the same audio track, so each short
 * chunk of the high-resolution audio is matched against the low-resolution audio's loudness curve.
 */

/** `len` seconds of the overlay, starting at overlay time `from`, belong at base time `at`. */
export interface Span { at: number; from: number; len: number }

const STEP = 0.01, CHUNK = 200, MIN_R = 0.9, SAME = 0.03;

function pearson(a: Float64Array, b: Float64Array): number {
  const n = a.length; let am = 0, bm = 0;
  for (let i = 0; i < n; i++) { am += a[i]; bm += b[i]; }
  am /= n; bm /= n;
  let num = 0, as = 0, bs = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - am, y = b[i] - bm; num += x * y; as += x * x; bs += y * y; }
  return as > 1e-6 && bs > 1e-6 ? num / Math.sqrt(as * bs) : 0;
}

/** Best Pearson match of `a` inside `b`: [correlation, offset in steps]. */
function bestMatch(a: Float64Array, b: Float64Array): [number, number] {
  const n = a.length;
  let am = 0; for (const v of a) am += v; am /= n;
  let ass = 0; for (const v of a) ass += (v - am) ** 2;
  if (ass < 1e-6 || b.length < n) return [0, 0];
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { sum += b[i]; sq += b[i] * b[i]; }
  let best: [number, number] = [-1, 0];
  for (let L = 0; ; L++) {
    const bm = sum / n, bss = sq - n * bm * bm;
    if (bss > 1e-6) {
      let num = 0; for (let i = 0; i < n; i++) num += (a[i] - am) * b[L + i];
      const r = num / Math.sqrt(ass * bss);
      if (r > best[0]) best = [r, L];
    }
    if (L + n >= b.length) break;
    sum += b[L + n] - b[L]; sq += b[L + n] ** 2 - b[L] ** 2;
  }
  return best;
}

/**
 * Splits the overlay's loudness curve into 2-second chunks, places each one in the base, and joins
 * neighbours that agree into spans. Chunks that match nothing well (silence, a different recording)
 * are left out, so those moments show the base. Returns [] when nothing can be placed.
 */
export function alignSpans(overlay: Float64Array, base: Float64Array): Span[] {
  const placed: { from: number; len: number; shift: number }[] = [];
  for (let c = 0; c < overlay.length; c += CHUNK) {
    const piece = overlay.subarray(c, Math.min(c + CHUNK, overlay.length));
    if (piece.length < CHUNK / 2) { if (placed.length) placed[placed.length - 1].len += piece.length * STEP; break; }
    const [r, L] = bestMatch(piece, base);
    if (r >= MIN_R) placed.push({ from: c * STEP, len: piece.length * STEP, shift: (L - c) * STEP });
  }
  const spans: Span[] = [];
  for (const p of placed) {
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.at - last.from - p.shift) <= SAME && p.from - (last.from + last.len) < 4.01) last.len = p.from + p.len - last.from;
    else spans.push({ at: p.from + p.shift, from: p.from, len: p.len });
  }
  // Chunks that straddle a join between two stretches match neither, so grow each span's edges in
  // quarter seconds while the audio still agrees at that span's offset.
  const Q = 25, fits = (from: number, shift: number) => {
    const i = Math.round(from / STEP), j = i + Math.round(shift / STEP);
    return i >= 0 && i + Q <= overlay.length && j >= 0 && j + Q <= base.length && pearson(overlay.subarray(i, i + Q), base.subarray(j, j + Q)) >= MIN_R;
  };
  spans.forEach((sp, k) => {
    const shift = sp.at - sp.from, lo = k ? spans[k - 1].from + spans[k - 1].len : 0, hi = k + 1 < spans.length ? spans[k + 1].from : overlay.length * STEP;
    while (sp.from - Q * STEP >= lo - 1e-9 && fits(sp.from - Q * STEP, shift)) { sp.from -= Q * STEP; sp.at -= Q * STEP; sp.len += Q * STEP; }
    while (sp.from + sp.len + Q * STEP <= hi + 1e-9 && fits(sp.from + sp.len, shift)) sp.len += Q * STEP;
  });
  const round = (x: number) => Math.round(x * 1000) / 1000;
  // A lone chunk could be a chance match; keep it only when the overlay is that short.
  return spans.filter((s) => s.len > CHUNK * STEP + 0.01 || overlay.length <= CHUNK * 1.5).map((s) => ({ at: round(Math.max(0, s.at)), from: round(s.from), len: round(s.len) }));
}
