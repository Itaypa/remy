import { describe, expect, test } from "bun:test";
import {
  analyzeHabits,
  analyzeSession,
  shouldSuppressPlanMode,
  type SessionSnapshot,
} from "../src/rules";
import type { SessionRow } from "../src/store";
import type { BashClass, ToolCall } from "../src/transcript";

const call = (name: string, ok = true, targetHash: string | null = "aaaaaaaaaaaaaaaa"): ToolCall => ({
  name,
  ok,
  targetHash,
});

const bash = (bashClass: BashClass, targetHash = "cccccccccccccccc"): ToolCall => ({
  name: "Bash",
  ok: true,
  targetHash,
  bashClass,
});

function snapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    sessionId: "s1",
    spendTokens: 500_000,
    toolCalls: [],
    editCalls: 0,
    usedPlanMode: false,
    autoCompacts: 0,
    contextLimit: 200_000,
    contextPct: 0,
    firstContextTokens: 0,
    cacheExpiries: 0,
    cacheExpiryTokens: 0,
    cacheExpiryWorstGapMinutes: 0,
    redZoneTurns: 0,
    redZoneExcessTokens: 0,
    claudeMdBytes: null,
    ...overrides,
  };
}

function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    session_id: "s1",
    started_at: "2026-07-20T00:00:00Z",
    ended_at: null,
    model: null,
    cwd_hash: null,
    repo_hash: null,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: null,
    tool_calls: 0,
    tool_fails: 0,
    compacts_auto: 0,
    compacts_manual: 0,
    used_plan_mode: 0,
    max_context_pct: 0,
    context_window: null,
    claude_md_bytes: null,
    ...overrides,
  };
}

