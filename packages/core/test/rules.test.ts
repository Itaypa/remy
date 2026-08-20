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
    skillBytes: null,
    fatReads: 0,
    fatReadTokens: 0,
    fatReadWorstTokens: 0,
    fatReadTargets: [],
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
    skill_bytes: null,
    skill_count: null,
    sub_agents: null,
    sub_tokens_in: null,
    sub_tokens_out: null,
    sub_cache_write: null,
    sub_tools: null,
    sub_model: null,
    effort_turns: null,
    effort_max_turns: null,
    effort_high_turns: null,
    effort_max_out: null,
    auto_memory_bytes: null,
    perm_denials: 0,
    cache_ttl_ms: null,
    cache_anchor_at: null,
    cache_model: null,
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
    expect(f!.evidence).toEqual({
      edits: 4,
      files: 1,
      bash_calls: 1,
      scope: "one file",
      shell: "one shell run",
      bash_mix: "1 git call",
    });
    // Zero on purpose: this used to be a flat 10,000 that no measurement
    // produced. What a verify pass buys is fewer bugs, and the catalog says so.
    expect(f!.estSavingsTokens).toBe(0);

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

  test("test, build AND lint each count as verification on their own", () => {
    // Only `test` was ever exercised, so dropping "build" or "lint" from
    // VERIFY_CLASSES broke nothing — and the failure mode is the bad one: the
    // tip would start telling people who DID verify that they shipped edits
    // unverified. A wrong tip is worse than silence.
    const edits = Array.from({ length: 4 }, () => call("Edit"));
    for (const cls of ["test", "build", "lint"] as const) {
      const findings = analyzeSession(snapshot({ toolCalls: [...edits, bash(cls)], editCalls: 4 }));
      expect(
        findings.some((x) => x.tipId === "no-verify"),
        `${cls} should count as a verification run`,
      ).toBe(false);
    }

    // And a shell class that is NOT verification leaves the tip firing, so the
    // test above is proving the membership rather than the edit count.
    for (const cls of ["git", "pkg", "run", "read-cmd", "other"] as const) {
      const findings = analyzeSession(snapshot({ toolCalls: [...edits, bash(cls)], editCalls: 4 }));
      expect(
        findings.some((x) => x.tipId === "no-verify"),
        `${cls} is not verification and should not silence the tip`,
      ).toBe(true);
    }
  });

  test("tools-over-bash fires on a habit of shell reads, not on a few", () => {
    const yes = analyzeSession(snapshot({ toolCalls: Array.from({ length: 6 }, () => bash("read-cmd")) }));
    const f = yes.find((x) => x.tipId === "tools-over-bash");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ count: 6, bash_total: 6, tool_reads: 0 });
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
    expect(f!.evidence).toEqual({ pct: 25, first_tokens: 50_000, first_ctx: "50k" });
    expect(f!.estSavingsTokens).toBe(35_000);

    const under = analyzeSession(snapshot({ firstContextTokens: 44_999 }));
    expect(under.some((x) => x.tipId === "context-tax")).toBe(false);
  });

  test("context-tax attributes the skill pack when it was measured", () => {
    const f = analyzeSession(
      snapshot({ firstContextTokens: 50_000, skillBytes: 10_176 }),
    ).find((x) => x.tipId === "context-tax");
    // 10,176 B / 4 = 2,544 tokens. The unit is spelled out because
    // claude-md-prune talks about the same startup pack in kilobytes.
    expect(f!.evidence.skill_k).toBe("~2.5k tokens");
  });

  test("attribution changes what context-tax says, never whether it fires or what it's worth", () => {
    // estSavingsTokens drives which tip goes active (tips.ts), so re-scoping it
    // to the attributed part would silently re-rank the coaching queue — a much
    // larger behaviour change than the copy edit this is meant to be.
    const base = analyzeSession(snapshot({ firstContextTokens: 50_000 })).find(
      (x) => x.tipId === "context-tax",
    )!;
    const measured = analyzeSession(
      snapshot({ firstContextTokens: 50_000, skillBytes: 40_000 }),
    ).find((x) => x.tipId === "context-tax")!;
    expect(measured.estSavingsTokens).toBe(base.estSavingsTokens);
    expect(measured.evidence.pct).toBe(base.evidence.pct);

    // Below the trigger, a fat skill pack still doesn't make the tip fire.
    expect(
      analyzeSession(snapshot({ firstContextTokens: 44_999, skillBytes: 40_000 })).some(
        (x) => x.tipId === "context-tax",
      ),
    ).toBe(false);
  });

  test("context-tax stays quiet about skills it never measured, and honest about a tiny pack", () => {
    // NULL is every pre-existing row and any session whose SessionStart never
    // fired. Emitting nothing lets the catalog's fallback supply the word —
    // claiming 0 would be a measurement we don't have.
    const unmeasured = analyzeSession(
      snapshot({ firstContextTokens: 50_000, skillBytes: null }),
    ).find((x) => x.tipId === "context-tax")!;
    expect(unmeasured.evidence).not.toHaveProperty("skill_k");

    // Measured-and-tiny is a real zero, not a missing value: the e2e harness
    // runs under a fake HOME and legitimately measures 0. "0.0k tokens" reads
    // as a broken probe, so it gets words instead of a rounded number.
    const tiny = analyzeSession(
      snapshot({ firstContextTokens: 50_000, skillBytes: 0 }),
    ).find((x) => x.tipId === "context-tax")!;
    expect(tiny.evidence.skill_k).toBe("a small slice");
  });

  test("cache-idle fires on verified expiries with count + worst-gap evidence", () => {
    const yes = analyzeSession(
      snapshot({ cacheExpiries: 2, cacheExpiryTokens: 280_000, cacheExpiryWorstGapMinutes: 120 }),
    );
    const f = yes.find((x) => x.tipId === "cache-idle");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ count: 2, mins: 120, gap: "2.0h", ctx: "140k" });
    // The raw re-written count, with the cold-vs-warm price difference now
    // carried by the class instead of a 0.9 fudge on the token count.
    expect(f!.estSavingsTokens).toBe(280_000);
    expect(f!.estClass).toBe("cold-write");

    // Zero expiries never fires regardless of tokens (transcript.ts already
    // filters to real gaps + fat re-writes, so any count is trustworthy).
    const none = analyzeSession(snapshot({ cacheExpiries: 0, cacheExpiryTokens: 500_000 }));
    expect(none.some((x) => x.tipId === "cache-idle")).toBe(false);
  });

  test("context-band fires after 3 red-zone turns with the excess as savings", () => {
    const yes = analyzeSession(snapshot({ redZoneTurns: 4, redZoneExcessTokens: 180_000 }));
    const f = yes.find((x) => x.tipId === "context-band");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ turns: 4, total_turns: 4, peak_pct: 0 });
    expect(f!.estSavingsTokens).toBe(180_000);
    // The excess is context re-sent from cache, not fresh input — billing it
    // at 1x is what made this tip claim "+219M" and outrank everything.
    expect(f!.estClass).toBe("cache-read");

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
    // No token estimate: delegating COSTS metered tokens, it doesn't save
    // them. What it buys is window headroom, which the copy already says and
    // this field cannot express. It used to claim (reads-10)*1500.
    expect(f!.estSavingsTokens).toBe(0);

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
    expect(f!.evidence).toEqual({ n: 4, total: 4, tier: "opus", model: "opus-4-8" });
    expect(f!.estSavingsTokens).toBe(Math.round(0.8 * 4 * 11_000));
  });

  test("a session is trivial only if it is light on BOTH counts", () => {
    // The heavy fixture is heavy in tool calls AND output, so either gate alone
    // carried the suite: raising the tool-call ceiling from 5 to 500 broke
    // nothing. Each dimension is now pinned on its own, because widening either
    // one makes model-fit start calling real work "a quick question".
    const chatty = () =>
      sessionRow({ model: "claude-opus-4-8", tool_calls: 40, tokens_in: 10_000, tokens_out: 500 });
    const verbose = () =>
      sessionRow({ model: "claude-opus-4-8", tool_calls: 2, tokens_in: 10_000, tokens_out: 50_000 });

    // Many tool calls, little output — real work, not a trivial question.
    expect(analyzeHabits([chatty(), chatty(), chatty(), chatty()])).toHaveLength(0);
    // Few tool calls, lots of output — also real work.
    expect(analyzeHabits([verbose(), verbose(), verbose(), verbose()])).toHaveLength(0);
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

  test("either delegation tool proves you delegated — Task and Agent both count", () => {
    // subagent-offload only fires when the session delegated NOTHING. Only
    // `Task` was ever exercised, so dropping "Agent" from SUBAGENT_TOOLS broke
    // no test — and the tip would then have told someone who used the Agent
    // tool that they should try using a subagent.
    const wideReads = Array.from({ length: 15 }, (_, i) =>
      call("Read", true, `${i}`.padStart(16, "0")),
    );
    expect(
      analyzeSession(snapshot({ toolCalls: wideReads, contextPct: 70 })).some(
        (x) => x.tipId === "subagent-offload",
      ),
    ).toBe(true);
    for (const tool of ["Task", "Agent"] as const) {
      const delegated = analyzeSession(
        snapshot({ toolCalls: [...wideReads, call(tool, true, null)], contextPct: 70 }),
      );
      expect(
        delegated.some((x) => x.tipId === "subagent-offload"),
        `${tool} should count as delegation`,
      ).toBe(false);
    }
  });

  test("read-in-slices fires on 3+ whole-file results, and prices only the excess", () => {
    const f = analyzeSession(
      snapshot({ fatReads: 3, fatReadTokens: 60_000, fatReadWorstTokens: 30_000 }),
    ).find((x) => x.tipId === "read-in-slices");
    expect(f).toBeDefined();
    expect(f!.evidence).toEqual({ count: 3, worst_k: 30, total_k: 60 });
    // Only what a bounded read would not have cost: 60k - 3x8k, at 0.9 because
    // the window re-reads it at cache price after the first turn.
    expect(f!.estSavingsTokens).toBe(Math.round((60_000 - 24_000) * 0.9));
  });

  test("one big file is not a habit — the tip stays silent below three", () => {
    // Sometimes the whole file IS what you needed. The floor is what keeps
    // this from scolding a legitimate read.
    const two = analyzeSession(snapshot({ fatReads: 2, fatReadTokens: 400_000, fatReadWorstTokens: 300_000 }));
    expect(two.some((x) => x.tipId === "read-in-slices")).toBe(false);

    // And a caller with no result-size data at all says nothing either way.
    const unmeasured = analyzeSession(snapshot({ fatReads: undefined }));
    expect(unmeasured.some((x) => x.tipId === "read-in-slices")).toBe(false);
  });

  test("read-in-slices yields only when the fat reads ARE the re-read file", () => {
    // Same file, read 5x and huge every time: reread-churn already bills those
    // bytes, so charging them again under a second name is the double-nag
    // applyClaudeMd exists to prevent.
    const rereads = Array.from({ length: 5 }, () => call("Read"));
    const sameFile = analyzeSession(
      snapshot({
        toolCalls: rereads,
        fatReads: 4,
        fatReadTokens: 80_000,
        fatReadWorstTokens: 30_000,
        fatReadTargets: ["aaaaaaaaaaaaaaaa"], // what call("Read") targets
      }),
    );
    expect(sameFile.some((x) => x.tipId === "reread-churn")).toBe(true);
    expect(sameFile.some((x) => x.tipId === "read-in-slices")).toBe(false);
  });

  test("read-in-slices still fires when the fat reads are DIFFERENT files", () => {
    // The case a blanket yield got wrong. Measured on the real corpus: the
    // session with the largest whole-file waste (914k tokens over 17 reads)
    // also trips reread-churn for 2k, and yielding on any overlap threw away
    // the 772k finding to protect the 2k one.
    const rereads = Array.from({ length: 5 }, () => call("Read"));
    const otherFiles = analyzeSession(
      snapshot({
        toolCalls: rereads,
        fatReads: 4,
        fatReadTokens: 80_000,
        fatReadWorstTokens: 30_000,
        fatReadTargets: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"],
      }),
    );
    expect(otherFiles.some((x) => x.tipId === "reread-churn")).toBe(true);
    const fat = otherFiles.find((x) => x.tipId === "read-in-slices");
    expect(fat).toBeDefined();
    expect(fat!.estSavingsTokens).toBeGreaterThan(0);
  });
});
