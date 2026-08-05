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
  /** `Read` results big enough to be whole files rather than the slice that
   * was asked for, the tokens they carried, and the worst single one. */
  fatReads: number;
  fatReadTokens: number;
  fatReadWorstTokens: number;
  /** Hashed targets of those reads, so the rules engine can tell a whole-file
   * read apart from a file `reread-churn` is already billing. */
  fatReadTargets: string[];
  /** Reasoning-effort mix across main-chain turns, as counts only — never the
   * value itself, so no new enum reaches the storage whitelist. `effortTurns`
   * is every turn that declared one, so a gap between it and max+high is how
   * we learn a `low`/`medium` value has appeared in the wild. */
  effortTurns: number;
  effortMaxTurns: number;
  effortHighTurns: number;
  effortMaxOutTokens: number;
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
/** Characters per token, for sizing a tool result. The same rough divisor the
 * rules engine uses for CLAUDE.md and the skill pack — good enough to tell a
 * slice from a whole file, which is the only question asked of it. */
const BYTES_PER_TOKEN = 4;
/** A single `Read` result this big is a whole file, not the part you asked
 * for. Local `Read` results sit at a p50 of ~2,200 characters, so this is far
 * above ordinary use, and far below the fat tail (p95 ~118k characters). */
const FAT_READ_TOKENS = 8_000;
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

/** Turns the host writes with no model behind them — placeholder entries that
 * carry zero usage. They are not a model anyone chose and must never win an
 * attribution. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Which model actually did this session's work, weighted by the output tokens
 * it produced.
 *
 * The obvious reading — "whatever model the last assistant turn used" — is
 * what this replaces, and it is wrong in a way that matters: sessions switch
 * models mid-flight (one local session ran 1,091 sonnet turns, 183 fable and
 * 40 opus, and recorded a single value), and `sessions.model` is what the
 * cross-session habit rules reason over. Under last-seen, one closing question
 * on the top tier relabels an entire sonnet session as an opus session, and
 * `model-fit` then attributes all of its tokens to opus.
 *
 * Output tokens rather than turn count or input tokens: it is the work the
 * model actually did. Turn count would let a burst of one-line answers outvote
 * an hour of generation, and input tokens mostly measure how big the context
 * had grown by then, which is the same for whichever model is in the chair.
 * Falls back to turn count when nothing produced output (a session of empty or
 * synthetic turns), and returns null when there is nothing to go on at all —
 * the caller keeps its previous last-seen value rather than inventing one. */
function dominantModel(turns: Array<{ usage: Usage; model: string | null }>): string | null {
  const byOut = new Map<string, number>();
  const byTurns = new Map<string, number>();
  for (const t of turns) {
    if (!t.model || t.model === SYNTHETIC_MODEL) continue;
    byOut.set(t.model, (byOut.get(t.model) ?? 0) + (t.usage?.output_tokens ?? 0));
    byTurns.set(t.model, (byTurns.get(t.model) ?? 0) + 1);
  }
  if (byTurns.size === 0) return null;
  const rank = [...byOut.values()].some((n) => n > 0) ? byOut : byTurns;
  let best: string | null = null;
  let bestN = -1;
  for (const [m, n] of rank) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

export function parseTranscript(text: string, limit = contextLimit()): TranscriptStats {
  // Streaming writes repeat a message id with growing usage — keep the last.
  const usageById = new Map<string, Usage>();
  const toolOrder: Array<{ id: string; call: ToolCall }> = [];
  const toolById = new Map<string, ToolCall>();
  let model: string | null = null;
  let usedPlanMode = false;
  let fatReads = 0;
  let fatReadTokens = 0;
  let fatReadWorstTokens = 0;
  const fatReadTargetSet = new Set<string>();
  let effortTurns = 0;
  let effortMaxTurns = 0;
  let effortHighTurns = 0;
  let effortMaxOutTokens = 0;
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
            // Reasoning effort rides on the ENTRY, not inside message.usage —
            // which is why an earlier review concluded it was unobservable
            // after enumerating only the usage keys. Counted here, never
            // stored as a string.
            if (typeof entry.effort === "string" && entry.effort !== "") {
              effortTurns += 1;
              if (entry.effort === "max") {
                effortMaxTurns += 1;
                effortMaxOutTokens += msg.usage.output_tokens ?? 0;
              } else if (entry.effort === "high") {
                effortHighTurns += 1;
              }
            }
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
        if (block?.type !== "tool_result") continue;
        const call = toolById.get(block.tool_use_id);
        if (block.is_error === true) {
          if (call) call.ok = false;
        }
        // How big the result was — a number, never the result itself. A whole
        // file arriving where a slice was asked for is the largest tool-shaped
        // waste in the local corpus: `Read` results run to 471k characters,
        // about 118k tokens, which the window then carries for every turn
        // after. Scoped to Read on purpose; the browser MCP's results are
        // base64 images, enormous and not a user's choice.
        if (call?.name === "Read") {
          const len =
            typeof block.content === "string"
              ? block.content.length
              : block.content == null
                ? 0
                : JSON.stringify(block.content).length;
          const tokens = Math.round(len / BYTES_PER_TOKEN);
          if (tokens >= FAT_READ_TOKENS) {
            fatReads += 1;
            fatReadTokens += tokens;
            if (tokens > fatReadWorstTokens) fatReadWorstTokens = tokens;
            if (call.targetHash) fatReadTargetSet.add(call.targetHash);
          }
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
  // Host bookkeeping is not a request, and leaving it in this walk did two
  // kinds of damage. A `<synthetic>` or zero-usage turn landing inside an idle
  // gap split one long gap into two sub-threshold halves, so the expiry went
  // unseen; and `<synthetic>` standing in as `prev.model` tripped the
  // model-switch guard below, skipping the turn outright. `dominantModel`
  // already excludes these turns — this walk did not.
  // Measured on the local corpus: 15 firings over 5.48M tokens becomes 17 over
  // 6.00M (+9.4%), with nothing lost, and two sessions that were silent — one
  // with a 1,361-minute gap — become coached.
  const cacheTurns = mainTurns.filter((t) => t.model !== SYNTHETIC_MODEL && contextOf(t.usage) > 0);
  for (let i = 1; i < cacheTurns.length; i++) {
    const t = cacheTurns[i]!;
    if (t.afterCompact) continue;
    const prev = cacheTurns[i - 1]!;
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
    model: dominantModel(mainTurns) ?? model,
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
    fatReads,
    fatReadTokens,
    fatReadWorstTokens,
    fatReadTargets: [...fatReadTargetSet],
    effortTurns,
    effortMaxTurns,
    effortHighTurns,
    effortMaxOutTokens,
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