describe("waste signatures", () => {
  test("auto-compact fires with 30% of context limit per compact", () => {
    const findings = analyzeSession(snapshot({ autoCompacts: 2 }));
    const f = findings.find((x) => x.tipId === "auto-compact");
    expect(f).toBeDefined();
    expect(f!.estSavingsTokens).toBe(2 * 60_000);
  });

  test("plan-mode fires only for long edit-heavy sessions without plan mode", () => {
    const manyCalls = Array.from({ length: 30 }, () => call("Read"));
    const edits = Array.from({ length: 6 }, () => call("Edit"));
    const yes = analyzeSession(snapshot({ toolCalls: [...manyCalls, ...edits], editCalls: 6 }));
    expect(yes.some((f) => f.tipId === "plan-mode")).toBe(true);

    const planned = analyzeSession(
      snapshot({ toolCalls: [...manyCalls, ...edits], editCalls: 6, usedPlanMode: true }),
    );
    expect(planned.some((f) => f.tipId === "plan-mode")).toBe(false);

    const short = analyzeSession(snapshot({ toolCalls: manyCalls.slice(0, 10), editCalls: 6 }));
    expect(short.some((f) => f.tipId === "plan-mode")).toBe(false);

    // A solidly-sized session that is still under the "big enough to have
    // wanted a plan" floor. 10 calls was too far below 25 to pin it; 20 is
    // just under, so dropping the floor breaks this instead of quietly
    // telling people they should have planned a medium-sized session.
    const medium = analyzeSession(snapshot({ toolCalls: manyCalls.slice(0, 20), editCalls: 6 }));
    expect(medium.some((f) => f.tipId === "plan-mode")).toBe(false);
  });

  test("retry-loop needs 3+ consecutive failures of the same call", () => {
    const loop = [call("Bash", false), call("Bash", false), call("Bash", false), call("Bash", false)];
    const findings = analyzeSession(snapshot({ toolCalls: loop }));
    const f = findings.find((x) => x.tipId === "retry-loop");
    expect(f).toBeDefined();
    expect(f!.evidence.run).toBe(4);
    expect(f!.estSavingsTokens).toBe(2 * 8_000);

    const broken = analyzeSession(
      snapshot({ toolCalls: [call("Bash", false), call("Bash", false), call("Read", true), call("Bash", false)] }),
    );
    expect(broken.some((x) => x.tipId === "retry-loop")).toBe(false);

    const differentTargets = analyzeSession(
      snapshot({
        toolCalls: [call("Bash", false, "aaaaaaaaaaaaaaaa"), call("Bash", false, "bbbbbbbbbbbbbbbb"), call("Bash", false, "cccccccccccccccc")],
      }),
    );
    expect(differentTargets.some((x) => x.tipId === "retry-loop")).toBe(false);
  });

  test("reread-churn needs 4+ reads of the same file", () => {
    const reads = Array.from({ length: 5 }, () => call("Read"));
    const findings = analyzeSession(snapshot({ toolCalls: reads }));
    const f = findings.find((x) => x.tipId === "reread-churn");
    expect(f).toBeDefined();
    expect(f!.evidence.worst).toBe(5);
    expect(f!.estSavingsTokens).toBe(2 * 2_000);

    const three = analyzeSession(snapshot({ toolCalls: reads.slice(0, 3) }));
    expect(three.some((x) => x.tipId === "reread-churn")).toBe(false);
  });

  describe("CLAUDE.md", () => {
    const rereads = Array.from({ length: 5 }, () => call("Read"));

    test("an unprobed session (null) says nothing in either direction", () => {
      // The common case for any row written before this shipped. Guessing
      // here would nag every historical session at once.
      const findings = analyzeSession(snapshot({ toolCalls: rereads, claudeMdBytes: null }));
      expect(findings.some((f) => f.tipId.startsWith("claude-md"))).toBe(false);
      expect(findings.some((f) => f.tipId === "reread-churn")).toBe(true);
    });

    test("missing CLAUDE.md replaces the reread-churn finding rather than joining it", () => {
      const findings = analyzeSession(snapshot({ toolCalls: rereads, claudeMdBytes: 0 }));
      const missing = findings.find((f) => f.tipId === "claude-md-missing");
      expect(missing).toBeDefined();
      // Same waste, named by its cause — so it inherits the estimate, and the
      // finding it explains must be gone. Two tips for one incident is a nag,
      // and it would also re-serve advice the user had already dismissed.
      expect(findings.some((f) => f.tipId === "reread-churn")).toBe(false);
      expect(missing!.estSavingsTokens).toBe(2 * 2_000);
      expect(missing!.evidence.worst).toBe(5);
    });

    test("missing CLAUDE.md alone is silent — it only speaks when re-reading actually cost something", () => {
      const findings = analyzeSession(snapshot({ toolCalls: [call("Read")], claudeMdBytes: 0 }));
      expect(findings.some((f) => f.tipId === "claude-md-missing")).toBe(false);
    });

    test("a thorough-but-reasonable CLAUDE.md is not nagged", () => {
      // This repo's own file is ~9k. It must stay silent, or the product
      // scolds its own authors for documenting their project.
      const findings = analyzeSession(snapshot({ claudeMdBytes: 8_920 }));
      expect(findings.some((f) => f.tipId === "claude-md-prune")).toBe(false);

      // And a genuinely long-but-not-bloated file, just under the floor. 9k
      // sat far enough below 20k that halving the threshold broke nothing —
      // so the number wasn't actually pinned by the suite, only stated.
      const justUnder = analyzeSession(snapshot({ claudeMdBytes: 19_500 }));
      expect(justUnder.some((f) => f.tipId === "claude-md-prune")).toBe(false);
    });

    test("a bloated CLAUDE.md fires with its size in KB and the tokens a prune returns", () => {
      const findings = analyzeSession(snapshot({ claudeMdBytes: 40_000 }));
      const prune = findings.find((f) => f.tipId === "claude-md-prune");
      expect(prune).toBeDefined();
      expect(prune!.evidence.kb).toBe(40);
      expect(prune!.estSavingsTokens).toBe((40_000 - 12_000) / 4);
    });

    test("context-tax suppresses the prune tip — its own fix already says to prune", () => {
      const findings = analyzeSession(
        snapshot({ claudeMdBytes: 40_000, firstContextTokens: 90_000 }),
      );
      expect(findings.some((f) => f.tipId === "context-tax")).toBe(true);
      expect(findings.some((f) => f.tipId === "claude-md-prune")).toBe(false);
    });
  });

  test("edit-thrash needs 6+ edits AND 3+ interleaved re-reads of the same file", () => {
    const hash = "dddddddddddddddd";
    const thrash: ToolCall[] = [call("Edit", true, hash)];
    for (let i = 0; i < 5; i++) {
      thrash.push(call("Read", true, hash), call("Edit", true, hash));
    }
    const yes = analyzeSession(snapshot({ toolCalls: thrash }));
    const f = yes.find((x) => x.tipId === "edit-thrash");
    expect(f).toBeDefined();
    expect(f!.evidence.edits).toBe(6);
    expect(f!.estSavingsTokens).toBe((6 - 3) * 5_000);

    // 6 edits, no interleaved re-reads: a long legit build, not thrash
    const straight = Array.from({ length: 6 }, () => call("Edit", true, hash));
    expect(analyzeSession(snapshot({ toolCalls: straight })).some((x) => x.tipId === "edit-thrash")).toBe(false);

    // 5 edits with re-reads: under the edit threshold
    const five: ToolCall[] = [call("Edit", true, hash)];
    for (let i = 0; i < 4; i++) five.push(call("Read", true, hash), call("Edit", true, hash));
    expect(analyzeSession(snapshot({ toolCalls: five })).some((x) => x.tipId === "edit-thrash")).toBe(false);

    // reads BEFORE the first edit don't count as rework cycles
    const readFirst: ToolCall[] = [
      call("Read", true, hash), call("Read", true, hash), call("Read", true, hash),
      ...Array.from({ length: 6 }, () => call("Edit", true, hash)),
    ];
    expect(analyzeSession(snapshot({ toolCalls: readFirst })).some((x) => x.tipId === "edit-thrash")).toBe(false);

    // Enough edits, one re-read short of the cycle floor: two corrections is
    // normal work, three is the ping-pong. Pins EDIT_THRASH_MIN_CYCLES — the
    // edit count alone was pinned, this half of the AND was not.
    const twoCycles: ToolCall[] = [
      ...Array.from({ length: 4 }, () => call("Edit", true, hash)),
      call("Read", true, hash), call("Edit", true, hash),
      call("Read", true, hash), call("Edit", true, hash),
    ];
    expect(analyzeSession(snapshot({ toolCalls: twoCycles })).some((x) => x.tipId === "edit-thrash")).toBe(false);
  });

  test("no-verify fires on edits with shell used but no test/build/lint run", () => {
    const edits = Array.from({ length: 4 }, () => call("Edit"));
    const yes = analyzeSession(snapshot({ toolCalls: [...edits, bash("git")], editCalls: 4 }));
    const f = yes.find((x) => x.tipId === "no-verify");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ edits: 4, bash_calls: 1 });
    expect(f!.estSavingsTokens).toBe(10_000);

    const verified = analyzeSession(
      snapshot({ toolCalls: [...edits, bash("git"), bash("test")], editCalls: 4 }),
    );
    expect(verified.some((x) => x.tipId === "no-verify")).toBe(false);

    // no Bash at all: shell unproven (sandboxed host), never fire
    const noShell = analyzeSession(snapshot({ toolCalls: edits, editCalls: 4 }));
    expect(noShell.some((x) => x.tipId === "no-verify")).toBe(false);

    const fewEdits = analyzeSession(snapshot({ toolCalls: [...edits.slice(0, 3), bash("git")], editCalls: 3 }));
    expect(fewEdits.some((x) => x.tipId === "no-verify")).toBe(false);
  });

  test("tools-over-bash fires on a habit of shell reads, not on a few", () => {
    const yes = analyzeSession(snapshot({ toolCalls: Array.from({ length: 6 }, () => bash("read-cmd")) }));
    const f = yes.find((x) => x.tipId === "tools-over-bash");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ count: 6 });
    expect(f!.estSavingsTokens).toBe(6_000); // (6 - 2 free) × 1.5k

    // Five is still ordinary shell work.
    const few = analyzeSession(snapshot({ toolCalls: Array.from({ length: 5 }, () => bash("read-cmd")) }));
    expect(few.some((x) => x.tipId === "tools-over-bash")).toBe(false);

    // Other Bash classes aren't reads, and neither are the native tools —
    // a session that reads 20 files the right way must stay silent.
    const proper = analyzeSession(
      snapshot({
        toolCalls: [...Array.from({ length: 20 }, () => call("Read")), ...Array.from({ length: 6 }, () => bash("test"))],
      }),
    );
    expect(proper.some((x) => x.tipId === "tools-over-bash")).toBe(false);
  });

  test("context-tax fires at 45k first-turn context", () => {
    const yes = analyzeSession(snapshot({ firstContextTokens: 50_000 }));
    const f = yes.find((x) => x.tipId === "context-tax");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ pct: 25, first_tokens: 50_000 });
    expect(f!.estSavingsTokens).toBe(35_000);

    const under = analyzeSession(snapshot({ firstContextTokens: 44_999 }));
    expect(under.some((x) => x.tipId === "context-tax")).toBe(false);
  });

  test("cache-idle fires on verified expiries with count + worst-gap evidence", () => {
    const yes = analyzeSession(
      snapshot({ cacheExpiries: 2, cacheExpiryTokens: 280_000, cacheExpiryWorstGapMinutes: 120 }),
    );
    const f = yes.find((x) => x.tipId === "cache-idle");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ count: 2, mins: 120 });
    expect(f!.estSavingsTokens).toBe(252_000); // 90% of the re-written tokens

    // Zero expiries never fires regardless of tokens (transcript.ts already
    // filters to real gaps + fat re-writes, so any count is trustworthy).
    const none = analyzeSession(snapshot({ cacheExpiries: 0, cacheExpiryTokens: 500_000 }));
    expect(none.some((x) => x.tipId === "cache-idle")).toBe(false);
  });

  test("context-band fires after 3 red-zone turns with the excess as savings", () => {
    const yes = analyzeSession(snapshot({ redZoneTurns: 4, redZoneExcessTokens: 180_000 }));
    const f = yes.find((x) => x.tipId === "context-band");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ turns: 4 });
    expect(f!.estSavingsTokens).toBe(180_000);

    // 1-2 red turns = crossed the line then compacted promptly — healthy, silent.
    const prompt = analyzeSession(snapshot({ redZoneTurns: 2, redZoneExcessTokens: 90_000 }));
    expect(prompt.some((x) => x.tipId === "context-band")).toBe(false);
  });

  test("context-band yields to auto-compact when both fired — one tip per incident", () => {
    const both = analyzeSession(snapshot({ redZoneTurns: 5, redZoneExcessTokens: 200_000, autoCompacts: 1 }));
    expect(both.some((x) => x.tipId === "auto-compact")).toBe(true);
    expect(both.some((x) => x.tipId === "context-band")).toBe(false);
  });

  test("subagent-offload needs wide distinct reads, no Task calls, and context pressure", () => {
    const wideReads = Array.from({ length: 15 }, (_, i) =>
      call("Read", true, `${i}`.padStart(16, "0")),
    );
    const yes = analyzeSession(snapshot({ toolCalls: wideReads, contextPct: 70 }));
    const f = yes.find((x) => x.tipId === "subagent-offload");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ reads: 15, ctx_pct: 70 });
    expect(f!.estSavingsTokens).toBe((15 - 10) * 1_500);

    // pressure via auto-compact also qualifies
    const compacted = analyzeSession(snapshot({ toolCalls: wideReads, contextPct: 30, autoCompacts: 1 }));
    expect(compacted.some((x) => x.tipId === "subagent-offload")).toBe(true);

    const noPressure = analyzeSession(snapshot({ toolCalls: wideReads, contextPct: 30 }));
    expect(noPressure.some((x) => x.tipId === "subagent-offload")).toBe(false);

    const delegated = analyzeSession(
      snapshot({ toolCalls: [...wideReads, call("Task", true, null)], contextPct: 70 }),
    );
    expect(delegated.some((x) => x.tipId === "subagent-offload")).toBe(false);

    const narrow = analyzeSession(snapshot({ toolCalls: wideReads.slice(0, 14), contextPct: 70 }));
    expect(narrow.some((x) => x.tipId === "subagent-offload")).toBe(false);

    // Busy but not yet under pressure. 30% was too far below the line to pin
    // it — this sits just under, so lowering the gate to 50% breaks the test
    // instead of silently widening who gets scolded for reading a lot.
    const belowPressure = analyzeSession(snapshot({ toolCalls: wideReads, contextPct: 60 }));
    expect(belowPressure.some((x) => x.tipId === "subagent-offload")).toBe(false);
  });

  test("clean session yields no findings, results sorted by savings", () => {
    expect(analyzeSession(snapshot({}))).toHaveLength(0);
    const findings = analyzeSession(
      snapshot({
        autoCompacts: 1,
        toolCalls: Array.from({ length: 5 }, () => call("Read")),
        firstContextTokens: 50_000,
        contextPct: 80,
      }),
    );
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const savings = findings.map((f) => f.estSavingsTokens);
    expect([...savings].sort((a, b) => b - a)).toEqual(savings);
  });
});

