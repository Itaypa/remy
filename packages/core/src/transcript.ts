import { envVar } from "./env";
import { hashPath } from "./schema";
import type { TokenUsage } from "./schema";

// Reads Claude Code transcript JSONL. Only metadata survives extraction:
// token usage, model ids, tool names, and sha256/16 hashes of tool targets.

export interface ToolCall {
  name: string;
  targetHash: string | null;
  ok: boolean;
  /** Only set for Bash calls: deterministic class of the command, derived in memory (never persisted). */
  bashClass?: BashClass;
}

export interface TranscriptStats {
  model: string | null;
  totals: TokenUsage;
  contextTokens: number;
  contextPct: number;
  /** Context size at the first main-chain assistant turn — the session's fixed startup tax. */
  firstContextTokens: number;
  usedPlanMode: boolean;
  toolCalls: ToolCall[];
  editCalls: number;
  assistantTurns: number;
  /** Mid-session prompt-cache expiries: a real idle gap (≥30 min by entry
   * timestamps) after which the next turn re-wrote a fat context at full
   * price instead of reading it from cache. */
  cacheExpiries: number;
  /** Total tokens re-written across those expiry turns. */
  cacheExpiryTokens: number;
  /** Longest idle gap among the expiries, in minutes (0 when none). */
  cacheExpiryWorstGapMinutes: number;
  /** Main-chain turns that ran with the context ≥80% full ("red zone"). */
  redZoneTurns: number;
  /** Tokens processed above the healthy 60% band across those turns — what
   * compacting at 60% would have avoided. */
  redZoneExcessTokens: number;
}

export interface ContextInfo {
  contextTokens: number;
  contextPct: number;
  model: string | null;
  limit: number;
}

export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Cache-expiry detection only fires on the unambiguous case: a real idle
 * gap (timestamps, not inference) AND a fat context re-written. Small
 * reheats after a coffee break are cheaper than /clear + re-briefing, so
 * they stay silent; other cache busts (tool-list changes, system-prompt
 * drift) have no idle gap and are excluded by the timestamp requirement. */
const CACHE_EXPIRY_MIN_GAP_MS = 30 * 60_000;
const CACHE_EXPIRY_MIN_WRITE = 100_000;

/** Red zone: a turn running with the context this full drags the whole
 * window through the model again and sits where accuracy measurably sags
 * (context rot). The healthy band tops out around 60% — the baseline the
 * excess is measured against. */
const RED_ZONE_PCT = 0.8;
const RED_ZONE_BASELINE_PCT = 0.6;

export function contextLimit(): number {
  const raw = Number(envVar("CONTEXT_LIMIT"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_LIMIT;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_TOOLS = new Set(["ExitPlanMode", "EnterPlanMode", "exit_plan_mode"]);

// Deterministic Bash command classification. The output is a closed enum —
// part of the metadata boundary: whatever the input contains, only one of
// these tokens can come out. The raw command itself is only ever hashed.
export type BashClass = "test" | "build" | "lint" | "git" | "pkg" | "run" | "read-cmd" | "other";

const TEST_RUNNERS = new Set(["jest", "vitest", "pytest", "mocha", "playwright", "cypress"]);
const LINTERS = new Set(["eslint", "ruff", "biome", "prettier", "oxlint", "flake8", "mypy", "clippy"]);
const BUILDERS = new Set(["tsc", "make", "webpack", "vite", "esbuild", "rollup", "gradle", "mvn"]);
// Reading and searching done through the shell, where Read/Grep/Glob exist:
// the output lands in the context whole — no pagination, no truncation.
const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "ls", "tree"]);
// Same word, different intent: `cat > file` writes, `find … -delete` acts.
// Any redirect at all drops the call back to "other" — a false negative is
// silence, a false positive is a wrong tip.
const NOT_A_READ = /[<>]|(^|\s)-(delete|exec|execdir|ok)(\s|$)/;

export function classifyCommand(cmd: string): BashClass {
  // First meaningful segment: strip leading `cd … &&` hops and VAR=val prefixes.
  let seg = cmd.trim();
  for (;;) {
    const m = seg.match(/^cd\s+[^&;|]*(?:&&|;)\s*/);
    if (!m) break;
    seg = seg.slice(m[0].length).trim();
  }
  const words: string[] = [];
  for (const w of seg.split(/\s+/)) {
    if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // env prefix
    words.push(w.toLowerCase());
    if (words.length >= 3) break;
  }
  const [w0 = "", w1 = "", w2 = ""] = words;

  if (w0 === "git") return "git";
  if (READ_CMDS.has(w0)) return NOT_A_READ.test(seg) ? "other" : "read-cmd";
  if (TEST_RUNNERS.has(w0)) return "test";
  if (LINTERS.has(w0)) return "lint";
  if (BUILDERS.has(w0)) return w0 === "make" && w1 === "test" ? "test" : "build";
  if (w0 === "go" || w0 === "cargo") {
    if (w1 === "test") return "test";
    if (w1 === "build" || w1 === "check") return "build";
    if (w1 === "clippy" || w1 === "fmt") return "lint";
    if (w1 === "add" || w1 === "install") return "pkg";
    return "other";
  }
  if (w0 === "npm" || w0 === "bun" || w0 === "pnpm" || w0 === "yarn" || w0 === "npx" || w0 === "bunx") {
    if (w1 === "test" || (w1 === "run" && TEST_RUNNERS.has(w2))) return "test";
    if (w1 === "i" || w1 === "install" || w1 === "add" || w1 === "ci") return "pkg";
    if (w1 === "run") {
      if (w2 === "test" || w2.startsWith("test:")) return "test";
      if (w2 === "build" || w2.startsWith("build:")) return "build";
      if (w2 === "lint" || w2 === "typecheck" || w2.startsWith("lint:")) return "lint";
      return "run";
    }
    if (TEST_RUNNERS.has(w1)) return "test"; // npx jest …
    if (LINTERS.has(w1)) return "lint";
    if (w1 === "tsc" || w1 === "build") return "build";
    return "other";
  }
  if (w0 === "pip" || w0 === "pip3" || w0 === "uv" || w0 === "poetry") return "pkg";
  return "other";
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function targetOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const raw = i.file_path ?? i.notebook_path ?? i.path ?? i.command ?? i.url ?? null;
  return typeof raw === "string" && raw.length > 0 ? hashPath(raw) : null;
}

function contextOf(u: Usage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  );
}

