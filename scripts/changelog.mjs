#!/usr/bin/env node
// Unreleased changelog entries live in .changelog/, one file per change, so branches never
// edit CHANGELOG.md at the same time. scripts/release.sh folds them into CHANGELOG.md.
//
//   node scripts/changelog.mjs add <added|changed|fixed|removed> <short_name> "<text>"
//   node scripts/changelog.mjs check                  # every entry is well formed
//   node scripts/changelog.mjs notes                  # the unreleased entries, as markdown
//   node scripts/changelog.mjs apply <version> <date> # write them into CHANGELOG.md, delete them
//
// Each entry is .changelog/<yyyymmddhhmmss UTC>-<short_name>.md:
//
//   ---
//   section: Fixed
//   ---
//
//   One change, in plain language. It may wrap onto more lines.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SECTIONS = ["Added", "Changed", "Fixed", "Removed"];
const NAME = /^(\d{14})-([a-z0-9]+(?:_[a-z0-9]+)*)\.md$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, ".changelog");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

/** Parses one entry file. Returns { section, text } or throws with the reason. */
export function parseEntry(name, source) {
  const m = NAME.exec(name);
  if (!m) throw new Error(`the name should look like 20261119143000-short_change_name.md`);
  const ts = m[1];
  const when = new Date(
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`,
  );
  if (Number.isNaN(when.getTime()) || when.toISOString().replace(/\D/g, "").slice(0, 14) !== ts) {
    throw new Error(`${ts} isn't a real date and time (yyyymmddhhmmss)`);
  }
  const fm = /^---\nsection: *(\S+) *\n---\n\n([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!fm) throw new Error(`it should start with "---", "section: <${SECTIONS.join("|")}>", "---" and a blank line`);
  if (!SECTIONS.includes(fm[1])) throw new Error(`section "${fm[1]}" should be one of ${SECTIONS.join(", ")}`);
  const text = fm[2].trim();
  if (!text) throw new Error(`it has no text`);
  if (/\n\s*\n/.test(text)) throw new Error(`one change per file, without blank lines`);
  if (/^[-*] /.test(text)) throw new Error(`write the text without a leading "- "; it is added for you`);
  return { section: fm[1], text };
}

/** Renders entries ({ name, section, text }) as CHANGELOG.md section bodies, oldest first. */
export function render(entries) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const blocks = [];
  for (const section of SECTIONS) {
    const lines = sorted
      .filter((e) => e.section === section)
      .map((e) => "- " + e.text.split("\n").map((l) => l.trim()).join("\n  "));
    if (lines.length) blocks.push(`### ${section}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** Inserts "## <version> - <date>" with the given body above the newest release in a changelog. */
export function insertRelease(changelog, version, date, body) {
  const lines = changelog.split("\n");
  if (lines.some((l) => l === `## ${version}` || l.startsWith(`## ${version} `))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  let at = lines.findIndex((l) => l.startsWith("## "));
  if (at < 0) at = lines.length;
  const section = [`## ${version} - ${date}`, "", ...body.split("\n"), ""];
  return [...lines.slice(0, at), ...section, ...lines.slice(at)].join("\n");
}

function readEntries() {
  if (!fs.existsSync(DIR)) return { entries: [], problems: [] };
  const entries = [];
  const problems = [];
  for (const name of fs.readdirSync(DIR).sort()) {
    if (name === "README.md" || name.startsWith(".")) continue;
    try {
      entries.push({ name, ...parseEntry(name, fs.readFileSync(path.join(DIR, name), "utf8")) });
    } catch (err) {
      problems.push(`.changelog/${name}: ${err.message}`);
    }
  }
  return { entries, problems };
}

function load() {
  const { entries, problems } = readEntries();
  if (problems.length) {
    for (const p of problems) console.error(`error: ${p}`);
    process.exit(1);
  }
  return entries;
}

function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "add": {
      const [section, short, ...words] = args;
      const text = words.join(" ");
      const sec = SECTIONS.find((s) => s.toLowerCase() === String(section).toLowerCase());
      if (!sec || !short || !text) {
        console.error(`usage: node scripts/changelog.mjs add <${SECTIONS.join("|").toLowerCase()}> <short_name> "<text>"`);
        process.exit(1);
      }
      const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const name = `${ts}-${short}.md`;
      const source = `---\nsection: ${sec}\n---\n\n${text.trim()}\n`;
      try {
        parseEntry(name, source);
      } catch (err) {
        console.error(`error: ${name}: ${err.message}`);
        process.exit(1);
      }
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, name), source, { flag: "wx" });
      console.log(`.changelog/${name}`);
      return;
    }
    case "check": {
      const entries = load();
      console.log(`${entries.length} unreleased ${entries.length === 1 ? "entry" : "entries"}, all well formed`);
      return;
    }
    case "notes": {
      const out = render(load());
      if (out) console.log(out);
      return;
    }
    case "apply": {
      const [version, date] = args;
      if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
        console.error("usage: node scripts/changelog.mjs apply <version> <yyyy-mm-dd>");
        process.exit(1);
      }
      const entries = load();
      if (!entries.length) {
        console.error("error: no unreleased entries in .changelog/");
        process.exit(1);
      }
      fs.writeFileSync(CHANGELOG, insertRelease(fs.readFileSync(CHANGELOG, "utf8"), version, date, render(entries)));
      for (const e of entries) fs.unlinkSync(path.join(DIR, e.name));
      return;
    }
    default:
      console.error("usage: node scripts/changelog.mjs <add|check|notes|apply> (see the top of the file)");
      process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
