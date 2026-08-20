#!/usr/bin/env bun
// Mutation-testing harness: break one invariant, see whether the suite
// notices. A mutation that nothing catches is a gap in the tests, not a bug in
// the code — the suite is claiming coverage it doesn't have.
//
// This exists because a green suite is not evidence. Every entry below was
// once a real survivor: the adaptive coach's off switch could be deleted and
// nothing failed, bar()'s clamp could be removed and the statusline would
// crash on an out-of-range percentage in silence, four detector thresholds
// could be retuned freely. Those are fixed; this file is what stops them
// coming back.
//
// ── Why a worktree ────────────────────────────────────────────────────────
// Everything runs in a detached git worktree at HEAD, never in the working
// tree. That is not fastidiousness: `bun run build` compiles
// packages/cli/src/index.ts straight into ~/.remy/bin/current, so a build
// during a run would bake a mutation into the developer's own live install,
// and nothing would restore it. Mutating a copy makes that impossible rather
// than unlikely — and a killed run then leaves at worst a stray worktree
// instead of a corrupted checkout.
//
// ── Adding an entry ───────────────────────────────────────────────────────
// `defends` is required and should name the promise, not the line. Note that
// pinning e.g. Hash16's regex means widening the storage whitelist now means
// editing this catalog too; that is intentional (CLAUDE.md treats widening as
// a breaking design change) but better learned here than from a red run.
//
// ── The allowlist ─────────────────────────────────────────────────────────
// `accepted` marks a mutation expected to survive. An entry is legitimate
// only when the behaviour change is unobservable from outside the process, or
// observable only by asserting the implementation. "We haven't written that
// test yet" is never a reason — that is a TODO, not an allowlist entry. An
// accepted mutation that starts being caught also fails the run, so the list
// cannot quietly grow stale.
import { $ } from "bun";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const WORKTREE = join(REPO, ".claude", "worktrees", "mutate");

interface Mutation {
  /** The promise this defends, in plain words. */
  defends: string;
  file: string;
  from: string;
  to: string;
  /** Expected occurrences of `from`. A mismatch is a hard failure, not a survivor. */
  count?: number;
  /** Test file to try first — a scoped failure is conclusive and ~180x faster. */
  scope?: string;
  /** Present = expected to survive, with the reason it is acceptable. */
  accepted?: string;
}

const CORE = "packages/core";
const CLI = "packages/cli";

