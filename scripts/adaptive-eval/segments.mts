/**
 * Checks what the recorder's segment lists (`playback-history`) mean, against the burned-in clock.
 * The product's keyframe times (the placement module's `clock.ts`) assume each low-channel segment runs from the first
 * keyframe of a recorded run to its last; rerun this when Protect changes.
 *
 *   pnpm tsx scripts/adaptive-eval/segments.mts [which=lo|hi] [<dataset>...]
 *
 * For each segment near the window: its start and end, and the keyframe whose clock is nearest each,
 * with the difference in seconds. On the recorder measured, low segments matched keyframes within
 * about a second (except the first, which starts before the export), and the high lists were 6 to 30
 * seconds off.
 */
import { gopsOf, thumbnails } from "@/server/protect/ffmpeg";
import { args, fmt, labels } from "./dataset.mjs";

const { sets, opts } = args(), which = (opts.which ?? "lo") as "lo" | "hi";
for (const d of sets) {
  const ws = d.meta.startMs, we = d.meta.endMs, lab = labels(d, which);
  const file = which === "lo" ? d.lo : d.hi, { gops } = await gopsOf(file);
  // Low labels are per frame, high labels per keyframe: find each keyframe's reading.
  const t = which === "lo" ? (await thumbnails(file, { keyframes: false, w: 8, h: 6 })).t : (await thumbnails(file, { keyframes: true, w: 8, h: 6 })).t;
  const keys = gops.map((g) => { const j = t.findIndex((x) => Math.abs(x - g.t) < 0.02); return { t: g.t, c: j < 0 ? null : lab[j] ?? null }; });
  const out: string[] = [];
  for (const [a, b] of d.segs[which]) {
    if (b < ws - 60_000 || a > we) continue;
    const sa = (a - d.midnightMs) / 1000, sb = (b - d.midnightMs) / 1000;
    const near = (s: number) => keys.reduce<{ t: number; c: number | null } | null>((m, k) => (k.c != null && (m == null || Math.abs(k.c - s) < Math.abs(m.c! - s)) ? k : m), null);
    const na = near(sa), nb = near(sb);
    out.push(`[${fmt(sa)} .. ${fmt(sb)} ${((b - a) / 1000).toFixed(1)} s] start: key@${na?.t.toFixed(1)} clock ${fmt(na?.c)} (${((na?.c ?? 0) - sa).toFixed(1)}), end: key@${nb?.t.toFixed(1)} clock ${fmt(nb?.c)} (${((nb?.c ?? 0) - sb).toFixed(1)})`);
  }
  console.log(`== ${d.name} ${which}\n   ` + out.join("\n   "));
}
