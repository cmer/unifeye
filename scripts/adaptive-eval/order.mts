/**
 * Whether playback runs forward in time: builds each dataset's entries with the product's placement
 * (`placeStretch`, as `fetchRecorded` does), walks them as the player would, and reads the burned-in
 * clock of what is shown (the low clock for base and over entries; for inserts the high clock, shifted
 * by the high-low clock offset measured at the nearest placed GOP).
 *
 *   pnpm tsx scripts/adaptive-eval/order.mts [<setting>=<value> ...] <dataset>...
 *       TH=2 backward steps up to TH s are ignored; V=1 list every backward step, E=1 print the entries
 *
 * Settings override `PLACEMENT` as in `placement.mts`.
 *
 * A backward step is a moment shown after a later one: a misplaced GOP, or time placed in the wrong hole.
 */
import { args, fmt, labels, placeDataset, settingsFrom, verbose } from "./dataset.mjs";

const { sets, opts } = args(), settings = settingsFrom(opts), TH = Number(process.env.TH ?? 2);
let totBack = 0, totWorst = 0;
for (const d of sets) {
  const lo = labels(d, "lo"), hi = labels(d, "hi");
  const { entries, high, hi: hg, frames: lt } = await placeDataset(d, settings);
  const at = high.matched;

  // The high clock runs apart from the low one: measure the offset at each placed GOP.
  const hiAt = (k: number) => { const j = high.keys[k]; return j == null ? null : hi[j]; };
  const frameAt = (s: number) => { let k = 0; while (k + 1 < lt.t.length && lt.t[k + 1] <= s + 1e-6) k++; return k; };
  const off: (number | null)[] = hg.gops.map((_, k) => { const a = at[k], c = hiAt(k); if (a == null || c == null) return null; const l = lo[frameAt(a)]; return l == null ? null : l - c; });
  const offAt = (k: number) => { for (let r = 0; r < hg.gops.length; r++) for (const q of [k - r, k + r]) if (off[q] != null) return off[q]!; return 0; };
  const gopOfHigh = (s: number) => hg.gops.findIndex((g) => s >= g.t - 1e-3 && s < g.t + g.len - 1e-3);

  // The clock of every labelled picture, in playback order.
  const seq: { c: number; src: string }[] = [];
  for (const e of entries) {
    if (e.lead) continue;
    if (e.kind === "insert") {
      hg.gops.forEach((g, k) => { const c = hiAt(k); if (g.t >= e.high! - 1e-3 && g.t < e.high! + e.len - 1e-3 && c != null) seq.push({ c: c + offAt(k), src: `hi#${k}` }); });
      const k = gopOfHigh(e.high!), c = k < 0 ? null : hiAt(k);
      if (k >= 0 && hg.gops[k].t < e.high! - 1e-3 && c != null) seq.push({ c: c + offAt(k) + Math.round(e.high! - hg.gops[k].t), src: `hi#${k}+` });
    } else lt.t.forEach((t, j) => { if (t >= e.base - 1e-3 && t < e.base + e.len - 1e-3 && lo[j] != null) seq.push({ c: lo[j]!, src: `lo@${t.toFixed(1)}` }); });
  }
  let back = 0, worst = 0, peak = -Infinity;
  const bad: string[] = [];
  seq.forEach((x, i) => {
    if (x.c < peak - TH && peak - x.c < 600 && seq[i - 1].c >= peak - TH) { back++; bad.push(`${fmt(peak)} then ${fmt(x.c)} (${x.src}, ${peak - x.c} s back)`); worst = Math.max(worst, peak - x.c); }
    peak = Math.max(peak, x.c);
  });
  if (process.env.E) {
    const loAt = (s: number) => lo[frameAt(s)] ?? null, local = (ms: number) => fmt((ms - d.midnightMs) / 1000);
    for (const e of entries) {
      const h0 = e.high != null ? gopOfHigh(e.high) : -1, h1 = e.high != null ? gopOfHigh(e.high + e.len - 0.01) : -1;
      console.log(`   ${e.kind.padEnd(6)} len ${e.len.toFixed(2).padStart(6)} base ${e.base.toFixed(2).padStart(6)} [lo ${fmt(loAt(e.base))}..${fmt(loAt(e.base + (e.kind === "insert" ? 0 : e.len) - 0.01))}]${h0 >= 0 ? ` high #${h0}..#${h1} [hi ${fmt(hiAt(h0))}..${fmt(hiAt(h1))} off ${offAt(h0)}]` : ""} at ${local(e.at)}${e.lead ? " lead" : ""}`);
    }
  }
  console.log(`${d.name}: ${entries.length} entries, ${back} backward steps, worst ${worst} s`);
  if (verbose) for (const b of bad) console.log("    " + b);
  totBack += back; totWorst += worst;
}
console.log(`TOTAL backward steps ${totBack}, sum of worst ${totWorst} s`);