const MUTATIONS: Mutation[] = [
  // ── the privacy gate ────────────────────────────────────────────────────
  {
    defends: "raw paths cannot pass where a hash is expected",
    file: `${CORE}/src/schema.ts`,
    from: "export const Hash16 = z.string().regex(/^[0-9a-f]{16}$/);",
    to: "export const Hash16 = z.string();",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "the event schema is a whitelist — unknown keys are dropped",
    file: `${CORE}/src/schema.ts`,
    from: "  cwd_hash: Hash16.optional(),\n});",
    to: "  cwd_hash: Hash16.optional(),\n}).passthrough();",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "hashPath is one-way — the path never survives it",
    file: `${CORE}/src/schema.ts`,
    from: 'return createHash("sha256").update(p).digest("hex").slice(0, 16);',
    to: "return p;",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "model ids are charset-gated, so no free text rides in on them",
    file: `${CORE}/src/schema.ts`,
    from: "export const ModelStr = z.string().min(1).max(80).regex(/^[\\w.:-]+$/);",
    to: "export const ModelStr = z.string().min(1).max(80);",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "session ids are charset-gated (no path-shaped ids)",
    file: `${CORE}/src/schema.ts`,
    from: "export const IdStr = z.string().min(1).max(128).regex(/^[\\w.:-]+$/);",
    to: "export const IdStr = z.string().min(1).max(128);",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "claude_md_bytes is coerced at the write site — INTEGER affinity is not a guarantee",
    file: `${CORE}/src/store.ts`,
    from: '  const n = typeof bytes === "number" && Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : null;',
    to: "  const n = bytes as number | null;",
    scope: `${CORE}/test/privacy.test.ts`,
  },
  {
    defends: "the adaptive payload is strict — nothing unlisted leaves the process",
    file: `${CORE}/src/adapt.ts`,
    from: "  })\n  .strict();\n\nexport type AdaptPayload",
    to: "  })\n  .passthrough();\n\nexport type AdaptPayload",
    scope: `${CORE}/test/privacy.test.ts`,
  },

  // ── the controls on the one outbound path ───────────────────────────────
  {
    defends: "REMY_ADAPT=0 disables the adaptive coach",
    file: `${CLI}/src/index.ts`,
    from: '  if (envVar("ADAPT") === "0") return false;',
    to: "",
    scope: `${CLI}/test/adapt-gate.test.ts`,
  },
  {
    defends: "`remy adapt --off` disables the adaptive coach, persistently",
    file: `${CLI}/src/index.ts`,
    from: '  return getSyncState(db, "adapt_enabled") !== "0";',
    to: "  return true;",
    scope: `${CLI}/test/adapt-gate.test.ts`,
  },
  {
    defends: "one model call a day is the budget",
    file: `${CLI}/src/index.ts`,
    from: '    if (!args.includes("--force") && last && Date.now() - Date.parse(last) < ADAPT_THROTTLE_MS) {',
    to: "    if (false) {",
    scope: `${CLI}/test/adapt-gate.test.ts`,
  },
  // The "a hook never waits on the analysis child" contract has no faithful
  // entry here: awaiting the child needs `maybeAutoAdapt` to become async in
  // the same edit, and a single string swap can only produce a program that
  // breaks for the wrong reason. It is covered directly by the slow-backend
  // timing test in adapt-gate.test.ts, which fails if SessionEnd ever waits.

  // ── what reaches the user's surfaces ────────────────────────────────────
  {
    defends: "unfilled placeholders never reach a surface as literal braces",
    file: `${CLI}/src/ui.ts`,
    from: "  const body = UNRESOLVED_PLACEHOLDER.test(rendered) ? def.title : rendered;",
    to: "  const body = rendered;",
    scope: `${CLI}/test/ui.test.ts`,
  },
  {
    defends: "bar() clamps — an out-of-range percentage would crash the statusline",
    file: `${CLI}/src/ui.ts`,
    from: "  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);",
    to: "  const filled = Math.round((pct / 100) * width);",
    scope: `${CLI}/test/ui.test.ts`,
  },
  {
    defends: "the rate-limit badge turns red with room left to act",
    file: `${CLI}/src/ui.ts`,
    from: "  const pctStr = rounded >= 80 ?",
    to: "  const pctStr = rounded >= 95 ?",
    scope: `${CLI}/test/ui.test.ts`,
  },

  // ── the noise budget ────────────────────────────────────────────────────
  {
    defends: "a dismissed tip stays gone for 30 days",
    file: `${CORE}/src/tips.ts`,
    from: "  return Date.parse(nowIso) - Date.parse(mem.last_dismissed_at) < DISMISS_COOLDOWN_MS;",
    to: "  return false;",
    scope: `${CORE}/test/tips.test.ts`,
  },
  {
    defends: "promotion is a no-op while a tip is already active — one voice at a time",
    file: `${CORE}/src/tips.ts`,
    from: "  const active = db.query(`SELECT id FROM tips WHERE status = 'active' LIMIT 1`).get();",
    to: "  const active = null;",
    scope: `${CORE}/test/tips.test.ts`,
  },

  // ── detector thresholds and the rules that stop double-nagging ──────────
  {
    defends: "re-read churn needs 4 reads of one file, not 3",
    file: `${CORE}/src/rules.ts`,
    from: "const REREAD_MIN = 4;",
    to: "const REREAD_MIN = 3;",
    scope: `${CORE}/test/rules.test.ts`,
  },
  {
    defends: "edit-thrash needs 3 rework cycles — two corrections is normal work",
    file: `${CORE}/src/rules.ts`,
    from: "const EDIT_THRASH_MIN_CYCLES = 3;",
    to: "const EDIT_THRASH_MIN_CYCLES = 2;",
    scope: `${CORE}/test/rules.test.ts`,
  },
  {
    defends: "the CLAUDE.md bloat floor stays above a merely thorough file",
    file: `${CORE}/src/rules.ts`,
    from: "const CLAUDE_MD_BLOAT_BYTES = 20_000;",
    to: "const CLAUDE_MD_BLOAT_BYTES = 10_000;",
    scope: `${CORE}/test/rules.test.ts`,
  },
  {
    defends: "red-zone riding yields to auto-compact — one incident, one tip",
    file: `${CORE}/src/rules.ts`,
    from: "function detectRedZoneRiding(s: SessionSnapshot): Finding | null {\n  if (s.autoCompacts > 0) return null;",
    to: "function detectRedZoneRiding(s: SessionSnapshot): Finding | null {",
    scope: `${CORE}/test/rules.test.ts`,
  },
  {
    defends: "claude-md-missing replaces reread-churn instead of stacking with it",
    file: `${CORE}/src/rules.ts`,
    from: "    const [reread] = findings.splice(i, 1);",
    to: "    const reread = findings[i];",
    scope: `${CORE}/test/rules.test.ts`,
  },

  // ── the noise budget: one voice, and it must be the right one ───────────
  {
    defends: "the one active slot goes to the most valuable tip, not the least",
    file: `${CORE}/src/tips.ts`,
    from: "    .query(`SELECT id FROM tips WHERE status = 'queued' ORDER BY est_savings_tokens DESC, id ASC LIMIT 1`)",
    to: "    .query(`SELECT id FROM tips WHERE status = 'queued' ORDER BY est_savings_tokens ASC, id ASC LIMIT 1`)",
    scope: `${CORE}/test/scenarios.test.ts`,
  },
  {
    defends: "a model's `why` cannot write escape codes into the statusline",
    file: `${CORE}/src/adapt.ts`,
    from: "    .replace(/[\\x00-\\x1f\\x7f]/g, \" \")",
    to: "",
    scope: `${CLI}/test/e2e/adapt.e2e.test.ts`,
  },

  // ── the transcript parser ───────────────────────────────────────────────
  {
    defends: "an idle gap means stepping away, not a coffee break",
    file: `${CORE}/src/transcript.ts`,
    from: "const CACHE_EXPIRY_MIN_GAP_MS = 30 * 60_000;",
    to: "const CACHE_EXPIRY_MIN_GAP_MS = 5 * 60_000;",
    scope: `${CORE}/test/transcript.test.ts`,
  },
  {
    defends: "every edit tool counts as an edit, Write included",
    file: `${CORE}/src/transcript.ts`,
    from: 'const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);',
    to: 'const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);',
    scope: `${CORE}/test/transcript.test.ts`,
  },

  // ── the launcher: a hook must never break the session ───────────────────
  {
    defends: "an unsupported OS declines instead of running something wrong",
    file: "packages/plugin-claude-code/bin/remy",
    from: "  Linux) OS=linux ;;\n  *) exit 0 ;;",
    to: "  Linux) OS=linux ;;\n  *) OS=linux ;;",
    scope: `${CLI}/test/launcher.test.ts`,
  },
  {
    defends: "an unsupported architecture declines instead of running something wrong",
    file: "packages/plugin-claude-code/bin/remy",
    from: "  x86_64 | amd64) ARCH=x64 ;;\n  *) exit 0 ;;",
    to: "  x86_64 | amd64) ARCH=x64 ;;\n  *) ARCH=x64 ;;",
    scope: `${CLI}/test/launcher.test.ts`,
  },

  // ── not losing the developer's own history ──────────────────────────────
  {
    defends: "when both databases exist, the new one wins — history must not fork",
    file: `${CORE}/src/store.ts`,
    from: '  const current = join(dir, "remy.db");\n  if (existsSync(current)) return current;',
    to: '  const current = join(dir, "remy.db");',
    scope: `${CORE}/test/paths.test.ts`,
  },
  {
    defends: "a directory from the coach era still resolves to its coach.db",
    file: `${CORE}/src/store.ts`,
    from: "  return existsSync(legacy) ? legacy : current;",
    to: "  return current;",
    scope: `${CORE}/test/paths.test.ts`,
  },
  {
    defends: "an unset flag is not a disabled flag",
    file: `${CORE}/src/env.ts`,
    from: "  if (raw === undefined) return undefined;",
    to: "  if (raw === undefined) return false;",
    scope: `${CORE}/test/paths.test.ts`,
  },

  // ── the 7-day window everything cross-session reads ─────────────────────
  {
    defends: "the week's boundary is inclusive — a session on the line still counts",
    file: `${CORE}/src/store.ts`,
    from: "WHERE started_at >= ? ORDER BY started_at ASC",
    to: "WHERE started_at > ? ORDER BY started_at ASC",
    scope: `${CORE}/test/store.test.ts`,
  },

  // ── what actually reaches the user's eyes ───────────────────────────────
  {
    defends: "a token count never renders as NaN or InfinityM",
    file: `${CLI}/src/ui.ts`,
    from: '  if (!Number.isFinite(n)) return "0";\n',
    to: "",
    scope: `${CLI}/test/ui.test.ts`,
  },
  {
    defends: "the analyzer's own sentence replaces the templated one in /remy",
    file: `${CLI}/src/ui.ts`,
    from: "opts.active.why ? `🤖 ${opts.active.why}` : renderTemplate(def.what, vars)",
    to: "renderTemplate(def.what, vars)",
    scope: `${CLI}/test/report.test.ts`,
  },
  {
    defends: "no tip's `fix` carries a placeholder — /remy renders it without evidence",
    file: `${CORE}/src/catalog.ts`,
    from: 'fix: "For every line ask: would deleting this cause a mistake? If not, cut it."',
    to: 'fix: "Your CLAUDE.md is {kb}KB. For every line ask: would deleting this cause a mistake?"',
    scope: `${CLI}/test/report.test.ts`,
  },

  // ── the user's settings file ────────────────────────────────────────────
  {
    defends: "an unreadable ownership record means back off, not overwrite",
    file: `${CLI}/src/spinner.ts`,
    from: "  try {\n    const parsed = JSON.parse(raw);\n    return Array.isArray(parsed) ? parsed.map(String) : null;\n  } catch {\n    return null;\n  }",
    to: "  const parsed = JSON.parse(raw);\n  return Array.isArray(parsed) ? parsed.map(String) : null;",
    scope: `${CLI}/test/spinner.test.ts`,
  },

  // ── the hook that must never throw ──────────────────────────────────────
  {
    defends: "the Stop-hook transcript reader survives a path that isn't a path",
    file: `${CORE}/src/transcript.ts`,
    from: "  try {\n    const f = Bun.file(path);\n    if (!(await f.exists())) return null;\n    return parseTranscript(await f.text(), limit);\n  } catch {\n    return null;\n  }",
    to: "    const f = Bun.file(path);\n    if (!(await f.exists())) return null;\n    return parseTranscript(await f.text(), limit);",
    scope: `${CORE}/test/transcript.test.ts`,
  },
  {
    defends: "openDb waits out a competing writer instead of failing fast",
    file: `${CORE}/src/store.ts`,
    from: '  db.run("PRAGMA busy_timeout = 2000");\n  db.run("PRAGMA journal_mode = WAL");',
    to: '  db.run("PRAGMA journal_mode = WAL");\n  db.run("PRAGMA busy_timeout = 2000");',
    scope: `${CORE}/test/store-lock.test.ts`,
  },

  // ── accepted survivors ──────────────────────────────────────────────────
  {
    defends: "settings.json is written atomically, so a crash can't truncate it",
    file: `${CLI}/src/spinner.ts`,
    from: "    const tmp = `${path}.remy-tmp`;\n    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\\n`);\n    renameSync(tmp, path);",
    to: "    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\\n`);",
    accepted:
      "Only observable by crashing mid-write or racing two writers. A test that mocks renameSync to prove renameSync was called asserts the implementation, not the behaviour.",
  },
];