// After /compact there is no assistant usage until the next reply lands; the
// host writes a system compact_boundary entry whose compactMetadata.postTokens
// is the live context size. Whichever comes later in the file — assistant
// usage or boundary — is the truth.
function postCompactTokens(entry: any): number | null {
  if (entry?.type !== "system" || entry.subtype !== "compact_boundary" || entry.isSidechain) return null;
  const post = entry.compactMetadata?.postTokens;
  return typeof post === "number" && post >= 0 ? post : null;
}

export function parseTranscript(text: string, limit = contextLimit()): TranscriptStats {
  // Streaming writes repeat a message id with growing usage — keep the last.
  const usageById = new Map<string, Usage>();
  const toolOrder: Array<{ id: string; call: ToolCall }> = [];
  const toolById = new Map<string, ToolCall>();
  let model: string | null = null;
  let usedPlanMode = false;
  let contextNow: number | null = null;
  let firstContext: number | null = null;
  let assistantTurns = 0;
  // Ordered main-chain turns, for cache-expiry detection. afterCompact marks
  // the first turn after a compact boundary (its cache re-write is
  // legitimate, not an expiry). ts is the entry's own timestamp (first
  // sighting for streamed messages) — the idle-gap evidence.
  const mainTurns: Array<{ usage: Usage; model: string | null; afterCompact: boolean; ts: number | null }> = [];
  const mainTurnIndex = new Map<string, number>();
  let compactPending = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "assistant" && entry.message) {
      const msg = entry.message;
      if (msg.model && !entry.isSidechain) model = msg.model;
      if (msg.usage) {
        const id = typeof msg.id === "string" ? msg.id : `line-${usageById.size}`;
        if (!usageById.has(id)) assistantTurns += 1;
        usageById.set(id, msg.usage);
        if (!entry.isSidechain) {
          contextNow = contextOf(msg.usage);
          if (firstContext === null) firstContext = contextNow;
          const idx = mainTurnIndex.get(id);
          if (idx == null) {
            const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
            mainTurnIndex.set(id, mainTurns.length);
            mainTurns.push({
              usage: msg.usage,
              model: msg.model ?? null,
              afterCompact: compactPending,
              ts: Number.isFinite(parsed) ? parsed : null,
            });
            compactPending = false;
          } else {
            mainTurns[idx]!.usage = msg.usage; // streaming update of the same turn
          }
        }
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== "tool_use") continue;
          if (PLAN_TOOLS.has(block.name)) usedPlanMode = true;
          const call: ToolCall = {
            name: String(block.name ?? "unknown").slice(0, 64),
            targetHash: targetOf(block.input),
            ok: true,
          };
          if (call.name === "Bash" && typeof block.input?.command === "string") {
            call.bashClass = classifyCommand(block.input.command);
          }
          if (typeof block.id === "string") toolById.set(block.id, call);
          toolOrder.push({ id: String(block.id ?? ""), call });
        }
      }
    } else if (entry?.type === "user" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === "tool_result" && block.is_error === true) {
          const call = toolById.get(block.tool_use_id);
          if (call) call.ok = false;
        }
      }
    } else {
      const post = postCompactTokens(entry);
      if (post !== null) {
        contextNow = post;
        compactPending = true;
      }
    }
  }

  const totals: TokenUsage = { in: 0, out: 0, cache_read: 0, cache_write: 0 };
  for (const u of usageById.values()) {
    totals.in += u.input_tokens ?? 0;
    totals.out += u.output_tokens ?? 0;
    totals.cache_read += u.cache_read_input_tokens ?? 0;
    totals.cache_write += u.cache_creation_input_tokens ?? 0;
  }

  // Cache-expiry detection: a warm turn reads its context from cache
  // (big cache_read, small cache_creation). When an idle gap outlives the
  // cache TTL, the next turn re-WRITES the whole context — cache_creation
  // spikes while cache_read collapses. Both halves are required: the
  // OBSERVED gap (entry timestamps ≥30 min apart) attributes it to idleness
  // — tool-list changes and system-prompt drift bust the cache with no gap
  // and must not be blamed on stepping away — and the usage shape proves
  // the cache actually expired during the gap (a longer TTL may hold).
  // Post-compact turns and model switches are excluded as legitimate
  // re-writes; missing timestamps count as no gap (conservative).
  let cacheExpiries = 0;
  let cacheExpiryTokens = 0;
  let cacheExpiryWorstGapMinutes = 0;
  for (let i = 1; i < mainTurns.length; i++) {
    const t = mainTurns[i]!;
    if (t.afterCompact) continue;
    const prev = mainTurns[i - 1]!;
    if (t.model && prev.model && t.model !== prev.model) continue;
    if (t.ts == null || prev.ts == null) continue;
    const gapMs = t.ts - prev.ts;
    if (gapMs < CACHE_EXPIRY_MIN_GAP_MS) continue;
    const write = t.usage.cache_creation_input_tokens ?? 0;
    const read = t.usage.cache_read_input_tokens ?? 0;
    if (write >= CACHE_EXPIRY_MIN_WRITE && read < write * 0.25) {
      cacheExpiries += 1;
      cacheExpiryTokens += write;
      cacheExpiryWorstGapMinutes = Math.max(cacheExpiryWorstGapMinutes, Math.round(gapMs / 60_000));
    }
  }

  // Red-zone riding: turns that ran with the context ≥80% full. Each turn's
  // own usage reflects its context size, so a compact naturally ends a run —
  // no boundary bookkeeping needed. Unlike the live ≥80% alarm (act now),
  // this measures the habit after the fact.
  let redZoneTurns = 0;
  let redZoneExcessTokens = 0;
  for (const t of mainTurns) {
    const ctx = contextOf(t.usage);
    if (ctx >= limit * RED_ZONE_PCT) {
      redZoneTurns += 1;
      redZoneExcessTokens += Math.round(ctx - limit * RED_ZONE_BASELINE_PCT);
    }
  }

  const contextTokens = contextNow ?? 0;
  const toolCalls = toolOrder.map((t) => t.call);
  return {
    model,
    totals,
    contextTokens,
    contextPct: Math.min(100, Math.round((contextTokens / limit) * 100)),
    firstContextTokens: firstContext ?? 0,
    usedPlanMode,
    toolCalls,
    editCalls: toolCalls.filter((t) => EDIT_TOOLS.has(t.name)).length,
    assistantTurns,
    cacheExpiries,
    cacheExpiryTokens,
    cacheExpiryWorstGapMinutes,
    redZoneTurns,
    redZoneExcessTokens,
  };
}

