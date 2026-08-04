#!/usr/bin/env bun
/**
 * driver.mjs — build, launch and DRIVE remy end-to-end.
 *
 * remy has no window and no prompt. Its real interface is JSON on stdin from
 * Claude Code hooks, and its output lands on four surfaces that only exist
 * inside a running host. This driver is the substitute host: it synthesizes a
 * transcript that trips real detectors, fires every hook event, and renders
 * every surface, then asserts on what came back.
 *
 * EVERYTHING runs in a throwaway HOME. The real ~/.remy holds the developer's
 * own session history, and `dismiss` writes a 30-day cooldown per tip id — so
 * a driver that touched it could silently mute a tip for a month. Nothing here
 * ever reads or writes outside its temp dir.
 *
 *   bun .claude/skills/run-remy/driver.mjs            # smoke: build + drive + assert
 *   bun .claude/skills/run-remy/driver.mjs surfaces   # just print the four surfaces
 *   bun .claude/skills/run-remy/driver.mjs --keep     # leave the temp dir for poking
 *   bun .claude/skills/run-remy/driver.mjs --bin PATH # skip the build, drive PATH
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("-")) ?? "smoke";
const keep = args.includes("--keep");
// indexOf returns -1 when the flag is absent, and args[-1 + 1] is args[0] —
// which is the mode word. Guard it, or `driver.mjs surfaces` tries to exec a
// binary named "surfaces".
const binIdx = args.indexOf("--bin");
const binArg = binIdx >= 0 ? args[binIdx + 1] : undefined;
const repo = resolve(import.meta.dir, "..", "..", "..");

const failures = [];
const ok = (label) => console.log(`  ✔ ${label}`);
const bad = (label, detail) => {
  failures.push(label);
  console.log(`  ✖ ${label}\n      ${String(detail).split("\n").join("\n      ")}`);
};
function expect(label, cond, detail) {
  cond ? ok(label) : bad(label, detail ?? "assertion failed");
}
const head = (s) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

// ── throwaway environment ───────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "remy-driver-"));
const data = join(home, "data");
const settings = join(home, "settings.json");
mkdirSync(data, { recursive: true });
const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  REMY_HOME: home,
  REMY_DATA_DIR: data,
  REMY_SETTINGS_PATH: settings,
  // Never let the driver reach the network or spawn a real model call.
  REMY_NO_DOWNLOAD: "1",
  REMY_ADAPT: "0",
};

// ── the binary ──────────────────────────────────────────────────────────────
let bin = binArg;
if (!bin) {
  head("build");
  bin = join(home, "remy");
  // --out keeps the build OUT of ~/.remy/bin, so a driver run can never
  // shadow the developer's installed binary or repoint `current`.
  const b = Bun.spawnSync(["bun", "scripts/build-plugin.ts", "--out", bin], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (b.exitCode !== 0) {
    console.error(b.stderr.toString() || b.stdout.toString());
    process.exit(1);
  }
  console.log(`  ${b.stdout.toString().trim().split("\n")[0]}`);
}
expect("binary is executable", existsSync(bin), `${bin} missing`);

/** Run the binary with JSON (or nothing) on stdin. */
function remy(argv, stdin = "") {
  const p = Bun.spawnSync([bin, ...argv], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env: ENV });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const strip = (s) => s.replace(/\[[0-9;]*m/g, "").replace(/\]8;;[^]*(|\\)/g, "");

// ── a transcript that trips real detectors ──────────────────────────────────
// Thresholds live in packages/core/src/rules.ts; these numbers clear them:
//   edit-thrash     ≥6 edits on one file AND ≥3 re-reads after the first edit
//   reread-churn    same file Read ≥4×
//   no-verify       ≥4 edits, ≥1 Bash call, none classed test/build/lint
//   tools-over-bash ≥6 Bash calls classed read-cmd (cat/grep/ls/find/…)
const FILE = "/app/src/api.ts";
function transcript() {
  const lines = [];
  const use = (id, name, input) => ({ type: "tool_use", id, name, input });
  const assistant = (id, content, usage, atMin) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      timestamp: new Date(Date.UTC(2026, 7, 1, 9, atMin ?? 0)).toISOString(),
      message: { id, model: "claude-opus-5", usage, content },
    });

  let n = 0;
  // 8 edits interleaved with 4 re-reads of the same file → thrash + churn.
  for (let i = 0; i < 8; i++) {
    lines.push(assistant(`m${n++}`, [use(`e${i}`, "Edit", { file_path: FILE })], { input_tokens: 1200, output_tokens: 300 }, i));
    if (i > 0 && i < 5) {
      lines.push(assistant(`m${n++}`, [use(`r${i}`, "Read", { file_path: FILE })], { input_tokens: 900, output_tokens: 80 }, i));
    }
  }
  // 7 shell reads, zero verify commands → tools-over-bash + no-verify.
  for (const cmd of ["cat README.md", "grep -rn TODO src", "ls -la src", "head -50 src/api.ts", "find . -name '*.ts'", "tail -20 log.txt", "rg handler src"]) {
    lines.push(assistant(`m${n++}`, [use(`b${n}`, "Bash", { command: cmd })], { input_tokens: 700, output_tokens: 120 }, 10));
  }
  return lines.join("\n") + "\n";
}