// ──────────────────────────────────────────────────────────────────────────

interface TestRun {
  failed: number;
  total: number;
}

async function runTests(target?: string): Promise<TestRun> {
  const res = target
    ? await $`bun test ${target}`.cwd(WORKTREE).nothrow().quiet()
    : await $`bun test`.cwd(WORKTREE).nothrow().quiet();
  const text = res.stdout.toString() + res.stderr.toString();
  // Anchored to the summary lines, which bun prints as " N pass" / " N fail"
  // at the start of a line. An unanchored /(\d+) fail/ matches inside a failure
  // diff instead — the rendered /remy report contains "20 calls · 0 failed",
  // so a genuinely caught mutation parsed as failed=0 and was then reported as
  // an unrelated INVALID. The harness has to be more trustworthy than the code
  // it audits, or a green run means nothing.
  const pass = Number(/^\s*(\d+) pass\s*$/m.exec(text)?.[1] ?? 0);
  const failed = Number(/^\s*(\d+) fail\s*$/m.exec(text)?.[1] ?? 0);
  return { failed, total: pass + failed };
}

async function setupWorktree(): Promise<string> {
  await $`git -C ${REPO} worktree remove --force ${WORKTREE}`.nothrow().quiet();
  await $`git -C ${REPO} worktree add --detach ${WORKTREE} HEAD`.quiet();
  // Bun resolves the workspace from the worktree's own package.json; only the
  // installed packages need borrowing, and a symlink keeps the run instant.
  for (const rel of ["node_modules", "packages/core/node_modules"]) {
    const src = join(REPO, rel);
    if (existsSync(src) && !existsSync(join(WORKTREE, rel))) symlinkSync(src, join(WORKTREE, rel));
  }
  return (await $`git -C ${REPO} rev-parse --short HEAD`.text()).trim();
}

