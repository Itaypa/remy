import type { ToolCall } from "./transcript";
import type { SessionRow } from "./store";

// Waste signatures. Deterministic — no model calls in the analysis path.
// Savings estimates are deliberately rough heuristics; every rendered number
// is prefixed with "~" by the UI layer.

export interface SessionSnapshot {
  sessionId: string;
  spendTokens: number; // in + out (excludes cache reads)
  toolCalls: ToolCall[];
  editCalls: number;
  usedPlanMode: boolean;
  autoCompacts: number;
  contextLimit: number;
  contextPct: number;
  firstContextTokens: number;
  /** Mid-session prompt-cache expiries (timestamp-verified idle gaps that
   * re-wrote a fat context), the tokens re-written by them, and the longest
   * gap in minutes (computed in transcript.ts from per-turn usage). */
  cacheExpiries: number;
  cacheExpiryTokens: number;
  cacheExpiryWorstGapMinutes: number;
  /** Main-chain turns that ran ≥80% full, and the tokens processed above the
   * healthy 60% band across them (computed in transcript.ts). */
  redZoneTurns: number;
  redZoneExcessTokens: number;
  /** Bytes of CLAUDE.md memory the host loads for this cwd (claudemd.ts).
   * null = never probed — the rules stay silent rather than guess. */
  claudeMdBytes: number | null;
  /** Bytes of skill frontmatter the host loads before turn one (skills.ts).
   * null = never probed. Attribution only: no rule fires on this, it only
   * changes what `context-tax` says — which is why it's optional where
   * `claudeMdBytes` is required. A caller that doesn't supply it gets the
   * same tip it got before, worded the same way. */
  skillBytes?: number | null;
}

export interface Finding {
  tipId: string;
  evidence: Record<string, string | number>;
  estSavingsTokens: number;
}

const LONG_SESSION_TOOL_CALLS = 25;
const LONG_SESSION_EDITS = 5;
const RETRY_RUN_MIN = 3;
const REREAD_MIN = 4;
const REREAD_EST_TOKENS_PER_READ = 2_000;
const RETRY_EST_TOKENS_PER_FAIL = 8_000;
const EDIT_THRASH_MIN_EDITS = 6;
const EDIT_THRASH_MIN_CYCLES = 3;
const EDIT_THRASH_EST_TOKENS_PER_EDIT = 5_000;
const NO_VERIFY_MIN_EDITS = 4;
const NO_VERIFY_EST_TOKENS = 10_000;
const CONTEXT_TAX_MIN_TOKENS = 45_000;
/** Below this the skill pack rounds to "0.0k tokens", which reads as a
 * measurement error rather than a small number — say it in words instead. */
const SKILL_SHARE_MIN_TOKENS = 100;
const CONTEXT_TAX_BASELINE_TOKENS = 15_000;
const SUBAGENT_MIN_DISTINCT_READS = 15;
const SUBAGENT_MIN_CONTEXT_PCT = 70;
const SUBAGENT_EST_TOKENS_PER_READ = 1_500;
const RED_ZONE_MIN_TURNS = 3;
const BASH_READ_MIN = 6;
const BASH_READ_FREE = 2;
const BASH_READ_EST_TOKENS = 1_500;
const MODEL_FIT_MIN_SESSIONS = 4;
const MODEL_FIT_MAX_TOOL_CALLS = 5;
const MODEL_FIT_MAX_OUT_TOKENS = 3_000;
const MODEL_FIT_MIN_TRIVIAL_RATE = 0.5;
const PLAN_HABIT_SUPPRESS_RATE = 0.5;
const PLAN_HABIT_MIN_SESSIONS = 5;
// Bloat floor in BYTES, deliberately not lines. Bytes-per-line is not stable
// enough to convert: unwrapped prose runs 150–250 B/line, dense bullet lists
// ~30, and non-Latin scripts cost 2–3 bytes per character — a line-derived
// threshold would nag a short Japanese file and stay silent on a 400-line
// one. So the rule measures bytes and the copy speaks in KB. 20k sits well
// clear of files that are merely thorough (this repo's own is ~9k).
const CLAUDE_MD_BLOAT_BYTES = 20_000;
// What a pruned file should weigh; the gap is what a session stops paying.
const CLAUDE_MD_TARGET_BYTES = 12_000;
const BYTES_PER_TOKEN = 4;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const VERIFY_CLASSES = new Set(["test", "build", "lint"]);
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

