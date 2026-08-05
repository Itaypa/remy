import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, contextFromPayload, parseTranscript, parseTranscriptFile, tailContext, type BashClass } from "../src/transcript";

function assistantLine(opts: {
  id: string;
  usage?: Record<string, number>;
  content?: unknown[];
  sidechain?: boolean;
  model?: string;
  /** Entry timestamp — minutes after a fixed session start, for gap tests. */
  atMin?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.sidechain ?? false,
    ...(opts.atMin != null ? { timestamp: new Date(Date.UTC(2026, 7, 1, 9, opts.atMin)).toISOString() } : {}),
    message: {
      id: opts.id,
      model: opts.model ?? "claude-fable-5",
      usage: opts.usage,
      content: opts.content ?? [],
    },
  });
}

function toolResultLine(toolUseId: string, isError: boolean): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  });
}

const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});

// What /compact writes into the transcript: a system entry carrying the exact
// post-compact context size. No assistant usage exists again until the next reply.
function boundaryLine(postTokens?: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    isSidechain: false,
    ...(postTokens != null
      ? { compactMetadata: { trigger: "manual", preTokens: 160_252, postTokens } }
      : {}),
  });
}

describe("transcript parser", () => {
  test("dedupes streamed duplicates of the same message id, keeping the last usage", () => {
    const text = [
      assistantLine({ id: "m1", usage: { input_tokens: 100, output_tokens: 5 } }),
      assistantLine({ id: "m1", usage: { input_tokens: 100, output_tokens: 50 } }),
      assistantLine({ id: "m2", usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 1000 } }),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.totals.in).toBe(300);
    expect(stats.totals.out).toBe(70);
    expect(stats.totals.cache_read).toBe(1000);
    expect(stats.assistantTurns).toBe(2);
  });

  test("context comes from the last main-chain message; sidechains are excluded", () => {
    const text = [
      assistantLine({ id: "m1", usage: { input_tokens: 50_000, cache_read_input_tokens: 100_000, output_tokens: 1_000 } }),
      assistantLine({ id: "side", sidechain: true, usage: { input_tokens: 199_000, output_tokens: 500 } }),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.contextTokens).toBe(151_000);
    expect(stats.contextPct).toBe(76);
  });

  test("detects plan mode, edits, and tool failures via tool_result", () => {
    const text = [
      assistantLine({
        id: "m1",
        usage: { input_tokens: 10 },
        content: [use("t1", "ExitPlanMode"), use("t2", "Edit", { file_path: "/a.ts" })],
      }),
      toolResultLine("t2", true),
      assistantLine({ id: "m2", usage: { input_tokens: 10 }, content: [use("t3", "Read", { file_path: "/a.ts" })] }),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.usedPlanMode).toBe(true);
    expect(stats.editCalls).toBe(1);
    expect(stats.toolCalls).toHaveLength(3);
    expect(stats.toolCalls[1]!.ok).toBe(false);
    expect(stats.toolCalls[2]!.ok).toBe(true);
  });

  test("every plan-mode tool name counts — including the snake_case one", () => {
    // Only ExitPlanMode was ever exercised, so dropping either of the other two
    // names broke no test. The failure is a false positive on someone who did
    // the right thing: plan mode goes undetected and the plan-mode tip fires at
    // a user who planned.
    for (const name of ["ExitPlanMode", "EnterPlanMode", "exit_plan_mode"]) {
      const text = assistantLine({ id: "m1", usage: { input_tokens: 10 }, content: [use("t1", name)] });
      expect(parseTranscript(text, 200_000).usedPlanMode, `${name} should mark plan mode`).toBe(true);
    }
    // A tool that merely looks similar does not count.
    const nope = assistantLine({ id: "m1", usage: { input_tokens: 10 }, content: [use("t1", "PlanSomething")] });
    expect(parseTranscript(nope, 200_000).usedPlanMode).toBe(false);
  });

  test("every edit tool counts as an edit — Write included", () => {
    // editCalls is the input to no-verify and plan-mode, and only Edit was
    // ever exercised here: dropping Write from EDIT_TOOLS broke no test, so a
    // Write-heavy session would silently stop qualifying for either rule.
    const text = [
      assistantLine({
        id: "m1",
        usage: { input_tokens: 10 },
        content: [
          use("t1", "Write", { file_path: "/a.ts" }),
          use("t2", "MultiEdit", { file_path: "/b.ts" }),
          use("t3", "NotebookEdit", { notebook_path: "/c.ipynb" }),
          use("t4", "Edit", { file_path: "/d.ts" }),
          use("t5", "Read", { file_path: "/e.ts" }),
        ],
      }),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.editCalls).toBe(4);
  });

  test("hashes tool targets — raw paths never appear in output", () => {
    const text = assistantLine({
      id: "m1",
      usage: { input_tokens: 1 },
      content: [use("t1", "Read", { file_path: "/Users/x/very-secret-file.ts" })],
    });
    const stats = parseTranscript(text, 200_000);
    expect(JSON.stringify(stats)).not.toContain("very-secret-file");
    expect(stats.toolCalls[0]!.targetHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("tolerates malformed lines and empty input", () => {
    const stats = parseTranscript("not json\n\n{\"type\":\"summary\"}", 200_000);
    expect(stats.totals.in).toBe(0);
    expect(stats.toolCalls).toHaveLength(0);
  });

  test("a compact boundary after the last reply resets context to postTokens", () => {
    const text = [
      assistantLine({ id: "m1", usage: { input_tokens: 10_000, cache_read_input_tokens: 150_000, output_tokens: 252 } }),
      boundaryLine(11_259),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.contextTokens).toBe(11_259);
    expect(stats.contextPct).toBe(6);
    // Lifetime totals still include the pre-compact spend — only the live context resets.
    expect(stats.totals.cache_read).toBe(150_000);
  });

  test("a reply after the compact boundary wins again", () => {
    const text = [
      assistantLine({ id: "m1", usage: { input_tokens: 160_000 } }),
      boundaryLine(11_259),
      assistantLine({ id: "m2", usage: { input_tokens: 14_000, output_tokens: 500 } }),
    ].join("\n");
    expect(parseTranscript(text, 200_000).contextTokens).toBe(14_500);
  });

  test("firstContextTokens is the first main-chain turn, not the last, and skips sidechains", () => {
    const text = [
      assistantLine({ id: "side", sidechain: true, usage: { input_tokens: 90_000 } }),
      assistantLine({ id: "m1", usage: { input_tokens: 30_000, cache_read_input_tokens: 20_000, output_tokens: 100 } }),
      assistantLine({ id: "m2", usage: { input_tokens: 10_000, cache_read_input_tokens: 140_000, output_tokens: 500 } }),
    ].join("\n");
    const stats = parseTranscript(text, 200_000);
    expect(stats.firstContextTokens).toBe(50_100);
    expect(stats.contextTokens).toBe(150_500);
  });

  test("bashClass is set only on Bash calls and the raw command never leaks", () => {
    const text = assistantLine({
      id: "m1",
      usage: { input_tokens: 1 },
      content: [
        use("t1", "Bash", { command: "bun test packages/core --secret-flag" }),
        use("t2", "Read", { file_path: "/a.ts" }),
      ],
    });
    const stats = parseTranscript(text, 200_000);
    expect(stats.toolCalls[0]!.bashClass).toBe("test");
    expect(stats.toolCalls[1]!.bashClass).toBeUndefined();
    expect(JSON.stringify(stats)).not.toContain("secret-flag");
  });
});

describe("classifyCommand", () => {
  const cases: Array<[string, BashClass]> = [
    ["bun test", "test"],
    ["npm test", "test"],
    ["CI=1 npm test", "test"],
    ["cd packages/core && bun test", "test"],
    ["cd a && cd b && vitest run", "test"],
    ["npx jest src/foo.test.ts", "test"],
    ["bun run test:watch", "test"],
    ["go test ./...", "test"],
    ["cargo test", "test"],
    ["make test", "test"],
    ["tsc --noEmit", "build"],
    ["bun run build", "build"],
    ["npm run build:dashboard", "build"],
    ["make", "build"],
    ["cargo build --release", "build"],
    ["eslint . --fix", "lint"],
    ["bun run typecheck", "lint"],
    ["cargo clippy", "lint"],
    ["git commit -m 'msg'", "git"],
    ["git status", "git"],
    ["gitk", "other"],
    ["bun install", "pkg"],
    ["npm i lodash", "pkg"],
    ["pip install requests", "pkg"],
    ["cargo add serde", "pkg"],
    ["bun run dev:server", "run"],
    ["ls -la /Users/x/secret", "read-cmd"],
    ["cat packages/core/src/rules.ts", "read-cmd"],
    ["head -50 README.md", "read-cmd"],
    ["grep -rn TODO packages", "read-cmd"],
    ["rg --files-with-matches useState", "read-cmd"],
    ["find . -name '*.test.ts'", "read-cmd"],
    ["cd packages/core && grep -n export src/index.ts", "read-cmd"],
    ["cat src/a.ts | wc -l", "read-cmd"],
    // Same words, different intent — a write or an action, not a read.
    ["cat > /tmp/x.txt", "other"],
    ["cat <<'EOF' > note.md", "other"],
    ["find . -name '*.tmp' -delete", "other"],
    ["find . -name '*.ts' -exec rm {} ;", "other"],
    ["echo $API_KEY", "other"],
    ["", "other"],
  ];
  for (const [cmd, expected] of cases) {
    test(`"${cmd}" → ${expected}`, () => {
      expect(classifyCommand(cmd)).toBe(expected);
    });
  }
});

describe("cache-expiry detection (timestamp-verified idle gaps that re-wrote a fat context)", () => {
  // The unambiguous case: 45-min gap, 140k re-write with collapsed reads.
  const coldReturn = (id: string, atMin: number, write = 140_000) =>
    assistantLine({ id, atMin, usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: write } });
  const warmTurn = (id: string, atMin: number, ctx = 140_000) =>
    assistantLine({ id, atMin, usage: { input_tokens: 500, cache_read_input_tokens: ctx, cache_creation_input_tokens: 1_000 } });

  test("a real gap + fat re-write is an expiry, with the worst gap in minutes", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        warmTurn("m2", 2),
        coldReturn("m3", 47), // 45-min gap
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(1);
    expect(stats.cacheExpiryTokens).toBe(140_000);
    expect(stats.cacheExpiryWorstGapMinutes).toBe(45);
  });

  test("a cache bust with NO time gap (tool-list change, prompt drift) is not blamed on idleness", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        warmTurn("m2", 2),
        coldReturn("m3", 4), // 2-min gap — same usage shape, no idle gap
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("a coffee-break gap is not an idle expiry — the floor is 30 minutes, not any pause", () => {
    // 20 minutes: longer than the 2-min drift case above, still inside the
    // prompt-cache TTL's practical window. Pins CACHE_EXPIRY_MIN_GAP_MS — the
    // 2-min case sat so far below the floor that dropping it to 5 minutes
    // broke nothing, which would have started blaming ordinary pauses (a
    // build, a code review, lunch) for a cache bust they didn't cause.
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        warmTurn("m2", 2),
        coldReturn("m3", 22), // 20-min gap
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("a long gap with a small re-write stays silent — reheating beats re-briefing", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 40_000 } }),
        warmTurn("m2", 2, 42_000),
        coldReturn("m3", 60, 43_000), // long gap, but only a 43k context
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("missing timestamps count as no gap (conservative)", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        assistantLine({ id: "m2", usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 141_000 } }),
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("the first turn after a compact re-writes legitimately — excluded even across a gap", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 150_000 } }),
        warmTurn("m2", 2, 152_000),
        boundaryLine(12_000),
        coldReturn("m3", 50),
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("the session's model is the one that did the work, not the one that spoke last", () => {
    // The shape that motivated this: a long session on one model with a short
    // detour to another at the end. Under last-seen, one closing question on
    // the top tier relabels the whole session — and `model-fit` then bills all
    // of its tokens to opus.
    const stats = parseTranscript(
      [
        assistantLine({ id: "a1", model: "claude-sonnet-5", usage: { output_tokens: 40_000 } }),
        assistantLine({ id: "a2", model: "claude-sonnet-5", usage: { output_tokens: 35_000 } }),
        assistantLine({ id: "a3", model: "claude-opus-5", usage: { output_tokens: 500 } }),
      ].join("\n"),
      200_000,
    );
    expect(stats.model).toBe("claude-sonnet-5");
  });

  test("a burst of short turns doesn't outvote the model that generated the work", () => {
    // Why output tokens rather than turn count: five one-line answers should
    // not outrank one long generation.
    const lines = [assistantLine({ id: "big", model: "claude-opus-5", usage: { output_tokens: 60_000 } })];
    for (let i = 0; i < 5; i++) {
      lines.push(assistantLine({ id: `s${i}`, model: "claude-haiku-4-5", usage: { output_tokens: 200 } }));
    }
    expect(parseTranscript(lines.join("\n"), 200_000).model).toBe("claude-opus-5");
  });

  test("synthetic turns never win the attribution, and never blank it", () => {
    // The host writes placeholder turns carrying no usage and the literal model
    // "<synthetic>". They are not a model anyone chose.
    const stats = parseTranscript(
      [
        assistantLine({ id: "a1", model: "claude-fable-5", usage: { output_tokens: 900 } }),
        assistantLine({ id: "a2", model: "<synthetic>", usage: { output_tokens: 0 } }),
        assistantLine({ id: "a3", model: "<synthetic>", usage: { output_tokens: 0 } }),
      ].join("\n"),
      200_000,
    );
    expect(stats.model).toBe("claude-fable-5");
  });

  test("a session with no output tokens still attributes, by turns", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "a1", model: "claude-haiku-4-5", usage: {} }),
        assistantLine({ id: "a2", model: "claude-haiku-4-5", usage: {} }),
        assistantLine({ id: "a3", model: "claude-opus-5", usage: {} }),
      ].join("\n"),
      200_000,
    );
    expect(stats.model).toBe("claude-haiku-4-5");
  });

  test("sidechain turns don't vote — a subagent's model is not the session's", () => {
    // Subagents run on their own model (often haiku). Counting their output
    // would let delegated work rename the session the user is actually in.
    const stats = parseTranscript(
      [
        assistantLine({ id: "a1", model: "claude-opus-5", usage: { output_tokens: 5_000 } }),
        assistantLine({ id: "s1", model: "claude-haiku-4-5", sidechain: true, usage: { output_tokens: 90_000 } }),
      ].join("\n"),
      200_000,
    );
    expect(stats.model).toBe("claude-opus-5");
  });

  test("a model switch re-writes legitimately — excluded even across a gap", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, model: "claude-fable-5", usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        assistantLine({
          id: "m2",
          atMin: 45,
          model: "claude-haiku-4-5",
          usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 141_000 },
        }),
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("sidechain turns neither count as expiries nor break main-chain adjacency", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        assistantLine({ id: "side", atMin: 30, sidechain: true, usage: { input_tokens: 100, cache_creation_input_tokens: 170_000 } }),
        warmTurn("m2", 31, 142_000),
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(0);
  });

  test("two separate long gaps both count, worst gap wins the evidence", () => {
    const stats = parseTranscript(
      [
        assistantLine({ id: "m1", atMin: 0, usage: { input_tokens: 2_000, cache_creation_input_tokens: 140_000 } }),
        coldReturn("m2", 40), // 40-min gap
        coldReturn("m3", 160, 150_000), // 120-min gap
      ].join("\n"),
      200_000,
    );
    expect(stats.cacheExpiries).toBe(2);
    expect(stats.cacheExpiryTokens).toBe(290_000);
    expect(stats.cacheExpiryWorstGapMinutes).toBe(120);
  });
});

