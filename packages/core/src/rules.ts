import type { ToolCall } from "./transcript";
import type { SessionRow } from "./store";
import { ModelStr, ToolNameStr } from "./schema";

// Waste signatures. Deterministic — no model calls in the analysis path.
// Savings estimates are deliberately rough heuristics; every rendered number
// is prefixed with "~" by the UI layer.

/** What a finding's tokens actually cost, as a multiple of the base input
 * price — the thing that turns a raw count into money.
 *
 * This exists because a bare token number is not comparable across tips and
 * was therefore misleading in both directions. Measured on real local data,
 * **99% of a session's tokens are cache reads**, billed at a tenth; so
 * `context-band` reporting 28.7M "recoverable" tokens was overstating its
 * dollar value by roughly 10× while `edit-thrash` — the tip that can name a
 * file and an action — reported 55k and lost the queue. Since `promoteNext`
 * ranks by this number, the unit error decided which tip a developer saw.
 *
 * Only two classes are claimed on measurement; everything else is `input`,
 * the neutral middle, because those estimates are per-event heuristics and
 * pretending to know their price class would be a second invented number. */
export type EstClass =
  /** 0.1× — context dragged through the window again, never re-sent fresh. */
  | "cache-read"
  /** 1× — fresh tokens that need not have entered the window at all. */
  | "input"
  /** 1.9× — re-written at the 2× cold-cache price where a warm read cost 0.1×. */
  | "cold-write";

export const EST_WEIGHT: Record<EstClass, number> = {
  "cache-read": 0.1,
  input: 1,
  "cold-write": 1.9,
};

/** Base-input-equivalent tokens: the estimate priced by its class. This is the
 * only figure that may be compared between tips, ranked, or turned into money. */
export function effectiveTokens(estTokens: number, estClass: EstClass): number {
  if (!Number.isFinite(estTokens) || estTokens <= 0) return 0;
  return Math.round(estTokens * (EST_WEIGHT[estClass] ?? 1));
}

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
  /** Every main-chain assistant turn — the denominator that makes redZoneTurns
   * mean something ("95 of 210" reads very differently from "95"). */
  assistantTurns?: number;
  /** Highest context any turn reached, as a percentage. `contextPct` is the
   * size at the end; this is the peak, which is what the developer saw. */
  maxContextPct?: number;
  /** Bytes of CLAUDE.md memory the host loads for this cwd (claudemd.ts).
   * null = never probed — the rules stay silent rather than guess. */
  claudeMdBytes: number | null;
  /** `Read` results that arrived as whole files rather than the slice asked
   * for (transcript.ts). Optional: a caller without them gets no such tip. */
  fatReads?: number;
  fatReadTokens?: number;
  fatReadWorstTokens?: number;
  fatReadTargets?: string[];
  /** Hashed target of the biggest one, so `read-in-slices` can name the file. */
  fatReadWorstTarget?: string | null;
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
  /** Price class of `estSavingsTokens`. Required, so a new rule cannot quietly
   * inherit a class it never thought about. */
  estClass: EstClass;
}

/** Findings are ordered — and therefore promoted to the one active-tip slot —
 * by what they are worth, not by how many raw tokens they name. */