export function analyzeSession(s: SessionSnapshot): Finding[] {
  const findings: Finding[] = [];

  if (s.autoCompacts > 0) {
    findings.push({
      tipId: "auto-compact",
      evidence: { count: s.autoCompacts },
      estSavingsTokens: s.autoCompacts * Math.round(s.contextLimit * 0.3),
    });
  }

  if (
    !s.usedPlanMode &&
    s.toolCalls.length >= LONG_SESSION_TOOL_CALLS &&
    s.editCalls >= LONG_SESSION_EDITS
  ) {
    findings.push({
      tipId: "plan-mode",
      evidence: { tool_calls: s.toolCalls.length, edits: s.editCalls },
      estSavingsTokens: Math.max(10_000, Math.round(s.spendTokens * 0.15)),
    });
  }

  const retry = detectRetryRuns(s.toolCalls);
  if (retry) findings.push(retry);

  const reread = detectRereadChurn(s.toolCalls);
  if (reread) findings.push(reread);

  const thrash = detectEditThrash(s.toolCalls);
  if (thrash) findings.push(thrash);

  const noVerify = detectNoVerify(s);
  if (noVerify) findings.push(noVerify);

  const tax = detectContextTax(s);
  if (tax) findings.push(tax);

  const offload = detectSubagentOffload(s);
  if (offload) findings.push(offload);

  const expiry = detectCacheExpiry(s);
  if (expiry) findings.push(expiry);

  const redZone = detectRedZoneRiding(s);
  if (redZone) findings.push(redZone);

  const shellReads = detectShellReads(s);
  if (shellReads) findings.push(shellReads);

  applyClaudeMd(s, findings);

  return findings.sort((a, b) => b.estSavingsTokens - a.estSavingsTokens);
}

// CLAUDE.md, in both directions — it runs last because both halves are about
// other findings rather than raw counts.
//
// Missing: an absent CLAUDE.md is only worth coaching when it demonstrably
// cost something, so it rides on observed re-read churn and *replaces* that
// finding instead of joining it. Two tips for one incident is a nag, and
// worse, letting both through would re-serve advice the user snoozed —
// dismissing `reread-churn` wouldn't stop the same point arriving under a new
// id. It inherits the re-read estimate because it is the same waste, named
// by its cause. (`detectRedZoneRiding` yields to `auto-compact` the same way.)
//
// Bloat: `context-tax` already ends with "prune CLAUDE.md", so when a heavy
// startup context is being reported there, adding this one says it twice.
function applyClaudeMd(s: SessionSnapshot, findings: Finding[]): void {
  const bytes = s.claudeMdBytes;
  if (bytes === null) return; // never probed — say nothing

  if (bytes === 0) {
    const i = findings.findIndex((f) => f.tipId === "reread-churn");
    if (i === -1) return;
    const [reread] = findings.splice(i, 1);
    findings.push({
      tipId: "claude-md-missing",
      evidence: reread!.evidence,
      estSavingsTokens: reread!.estSavingsTokens,
    });
    return;
  }

  if (bytes < CLAUDE_MD_BLOAT_BYTES) return;
  if (findings.some((f) => f.tipId === "context-tax")) return;
  findings.push({
    tipId: "claude-md-prune",
    evidence: { kb: Math.round(bytes / 1000) },
    estSavingsTokens: Math.round((bytes - CLAUDE_MD_TARGET_BYTES) / BYTES_PER_TOKEN),
  });
}

