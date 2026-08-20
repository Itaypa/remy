import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

// The cache clock is the one statusline field with a whole pipeline behind it:
// a Stop hook parses the transcript for the TTL the host bought and stamps an
// anchor, and the statusline reads both back without opening a file. Unit
// tests cover the arithmetic (cacheField in ui.test.ts); these prove the wiring
// survives two separate processes and a real database.
describe("the cache clock, end to end", () => {
  const transcriptLine = (id: string, ttlKey: string) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      timestamp: new Date().toISOString(),
      message: {
        id,
        model: "claude-fable-5",
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 140_000,
          cache_creation: { [ttlKey]: 140_000 },
        },
        content: [],
      },
    });

  async function stopHook(transcriptPath: string): Promise<void> {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "ingest"], {
      stdin: Buffer.from(
        JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", cwd: repoDir, transcript_path: transcriptPath }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, REMY_DATA_DIR: dataDir, REMY_HOME: dataDir, REMY_SETTINGS_PATH: join(dataDir, "settings.json") },
    });
    await proc.exited;
  }

  function backdateAnchor(minutesAgo: number): void {
    const db = new Database(join(dataDir, "remy.db"));
    db.query(`UPDATE sessions SET cache_anchor_at = ? WHERE session_id = 'sess-1'`).run(
      new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    );
    db.close();
  }

  test("the Stop hook itself stamps the anchor — a turn just ended reads as fully warm", async () => {
    // Deliberately does NOT pre-write the anchor. An earlier version of this
    // test backdated it by hand before rendering, which exercised the
    // arithmetic and skipped the stamping — and the stamping was broken:
    // the hook set threw into the global catch, which logs and exits 0, so
    // every other write in the same hook landed and the anchor silently never
    // did. The clock read empty on a real session while this suite was green.
    // Nothing here may write cache_anchor_at except the hook under test.
    const path = join(repoDir, "t.jsonl");
    writeFileSync(path, transcriptLine("m1", "ephemeral_1h_input_tokens"));
    await stopHook(path);

    const db = new Database(join(dataDir, "remy.db"), { readonly: true });
    const row = db.query(`SELECT cache_anchor_at, cache_ttl_ms FROM sessions WHERE session_id = 'sess-1'`).get() as
      | { cache_anchor_at: string | null; cache_ttl_ms: number | null }
      | null;
    db.close();
    expect(row?.cache_anchor_at, "the Stop hook did not stamp the cache anchor").toBeTruthy();
    expect(row?.cache_ttl_ms).toBe(60 * 60_000);

    // The word is not decoration. The line already carries four emoji, so a
    // bare "🔥 52m" reads as a streak or a timer; the context field beside it
    // labels itself the same way ("48% ctx"). Trimming this back to save three
    // columns is what this assertion exists to catch.
    // 59 or 60: the hook and the render are two separate process spawns, and
    // the clock floors rather than rounds — it never promises time already
    // spent. Either reading proves the stamp happened just now.
    const out = stripAnsi(await runStatusline(basePayload()));
    expect(out).toMatch(/🔥 cache (59|60)m/);
  }, 20_000);

  test("the clock ticks down from the anchor", async () => {
    const path = join(repoDir, "t.jsonl");
    writeFileSync(path, transcriptLine("m1", "ephemeral_1h_input_tokens"));
    await stopHook(path);
    // Half a minute off a whole number: the render happens a few ms after the
    // backdate, so an exact 8 would floor to 51 or 52 depending on the machine.
    backdateAnchor(8.5);

    expect(stripAnsi(await runStatusline(basePayload()))).toContain("🔥 cache 51m");
  }, 20_000);

  test("idle past the TTL → cold, and the rest of the line is untouched", async () => {
    const path = join(repoDir, "t.jsonl");
    writeFileSync(path, transcriptLine("m1", "ephemeral_1h_input_tokens"));
    await stopHook(path);
    backdateAnchor(90);

    const out = stripAnsi(await runStatusline(basePayload()));
    expect(out).toContain("🧊 cache cold");
    // One constant layout: going cold colours a field, it does not restructure
    // the line or evict anything.
    expect(out).toContain("Fable");
    expect(out).toContain("🌿 main");
    expect(out).toContain("$1.23");
  }, 20_000);

  test("a 5-minute session goes cold in five minutes, not in an hour", async () => {
    // Nothing in the pipeline hardcodes an hour: the TTL the host bought is
    // carried from the transcript to the render. A session under usage overage
    // drops to the 5-minute cache, and telling it "cache 52m" would be an
    // invitation to leave a fat session open on a cache that is already gone.
    const path = join(repoDir, "t.jsonl");
    writeFileSync(path, transcriptLine("m1", "ephemeral_5m_input_tokens"));
    await stopHook(path);
    backdateAnchor(8);

    expect(stripAnsi(await runStatusline(basePayload()))).toContain("🧊 cache cold");
  }, 20_000);

  test("a session we have never analyzed shows no clock rather than a guessed one", async () => {
    // No Stop hook has run, so no TTL has ever been observed on this machine.
    // A wrong warm reading is worse than no field: it says "keep this fat
    // session open", which is the exact advice the tip exists to prevent.
    const out = stripAnsi(await runStatusline(basePayload()));
    expect(out).not.toContain("cache");
    expect(out).toContain("Fable"); // ...and the rest of the HUD still renders
  }, 10_000);
});