export function findingValue(f: Finding): number {
  return effectiveTokens(f.estSavingsTokens, f.estClass);
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
const CONTEXT_TAX_MIN_TOKENS = 45_000;
/** Below this the skill pack rounds to "0.0k tokens", which reads as a
 * measurement error rather than a small number — say it in words instead. */
const SKILL_SHARE_MIN_TOKENS = 100;
/** A single Read result at or above this is a whole file, not a slice — the
 * same floor transcript.ts counts on. Local Read results sit at a p50 of
 * ~550 tokens, so ordinary reads never reach it. */
const FAT_READ_TOKENS = 8_000;
/** One big file is often exactly what was needed. Three in a session is a
 * habit with a lever, which is the same floor `reread-churn` uses. */
const FAT_READ_MIN = 3;
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
/** The built-in tools that read a file properly, for `tools-over-bash`'s contrast. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

// --- Evidence helpers -------------------------------------------------------
//
// Everything below produces a value a rule puts in `Finding.evidence`, which is
// JSON-stringified straight into the `tips` table without passing through the
// zod whitelist. Values built from OUR OWN counts are safe by construction;
// the two that come from outside — a tool name off the transcript and a model
// id off the host — are gated here with the same schemas the store uses.

/** A tool name is transcript-derived (`block.name`), so it is the one evidence
 * string an exotic MCP server could steer. Gate it rather than trust it. */
function safeToolName(name: string): string {
  return ToolNameStr.safeParse(name).data ?? "the same tool";
}

/** `claude-opus-5[1m]` → `opus-5[1m]`. Gated first for the same reason. */
function safeShortModel(id: string | null | undefined): string {
  const ok = ModelStr.safeParse(id ?? "").data;
  return ok ? ok.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "the top-tier model";
}

/** A token count with its unit attached, so a template never concatenates a
 * suffix onto something that may have fallen back to a word. */
function kTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "the whole context";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`;
}

/** "1333 min" is 22 hours, and nobody converts that in their head. Minutes
 * below an hour stay minutes; past that it reads in hours. */
export function humanGap(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "a moment";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

/** A count with a noun that agrees with it. Every "{n} files" in a template is
 * a latent "1 files" — the copy cannot know the number, so the rule composes
 * the phrase and the template just places it. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? `one ${one}` : `${n} ${many}`;
}

/** Plural-safe by construction: the caller names the worst offender, and this
 * says what — if anything — was behind it. The old copy read "1 files … one of
 * them 4×", which is the sort of thing that makes a coach look broken. */
function othersClause(files: number, tail: string): string {
  if (files <= 1) return "nothing new any of those times";
  return `and ${plural(files - 1, "other file", "other files")} ${tail}`;
}

/** "9 git, 4 file reads" — what the shell was actually doing. `no-verify`
 * already inspects every Bash class to prove none is a test; this reports the
 * proof instead of discarding it. */
/** Singular and plural, because "1 file reads" is the same defect as "1 files". */
const BASH_CLASS_LABEL: Record<string, [string, string]> = {
  git: ["git call", "git"],
  pkg: ["package call", "package"],
  run: ["run", "runs"],
  "read-cmd": ["file read", "file reads"],
  test: ["test", "tests"],
  build: ["build", "builds"],
  lint: ["lint", "lints"],
  other: ["other", "other"],
};

function bashMix(calls: ToolCall[], top = 2): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    if (c.name !== "Bash") continue;
    const key = c.bashClass ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // "15 other" names nothing the developer can picture, and on real sessions it
  // is usually the largest bucket — so it would crowd out the classes that do
  // mean something. Kept only when it is all there is.
  const named = [...counts.entries()].filter(([k]) => k !== "other");
  const parts = (named.length > 0 ? named : [...counts.entries()])
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([key, n]) => {
      const [one, many] = BASH_CLASS_LABEL[key] ?? BASH_CLASS_LABEL.other!;
      return `${n} ${n === 1 ? one : many}`;
    });
  return parts.length > 0 ? parts.join(", ") : "no shell calls";
}

/** The tool the session leaned on hardest — a recognizable anchor for rules
 * that otherwise only have totals to report. */
function topTool(calls: ToolCall[]): { name: string; n: number } {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  let best = { name: "", n: 0 };
  for (const [name, n] of counts) if (n > best.n) best = { name, n };
  return { name: safeToolName(best.name || "tool"), n: best.n };
}

export function analyzeSession(s: SessionSnapshot): Finding[] {
  const findings: Finding[] = [];

  if (s.autoCompacts > 0) {
    findings.push({
      tipId: "auto-compact",
      evidence: {
        count: s.autoCompacts,
        peak_pct: s.maxContextPct ?? s.contextPct,
        window_k: Math.round(s.contextLimit / 1000),
      },
      estSavingsTokens: s.autoCompacts * Math.round(s.contextLimit * 0.3),
      estClass: "input",
    });
  }

  if (
    !s.usedPlanMode &&
    s.toolCalls.length >= LONG_SESSION_TOOL_CALLS &&
    s.editCalls >= LONG_SESSION_EDITS
  ) {
    const top = topTool(s.toolCalls);
    findings.push({
      tipId: "plan-mode",
      evidence: {
        tool_calls: s.toolCalls.length,
        edits: s.editCalls,
        top_tool: top.name,
        top_tool_n: top.n,
      },
      estSavingsTokens: Math.max(10_000, Math.round(s.spendTokens * 0.15)),
      estClass: "input",
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

  // Yields to `reread-churn`: that rule already bills repeated reads of one
  // file, and charging the same bytes again under a second id is the double-
  // nag `applyClaudeMd` was written to avoid.
  const fat = detectFatReads(s);
  if (fat) findings.push(fat);

  applyClaudeMd(s, findings);

  // By worth, not by raw token count — see EstClass.
  return findings.sort((a, b) => findingValue(b) - findingValue(a));
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
      estClass: reread!.estClass,
    });
    return;
  }

  if (bytes < CLAUDE_MD_BLOAT_BYTES) return;
  if (findings.some((f) => f.tipId === "context-tax")) return;
  findings.push({
    tipId: "claude-md-prune",
    evidence: {
      kb: Math.round(bytes / 1000),
      md_tokens: kTokens(bytes / BYTES_PER_TOKEN),
    },
    estSavingsTokens: Math.round((bytes - CLAUDE_MD_TARGET_BYTES) / BYTES_PER_TOKEN),
    estClass: "input",
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
  // The denominators are what make this recognizable: "58 reads went through
  // the shell" is a number about nothing, "58 of your 420 Bash calls, against
  // 132 real Read/Grep calls" is a habit the developer can picture.
  const bashTotal = s.toolCalls.filter((c) => c.name === "Bash").length;
  const toolReads = s.toolCalls.filter((c) => READ_TOOLS.has(c.name)).length;
  return {
    tipId: "tools-over-bash",
    evidence: { count: shellReads, bash_total: bashTotal, tool_reads: toolReads },
    estSavingsTokens: (shellReads - BASH_READ_FREE) * BASH_READ_EST_TOKENS,
    estClass: "input",
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
    evidence: {
      turns: s.redZoneTurns,
      // Denominator and peak. Without them "95 replies" is unanswerable —
      // 95 out of how many, and how bad did it actually get?
      total_turns: Math.max(s.assistantTurns ?? 0, s.redZoneTurns),
      peak_pct: s.maxContextPct ?? s.contextPct,
    },
    estSavingsTokens: s.redZoneExcessTokens,
    // Measured, not assumed: redZoneExcessTokens is a sum of per-turn CONTEXT
    // sizes, and a context that is already in the window is re-sent as a cache
    // read at a tenth of the input price. Billing it at 1× is what produced the
    // "+219M 🪙" headline — a real measurement in a unit that made it a lie.
    estClass: "cache-read",
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
    evidence: {
      count: s.cacheExpiries,
      mins: s.cacheExpiryWorstGapMinutes,
      gap: humanGap(s.cacheExpiryWorstGapMinutes),
      // Pre-formatted with its unit so the template never has to glue "k" onto
      // a value that might have fallen back to a word.
      ctx: kTokens(s.cacheExpiryTokens / Math.max(1, s.cacheExpiries)),
    },
    // The raw re-written count. The 0.9 that used to sit here was the
    // difference between the cold and warm price expressed as a fudge on the
    // token count; that belongs in the price class, where it can be stated
    // once and applied consistently.
    estSavingsTokens: s.cacheExpiryTokens,
    estClass: "cold-write",
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
  // The hash of the worst offender and its re-read count were both computed
  // here and then discarded, which is why this tip could only ever say "one
  // file". They are the whole story: a name and the rework cycle around it.
  let worstHash: string | null = null;
  for (const [hash, count] of edits) {
    if (count < EDIT_THRASH_MIN_EDITS) continue;
    if ((rereads.get(hash) ?? 0) < EDIT_THRASH_MIN_CYCLES) continue;
    files += 1;
    if (count > worstEdits) {
      worstEdits = count;
      worstHash = hash;
    }
  }
  if (files === 0) return null;
  return {
    tipId: "edit-thrash",
    evidence: {
      files,
      edits: worstEdits,
      rereads: rereads.get(worstHash ?? "") ?? 0,
      next: worstEdits + 1,
      ...(worstHash ? { file_hash: worstHash } : {}),
    },
    estSavingsTokens: (worstEdits - 3) * EDIT_THRASH_EST_TOKENS_PER_EDIT,
    estClass: "input",
  };
}

// Edits shipped without a verify pass. Requires at least one Bash call so
// sessions where the shell was never usable (sandboxed hosts) never fire.
function detectNoVerify(s: SessionSnapshot): Finding | null {
  if (s.editCalls < NO_VERIFY_MIN_EDITS) return null;
  const bashCalls = s.toolCalls.filter((c) => c.name === "Bash");
  if (bashCalls.length === 0) return null;
  if (bashCalls.some((c) => c.bashClass && VERIFY_CLASSES.has(c.bashClass))) return null;
  const editedFiles = new Set(
    s.toolCalls.filter((c) => EDIT_TOOLS.has(c.name) && c.targetHash).map((c) => c.targetHash),
  ).size;
  return {
    tipId: "no-verify",
    evidence: {
      edits: s.editCalls,
      files: editedFiles,
      bash_calls: bashCalls.length,
      // Pre-composed: a session can legitimately edit one file and make one
      // shell call, so "{files} files" and "{bash_calls} shell runs" are both
      // a "1 files" waiting to happen.
      scope: plural(editedFiles, "file", "files"),
      shell: plural(bashCalls.length, "shell run", "shell runs"),
      // The rule inspected every one of these classes to prove none is a test,
      // build or lint. Reporting the proof is strictly more useful than
      // reporting only the conclusion.
      bash_mix: bashMix(bashCalls),
    },
    // Zero, deliberately. This was a flat 10,000 — a constant, identical for a
    // 4-edit session and a 400-edit one, that no measurement produced. There is
    // no honest token figure here because skipping a verify pass does not spend
    // tokens, it ships bugs; the catalog's `worth` line says exactly that.
    estSavingsTokens: 0,
    estClass: "input",
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
      first_ctx: kTokens(s.firstContextTokens),
      // Attribution, not a trigger: it changes what the tip SAYS, never
      // whether it fires or what it's worth. estSavingsTokens deliberately
      // stays the whole pack — it drives which tip goes active (tips.ts), so
      // re-scoping it here would silently re-rank the coaching queue.
      // Omitted entirely when unmeasured; the catalog's `fallbacks` supplies
      // the word, which also covers rows written before this shipped.
      ...(s.skillBytes == null ? {} : { skill_k: skillShare(s.skillBytes) }),
    },
    estSavingsTokens: s.firstContextTokens - CONTEXT_TAX_BASELINE_TOKENS,
    estClass: "input",
  };
}

/** Targets `reread-churn` would fire on: files read at least REREAD_MIN times. */
function rereadOffenders(calls: ToolCall[]): Set<string> {
  const byTarget = new Map<string, number>();
  for (const c of calls) {
    if (c.name !== "Read" || !c.targetHash) continue;
    byTarget.set(c.targetHash, (byTarget.get(c.targetHash) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [t, n] of byTarget) if (n >= REREAD_MIN) out.add(t);
  return out;
}

// Whole files arriving where a slice was asked for. The window then carries
// them for every turn that follows, which is why this is measured on the
// RESULT rather than on the call: asking to read a file is not a mistake,
// getting 118k tokens back for it is.
function detectFatReads(s: SessionSnapshot): Finding | null {
  const count = s.fatReads ?? 0;
  if (count < FAT_READ_MIN) return null;
  // Yield only when EVERY oversized read was of a file `reread-churn` is
  // already billing — then it is the same bytes under two names. Yielding on
  // any overlap would be far too eager: measured on the local corpus, the
  // session with the largest whole-file waste (914k tokens across 17 reads)
  // also trips reread-churn for 2k, and a blanket yield traded the 772k
  // finding for the 2k one.
  const targets = s.fatReadTargets ?? [];
  if (targets.length > 0 && targets.every((t) => rereadOffenders(s.toolCalls).has(t))) return null;
  const total = s.fatReadTokens ?? 0;
  const worst = s.fatReadWorstTokens ?? 0;
  return {
    tipId: "read-in-slices",
    evidence: {
      count,
      worst_k: Math.round(worst / 1_000),
      total_k: Math.round(total / 1_000),
      ...(s.fatReadWorstTarget ? { file_hash: s.fatReadWorstTarget } : {}),
    },
    // Only the excess over a bounded read, and only charged once: the window
    // re-reads it at cache price thereafter, so claiming the full amount every
    // turn would be the inflated-estimate mistake `subagent-offload` just had
    // corrected.
    estSavingsTokens: Math.max(0, Math.round((total - count * FAT_READ_TOKENS) * 0.9)),
    estClass: "input",
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
    // The peak under the existing key rather than a new one: `contextPct` is
    // the size at the END of the session, and the developer's memory is of the
    // worst it got. Improving the value in place needs no fallback and no
    // migration — every row already written carries this key.
    evidence: { reads: distinctReads, ctx_pct: s.maxContextPct ?? s.contextPct },
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
    estClass: "input",
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
      evidence: {
        n: trivial.length,
        total: rows.length,
        // The real id, not the literal "opus". The rows were matched on
        // `.includes("opus")` and the actual model then thrown away, so the tip
        // named a tier the developer never types instead of the model they
        // picked. `tier` stays for rows written before this shipped.
        model: safeShortModel(trivial[0]?.model),
        tier: "opus",
      },
      estSavingsTokens: Math.round(0.8 * spend),
      estClass: "input",
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
  let worstHash: string | null = null;
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
        // A retry run is keyed on the same target, so the run HAS a file —
        // it was matched on and then dropped.
        worstHash = c.targetHash;
      }
    }
    i += len;
  }
  if (runs === 0) return null;
  return {
    tipId: "retry-loop",
    evidence: {
      runs,
      run: worstRun,
      tool: safeToolName(worstTool),
      ...(worstHash ? { file_hash: worstHash } : {}),
    },
    estSavingsTokens: est,
    estClass: "input",
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
  let worstHash: string | null = null;
  let est = 0;
  for (const [hash, count] of readCounts) {
    if (count < REREAD_MIN) continue;
    files += 1;
    if (count > worst) {
      worst = count;
      worstHash = hash;
    }
    est += (count - 3) * REREAD_EST_TOKENS_PER_READ;
  }
  if (files === 0) return null;
  return {
    tipId: "reread-churn",
    evidence: {
      files,
      worst,
      // Pre-composed rather than left to the template, which is how "1 files
      // … one of them 4×" shipped: a count and a plural noun in the same
      // sentence will eventually meet a 1.
      more: othersClause(files, "went the same way"),
      ...(worstHash ? { file_hash: worstHash } : {}),
    },
    estSavingsTokens: est,
    estClass: "input",
  };
}