// Reading and searching through the shell (cat/grep/find/ls) where Read,
// Grep and Glob exist: those tools paginate, truncate and cap their output,
// a shell pipe does none of it — a `cat` of a 3k-line file lands whole, and
// a wide `grep -r` can dump more than the answer is worth. A handful is
// normal (checking a build artifact, a quick ls), so the floor is high
// enough that only the habit fires, and the first two are free.
function detectShellReads(s: SessionSnapshot): Finding | null {
  const shellReads = s.toolCalls.filter((c) => c.name === "Bash" && c.bashClass === "read-cmd").length;
  if (shellReads < BASH_READ_MIN) return null;
  return {
    tipId: "tools-over-bash",
    evidence: { count: shellReads },
    estSavingsTokens: (shellReads - BASH_READ_FREE) * BASH_READ_EST_TOKENS,
  };
}

// Riding the red zone: 3+ turns with the context ≥80% full. Crossing 80%
// then promptly compacting yields 1-2 red turns and stays silent; three or
// more means the red zone (and the live alarm) got ignored. Est = tokens
// processed above the 60% band — what compacting there would have avoided.
// Rough in both directions: much of it is cache-read priced (cheaper), but
// the context-rot quality cost isn't counted at all. Suppressed when
// auto-compact fired the same session — that tip already owns the session's
// context story, and two tips scolding one incident is a nag, not coaching.
function detectRedZoneRiding(s: SessionSnapshot): Finding | null {
  if (s.autoCompacts > 0) return null;
  if (s.redZoneTurns < RED_ZONE_MIN_TURNS) return null;
  return {
    tipId: "context-band",
    evidence: { turns: s.redZoneTurns },
    estSavingsTokens: s.redZoneExcessTokens,
  };
}

// A fat session left open: a timestamp-verified idle gap (≥30 min) after
// which the next message re-wrote a 100k+ context at full price where a
// warm return would have read it at 0.1×. transcript.ts already filters to
// the unambiguous case (real gap, big re-write, not post-compact, not a
// model switch), so any count fires. Savings ≈ 90% of the re-written
// tokens — the cache-read price is ~a tenth.
function detectCacheExpiry(s: SessionSnapshot): Finding | null {
  if (s.cacheExpiries === 0) return null;
  return {
    tipId: "cache-idle",
    evidence: { count: s.cacheExpiries, mins: s.cacheExpiryWorstGapMinutes },
    estSavingsTokens: Math.round(s.cacheExpiryTokens * 0.9),
  };
}

// Correction churn: the same file edited over and over, with re-reads
// interleaved after the first edit — the edit→re-read→edit rework cycle.
// A long legitimate single-file build writes without re-reading in between.
function detectEditThrash(calls: ToolCall[]): Finding | null {
  const edits = new Map<string, number>();
  const rereads = new Map<string, number>();
  const firstEditSeen = new Set<string>();
  for (const c of calls) {
    if (!c.targetHash) continue;
    if (EDIT_TOOLS.has(c.name)) {
      edits.set(c.targetHash, (edits.get(c.targetHash) ?? 0) + 1);
      firstEditSeen.add(c.targetHash);
    } else if (c.name === "Read" && firstEditSeen.has(c.targetHash)) {
      rereads.set(c.targetHash, (rereads.get(c.targetHash) ?? 0) + 1);
    }
  }
  let files = 0;
  let worstEdits = 0;
  for (const [hash, count] of edits) {
    if (count < EDIT_THRASH_MIN_EDITS) continue;
    if ((rereads.get(hash) ?? 0) < EDIT_THRASH_MIN_CYCLES) continue;
    files += 1;
    worstEdits = Math.max(worstEdits, count);
  }
  if (files === 0) return null;
  return {
    tipId: "edit-thrash",
    evidence: { files, edits: worstEdits },
    estSavingsTokens: (worstEdits - 3) * EDIT_THRASH_EST_TOKENS_PER_EDIT,
  };
}