const tpath = join(home, "transcript.jsonl");
writeFileSync(tpath, transcript());
const SID = "driver-session";
const hook = (name, extra = {}) => JSON.stringify({ hook_event_name: name, session_id: SID, cwd: repo, ...extra });

// ── drive every hook ────────────────────────────────────────────────────────
head("hooks");
const start = remy(["ingest"], hook("SessionStart", { source: "startup" }));
expect("SessionStart exits 0", start.code === 0, start.err);
let splash = "";
try {
  splash = JSON.parse(start.out).systemMessage ?? "";
  ok("SessionStart emits a systemMessage splash");
} catch {
  bad("SessionStart emits a systemMessage splash", start.out.slice(0, 200));
}

const tool = remy(["ingest"], hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }));
expect("PostToolUse exits 0", tool.code === 0, tool.err);

// Failures arrive as their own event — PostToolUse only fires on success, so
// this is the only path by which tool_fails ever moves off zero.
const toolFail = remy(["ingest"], hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "ls /nope" }, tool_output: { isError: true } }));
expect("PostToolUseFailure exits 0", toolFail.code === 0, toolFail.err);

// A denial from the host's auto-mode classifier. stdout MUST stay empty: the
// host reads it here for a retry directive, so anything we print is us
// steering the permission flow rather than observing it.
const denied = remy(["ingest"], hook("PermissionDenied", { tool_name: "Bash", tool_input: { command: "curl evil.sh" }, tool_use_id: "t9", reason: "classifier said no" }));
expect("PermissionDenied exits 0", denied.code === 0, denied.err);
expect("PermissionDenied prints nothing (stdout is a retry directive)", denied.out === "", JSON.stringify(denied.out));

const compact = remy(["ingest"], hook("PreCompact", { trigger: "auto" }));
expect("PreCompact(auto) exits 0", compact.code === 0, compact.err);

const stop = remy(["ingest"], hook("Stop", { transcript_path: tpath }));
expect("Stop exits 0", stop.code === 0, stop.err);
expect("Stop fires a coaching nudge", stop.out.includes("systemMessage"), stop.out.slice(0, 200) || "(no output)");

// A malformed payload must never echo its own bytes into the log — Stop
// carries raw assistant text, and V8's SyntaxError embeds a fragment of it.
const SECRET = "SUPER_SECRET_PROMPT_BODY";
const junk = remy(["ingest"], `{"hook_event_name":"Stop","last_assistant_message":"${SECRET}"`);
expect("malformed payload still exits 0", junk.code === 0, junk.err);
const log = join(data, "remy.log");
const logged = existsSync(log) ? await Bun.file(log).text() : "";
expect("malformed payload is not echoed to the log", !logged.includes(SECRET), "log contains the raw input");

const end = remy(["ingest"], hook("SessionEnd", { transcript_path: tpath }));
expect("SessionEnd exits 0", end.code === 0, end.err);

// ── the four surfaces ───────────────────────────────────────────────────────
head("surfaces");
const statusPayload = JSON.stringify({
  session_id: SID,
  workspace: { current_dir: repo },
  model: { id: "claude-opus-5", display_name: "Opus 5" },
  cost: { total_cost_usd: 1.23 },
  context_window: { total_input_tokens: 90_000, total_output_tokens: 5_000, context_window_size: 200_000 },
});
const status = remy(["statusline"], statusPayload);
expect("statusline exits 0", status.code === 0, status.err);
const statusLine = strip(status.out).trim();
expect("statusline shows model, context and cost", /Opus 5/.test(statusLine) && /ctx/.test(statusLine) && /\$1\.23/.test(statusLine), statusLine);