export async function parseTranscriptFile(
  path: string,
  limit = contextLimit(),
): Promise<TranscriptStats | null> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return parseTranscript(await f.text(), limit);
  } catch {
    return null;
  }
}

/** Fast path for the statusline: only the last main-chain assistant usage, read from the file tail. */
export async function tailContext(path: string, limit = contextLimit()): Promise<ContextInfo | null> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    const size = f.size;
    const start = Math.max(0, size - 262_144);
    let text = await f.slice(start, size).text();
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    const info = (contextTokens: number, model: string | null): ContextInfo => ({
      contextTokens,
      contextPct: Math.min(100, Math.round((contextTokens / limit) * 100)),
      model,
      limit,
    });
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !(line.includes('"assistant"') || line.includes('"compact_boundary"'))) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "assistant" && entry.message?.usage && !entry.isSidechain) {
          return info(contextOf(entry.message.usage), entry.message.model ?? null);
        }
        const post = postCompactTokens(entry);
        if (post !== null) return info(post, null);
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Statusline fast path: the host already computed context size for us in
 * the `context_window` field of the statusLine payload — no need to tail the
 * transcript file at all. Returns null when the fields are absent (older
 * hosts), which is the version-compatibility fallback: callers fall back to
 * tailContext.
 *
 * Deliberately sums total_input_tokens + total_output_tokens rather than
 * using the host's own `used_percentage` — that field excludes output
 * tokens, while every other context number in this codebase (contextOf())
 * includes them. Using it would silently disagree with the rest of the app. */
export function contextFromPayload(payload: unknown): ContextInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const cw = (payload as any).context_window;
  if (!cw || typeof cw !== "object") return null;
  const { total_input_tokens: inTok, total_output_tokens: outTok, context_window_size: limit } = cw;
  if (![inTok, outTok, limit].every((n) => typeof n === "number" && Number.isFinite(n)) || limit <= 0) {
    return null;
  }
  const contextTokens = inTok + outTok;
  const model = (payload as any).model?.id;
  return {
    contextTokens,
    contextPct: Math.min(100, Math.round((contextTokens / limit) * 100)),
    model: typeof model === "string" ? model : null,
    limit,
  };
}