// Edits shipped without a verify pass. Requires at least one Bash call so
// sessions where the shell was never usable (sandboxed hosts) never fire.
function detectNoVerify(s: SessionSnapshot): Finding | null {
  if (s.editCalls < NO_VERIFY_MIN_EDITS) return null;
  const bashCalls = s.toolCalls.filter((c) => c.name === "Bash");
  if (bashCalls.length === 0) return null;
  if (bashCalls.some((c) => c.bashClass && VERIFY_CLASSES.has(c.bashClass))) return null;
  return {
    tipId: "no-verify",
    evidence: { edits: s.editCalls, bash_calls: bashCalls.length },
    estSavingsTokens: NO_VERIFY_EST_TOKENS,
  };
}

// Session starts already heavy — MCP schemas / bloated CLAUDE.md tax paid
// before turn one, on every session. Threshold is high enough to absorb a
// big pasted first prompt.
/** The skill pack as a token count, spelled with its unit. `claude-md-prune`
 * talks about the same startup pack in kilo*bytes* ("CLAUDE.md is 40KB"), so a
 * bare "2.5k" next to it would read as the same unit and it is not. Below a
 * rounding floor it says "a slice" rather than "0.0k tokens", because a
 * measured-but-tiny pack is a true zero and claiming otherwise is the kind of
 * small lie that costs a coach its numbers. */