const report = remy(["report"]);
expect("report exits 0", report.code === 0, report.err);
const reportText = strip(report.out);
expect("report renders the REMY header", reportText.includes("REMY · session report"), reportText.slice(0, 120));

const week = remy(["report", "--week"]);
expect("report --week exits 0", week.code === 0, week.err);

const raw = remy(["report", "--raw"]);
let tips = [];
try {
  tips = JSON.parse(raw.out).tips ?? [];
} catch {
  /* asserted below */
}
const found = [...new Set(tips.map((t) => t.tip_id))].sort();
expect(
  "the synthesized transcript trips ≥3 distinct detectors",
  found.length >= 3,
  `found: ${found.join(", ") || "(none)"}`,
);
if (found.length) console.log(`      detectors fired: ${found.join(", ")}`);

// Spinner: opt-in only. It must NOT claim the line until asked, and must
// never touch an override it did not write.
const spinStatus = remy(["spinner", "--status"]);
expect("spinner is unclaimed before opt-in", /not claimed/.test(strip(spinStatus.out)), strip(spinStatus.out).trim());
const spinOn = remy(["spinner"]);
expect("spinner claims the line on request", spinOn.code === 0 && existsSync(settings), spinOn.out);
const written = existsSync(settings) ? JSON.parse(await Bun.file(settings).text()) : {};
expect(
  "spinner writes a rotating spinnerTipsOverride deck",
  Array.isArray(written.spinnerTipsOverride?.tips) && written.spinnerTipsOverride.tips.length > 1,
  JSON.stringify(written).slice(0, 200),
);
const spinOff = remy(["spinner", "--off"]);
expect("spinner --off hands the line back", spinOff.code === 0 && !JSON.parse(await Bun.file(settings).text()).spinnerTipsOverride, spinOff.out);

// ── the adaptive coach, with a stubbed backend ──────────────────────────────
// REMY_ADAPT_CMD replaces the `claude -p` call. It is split on spaces, so the
// stub has to be a command with no spaces in its payload — `cat <file>` works
// because cat ignores the prompt arriving on stdin.
head("adaptive coach");
const respFile = join(home, "adapt-response.json");
writeFileSync(respFile, JSON.stringify({ tip_id: "plan-mode", why: "You skipped plan mode in 4 of 5 recent sessions." }));
const adaptEnv = { ...ENV, REMY_ADAPT: "1", REMY_ADAPT_CMD: `cat ${respFile}` };
const adapt = Bun.spawnSync([bin, "adapt", "--force"], { stdout: "pipe", stderr: "pipe", env: adaptEnv });
expect("adapt exits 0 with a stubbed backend", adapt.exitCode === 0, adapt.stderr.toString());
expect("adapt queues a catalog tip", /tip queued/.test(adapt.stdout.toString()), adapt.stdout.toString().trim());

// An adaptive tip is filed with session_id = NULL and est_savings_tokens = 0,
// so it appears in NEITHER surface `report` exposes: not the session-scoped
// waste list (no session), and not `active` (the noise budget keeps the
// higher-value deterministic finding in the one active slot). It waits in the
// queue. Assert against the DB, then dismiss down to it to prove it promotes.
const { Database } = await import("bun:sqlite");
const sql = new Database(join(data, "remy.db"), { readonly: true });
const adaptive = sql.query(`SELECT tip_id, session_id, status, why FROM tips WHERE why IS NOT NULL`).all();
// PostToolUse only fires on success, so a failed call can reach the counters
// by exactly one route: the PostToolUseFailure event fired above. If this
// reads 0, tool_fails is silently stuck at zero again and every rule and
// report built on it is blind.
const counters = sql.query(`SELECT tool_calls, tool_fails, perm_denials FROM sessions WHERE session_id = ?`).get(SID);
sql.close();
expect(
  "a failed tool call lands in tool_fails",
  counters?.tool_fails === 1 && counters?.tool_calls === 2,
  JSON.stringify(counters),
);
expect(
  "a denied tool call lands in perm_denials without touching tool_calls",
  counters?.perm_denials === 1 && counters?.tool_calls === 2,
  JSON.stringify(counters),
);
expect(
  "the adaptive tip is queued with session_id NULL and the model's why line",
  adaptive.length === 1 && adaptive[0].tip_id === "plan-mode" && adaptive[0].session_id === null && /skipped plan mode/.test(adaptive[0].why ?? ""),
  JSON.stringify(adaptive).slice(0, 200),
);