describe("red-zone turn counting (context ≥80% full)", () => {
  // limit 200k → red zone at ≥160k per-turn context, baseline 120k (60%).
  const warm = (id: string, ctx: number) =>
    assistantLine({ id, usage: { input_tokens: 1_000, cache_read_input_tokens: ctx - 1_500, output_tokens: 500 } });

  test("counts red turns and sums the excess above the 60% band", () => {
    const stats = parseTranscript(
      [warm("m1", 100_000), warm("m2", 170_000), warm("m3", 180_000), warm("m4", 190_000)].join("\n"),
      200_000,
    );
    expect(stats.redZoneTurns).toBe(3);
    // (170k-120k) + (180k-120k) + (190k-120k) = 180k
    expect(stats.redZoneExcessTokens).toBe(180_000);
  });

  test("turns below 80% never count", () => {
    const stats = parseTranscript([warm("m1", 100_000), warm("m2", 159_000)].join("\n"), 200_000);
    expect(stats.redZoneTurns).toBe(0);
    expect(stats.redZoneExcessTokens).toBe(0);
  });

  test("a compact ends the run — post-compact turns reflect their own smaller context", () => {
    const stats = parseTranscript(
      [warm("m1", 170_000), warm("m2", 175_000), boundaryLine(30_000), warm("m3", 35_000)].join("\n"),
      200_000,
    );
    expect(stats.redZoneTurns).toBe(2);
  });

  test("sidechain turns are excluded", () => {
    const stats = parseTranscript(
      [
        warm("m1", 100_000),
        assistantLine({ id: "side", sidechain: true, usage: { input_tokens: 1_000, cache_read_input_tokens: 185_000 } }),
      ].join("\n"),
      200_000,
    );
    expect(stats.redZoneTurns).toBe(0);
  });

  test("the red-zone threshold scales with the context limit", () => {
    // A 170k turn is red on a 200k window but healthy on a 1M window.
    const big = parseTranscript([warm("m1", 170_000), warm("m2", 170_000), warm("m3", 170_000)].join("\n"), 1_000_000);
    expect(big.redZoneTurns).toBe(0);
  });
});

