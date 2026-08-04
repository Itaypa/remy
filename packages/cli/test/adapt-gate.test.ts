import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adaptive coach is the ONE thing in this product that leaves the process.
// Everything below is a control the user has over it — the env kill switch,
// the persisted off switch, the one-call-a-day budget, and the requirement
// that there be something new to analyse. None of them had a test: every one
// could be deleted and the suite stayed green.
//
// These have to be full-process tests. index.ts runs its CLI dispatch at
// import time, so importing it would execute the CLI.

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let dataDir: string;
let stubLog: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "remy-adapt-"));
  stubLog = join(dataDir, "backend-calls.log");
  // Stands in for `claude -p`: records that it was invoked, answers with a
  // valid response so the success path is exercised too.
  const stub = join(dataDir, "stub.sh");
  writeFileSync(
    stub,
    `#!/bin/sh\ncat > /dev/null\necho call >> ${JSON.stringify(stubLog)}\necho '{"tip_id":"clear-between-tasks","why":"stub said so","confidence":0.9}'\n`,
  );
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    REMY_DATA_DIR: dataDir,
    REMY_HOME: dataDir,
    REMY_SETTINGS_PATH: join(dataDir, "settings.json"),
    REMY_ADAPT_CMD: `sh ${join(dataDir, "stub.sh")}`,
    ...extra,
  } as Record<string, string>;
}

async function remy(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], { env: env(extraEnv), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

function backendCalls(): number {
  try {
    return readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Seed enough recent sessions that the analysis has something to chew on. */
function seedSessions(n: number): void {
  const db = new Database(join(dataDir, "remy.db"), { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, model TEXT,
    cwd_hash TEXT, repo_hash TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, cost_usd REAL,
    tool_calls INTEGER DEFAULT 0, tool_fails INTEGER DEFAULT 0, compacts_auto INTEGER DEFAULT 0,
    compacts_manual INTEGER DEFAULT 0, used_plan_mode INTEGER DEFAULT 0, max_context_pct REAL DEFAULT 0)`);
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    db.query(`INSERT OR REPLACE INTO sessions (session_id, started_at, model, tool_calls) VALUES (?, ?, ?, ?)`).run(
      `s${i}`,
      new Date(now - i * 3_600_000).toISOString(),
      "claude-opus-5",
      20,
    );
  }
  db.close();
}

describe("adaptive coach — the controls over the one outbound path", () => {
  test("REMY_ADAPT=0 stops it dead, without touching stored state", async () => {
    seedSessions(5);
    const out = await remy(["adapt"], { REMY_ADAPT: "0" });
    expect(out).toContain("off");
    expect(backendCalls()).toBe(0);
  });

  test("`adapt --off` persists, and survives into later invocations", async () => {
    seedSessions(5);
    await remy(["adapt", "--off"]);
    const out = await remy(["adapt"]);
    expect(out).toContain("off");
    expect(backendCalls()).toBe(0);

    // and --on brings it back
    await remy(["adapt", "--on"]);
    await remy(["adapt"]);
    expect(backendCalls()).toBe(1);
  });

  test("one call a day is the budget — a second run inside the window is refused", async () => {
    seedSessions(5);
    await remy(["adapt"]);
    expect(backendCalls()).toBe(1);

    const second = await remy(["adapt"]);
    expect(second).toContain("one call a day");
    expect(backendCalls()).toBe(1);

    // --force is the documented escape hatch
    await remy(["adapt", "--force"]);
    expect(backendCalls()).toBe(2);
  });

  test("no sessions to analyse means no call at all", async () => {
    const out = await remy(["adapt"]);
    expect(out).toContain("nothing to analyze");
    expect(backendCalls()).toBe(0);
  });

  test("a backend that fails degrades to silence, not to an error", async () => {
    seedSessions(5);
    const out = await remy(["adapt"], { REMY_ADAPT_CMD: "sh -c exit1-does-not-exist" });
    expect(out).toContain("unavailable");
  });

  test("the SessionEnd hook returns immediately even when the analysis is slow", async () => {
    // The contract from CLAUDE.md: the analysis is out-of-band and a hook
    // never waits on it. Assert the observable property rather than the
    // mechanism — whether that is process.exit, an unref'd child, or
    // something else later, what must stay true is that a slow backend cannot
    // stall the host's session teardown.
    seedSessions(5);
    const slow = join(dataDir, "slow.sh");
    writeFileSync(slow, `#!/bin/sh\nsleep 30\n`);
    chmodSync(slow, 0o755);

    const payload = JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s0", cwd: dataDir });
    const started = performance.now();
    const proc = Bun.spawn(["bun", CLI_ENTRY, "ingest"], {
      env: env({ REMY_ADAPT_CMD: `sh ${slow}` }),
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const elapsedMs = performance.now() - started;

    expect(code).toBe(0);
    // Generous ceiling: the point is "does not wait 30s", not a latency budget.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 40_000);
});