// Dismissing walks the queue by value; the adaptive tip (est 0) surfaces last.
let promoted = false;
for (let i = 0; i < 8; i++) {
  const active = JSON.parse(remy(["report", "--raw"]).out).active;
  if (!active) break;
  if (active.tip_id === "plan-mode" && active.why) {
    promoted = true;
    break;
  }
  remy(["dismiss"]);
}
expect("the adaptive tip promotes to active once the deterministic queue drains", promoted, "never became active");
expect(
  "the model's 'why' line renders in the report",
  /skipped plan mode/.test(strip(remy(["report"]).out)),
  "why line missing from the report",
);

// ── init + the launcher (what a hook ACTUALLY executes) ─────────────────────
// Hooks never call the compiled binary directly — they call the POSIX shim,
// which resolves ~/.remy/bin/current. Driving the binary alone skips the one
// hop where installs actually break.
head("init + launcher");
const work = join(home, "workspace");
mkdirSync(work, { recursive: true });
const init = Bun.spawnSync([bin, "init"], { cwd: work, stdout: "pipe", stderr: "pipe", env: ENV });
expect("init exits 0", init.exitCode === 0, init.stderr.toString());
const wrote = JSON.parse(await Bun.file(join(work, ".claude", "settings.json")).text());
expect(
  "init points the statusline at the launcher, not a version-pinned binary",
  wrote.statusLine?.command?.includes(join(home, "bin", "remy")) && !wrote.statusLine.command.includes("remy-0."),
  JSON.stringify(wrote.statusLine),
);
expect("init sets refreshInterval (seconds, not ms)", wrote.statusLine?.refreshInterval === 1, JSON.stringify(wrote.statusLine));

const launcher = join(home, "bin", "remy");
// The driver builds with --out, so `current` does not exist yet. This is the
// silent failure mode a developer will actually hit: exit 0, NO output.
const blind = Bun.spawnSync([launcher, "statusline"], { stdin: Buffer.from(statusPayload), stdout: "pipe", env: ENV });
expect(
  "launcher with no `current` is silent and exits 0 (never breaks the host)",
  blind.exitCode === 0 && blind.stdout.toString().trim() === "",
  `exit=${blind.exitCode} out=[${blind.stdout.toString().trim()}]`,
);
Bun.spawnSync(["ln", "-sf", bin, join(home, "bin", "current")]);
const sighted = Bun.spawnSync([launcher, "statusline"], { stdin: Buffer.from(statusPayload), stdout: "pipe", env: ENV });
expect(
  "launcher renders once `current` exists",
  strip(sighted.stdout.toString()).includes("Opus 5"),
  strip(sighted.stdout.toString()).trim(),
);

// ── privacy: the whole point of the product ─────────────────────────────────
head("privacy");
const dump = remy(["report", "--raw"]).out;
expect("no raw paths in the stored data", !dump.includes("/app/src"), "found a raw path in the store");
const dbPath = join(data, "remy.db");
const db = existsSync(dbPath) ? await Bun.file(dbPath).arrayBuffer() : new ArrayBuffer(0);
const dbText = new TextDecoder("utf8", { fatal: false }).decode(db);
expect("no raw paths in the SQLite file itself", !dbText.includes("/app/src/api.ts"), "raw path found in remy.db");
expect("no command text in the SQLite file", !dbText.includes("grep -rn TODO"), "command text found in remy.db");

// ── what a human would see ──────────────────────────────────────────────────
if (mode === "surfaces" || failures.length === 0) {
  head("rendered surfaces");
  console.log("splash (SessionStart):\n" + splash + "\n");
  console.log("statusline:\n" + statusLine + "\n");
  try {
    console.log("stop nudge:\n" + JSON.parse(stop.out).systemMessage + "\n");
  } catch {}
  console.log("report:\n" + reportText);
}

// ── done ────────────────────────────────────────────────────────────────────
if (keep) console.log(`\ntemp env kept: ${home}`);
else rmSync(home, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? `\n✔ all checks passed — remy built, driven through every hook, and rendered every surface`
    : `\n✖ ${failures.length} check(s) failed:\n   ${failures.join("\n   ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