describe("tailContext (statusline fast path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-tail-"));
  const write = (name: string, lines: string[]): string => {
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  };
  const bigUsage = assistantLine({
    id: "m1",
    usage: { input_tokens: 20_000, cache_read_input_tokens: 140_000, output_tokens: 252 },
  });

  test("stale pre-compact usage no longer wins after /compact", async () => {
    const p = write("compacted.jsonl", [bigUsage, boundaryLine(11_259)]);
    const ctx = await tailContext(p, 200_000);
    expect(ctx?.contextTokens).toBe(11_259);
    expect(ctx?.contextPct).toBe(6);
  });

  test("the next reply after a compact takes over", async () => {
    const p = write("resumed.jsonl", [
      bigUsage,
      boundaryLine(11_259),
      assistantLine({ id: "m2", usage: { input_tokens: 14_000, output_tokens: 500 } }),
    ]);
    expect((await tailContext(p, 200_000))?.contextTokens).toBe(14_500);
  });

  test("a boundary without postTokens is skipped, falling back to older usage", async () => {
    const p = write("malformed.jsonl", [bigUsage, boundaryLine()]);
    expect((await tailContext(p, 200_000))?.contextTokens).toBe(160_252);
  });

  test("sidechain usage after the boundary does not mask the reset", async () => {
    const p = write("sidechain.jsonl", [
      bigUsage,
      boundaryLine(11_259),
      assistantLine({ id: "side", sidechain: true, usage: { input_tokens: 90_000 } }),
    ]);
    expect((await tailContext(p, 200_000))?.contextTokens).toBe(11_259);
  });
});

