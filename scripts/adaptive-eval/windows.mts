/**
 * With the recorder's stamps (`stamps.json`): plays a dataset the way the product does, one minute
 * at a time, and checks what is shown against the clock drawn on the pictures. Each one-minute window
 * inside the dataset that has a minute of footage on either side is placed on its own (`placeStretch`
 * with stamps): its base is the low file's GOPs stamped inside it (and the one before, the lead), its
 * context the low file a minute either side, and its high file the high GOPs stamped from its start
 * to a minute past its end, as `fetchRecorded` exports them. The windows' entries are then read in
 * order, as the player plays them on from one another.
 *
 *   pnpm tsx scripts/adaptive-eval/windows.mts [key=value ...] <dataset>...     V=1 lists every entry
 *
 * Counted, in seconds of the camera's clock: shown out of order (after a later moment), shown twice,
 * recorded but never shown, and how far the time the player would show is from the clock.
 */
import { highReachMs, placeStretch } from "@/server/media/placement";
import { gopsOf, thumbnails } from "@/server/protect/ffmpeg";
import { args, fmt, labels, settingsFrom, verbose } from "./dataset.mjs";

const { sets, opts } = args(), settings = settingsFrom(opts), MIN = 60_000, reach = highReachMs(settings);
const tot = { windows: 0, shown: 0, back: 0, twice: 0, lost: 0, recorded: 0, off: [] as number[] };
for (const d of sets) {
  if (!d.stamps) { console.log(`${d.name}: no stamps.json`); continue; }
  const lo = labels(d, "lo"), hi = labels(d, "hi");
  const [L, H] = await Promise.all([gopsOf(d.lo), gopsOf(d.hi)]);
  const [frames, keys] = await Promise.all([thumbnails(d.lo, { keyframes: false, ...settings.thumb }), thumbnails(d.hi, { keyframes: true, ...settings.thumb })]);
  const Ls = d.stamps.lo, Hs = d.stamps.hi;
  if (Ls.length !== L.gops.length || Hs.length !== H.gops.length) { console.log(`${d.name}: stamps do not fit the files (${Ls.length}/${L.gops.length} low, ${Hs.length}/${H.gops.length} high)`); continue; }
  // The clock at a low media time (its frame's label), and at a high one (its GOP's keyframe label plus the time into the GOP).
  const loClock = (s: number) => { let k = 0; while (k + 1 < frames.t.length && frames.t[k + 1] <= s + 1e-3) k++; return lo[k]; };
  const keyIdx = H.gops.map((g) => keys.t.findIndex((t) => Math.abs(t - g.t) < 0.02));
  const hiClock = (s: number) => { const g = H.gops.findLastIndex((x) => x.t <= s + 1e-3); const c = g < 0 || keyIdx[g] < 0 ? null : hi[keyIdx[g]]; return c == null ? null : c + (s - H.gops[g].t); };
  const baseOff: number[] = [];
  Ls.forEach((t, k) => { const c = loClock(L.gops[k].t); if (c != null) baseOff.push((t - d.midnightMs) / 1000 - c); });
  const usual = baseOff.sort((a, b) => a - b)[baseOff.length >> 1] ?? 0;
  // The high file ends at the dataset's end, or `highExtendMs` past it for newer captures.
  const hiEnd = d.meta.endMs + ((d.meta as { highExtendMs?: number }).highExtendMs ?? 0);
  const shownAt = new Map<number, number>();
  let peak = -Infinity, back = 0, n = 0, first = Infinity, last = -Infinity;
  for (let a = Math.ceil((d.meta.startMs + reach) / MIN) * MIN; a + MIN + reach <= Math.min(d.meta.endMs, hiEnd); a += MIN) {
    const b = a + MIN;
    const pick = (stamps: number[], from: number, to: number) => { const ks: number[] = []; const lead = stamps.findLastIndex((t) => t < from); if (lead >= 0) ks.push(lead); stamps.forEach((t, k) => { if (t >= from && t < to) ks.push(k); }); return ks; };
    const bk = pick(Ls, a, b), ck = pick(Ls, a - reach, b + reach), hk = pick(Hs, a, b + reach);
    if (!bk.length) continue;
    const sub = <T,>(xs: T[], ks: number[]) => ks.map((k) => xs[k]);
    const endOf = (g: { gops: { t: number; len: number }[] }, ks: number[]) => { const x = g.gops[ks[ks.length - 1]]; return x.t + x.len; };
    const base = { gops: sub(L.gops, bk), end: endOf(L, bk), segments: null, frames, stamps: sub(Ls, bk), context: { gops: sub(L.gops, ck), stamps: sub(Ls, ck), frames } };
    const { entries } = hk.length > 1 ? placeStretch({ startMs: a, endMs: b }, base, { gops: sub(H.gops, hk), end: endOf(H, hk), segments: null, keys, stamps: sub(Hs, hk) }, settings) : placeStretch({ startMs: a, endMs: b }, base, undefined, settings);
    n++; first = Math.min(first, a); last = Math.max(last, b);
    for (const e of entries) {
      if (e.lead) continue;
      const clock = (o: number) => (e.kind === "base" ? loClock(e.base + o) : hiClock(e.high! + o));
      // The clock second of every quarter second played; unreadable ones are skipped.
      const secs: number[] = [];
      for (let o = 0; o < e.len; o += 0.25) { const c = clock(o); if (c != null) secs.push(c); }
      const c0 = secs[0], c1 = secs[secs.length - 1];
      if (verbose) console.log(`   ${fmt((a - d.midnightMs) / 1000)} ${e.kind.padEnd(6)} ${e.len.toFixed(1).padStart(5)} s shows ${fmt(c0)}..${fmt(c1)} as ${fmt((e.at - d.midnightMs) / 1000 - usual)}${c0 != null && c0 < peak - 1.5 ? `  BACK ${(peak - c0).toFixed(0)} s` : ""}`);
      if (c0 == null) continue;
      if (c0 < peak - 1.5) back += Math.min(e.len, peak - c0);
      if (clock(0) != null) tot.off.push(Math.abs((e.at - d.midnightMs) / 1000 - usual - c0));
      for (const x of new Set(secs.map((c) => Math.floor(c)))) shownAt.set(x, (shownAt.get(x) ?? 0) + 1);
      peak = Math.max(peak, c1);
    }
  }
  if (!n) { console.log(`${d.name}: too short for a window with context`); continue; }
  // What was recorded inside the windows played, by the clock (either file).
  const lo0 = (first - d.midnightMs) / 1000 - usual, lo1 = (last - d.midnightMs) / 1000 - usual, rec = new Set<number>();
  lo.forEach((c) => { if (c != null && c >= lo0 + 1 && c < lo1 - 1) rec.add(c); });
  H.gops.forEach((g, k) => { const c = keyIdx[k] < 0 ? null : hi[keyIdx[k]]; if (c != null) for (let s = c; s < c + Math.floor(g.len); s++) if (s >= lo0 + 1 && s < lo1 - 1) rec.add(s); });
  let twice = 0, lost = 0, shown = 0;
  for (const [s, c] of shownAt) { if (s >= lo0 + 1 && s < lo1 - 1) { shown++; if (c > 2) twice += c - 2; } }
  for (const s of rec) if (!shownAt.has(s)) lost++;
  console.log(`${d.name}: ${n} windows, ${rec.size} s recorded: ${back.toFixed(0)} s out of order, ${twice} s twice, ${lost} s never shown`);
  tot.windows += n; tot.back += back; tot.twice += twice; tot.lost += lost; tot.recorded += rec.size; tot.shown += shown;
}
const q = (p: number) => (tot.off.length ? [...tot.off].sort((a, b) => a - b)[Math.min(tot.off.length - 1, Math.floor(p * tot.off.length))] : NaN);
console.log(`TOTAL ${tot.windows} windows, ${tot.recorded} s recorded: ${tot.back.toFixed(0)} s out of order, ${tot.twice} s twice, ${tot.lost} s never shown; shown time off the clock by ${q(0.5).toFixed(1)} s at the median, ${q(0.9).toFixed(1)} s at p90, ${Math.max(0, ...tot.off).toFixed(1)} s at worst`);
