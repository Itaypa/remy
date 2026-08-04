#!/usr/bin/env bun
// Compiles the remy binary.
//
// The plugin itself ships only `bin/remy` — a shim that resolves the compiled
// binary under ~/.remy/bin and downloads it from GitHub Releases when it's
// missing (a 60MB artifact has no business in a git repo that Claude Code
// clones). So a build's job is to put the binary where that shim looks:
//
//   bun run build                        → this host, ~/.remy/bin/remy-<ver>-<target>
//   bun scripts/build-plugin.ts \        → one release asset, for CI
//     --target darwin-arm64 --out dist/remy-0.2.0-darwin-arm64 --channel release
import { $ } from "bun";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifest = await Bun.file("packages/plugin-claude-code/.claude-plugin/plugin.json").json();
const version: string = manifest.version;

const hostTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const target = arg("--target") ?? hostTarget;
const channel = arg("--channel") ?? "dev";

// A release stamp is the version, not a clock reading, so the same tag always
// produces the same string. Dev builds carry commit + time, which is what
// makes a rebuild immediately visible in the statusline's build badge.
let stamp: string;
if (channel === "release") {
  stamp = `v${version}`;
} else {
  const hash = (await $`git rev-parse --short HEAD`.text().catch(() => "")).trim() || "local";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  // Hardcoded month names, not toLocaleDateString — this stamp must read the
  // same on every build machine regardless of locale.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  stamp = `${hash} · ${MONTHS[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const binDir = join(process.env.REMY_HOME ?? join(homedir(), ".remy"), "bin");
const outfile = resolve(arg("--out") ?? join(binDir, `remy-${version}-${target}`));
mkdirSync(dirname(outfile), { recursive: true });

const defines = [
  "--define",
  `REMY_VERSION=${JSON.stringify(version)}`,
  "--define",
  `REMY_CHANNEL=${JSON.stringify(channel)}`,
  "--define",
  `REMY_BUILD_ID=${JSON.stringify(stamp)}`,
];
const crossCompile = arg("--target") ? [`--target=bun-${target}`] : [];

await $`bun build --compile --minify ${crossCompile} ${defines} packages/cli/src/index.ts --outfile ${outfile}`;
console.log(`remy ${version} (${channel}) built for ${target} · ${stamp}`);
console.log(`  → ${outfile}`);

// `current` is what the statusline command points at, so a fresh dev build
// goes live everywhere without touching anyone's settings.json.
if (!arg("--out")) {
  const current = join(binDir, "current");
  rmSync(current, { force: true });
  symlinkSync(outfile, current);
  console.log(`  → ${current}`);
}