describe("habit rules", () => {
  const trivialOpus = () =>
    sessionRow({ model: "claude-opus-4-8", tool_calls: 3, tokens_in: 10_000, tokens_out: 1_000 });
  const heavyOpus = () =>
    sessionRow({ model: "claude-opus-4-8", tool_calls: 40, tokens_in: 200_000, tokens_out: 20_000 });

  test("model-fit fires on 4+ trivial opus sessions forming a majority", () => {
    const findings = analyzeHabits([trivialOpus(), trivialOpus(), trivialOpus(), trivialOpus()]);
    const f = findings.find((x) => x.tipId === "model-fit");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ n: 4, tier: "opus" });
    expect(f!.estSavingsTokens).toBe(Math.round(0.8 * 4 * 11_000));
  });

  test("model-fit stays quiet under threshold, when heavy use dominates, or off-tier", () => {
    expect(analyzeHabits([trivialOpus(), trivialOpus(), trivialOpus()])).toHaveLength(0);

    const mostlyHeavy = [
      trivialOpus(), trivialOpus(), trivialOpus(), trivialOpus(),
      heavyOpus(), heavyOpus(), heavyOpus(), heavyOpus(), heavyOpus(),
    ];
    expect(analyzeHabits(mostlyHeavy)).toHaveLength(0);

    const sonnet = Array.from({ length: 6 }, () =>
      sessionRow({ model: "claude-sonnet-5", tool_calls: 2, tokens_out: 500 }),
    );
    expect(analyzeHabits(sonnet)).toHaveLength(0);
  });

  test("plan-mode suppressor needs 5+ sessions at 50%+ plan rate", () => {
    const planned = () => sessionRow({ used_plan_mode: 1 });
    const direct = () => sessionRow({ used_plan_mode: 0 });

    expect(shouldSuppressPlanMode([planned(), planned(), direct(), planned(), direct()])).toBe(true);
    expect(shouldSuppressPlanMode([planned(), planned(), direct(), direct(), direct()])).toBe(false);
    expect(shouldSuppressPlanMode([planned(), planned(), planned(), planned()])).toBe(false);
  });
});