function skillShare(bytes: number): string {
  const tokens = bytes / BYTES_PER_TOKEN;
  if (tokens < SKILL_SHARE_MIN_TOKENS) return "a small slice";
  return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

function detectContextTax(s: SessionSnapshot): Finding | null {
  if (s.firstContextTokens < CONTEXT_TAX_MIN_TOKENS) return null;
  return {
    tipId: "context-tax",
    evidence: {
      pct: Math.min(100, Math.round((s.firstContextTokens / s.contextLimit) * 100)),
      first_tokens: s.firstContextTokens,
      // Attribution, not a trigger: it changes what the tip SAYS, never
      // whether it fires or what it's worth. estSavingsTokens deliberately
      // stays the whole pack — it drives which tip goes active (tips.ts), so
      // re-scoping it here would silently re-rank the coaching queue.
      // Omitted entirely when unmeasured; the catalog's `fallbacks` supplies
      // the word, which also covers rows written before this shipped.
      ...(s.skillBytes == null ? {} : { skill_k: skillShare(s.skillBytes) }),
    },
    estSavingsTokens: s.firstContextTokens - CONTEXT_TAX_BASELINE_TOKENS,
  };
}

// Wide inline exploration under context pressure, with subagents left unused.
// Only fires when the bloat actually hurt (high context or an auto-compact).
function detectSubagentOffload(s: SessionSnapshot): Finding | null {
  if (s.toolCalls.some((c) => SUBAGENT_TOOLS.has(c.name))) return null;
  const distinctReads = new Set(
    s.toolCalls.filter((c) => c.name === "Read" && c.targetHash).map((c) => c.targetHash),
  ).size;
  if (distinctReads < SUBAGENT_MIN_DISTINCT_READS) return null;
  if (s.contextPct < SUBAGENT_MIN_CONTEXT_PCT && s.autoCompacts === 0) return null;
  return {
    tipId: "subagent-offload",
    evidence: { reads: distinctReads, ctx_pct: s.contextPct },
    // No token estimate, on purpose. This used to claim
    // `(reads - 10) * 1500` tokens saved, which had the sign backwards on the
    // metered axis: delegating to a subagent COSTS more tokens than doing the
    // work inline — measured locally, the median worker spends ~69k billable
    // to hand back ~2.4k of report. What delegation actually buys is room in
    // the main window, which is what this tip's copy and its citation have
    // always said. Since est_savings_tokens ranks the coaching queue, the
    // inflated number was also winning the one active-tip slot against tips
    // with real measured savings.
    // Not re-derived into an honest number because there isn't one to derive:
    // the snapshot counts distinct read TARGETS, never their size, so any
    // replacement would be the same per-read guess wearing a new hat. The one
    // measured headroom figure we have (redZoneExcessTokens) is already spent
    // by `context-band`, and reusing it would double-count the same tokens.
    estSavingsTokens: 0,
  };
}

// --- Cross-session habit analysis (run on SessionEnd only) ---

function isTrivialSession(r: SessionRow): boolean {
  return r.tool_calls <= MODEL_FIT_MAX_TOOL_CALLS && r.tokens_out <= MODEL_FIT_MAX_OUT_TOKENS;
}

/** Pure habit rules over recent session rows. `model-fit`: a run of trivial
 * sessions on the top-tier model. Only sound as a pattern — one quick opus
 * question is fine; four in a week is a habit. */
export function analyzeHabits(rows: SessionRow[]): Finding[] {
  const findings: Finding[] = [];
  const opus = rows.filter((r) => (r.model ?? "").includes("opus"));
  const trivial = opus.filter(isTrivialSession);
  if (
    trivial.length >= MODEL_FIT_MIN_SESSIONS &&
    trivial.length / opus.length >= MODEL_FIT_MIN_TRIVIAL_RATE
  ) {
    const spend = trivial.reduce((sum, r) => sum + r.tokens_in + r.tokens_out, 0);
    findings.push({
      tipId: "model-fit",
      evidence: { n: trivial.length, tier: "opus" },
      estSavingsTokens: Math.round(0.8 * spend),
    });
  }
  return findings;
}

/** Anti-nag: skip the plan-mode tip for users whose recent habit is already
 * plan-first. Rewards the formed habit instead of re-flagging the exception. */
export function shouldSuppressPlanMode(rows: SessionRow[]): boolean {
  if (rows.length < PLAN_HABIT_MIN_SESSIONS) return false;
  const rate = rows.filter((r) => r.used_plan_mode !== 0).length / rows.length;
  return rate >= PLAN_HABIT_SUPPRESS_RATE;
}

function detectRetryRuns(calls: ToolCall[]): Finding | null {
  let runs = 0;
  let worstRun = 0;
  let worstTool = "";
  let est = 0;
  let i = 0;
  while (i < calls.length) {
    const c = calls[i]!;
    let len = 1;
    while (
      i + len < calls.length &&
      !calls[i + len]!.ok &&
      !c.ok &&
      calls[i + len]!.name === c.name &&
      calls[i + len]!.targetHash === c.targetHash
    ) {
      len += 1;
    }
    if (!c.ok && len >= RETRY_RUN_MIN) {
      runs += 1;
      est += (len - 2) * RETRY_EST_TOKENS_PER_FAIL;
      if (len > worstRun) {
        worstRun = len;
        worstTool = c.name;
      }
    }
    i += len;
  }
  if (runs === 0) return null;
  return {
    tipId: "retry-loop",
    evidence: { runs, run: worstRun, tool: worstTool },
    estSavingsTokens: est,
  };
}

function detectRereadChurn(calls: ToolCall[]): Finding | null {
  const readCounts = new Map<string, number>();
  for (const c of calls) {
    if (c.name !== "Read" || !c.targetHash) continue;
    readCounts.set(c.targetHash, (readCounts.get(c.targetHash) ?? 0) + 1);
  }
  let files = 0;
  let worst = 0;
  let est = 0;
  for (const count of readCounts.values()) {
    if (count < REREAD_MIN) continue;
    files += 1;
    worst = Math.max(worst, count);
    est += (count - 3) * REREAD_EST_TOKENS_PER_READ;
  }
  if (files === 0) return null;
  return {
    tipId: "reread-churn",
    evidence: { files, worst },
    estSavingsTokens: est,
  };
}