describe("contextFromPayload (statusline payload fast path)", () => {
  test("agrees with contextOf()'s definition — sums input AND output tokens", async () => {
    // Same shape parseTranscript would see for one assistant turn: input +
    // cache tokens + output. contextFromPayload must land on the same total
    // as the transcript-derived path, not the host's used_percentage
    // (which excludes output tokens).
    const usage = { input_tokens: 20_000, cache_read_input_tokens: 140_000, output_tokens: 252 };
    const transcriptTotal = parseTranscript(
      assistantLine({ id: "m1", usage }) + "\n",
      200_000,
    ).contextTokens;
    const payload = {
      model: { id: "claude-fable-5" },
      context_window: {
        total_input_tokens: usage.input_tokens + usage.cache_read_input_tokens,
        total_output_tokens: usage.output_tokens,
        context_window_size: 200_000,
      },
    };
    const ctx = contextFromPayload(payload);
    expect(ctx?.contextTokens).toBe(transcriptTotal);
    expect(ctx?.contextTokens).toBe(160_252);
    expect(ctx?.limit).toBe(200_000);
    expect(ctx?.model).toBe("claude-fable-5");
  });

  test("returns null when context_window is absent (older host fallback)", () => {
    expect(contextFromPayload({ model: { id: "x" } })).toBeNull();
    expect(contextFromPayload({})).toBeNull();
    expect(contextFromPayload(null)).toBeNull();
  });

  test("returns null on a malformed context_window rather than guessing", () => {
    expect(
      contextFromPayload({ context_window: { total_input_tokens: 100, total_output_tokens: 10 } }),
    ).toBeNull(); // missing context_window_size
    expect(
      contextFromPayload({
        context_window: { total_input_tokens: 100, total_output_tokens: 10, context_window_size: 0 },
      }),
    ).toBeNull(); // zero limit
    expect(
      contextFromPayload({
        context_window: { total_input_tokens: "100", total_output_tokens: 10, context_window_size: 200_000 },
      }),
    ).toBeNull(); // non-numeric field
  });

  test("carries no content — numbers and a model id only", () => {
    const MARKER = "SUPER_SECRET_PROMPT_BODY";
    const ctx = contextFromPayload({
      cwd: `/Users/x/${MARKER}`,
      transcript_path: `/Users/x/${MARKER}.jsonl`,
      model: { id: "claude-fable-5" },
      context_window: { total_input_tokens: 1, total_output_tokens: 1, context_window_size: 200_000 },
    });
    expect(JSON.stringify(ctx)).not.toContain(MARKER);
  });
});

