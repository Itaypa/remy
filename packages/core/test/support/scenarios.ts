import type { Database } from "bun:sqlite";
import type { SessionSnapshot } from "../../src/rules";
import type { TranscriptStats } from "../../src/transcript";
import { MARKER, TranscriptBuilder } from "./transcript-builder";

// The coverage matrix, as data. One entry per way a developer wastes tokens
// driving Claude Code, plus the negatives that prove REMY stays quiet and the
// pairs that prove it says a thing only once.
//
// Both tiers consume this list: the fast tier parses `transcript` in-process
// and runs the rules, the e2e tier writes it to disk and drives the real
// `remy ingest` hooks over it. Same fixtures, same expectations, two depths —
// so a rule that passes the unit tier and dies in the pipeline has nowhere to
// hide.
//
// Every fixture is deliberately narrow: it clears the threshold of the rule it
// targets and stays under every other rule's. That is why, for example, the
// edit-thrash fixture re-reads exactly three times (four would also trip
// reread-churn) and the cache-idle fixture opens with a cheap turn (a fat one
// would also trip context-tax). `expect` is an EXACT set — cross-fire is a
// failure, not a detail.

export interface SeedSession {
  daysAgo?: number;
  usedPlanMode?: boolean;
  model?: string;
  toolCalls?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface HookStep {
  event: "PreCompact" | "PermissionDenied" | "PostToolUse" | "PostToolUseFailure";
  trigger?: "auto" | "manual";
  toolName?: string;
  repeat?: number;
}

export interface Scenario {
  name: string;
  /** What the developer did, as transcript JSONL. */
  build: (t: TranscriptBuilder) => void;
  /** Hook events that arrive outside the transcript (compacts, denials). */
  hooks?: HookStep[];
  /** Project memory the session starts with. Default: present but small. */
  claudeMd?: "none" | "small" | number;
  /** Prior sessions in the 7-day window, for the habit rules. */
  seed?: SeedSession[];
  /** The complete set of tips this session should produce. */
  expect: string[];
  /** Tips that must NOT appear. Redundant with the exact-set check, but names
   * the suppression each scenario exists to prove. */
  forbid?: string[];
  /** Only meaningful through the real hook pipeline (no transcript signal). */
  e2eOnly?: boolean;
  why: string;
}

const CLEAN_BASH = "bun test";

export const SCENARIOS: Scenario[] = [
  {
    name: "auto-compact",
    why: "the host compacted for you — the session outgrew its window",
    build: (t) => t.read("api.ts").edit("api.ts"),
    hooks: [{ event: "PreCompact", trigger: "auto" }],
    expect: ["auto-compact"],
  },
  {
    name: "plan-mode",
    why: "a long editing session driven turn-by-turn, never planned",
    build: (t) => {
      t.times(7, (b, f) => b.times(3, () => b.read(`lib${f}.ts`)));
      t.times(5, (b, i) => b.edit(`mod${i}.ts`));
      t.bash(CLEAN_BASH);
    },
    expect: ["plan-mode"],
  },
  {
    name: "plan-mode suppressed by habit",
    why: "someone who already plans most sessions should not be nagged",
    build: (t) => {
      t.times(7, (b, f) => b.times(3, () => b.read(`lib${f}.ts`)));
      t.times(5, (b, i) => b.edit(`mod${i}.ts`));
      t.bash(CLEAN_BASH);
    },
    seed: [
      { daysAgo: 1, usedPlanMode: true },
      { daysAgo: 2, usedPlanMode: true },
      { daysAgo: 3, usedPlanMode: true },
      { daysAgo: 4, usedPlanMode: false },
      { daysAgo: 5, usedPlanMode: false },
    ],
    expect: [],
    forbid: ["plan-mode"],
  },
  {
    name: "retry-loop",
    why: "the same failing command run three times without changing anything",
    build: (t) => t.failedRun("Bash", { command: `npm run migrate # ${MARKER}` }, 3),
    expect: ["retry-loop"],
  },
  {
    name: "reread-churn",
    why: "the same file pulled into context four times over",
    build: (t) => t.times(4, (b) => b.read("api.ts")),
    expect: ["reread-churn"],
  },
  {
    name: "claude-md-missing replaces reread-churn",
    why: "re-reading with no project memory to read from is a cause, not a symptom",
    build: (t) => t.times(4, (b) => b.read("api.ts")),
    claudeMd: "none",
    expect: ["claude-md-missing"],
    forbid: ["reread-churn"],
  },
  {
    name: "edit-thrash",
    why: "six edits to one file with re-reads in between — the rework cycle",
    build: (t) =>
      t
        .edit("api.ts")
        .read("api.ts")
        .edit("api.ts")
        .read("api.ts")
        .edit("api.ts")
        .read("api.ts")
        .times(3, (b) => b.edit("api.ts")),
    expect: ["edit-thrash"],
    forbid: ["reread-churn"],
  },
  {
    name: "no-verify",
    why: "four files edited, the shell used, and never once to check the work",
    build: (t) => t.times(4, (b, i) => b.edit(`mod${i}.ts`)).bash("echo done"),
    expect: ["no-verify"],
  },
  {
    name: "clean: edits followed by a test run",
    why: "the same edit volume, verified — must stay silent",
    build: (t) => t.times(4, (b, i) => b.edit(`mod${i}.ts`)).bash(CLEAN_BASH),
    expect: [],
    forbid: ["no-verify"],
  },
  {
    name: "context-tax",
    why: "the session opens already heavy — a tax paid before turn one",
    build: (t) => t.turn({ usage: { input_tokens: 50_000, output_tokens: 500 } }).read("api.ts"),
    expect: ["context-tax"],
  },
  {
    name: "claude-md-prune",
    why: "25KB of project memory loaded into every single session",
    build: (t) => t.read("api.ts").edit("api.ts"),
    claudeMd: 25_000,
    expect: ["claude-md-prune"],
  },
  {
    name: "context-tax swallows claude-md-prune",
    why: "context-tax already ends with 'prune CLAUDE.md' — saying it twice is a nag",
    build: (t) => t.turn({ usage: { input_tokens: 50_000, output_tokens: 500 } }).read("api.ts"),
    claudeMd: 25_000,
    expect: ["context-tax"],
    forbid: ["claude-md-prune"],
  },
  {
    name: "subagent-offload",
    why: "fifteen files read inline under context pressure, no subagent used",
    build: (t) =>
      t
        .times(15, (b, i) => b.read(`file${i}.ts`))
        .turn({ usage: { input_tokens: 150_000, output_tokens: 500 } }),
    expect: ["subagent-offload"],
  },
  {
    name: "clean: wide exploration delegated to a subagent",
    why: "same read volume, offloaded — must stay silent",
    build: (t) =>
      t
        .taskTool()
        .times(15, (b, i) => b.read(`file${i}.ts`))
        .turn({ usage: { input_tokens: 150_000, output_tokens: 500 } }),
    expect: [],
    forbid: ["subagent-offload"],
  },
  {
    name: "cache-idle",
    why: "walked away for half an hour and paid to re-write a 120k context",
    build: (t) =>
      t
        .turn({ usage: { input_tokens: 500, output_tokens: 300 } })
        .idle(35)
        .turn({
          usage: {
            input_tokens: 500,
            output_tokens: 300,
            cache_creation_input_tokens: 120_000,
            cache_read_input_tokens: 5_000,
          },
        }),
    expect: ["cache-idle"],
  },
  {
    name: "context-band",
    why: "three turns ridden above 80% full without ever compacting",
    build: (t) =>
      t
        .read("api.ts")
        .times(3, (b) => b.turn({ usage: { input_tokens: 165_000, output_tokens: 500 } })),
    expect: ["context-band"],
    forbid: ["context-tax"],
  },
  {
    name: "auto-compact swallows context-band",
    why: "one incident, one tip — auto-compact owns the session's context story",
    build: (t) =>
      t
        .read("api.ts")
        .times(3, (b) => b.turn({ usage: { input_tokens: 165_000, output_tokens: 500 } })),
    hooks: [{ event: "PreCompact", trigger: "auto" }],
    expect: ["auto-compact"],
    forbid: ["context-band"],
  },
  {
    name: "tools-over-bash",
    why: "six shell reads where Read and Grep would have paginated",
    build: (t) =>
      t
        .bash("cat README.md")
        .bash("grep -rn TODO src")
        .bash("ls -la src")
        .bash("head -50 src/api.ts")
        .bash("find . -name '*.ts'")
        .bash("rg handler src"),
    expect: ["tools-over-bash"],
  },
  {
    name: "clean: a well-driven session",
    why: "planned, verified, no churn — the shape REMY must never interrupt",
    build: (t) =>
      t
        .planTool()
        .read("a.ts")
        .read("b.ts")
        .read("c.ts")
        .edit("a.ts")
        .edit("b.ts")
        .bash(CLEAN_BASH),
    expect: [],
  },
  {
    name: "chaos: five detectors, one voice",
    why: "a genuinely bad session — the highest-value tip must win the only slot",
    build: (t) =>
      t
        .edit("api.ts")
        .read("api.ts")
        .edit("api.ts")
        .read("api.ts")
        .edit("api.ts")
        .read("api.ts")
        .times(3, (b) => b.edit("api.ts"))
        .times(4, (b) => b.read("util.ts"))
        .bash("cat README.md")
        .bash("grep -rn TODO src")
        .bash("ls -la src")
        .bash("head -50 src/api.ts")
        .bash("find . -name '*.ts'")
        .bash("rg handler src")
        .times(3, (b) => b.turn({ usage: { input_tokens: 165_000, output_tokens: 500 } })),
    expect: ["edit-thrash", "reread-churn", "no-verify", "tools-over-bash", "context-band"],
  },
  {
    name: "permission denials are counted, never coached",
    why: "pins today's deliberate gap: no rule reads perm_denials (see the backlog)",
    build: (t) => t.read("api.ts").edit("api.ts"),
    hooks: [{ event: "PermissionDenied", repeat: 3 }],
    expect: [],
    e2eOnly: true,
  },
  {
    name: "tool failures reported only by hooks do not fake a retry loop",
    why: "retry-loop is a transcript signal; three failed hooks are not three retries",
    build: (t) => t.read("api.ts").edit("api.ts"),
    hooks: [{ event: "PostToolUseFailure", toolName: "Bash", repeat: 3 }],
    expect: [],
    forbid: ["retry-loop"],
    e2eOnly: true,
  },
];

export const CHAOS = SCENARIOS.find((s) => s.name.startsWith("chaos"))!;

/** Bytes of CLAUDE.md a scenario asks for. */
export function claudeMdBytesFor(s: Scenario): number {
  const spec = s.claudeMd ?? "small";
  if (spec === "none") return 0;
  if (spec === "small") return 400;
  return spec;
}

/** Auto-compacts a scenario's hooks would have recorded. Derived rather than
 * declared, so the two tiers cannot disagree about it. */
export function autoCompactsFor(s: Scenario): number {
  return (s.hooks ?? [])
    .filter((h) => h.event === "PreCompact" && h.trigger === "auto")
    .reduce((n, h) => n + (h.repeat ?? 1), 0);
}

export function transcriptFor(s: Scenario): string {
  const t = new TranscriptBuilder();
  s.build(t);
  return t.jsonl();
}

/** Build the snapshot exactly as `analyzeTranscript` in the CLI does. Kept
 * here so the fast tier measures the same thing the pipeline measures. */
export function snapshotFor(
  s: Scenario,
  stats: TranscriptStats,
  limit: number,
): SessionSnapshot {
  return {
    sessionId: "scenario",
    spendTokens: stats.totals.in + stats.totals.out,
    toolCalls: stats.toolCalls,
    editCalls: stats.editCalls,
    usedPlanMode: stats.usedPlanMode,
    autoCompacts: autoCompactsFor(s),
    contextLimit: limit,
    contextPct: stats.contextPct,
    firstContextTokens: stats.firstContextTokens,
    cacheExpiries: stats.cacheExpiries,
    cacheExpiryTokens: stats.cacheExpiryTokens,
    cacheExpiryWorstGapMinutes: stats.cacheExpiryWorstGapMinutes,
    redZoneTurns: stats.redZoneTurns,
    redZoneExcessTokens: stats.redZoneExcessTokens,
    claudeMdBytes: claudeMdBytesFor(s),
  };
}

/** Insert a prior session row. Shared by both tiers so the habit fixtures are
 * identical whether the DB is in memory or on disk. */
export function seedSession(db: Database, id: string, seed: SeedSession, now = Date.now()): void {
  const startedAt = new Date(now - (seed.daysAgo ?? 1) * 86_400_000).toISOString();
  db.query(
    `INSERT OR REPLACE INTO sessions
       (session_id, started_at, model, tokens_in, tokens_out, tool_calls, used_plan_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    startedAt,
    seed.model ?? "claude-fable-5",
    seed.tokensIn ?? 5_000,
    seed.tokensOut ?? 2_000,
    seed.toolCalls ?? 10,
    seed.usedPlanMode ? 1 : 0,
  );
}
