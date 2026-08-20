import { describe, expect, test } from "bun:test";
import { openDb } from "../src/store";
import {
  analyzeSession,
  effectiveTokens,
  findingValue,
  shouldSuppressPlanMode,
  type EstClass,
  type Finding,
} from "../src/rules";
import { parseTranscript } from "../src/transcript";
import { activeTip, openTips, recordFindings } from "../src/tips";
import { recentSessions } from "../src/store";
import {
  SCENARIOS,
  seedSession,
  snapshotFor,
  transcriptFor,
  type Scenario,
} from "./support/scenarios";
import { MARKER, TranscriptBuilder, transcript } from "./support/transcript-builder";

// Tier A of the toxic-driver suite: every scenario, in-process, in about a
// second. The e2e tier proves the same fixtures survive the real hook
// pipeline; this tier is where the exhaustive work lives — exact tip sets,
// suppression pairs, queue order, and the threshold-minus-one cases that
// prove REMY stays quiet.

const LIMIT = 200_000;

/** Run a scenario through the analysis the CLI performs on Stop. */
function analyze(s: Scenario): Finding[] {
  const stats = parseTranscript(transcriptFor(s), LIMIT);
  const db = openDb(":memory:");
  for (const [i, seed] of (s.seed ?? []).entries()) seedSession(db, `seed${i}`, seed);

  let findings = analyzeSession(snapshotFor(s, stats, LIMIT));
  // Mirrors analyzeTranscript: the anti-nag gate lives outside analyzeSession.
  if (findings.some((f) => f.tipId === "plan-mode")) {
    const week = recentSessions(db, new Date(Date.now() - 7 * 86_400_000).toISOString());
    if (shouldSuppressPlanMode(week)) findings = findings.filter((f) => f.tipId !== "plan-mode");
  }
  db.close();
  return findings;
}

describe("toxic sessions — what each one should be told", () => {
  for (const s of SCENARIOS.filter((x) => !x.e2eOnly)) {
    test(`${s.name}: ${s.why}`, () => {
      const found = analyze(s).map((f) => f.tipId);
      expect(found.sort()).toEqual([...s.expect].sort());
      for (const forbidden of s.forbid ?? []) expect(found).not.toContain(forbidden);
    });
  }
});

describe("the noise budget: many findings, one voice", () => {
  const chaos = SCENARIOS.find((s) => s.name.startsWith("chaos"))!;

  test("five detectors fire but only the most valuable tip goes active", () => {
    const findings = analyze(chaos);
    expect(findings.length).toBe(5);

    const db = openDb(":memory:");
    recordFindings(db, "chaos", findings, new Date().toISOString());

    const active = activeTip(db);
    // By WORTH, not by raw token count. The two differ by up to 19× across
    // price classes, and while the ranking used the raw number, `context-band`
    // — a sum of cache-read context — held the one active slot against every
    // tip that could name a file and an action.
    const best = findings.reduce((a, b) => (findingValue(b) > findingValue(a) ? b : a));
    expect(active?.tip_id).toBe(best.tipId);

    // Everything else waits its turn rather than piling onto the surface.
    const open = openTips(db, 10);
    expect(open.filter((t) => t.status === "active").length).toBe(1);
    expect(open.length).toBe(5);
    db.close();
  });

  test("the queue is ordered by what it would save, best first", () => {
    const db = openDb(":memory:");
    recordFindings(db, "chaos", analyze(chaos), new Date().toISOString());
    const worth = openTips(db, 10).map((t) =>
      effectiveTokens(t.est_savings_tokens, (t.est_class as EstClass) ?? "input"),
    );
    expect(worth).toEqual([...worth].sort((a, b) => b - a));
    db.close();
  });

  test("a big cache-read finding does not outrank a smaller fresh-input one", () => {
    // The regression this whole change exists for, as a unit. `context-band`
    // files an enormous raw number because it sums per-turn CONTEXT — which is
    // re-sent from cache at a tenth of the input price. Ranked raw, it wins by
    // 50×; ranked by worth, it loses, which is the correct answer.
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    recordFindings(
      db,
      "s1",
      [
        { tipId: "context-band", evidence: { turns: 9 }, estSavingsTokens: 2_000_000, estClass: "cache-read" },
        { tipId: "edit-thrash", evidence: { edits: 9 }, estSavingsTokens: 300_000, estClass: "input" },
      ],
      now,
    );
    expect(activeTip(db)?.tip_id).toBe("edit-thrash");
    expect(openTips(db, 5).map((t) => t.tip_id)).toEqual(["edit-thrash", "context-band"]);
    db.close();
  });
});