describe("parseTranscriptFile (the Stop-hook reader)", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-parsefile-"));

  // This runs inside the Stop/SessionEnd hook. A throw here does not just lose
  // the analysis: it unwinds to the CLI's global handler, which writes the
  // stack — containing the raw transcript path — into remy.log. Returning null
  // is therefore the contract, not a convenience.
  test("a missing file is null, not a throw", async () => {
    const stats = await parseTranscriptFile(join(dir, "does-not-exist.jsonl"), 200_000);
    expect(stats).toBeNull();
  });

  test("a directory where a file was expected is null, not a throw", async () => {
    // What a stale or mistyped transcript_path can actually look like. Note
    // this one is caught by the exists() check rather than the outer catch —
    // Bun.file(dir).exists() is false. The case below is what exercises the catch.
    expect(await parseTranscriptFile(dir, 200_000)).toBeNull();
  });

  test("a path that isn't even a valid path is null, not a throw", async () => {
    // transcript_path arrives in a hook payload and is not validated anywhere.
    // A NUL byte makes Bun.file().exists() itself throw a TypeError, so this
    // is the case the outer try/catch exists for — without it the Stop hook
    // dies and the global handler logs the raw path.
    expect(await parseTranscriptFile("/tmp/\0nope.jsonl", 200_000)).toBeNull();
    expect(await parseTranscriptFile("", 200_000)).toBeNull();
  });

  test("an empty file parses to an empty session rather than failing", async () => {
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    const stats = await parseTranscriptFile(p, 200_000);
    expect(stats).not.toBeNull();
    expect(stats!.assistantTurns).toBe(0);
    expect(stats!.toolCalls).toEqual([]);
  });

  test("a half-written final line is skipped, not fatal", async () => {
    // The host appends to the transcript while the hook reads it, so catching
    // the file mid-write is the normal case, not the edge case. The complete
    // turns before the tear must still be counted.
    const p = join(dir, "torn.jsonl");
    const good = assistantLine({ id: "m1", usage: { input_tokens: 1_000, output_tokens: 10 } });
    writeFileSync(p, `${good}\n{"type":"assistant","message":{"id":"m2","usa`);
    const stats = await parseTranscriptFile(p, 200_000);
    expect(stats).not.toBeNull();
    expect(stats!.assistantTurns).toBe(1);
    expect(stats!.totals.in).toBe(1_000);
  });
});

