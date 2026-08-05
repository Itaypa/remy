import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Full-process integration tests: statusline() lives in a script that runs
// its whole CLI dispatch at import time, so it can't be unit-tested by
// importing it (that would execute the CLI). Spawn the real binary instead,
// the way Claude Code actually invokes it.

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let dataDir: string;
let repoDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "remy-statusline-"));
  repoDir = mkdtempSync(join(tmpdir(), "remy-repo-"));
  await Bun.spawn(["git", "init", "-q", "-b", "main", repoDir]).exited;
  await Bun.spawn(["git", "-C", repoDir, "config", "user.email", "t@t.com"]).exited;
  await Bun.spawn(["git", "-C", repoDir, "config", "user.name", "t"]).exited;
  writeFileSync(join(repoDir, "a.txt"), "1");
  await Bun.spawn(["git", "-C", repoDir, "add", "a.txt"]).exited;
  await Bun.spawn(["git", "-C", repoDir, "commit", "-q", "-m", "init"]).exited;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function runStatusline(payload: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "statusline"], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, REMY_DATA_DIR: dataDir },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** The statusline emits SGR codes and OSC 8 hyperlinks unconditionally, so
 * assertions about *layout* have to read the text underneath them. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

function basePayload(extra: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    cwd: repoDir,
    workspace: { current_dir: repoDir },
    model: { id: "claude-fable-5", display_name: "Fable" },
    cost: { total_cost_usd: 1.23 },
    ...extra,
  };
}

describe("coach statusline — one constant layout", () => {
  test("a normal payload renders the standard fields", async () => {
    const out = await runStatusline(
      basePayload({ context_window: { total_input_tokens: 1000, total_output_tokens: 50, context_window_size: 200_000 } }),
    );
    expect(out).toContain("Fable");
    expect(out).toContain("ctx");
    expect(out).toContain("🌿 main");
  }, 10_000);

  test("even at ctx>=80%, the layout stays the SAME shape — no alarm hijack, no different line structure", async () => {
    const normal = await runStatusline(
      basePayload({ context_window: { total_input_tokens: 1000, total_output_tokens: 50, context_window_size: 200_000 } }),
    );
    const overflowing = await runStatusline(
      basePayload({ context_window: { total_input_tokens: 184_000, total_output_tokens: 0, context_window_size: 200_000 } }),
    );
    // The old alarm view replaced the whole line and dropped the model name
    // and $ cost; the new one must not.
    expect(overflowing).toContain("Fable");
    expect(overflowing).toContain("$1.23");
    expect(overflowing).not.toContain("🔥 CTX");
    // Same field markers present in both — only the data differs, not the shape.
    for (const marker of ["ctx", "🌿 main"]) {
      expect(normal).toContain(marker);
      expect(overflowing).toContain(marker);
    }
  }, 10_000);

  test("no streak field, no [used/limit] token-count badge, no XP level — gamification is gone", async () => {
    const out = await runStatusline(
      basePayload({ context_window: { total_input_tokens: 1000, total_output_tokens: 50, context_window_size: 200_000 } }),
    );
    expect(out).not.toMatch(/🔥 \d+d/); // the old streak marker
    expect(out).not.toMatch(/\[\d+[km]?\/\d+[km]?\s*🪙\]/); // the old used/limit badge
    expect(out).not.toContain("⭐ Lv"); // the old XP level field
  }, 10_000);

  test("shows the current git branch, clean repo — no dirty marker", async () => {
    const out = await runStatusline(basePayload());
    expect(stripAnsi(out)).toContain("🌿 main");
    expect(out).not.toContain("●");
  }, 10_000);

  test("shows a dirty marker when the repo has uncommitted changes", async () => {
    writeFileSync(join(repoDir, "a.txt"), "2");
    const out = await runStatusline(basePayload());
    expect(stripAnsi(out)).toContain("🌿 main ●");
  }, 10_000);

  test("the dirty marker never touches the branch name, and carries its own color", async () => {
    // `main●` renders as a branch literally named that — the marker has to be
    // separated and colored, or it reads as a typo rather than as state. The
    // colour assertion is what keeps the space from being re-glued later: a
    // bare `${branch}●` would satisfy a space-only check if someone padded
    // the wrong side.
    writeFileSync(join(repoDir, "a.txt"), "2");
    const out = await runStatusline(basePayload());
    expect(stripAnsi(out)).not.toContain("main●");
    expect(out).toContain(`main \x1b[33m●`);
  }, 10_000);

  test("no git repo at cwd — statusline still renders, just without a branch field", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "coach-not-a-repo-"));
    try {
      const out = await runStatusline(basePayload({ cwd: notARepo, workspace: { current_dir: notARepo } }));
      expect(out).toContain("Fable");
      expect(out).not.toContain("🌿");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  }, 10_000);

  test("Pro/Max plan (rate_limits present) — shows % of plan, not $ cost", async () => {
    const out = await runStatusline(basePayload({ rate_limits: { five_hour: { used_percentage: 42 } } }));
    expect(out).toContain("⏳");
    expect(out).toContain("42%");
    expect(out).toContain("(5h)");
    expect(out).not.toContain("$1.23");
  }, 10_000);

  test("API/pay-per-token plan (no rate_limits) — shows $ cost, not %", async () => {
    const out = await runStatusline(basePayload());
    expect(out).toContain("$1.23");
    expect(out).not.toContain("⏳");
  }, 10_000);
});
