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
  // PostToolUse fires only on success; without the failure event registered,
  // tool_fails is structurally always 0 and nothing built on it can work.
  if (!hooks.includes("PostToolUseFailure")) return "hooks.json does not register PostToolUseFailure — tool failures would go uncounted";
  return null;
});

// A missing hook doesn't error — it silently deletes a whole surface. Stop
// alone owns the tip nudge, the context alarm, and the spinner refresh, and it
// has been dropped by accident once already.
//
// Derived from the source rather than listed here, deliberately. The hardcoded
// list this replaces covered five events and had not grown with the code:
// PostToolUseFailure and PermissionDenied were both handled in ingest and
// absent from it, so deleting either hook block left this check green — and
// deleting either one returns a counter to structurally-always-zero, which is
// the exact bug class both were added to fix. A list you have to remember to
// update is a list that lies.
/** The body of ingest's `switch (hook)`, or null if it can't be delimited.
 * Both hook checks work from this rather than the whole file: index.ts is ~880
 * lines and contains unrelated `case`/`type:` literals (settings.json writes
 * use `type: "command"`), any of which could mask a real gap. */
async function ingestSwitchBody(): Promise<string | null> {
  const src = await Bun.file("packages/cli/src/index.ts").text();
  const start = src.indexOf("switch (hook) {");
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return null;
}

check("hooks.json and the ingest switch agree", async () => {
  const hooks = await Bun.file("packages/plugin-claude-code/hooks/hooks.json").json();
  const registered = new Set(Object.keys(hooks.hooks ?? {}));
  if (registered.size === 0) return "hooks.json registers nothing";

  // Note the limit: this compares *labels*, not behaviour. A case that exists
  // but whose effect was refactored away still reads as handled, and removing
  // a hook together with its label leaves both sets agreeing. The existence
  // pin for PostToolUseFailure in the check above is therefore not redundant,
  // and PermissionDenied is pinned by cli/test/ingest.test.ts. Keep both.
  const body = await ingestSwitchBody();
  if (body === null) return "could not delimit the ingest switch — this check needs updating, not silencing";
  const handled = new Set([...body.matchAll(/case "([A-Z]\w+)":/g)].map((m) => m[1]!));

  const unhandled = [...registered].filter((e) => !handled.has(e));
  const unregistered = [...handled].filter((e) => !registered.has(e));
  const problems: string[] = [];
  if (unhandled.length > 0) problems.push(`registered but ignored by ingest: ${unhandled.join(", ")}`);
  // The costlier direction: the code believes it is collecting something the
  // host was never asked to send, so the data is silently always empty.
  if (unregistered.length > 0) problems.push(`handled by ingest but never registered: ${unregistered.join(", ")}`);
  return problems.length === 0 ? null : problems.join("; ");
});

// Same failure shape one layer down: an event type nothing ever writes reads
// as "this never happens" forever, and no test can tell the difference.
check("every event type has a writer", async () => {
  const schema = await Bun.file("packages/core/src/schema.ts").text();
  const block = /EventTypeSchema = z\.enum\(\[([\s\S]*?)\]\)/.exec(schema);
  if (!block) return "could not find EventTypeSchema — this check needs updating, not silencing";
  const declared = [...block[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);

  // Scoped to the switch body, not the whole file: `type: "command"` in the
  // settings.json writers would otherwise count as a writer, and any future
  // object literal using `type: "stop"` elsewhere would mask a real orphan.
  // Take the whole `type:` expression and pull every literal out of it, so a
  // ternary (Stop and SessionEnd share one) contributes both of its arms.
  const body = await ingestSwitchBody();
  if (body === null) return "could not delimit the ingest switch — this check needs updating, not silencing";
  const written = new Set<string>();
  for (const m of body.matchAll(/\btype:\s*([^,\n]+)/g)) {
    for (const lit of m[1]!.matchAll(/"(\w+)"/g)) written.add(lit[1]!);
  }

  // Documented exception. Unlike a runtime allowlist, every way this can go
  // stale is benign — a dead entry suppresses nothing, and a NEW orphan still
  // fails — so it stays one line with its reason attached.
  const KNOWN_UNWRITTEN: Record<string, string> = {
    prompt: "batch-2b (UserPromptSubmit cadence events) was never built; the enum member is reserved. UserPromptSubmit carries raw prompt text, so if it is ever wired the payload must stay cadence-only.",
  };

  // An exception that outlives its enum member is itself a staleness signal.
  const ghosts = Object.keys(KNOWN_UNWRITTEN).filter((t) => !declared.includes(t));
  if (ghosts.length > 0) return `KNOWN_UNWRITTEN names event type(s) that no longer exist: ${ghosts.join(", ")}`;

  const orphans = declared.filter((t) => !written.has(t) && !(t in KNOWN_UNWRITTEN));
  return orphans.length === 0
    ? null
    : `event type(s) with no writer in ingest: ${orphans.join(", ")} — either write them or drop them from the enum`;
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