describe("oversized tool results", () => {
  const useLine = (id: string, name: string, path: string) =>
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: {
        id: `a-${id}`,
        model: "claude-fable-5",
        usage: { output_tokens: 1 },
        content: [{ type: "tool_use", id, name, input: { file_path: path } }],
      },
    });
  const resultLine = (id: string, chars: number) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(chars) }] },
    });

  test("counts Read results big enough to be whole files, and remembers the worst", () => {
    const lines: string[] = [];
    for (const [i, chars] of [40_000, 200_000, 36_000].entries()) {
      lines.push(useLine(`t${i}`, "Read", `/src/f${i}.ts`), resultLine(`t${i}`, chars));
    }
    const stats = parseTranscript(lines.join("\n"), 200_000);
    expect(stats.fatReads).toBe(3);
    expect(stats.fatReadWorstTokens).toBe(50_000); // 200,000 chars / 4
    expect(stats.fatReadTokens).toBe(10_000 + 50_000 + 9_000);
  });

  test("ordinary reads never count — the floor is well above normal use", () => {
    // Local Read results sit around 2,200 characters; nothing that size should
    // ever reach this rule.
    const lines = [useLine("t1", "Read", "/src/small.ts"), resultLine("t1", 2_200)];
    expect(parseTranscript(lines.join("\n"), 200_000).fatReads).toBe(0);
  });

  test("only Read counts — a huge browser result is an image, not a user's choice", () => {
    const lines = [
      useLine("t1", "mcp__Claude_Browser__computer", "https://example.com"),
      resultLine("t1", 400_000),
    ];
    expect(parseTranscript(lines.join("\n"), 200_000).fatReads).toBe(0);
  });

  test("the result content never leaves the parser — only its length does", () => {
    const marker = "SECRET-FILE-BODY";
    const lines = [useLine("t1", "Read", "/src/f.ts"), resultLine("t1", 40_000).replace(/x{16}/, marker)];
    const stats = parseTranscript(lines.join("\n"), 200_000);
    expect(stats.fatReads).toBe(1);
    expect(JSON.stringify(stats)).not.toContain(marker);
  });
});