const sha = await setupWorktree();
console.log(`mutation testing ${sha} (a copy — the working tree is never written)\n`);

const dirty = (await $`git -C ${REPO} status --porcelain`.text())
  .split("\n")
  .filter((l) => l && !l.startsWith("??"));
if (dirty.length > 0) {
  console.log(`⚠ ${dirty.length} uncommitted change(s) are NOT under test — this runs against HEAD.\n`);
}

const baseline = await runTests();
if (baseline.failed > 0) {
  console.error(`baseline is red (${baseline.failed} failing) — fix that before mutating`);
  await $`git -C ${REPO} worktree remove --force ${WORKTREE}`.nothrow().quiet();
  process.exit(1);
}

const scopedBaseline = new Map<string, number>();
for (const scope of new Set(MUTATIONS.map((m) => m.scope).filter(Boolean) as string[])) {
  scopedBaseline.set(scope, (await runTests(scope)).total);
}

type Verdict = "caught" | "survived" | "invalid" | "stale";
const results: Array<{ m: Mutation; verdict: Verdict; note: string }> = [];

for (const m of MUTATIONS) {
  const path = join(WORKTREE, m.file);
  const pristine = readFileSync(path, "utf8");
  const expected = m.count ?? 1;
  const found = pristine.split(m.from).length - 1;

  if (found !== expected) {
    results.push({
      m,
      verdict: "stale",
      note: `expected ${expected} occurrence(s) of the pattern, found ${found} — the code moved and this entry no longer tests what it claims`,
    });
    continue;
  }

  writeFileSync(path, pristine.replaceAll(m.from, m.to));
  try {
    let run = m.scope ? await runTests(m.scope) : await runTests();
    const expectedTotal = m.scope ? scopedBaseline.get(m.scope)! : baseline.total;

    if (run.failed === 0 && m.scope) {
      // A scoped pass isn't conclusive — confirm against the whole suite.
      run = await runTests();
      if (run.failed > 0) {
        results.push({ m, verdict: "caught", note: "caught outside its scope hint" });
        continue;
      }
      results.push({ m, verdict: run.total < baseline.total ? "invalid" : "survived", note: "" });
      continue;
    }

    if (run.failed > 0) {
      // A mutation that stops the code parsing makes the suite red for the
      // wrong reason and would read as "caught" forever.
      results.push(
        run.total < expectedTotal
          ? { m, verdict: "invalid", note: `${expectedTotal - run.total} test(s) vanished — the mutation isn't a valid program` }
          : { m, verdict: "caught", note: `${run.failed} failed` },
      );
    } else {
      results.push({ m, verdict: run.total < expectedTotal ? "invalid" : "survived", note: "" });
    }
  } finally {
    writeFileSync(path, pristine);
  }
}

