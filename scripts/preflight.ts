#!/usr/bin/env bun
// Release gate: everything that can fail AFTER a tag is pushed, checked
// before one is. A bad release isn't a red build — it's a plugin that
// installs and then silently never finds its binary, on every machine that
// pulled it. Run `bun run preflight` before tagging.
import { $ } from "bun";
import { existsSync } from "node:fs";

const checks: Array<{ name: string; run: () => Promise<string | null> }> = [];
const check = (name: string, run: () => Promise<string | null>) => checks.push({ name, run });

const manifestPath = "packages/plugin-claude-code/.claude-plugin/plugin.json";
const manifest = await Bun.file(manifestPath).json();
const version: string = manifest.version;

check("plugin manifest and package.json agree on the version", async () => {
  const root = await Bun.file("package.json").json();
  return root.version === version ? null : `package.json ${root.version} vs plugin.json ${version}`;
});

check("the launcher is committed, executable, and valid sh", async () => {
  const path = "packages/plugin-claude-code/bin/remy";
  if (!existsSync(path)) return `${path} is missing — the plugin ships it, not the binary`;
  const tracked = await $`git ls-files -s ${path}`.text();
  if (!tracked.trim()) return `${path} is not tracked by git — a marketplace install would clone a plugin with no launcher`;
  if (!tracked.startsWith("100755")) return `${path} is not executable in git (mode ${tracked.split(" ")[0]})`;
  const parse = await $`sh -n ${path}`.nothrow().quiet();
  return parse.exitCode === 0 ? null : `sh -n failed: ${parse.stderr.toString()}`;
});

check("no compiled binary is about to be committed", async () => {
  const tracked = (await $`git ls-files packages/plugin-claude-code/bin`.text()).trim().split("\n");
  const stray = tracked.filter((f) => f && !f.endsWith("/remy"));
  return stray.length === 0 ? null : `unexpected tracked files: ${stray.join(", ")}`;
});

check("hooks and commands point at the launcher", async () => {
  const hooks = await Bun.file("packages/plugin-claude-code/hooks/hooks.json").text();
  if (hooks.includes("/bin/coach")) return "hooks.json still references the old bin/coach";
  if (!hooks.includes("/bin/remy")) return "hooks.json does not reference bin/remy";
  return null;
});

// A missing hook doesn't error — it silently deletes a whole surface. Stop
// alone owns the tip nudge, the context alarm, and the spinner refresh, and it
// has been dropped by accident once already.
check("every hook event is registered", async () => {
  const hooks = await Bun.file("packages/plugin-claude-code/hooks/hooks.json").json();
  const want = ["SessionStart", "PostToolUse", "PreCompact", "Stop", "SessionEnd"];
  const missing = want.filter((e) => !hooks.hooks?.[e]);
  return missing.length === 0 ? null : `hooks.json is missing: ${missing.join(", ")}`;
});

check("typecheck", async () => {
  const out = await $`bun run typecheck`.nothrow().quiet();
  return out.exitCode === 0 ? null : out.stdout.toString().slice(-800);
});

check("tests", async () => {
  const out = await $`bun test`.nothrow().quiet();
  return out.exitCode === 0 ? null : out.stderr.toString().slice(-800);
});

check("every release target cross-compiles", async () => {
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
    const out = await $`bun scripts/build-plugin.ts --target ${target} --channel release --out ${`/tmp/remy-preflight-${target}`}`
      .nothrow()
      .quiet();
    if (out.exitCode !== 0) return `${target}: ${out.stderr.toString().slice(-400)}`;
  }
  return null;
});

let failed = 0;
for (const c of checks) {
  const problem = await c.run();
  console.log(problem ? `✖ ${c.name}\n   ${problem}` : `✔ ${c.name}`);
  if (problem) failed += 1;
}

console.log(
  failed === 0
    ? `\n✔ ready to ship v${version} — tag it:\n   git tag v${version} && git push origin v${version}`
    : `\n✖ ${failed} check(s) failed — do not tag`,
);
process.exit(failed === 0 ? 0 : 1);
