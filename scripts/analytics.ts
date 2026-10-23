#!/usr/bin/env bun
// REMY's analytics layer — the read side. There is no server.
//
// The launcher (packages/plugin-claude-code/bin/remy) GETs a one-byte
// `ping-<os>-<arch>` asset on its version's GitHub release once per machine
// per UTC day, carrying nothing. This script reads GitHub's download counters
// back. One download = one machine-day, so:
//
//   downloads of ping-* so far                          = machine-days since release
//   (downloads now − downloads at the last run) / days  = daily active machines
//
// The second line needs a previous reading, so every run appends a snapshot to
// ~/.remy/analytics/snapshots.jsonl. Run it daily (cron, or the night-shift
// morning cycle) and the per-day figure is exact. Binary downloads (installs
// and upgrades) and the repo's 14-day clone/view traffic are shown for context.
//
//   bun run analytics          # record a snapshot, print the table
//   bun run analytics --dry    # print only, record nothing
//   bun run analytics --json   # machine-readable
//
// Talks to GitHub through `gh` (already required to cut a release), so no
// token handling lives here. Maintainer tooling: this is not shipped.
import { $ } from "bun";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Asset {
  name: string;
  download_count: number;
}
interface Release {
  tag_name: string;
  published_at: string;
  assets: Asset[];
}
interface Snapshot {
  at: string;
  pings: Record<string, number>;
  installs: Record<string, number>;
}
interface Traffic {
  count: number;
  uniques: number;
}

const args = process.argv.slice(2);
const REPO = process.env.REMY_RELEASE_REPO ?? "Itaypa/remy";
const HOME = process.env.REMY_HOME ?? join(homedir(), ".remy");
const DIR = join(HOME, "analytics");
const LOG = join(DIR, "snapshots.jsonl");
const DAY_MS = 86_400_000;

let releases: Release[];
try {
  releases = (await $`gh api ${`repos/${REPO}/releases?per_page=100`}`.quiet().json()) as Release[];
} catch (err) {
  console.error(`could not read releases for ${REPO} — is \`gh\` installed and logged in?`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Keys are "v0.3.6 darwin-arm64": one row per release × platform.
const pings: Record<string, number> = {};
const installs: Record<string, number> = {};
for (const r of releases) {
  for (const a of r.assets) {
    if (a.name.startsWith("ping-")) pings[`${r.tag_name} ${a.name.slice("ping-".length)}`] = a.download_count;
    else if (/^remy-\d/.test(a.name)) installs[`${r.tag_name} ${a.name.replace(/^remy-[^-]+-/, "")}`] = a.download_count;
  }
}

const now: Snapshot = { at: new Date().toISOString(), pings, installs };
const prev = lastSnapshot();
if (!args.includes("--dry")) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(now)}\n`);
}

// Traffic needs push access to the repo; anyone else just sees no row.
const traffic: { clones?: Traffic; views?: Traffic } = {};
try {
  traffic.clones = (await $`gh api ${`repos/${REPO}/traffic/clones`}`.quiet().json()) as Traffic;
  traffic.views = (await $`gh api ${`repos/${REPO}/traffic/views`}`.quiet().json()) as Traffic;
} catch {
  /* not the owner — fine */
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...now, previous: prev?.at ?? null, traffic }, null, 2));
  process.exit(0);
}

const days = prev ? (Date.parse(now.at) - Date.parse(prev.at)) / DAY_MS : 0;
const n = (v: number) => v.toLocaleString("en-US");
const rate = (delta: number) => (days >= 0.5 ? `~${(delta / days).toFixed(1)}/day` : "");

console.log(`🐭 REMY analytics · ${REPO} · ${now.at.slice(0, 16).replace("T", " ")} UTC`);
console.log("");
console.log("daily pings — one per machine per UTC day (download counts of ping-*)");
const pingKeys = sortedKeys(pings);
if (pingKeys.length === 0) {
  console.log("  none yet: no release carries a ping-* asset. The next release build adds one per target.");
} else {
  const since = prev ? `since ${prev.at.slice(0, 10)} (${days.toFixed(1)}d)` : "since last run";
  console.log(`  ${"version · platform".padEnd(26)} ${"machine-days".padStart(12)}  ${since}`);
  let total = 0;
  let totalDelta = 0;
  for (const k of pingKeys) {
    const v = pings[k]!;
    const delta = v - (prev?.pings[k] ?? 0);
    total += v;
    totalDelta += delta;
    console.log(`  ${k.padEnd(26)} ${n(v).padStart(12)}  ${prev ? `+${n(delta)} ${rate(delta)}` : ""}`);
  }
  console.log(`  ${"Σ".padEnd(26)} ${n(total).padStart(12)}  ${prev ? `+${n(totalDelta)} ${rate(totalDelta)}` : ""}`);
}

console.log("");
console.log("installs — binary downloads (first install or upgrade, per platform)");
let installTotal = 0;
for (const k of sortedKeys(installs)) {
  installTotal += installs[k]!;
  console.log(`  ${k.padEnd(26)} ${n(installs[k]!).padStart(12)}`);
}
console.log(`  ${"Σ".padEnd(26)} ${n(installTotal).padStart(12)}`);

if (traffic.clones || traffic.views) {
  console.log("");
  console.log("repo traffic — last 14 days");
  if (traffic.clones) console.log(`  clones  ${n(traffic.clones.count)} (${n(traffic.clones.uniques)} unique)`);
  if (traffic.views) console.log(`  views   ${n(traffic.views.count)} (${n(traffic.views.uniques)} unique)`);
}

if (!prev && !args.includes("--dry")) {
  console.log("");
  console.log(`first snapshot recorded in ${LOG} — run again tomorrow for the per-day column`);
}

function lastSnapshot(): Snapshot | null {
  try {
    const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
    return lines.length ? (JSON.parse(lines[lines.length - 1]!) as Snapshot) : null;
  } catch {
    return null;
  }
}

/** Newest version first, platforms alphabetical within it. */
function sortedKeys(o: Record<string, number>): string[] {
  return Object.keys(o).sort((a, b) => {
    const [va, pa] = a.split(" ");
    const [vb, pb] = b.split(" ");
    const byVersion = vb!.localeCompare(va!, undefined, { numeric: true });
    return byVersion !== 0 ? byVersion : pa!.localeCompare(pb!);
  });
}