await $`git -C ${REPO} worktree remove --force ${WORKTREE}`.nothrow().quiet();

// ── report ────────────────────────────────────────────────────────────────
const problems: string[] = [];

for (const r of results) {
  const accepted = !!r.m.accepted;
  if (r.verdict === "stale") {
    console.log(`✗ STALE     ${r.m.defends}\n            ${r.note}`);
    problems.push(`stale entry: ${r.m.defends}`);
  } else if (r.verdict === "invalid") {
    console.log(`✗ INVALID   ${r.m.defends}\n            ${r.note || "the mutated source no longer builds"}`);
    problems.push(`invalid mutation: ${r.m.defends}`);
  } else if (r.verdict === "caught") {
    if (accepted) {
      console.log(`✗ NOW TESTED ${r.m.defends}\n            allowlisted as untestable, but a test caught it — delete the entry`);
      problems.push(`stale allowlist entry: ${r.m.defends}`);
    } else {
      console.log(`✔ caught    ${r.m.defends}`);
    }
  } else if (accepted) {
    console.log(`• accepted  ${r.m.defends}\n            ${r.m.accepted}`);
  } else {
    console.log(`✗ SURVIVED  ${r.m.defends}\n            nothing failed — the suite does not defend this`);
    problems.push(`undefended: ${r.m.defends}`);
  }
}

const caught = results.filter((r) => r.verdict === "caught" && !r.m.accepted).length;
const acceptedCount = results.filter((r) => r.verdict === "survived" && r.m.accepted).length;
console.log(`\n${caught}/${results.length} caught · ${acceptedCount} accepted survivor(s)`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("every invariant in the catalog is defended by a test");
