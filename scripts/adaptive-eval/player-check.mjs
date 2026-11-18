/**
 * Watches adaptive playback in a real browser (headless Chrome) against a mock-mode stack and prints
 * what the player shows every half second, plus any stretch where the picture stopped moving.
 * No real footage: the simulated "Upper Lounge" camera records high resolution in seconds 12 to 21
 * of every half minute and low resolution everywhere but seconds 15 to 18.
 *
 *   MOCK_ADAPTIVE=mock-06 PLAYBACK_WINDOW_SECONDS=10 bash .claude/skills/qa-sweep/scripts/stack.sh start <slot>
 *   PLAYWRIGHT=<path to playwright's index.mjs> node scripts/adaptive-eval/player-check.mjs <app url> [seconds=42] [camera=Upper Lounge]
 *
 * Ten-second windows make motion cross window handovers. Ports are shared by every checkout on the
 * machine: pick a slot no other session is using, or the stacks stop each other.
 *
 * Each row: seconds since opening, state, base time, window (seconds into the minute), high time.
 * States: B base alone, O high over the base, I insert (base paused, high alone), P base paused,
 * - nothing yet. The sequence should read B, then O from second 12, I from 15, O from 18, B from 21.
 */
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const [url, secs = "42", name = "Upper Lounge"] = process.argv.slice(2);
if (!url) { console.error("usage: node player-check.mjs <app url> [seconds] [camera]"); process.exit(2); }

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/status of 404/.test(m.text())) console.log("console error:", m.text().slice(0, 200)); });
  // Sign in through the test sign-in provider as the bootstrap administrator.
  await page.goto(`${url}/api/auth/login?with=oidc&returnTo=/`);
  await page.getByText("Avery Chen").click();
  await page.waitForURL(`${url}/**`);
  await page.waitForTimeout(1500);
  const cams = await page.evaluate(async () => (await (await fetch("/api/cameras")).json()).cameras);
  const cam = cams.find((c) => c.name === name);
  if (!cam) throw new Error(`no camera named ${name}`);
  // A recorded stretch two to four hours ago, 8 s into a half minute (motion starts at 12 s).
  const now = Date.now(), recs = await page.evaluate(async ([id, a, b]) => (await (await fetch(`/api/cameras/${id}/recordings?from=${a}&to=${b}`)).json()), [cam.id, now - 4 * 3600e3, now - 2 * 3600e3]);
  const r = recs.ranges.find(([a, b]) => b - a > 5 * 60_000);
  const T = Math.floor((r[0] + 120_000) / 30_000) * 30_000 + 8000;
  console.log(`${name}: opening at ${new Date(T).toISOString()}`);
  await page.goto(`${url}/camera/${cam.id}?t=${T}`);

  const t0 = Date.now(), rows = [];
  while (Date.now() - t0 < Number(secs) * 1000) {
    const s = await page.evaluate(() => {
      const vids = [...document.querySelectorAll("video")];
      const base = vids.find((v) => !v.getAttribute("aria-hidden"));
      const hi = vids.find((v) => v.getAttribute("aria-hidden") && !v.classList.contains("invisible") && v.style.visibility === "visible");
      return { b: base ? { t: base.currentTime, p: base.paused, src: base.src.replace(/.*t=/, "") } : null, h: hi ? { t: hi.currentTime } : null };
    });
    rows.push({ at: (Date.now() - t0) / 1000, ...s });
    await page.waitForTimeout(100);
  }

  let prev = null;
  const stalls = [], out = [];
  for (const x of rows) {
    const state = !x.b ? "-" : x.h ? (x.b.p ? "I" : "O") : x.b.p ? "P" : "B";
    const moved = prev?.b && x.b && (Math.abs(x.b.t - prev.b.t) > 0.01 || (x.h && prev.h && Math.abs(x.h.t - prev.h.t) > 0.01) || x.b.src !== prev.b.src);
    if (prev?.b && x.b && !moved) stalls.push(x.at);
    out.push(`${x.at.toFixed(1).padStart(5)} ${state} base ${x.b ? x.b.t.toFixed(2) : "-"} window ${x.b ? (Number(x.b.src) % 60_000) / 1000 : "-"} high ${x.h ? x.h.t.toFixed(2) : "-"}`);
    prev = x;
  }
  console.log(out.filter((_, i) => i % 5 === 0).join("\n"));
  const groups = [];
  for (const a of stalls) { const g = groups[groups.length - 1]; if (g && a - g[1] < 0.25) g[1] = a; else groups.push([a, a]); }
  console.log("picture stopped (s since opening):", groups.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(" ") || "never");
} finally {
  await browser.close();
}