describe("classifyCommand — every member of every set", () => {
  // These lists are written out deliberately rather than imported: they pin the
  // CONTRACT ("pytest is a test runner"), so removing a member from the source
  // fails here instead of silently changing what REMY believes. 24 of the 36
  // members across these four sets were never mentioned by any test, and the
  // failure direction is the harmful one — a runner that falls out of its set
  // classifies as "other", and `no-verify` then tells someone who ran their
  // tests that they shipped edits unverified. That is every Python user
  // (pytest, ruff, flake8, mypy) and every JVM build (gradle, mvn).
  const EXPECT: Array<[BashClass, string[]]> = [
    ["test", ["jest", "vitest", "pytest", "mocha", "playwright", "cypress"]],
    ["lint", ["eslint", "ruff", "biome", "prettier", "oxlint", "flake8", "mypy", "clippy"]],
    ["build", ["tsc", "make", "webpack", "vite", "esbuild", "rollup", "gradle", "mvn"]],
    ["read-cmd", ["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "ls", "tree"]],
  ];

  for (const [expected, cmds] of EXPECT) {
    for (const cmd of cmds) {
      test(`${cmd} → ${expected}`, () => {
        expect(classifyCommand(`${cmd} some/path`)).toBe(expected);
      });
    }
  }

  test("make test is a test run, not a build — the one documented exception", () => {
    expect(classifyCommand("make test")).toBe("test");
    expect(classifyCommand("make")).toBe("build");
  });

  test("a read command that writes or acts is not a read", () => {
    // Same word, different intent. Checked across the whole set rather than on
    // one example, because the guard is a single regex for all of them.
    for (const cmd of ["cat", "grep", "find", "ls"]) {
      expect(classifyCommand(`${cmd} x > out.txt`), `${cmd} with a redirect`).toBe("other");
    }
    expect(classifyCommand("find . -name '*.tmp' -delete")).toBe("other");
    expect(classifyCommand("find . -exec rm {} ;")).toBe("other");
  });
});