// One below every threshold. These are the tests that keep REMY from becoming
// the thing it exists to prevent: a tool that interrupts you constantly.
describe("just under the line — REMY says nothing", () => {
  const tips = (jsonl: string, over: Partial<Parameters<typeof analyzeSession>[0]> = {}) => {
    const stats = parseTranscript(jsonl, LIMIT);
    return analyzeSession({
      sessionId: "boundary",
      spendTokens: stats.totals.in + stats.totals.out,
      toolCalls: stats.toolCalls,
      editCalls: stats.editCalls,
      usedPlanMode: stats.usedPlanMode,
      autoCompacts: 0,
      contextLimit: LIMIT,
      contextPct: stats.contextPct,
      firstContextTokens: stats.firstContextTokens,
      cacheExpiries: stats.cacheExpiries,
      cacheExpiryTokens: stats.cacheExpiryTokens,
      cacheExpiryWorstGapMinutes: stats.cacheExpiryWorstGapMinutes,
      redZoneTurns: stats.redZoneTurns,
      redZoneExcessTokens: stats.redZoneExcessTokens,
      claudeMdBytes: 400,
      ...over,
    }).map((f) => f.tipId);
  };

  test("three reads of one file is research, not churn", () => {
    expect(tips(transcript((t) => t.times(3, (b) => b.read("api.ts"))))).not.toContain("reread-churn");
  });

  test("five edits to one file is building, not thrashing", () => {
    const jsonl = transcript((t) =>
      t.times(5, (b) => b.edit("api.ts")).times(3, (b) => b.read("api.ts")),
    );
    expect(tips(jsonl)).not.toContain("edit-thrash");
  });

  test("two identical failures is a retry, not a loop", () => {
    const jsonl = transcript((t) => t.failedRun("Bash", { command: `flaky # ${MARKER}` }, 2));
    expect(tips(jsonl)).not.toContain("retry-loop");
  });

  test("a failing run broken by a success is not one loop", () => {
    // The run must be CONSECUTIVE — recovering and failing again is a
    // different story from hammering the same broken command.
    const jsonl = transcript((t) =>
      t
        .failedRun("Bash", { command: `flaky # ${MARKER}` }, 2)
        .bash("flaky")
        .failedRun("Bash", { command: `flaky # ${MARKER}` }, 2),
    );
    expect(tips(jsonl)).not.toContain("retry-loop");
  });

  test("three edits without a verify pass is under the floor", () => {
    const jsonl = transcript((t) => t.times(3, (b, i) => b.edit(`m${i}.ts`)).bash("echo hi"));
    expect(tips(jsonl)).not.toContain("no-verify");
  });

  test("edits with no shell at all never fire no-verify", () => {
    // A sandboxed host where Bash was never available must not be scolded for
    // failing to run tests it could not run.
    const jsonl = transcript((t) => t.times(6, (b, i) => b.edit(`m${i}.ts`)));
    expect(tips(jsonl)).not.toContain("no-verify");
  });

  test("a 44,999-token opening is not yet a context tax", () => {
    expect(tips("", { firstContextTokens: 44_999 })).not.toContain("context-tax");
  });

  test("five shell reads is a handful, not a habit", () => {
    const jsonl = transcript((t) =>
      t.bash("cat a").bash("ls b").bash("grep c d").bash("head e").bash("rg f g"),
    );
    expect(tips(jsonl)).not.toContain("tools-over-bash");
  });

  test("two red-zone turns is crossing 80%, not riding it", () => {
    expect(tips("", { redZoneTurns: 2, redZoneExcessTokens: 90_000 })).not.toContain("context-band");
  });

  test("fourteen distinct reads is not yet wide enough to delegate", () => {
    const jsonl = transcript((t) =>
      t.times(14, (b, i) => b.read(`f${i}.ts`)).turn({ usage: { input_tokens: 150_000 } }),
    );
    expect(tips(jsonl)).not.toContain("subagent-offload");
  });

  test("wide reads that never cost anything stay silent", () => {
    // 15 reads is only worth coaching when the context actually hurt.
    const jsonl = transcript((t) => t.times(15, (b, i) => b.read(`f${i}.ts`)));
    expect(tips(jsonl)).not.toContain("subagent-offload");
  });

  test("a 19KB CLAUDE.md is thorough, not bloated", () => {
    expect(tips("", { claudeMdBytes: 19_999 })).not.toContain("claude-md-prune");
  });

  test("a 25-minute break does not expire the cache", () => {
    const jsonl = transcript((t) =>
      t
        .turn({ usage: { input_tokens: 500, output_tokens: 300 } })
        .idle(24)
        .turn({
          usage: {
            input_tokens: 500,
            output_tokens: 300,
            cache_creation_input_tokens: 120_000,
            cache_read_input_tokens: 5_000,
          },
        }),
    );
    expect(tips(jsonl)).not.toContain("cache-idle");
  });

  test("a long break that re-writes only a small context stays silent", () => {
    // Reheating 20k after a coffee break is cheaper than /clear and re-briefing.
    const jsonl = transcript((t) =>
      t
        .turn({ usage: { input_tokens: 500, output_tokens: 300 } })
        .idle(60)
        .turn({ usage: { input_tokens: 500, cache_creation_input_tokens: 20_000 } }),
    );
    expect(tips(jsonl)).not.toContain("cache-idle");
  });

  test("a cache re-write straight after a compact is legitimate", () => {
    const t = new TranscriptBuilder();
    t.turn({ usage: { input_tokens: 500, output_tokens: 300 } });
    t.idle(60);
    t.compactBoundary(30_000);
    t.turn({ usage: { input_tokens: 500, cache_creation_input_tokens: 120_000 } });
    expect(tips(t.jsonl())).not.toContain("cache-idle");
  });

  test("a session under 25 tool calls does not need a plan", () => {
    const jsonl = transcript((t) =>
      t.times(6, (b, i) => b.edit(`m${i}.ts`)).times(18, (b, i) => b.read(`r${i}.ts`)),
    );
    expect(tips(jsonl)).not.toContain("plan-mode");
  });

  test("plan mode used means the plan tip never fires, however long the session", () => {
    const jsonl = transcript((t) =>
      t
        .planTool()
        .times(6, (b, i) => b.edit(`m${i}.ts`))
        .times(20, (b, i) => b.read(`r${i}.ts`)),
    );
    expect(tips(jsonl)).not.toContain("plan-mode");
  });

  test("four plan-first sessions is too small a sample to call it a habit", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) seedSession(db, `s${i}`, { daysAgo: i + 1, usedPlanMode: true });
    expect(shouldSuppressPlanMode(recentSessions(db, "1970-01-01T00:00:00.000Z"))).toBe(false);
    db.close();
  });

  test("an unprobed CLAUDE.md keeps both memory tips quiet", () => {
    // null means "never asked", which is not the same as "there isn't one".
    const jsonl = transcript((t) => t.times(4, (b) => b.read("api.ts")));
    const found = tips(jsonl, { claudeMdBytes: null });
    expect(found).toContain("reread-churn");
    expect(found).not.toContain("claude-md-missing");
  });
});
