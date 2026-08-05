import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// What the delegated workers spent.
//
// REMY's token totals come from the main transcript, and for a long time that
// was the whole story: subagent turns arrived inline, flagged `isSidechain`.
// They don't any more. On host 2.1.220 every one of the 14,858 entries across
// this developer's 27 transcripts is `isSidechain:false` — the workers moved
// to their own tree, `<transcript dir>/<session-id>/subagents/agent-<id>.jsonl`,
// which nothing here had ever read. So the sidechain exclusions in
// transcript.ts never fire, and every delegated token was simply missing:
// 15.1% of all local billable tokens, and 55.7% of the worst session.
//
// That gap also made the numbers on one screen disagree, which is the part a
// coaching product cannot afford: `tool_calls` comes from hooks and counts
// subagents, tokens came from the transcript parse and didn't, `cost_usd`
// comes from the host and does.
//
// Two deliberate refusals:
//
// 1. This never opens the `agent-<id>.meta.json` sitting next to each
//    transcript. It carries `description` — the task prompt, free text — and
//    the `model` field we might have wanted from it is unset on 24 of 44 local
//    agents anyway. Not opening a file is a stronger guarantee than parsing it
//    carefully, and the worker's tier is more reliably read from its own turns.
// 2. Nothing here is rendered or ruled on. It collects; what to *show* is a
//    decision for someone awake, because every existing threshold in rules.ts
//    was calibrated against main-chain-only numbers.
//
// Privacy: paths go in, integers and one model id come out.

/** The host caps subagents per session at 200 by default
 * (CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION), so this is its ceiling, not ours —
 * a directory with more than this has something wrong with it and is not worth
 * a syscall storm inside a hook. */
const MAX_AGENT_FILES = 200;

export interface SubagentStats {
  /** Worker transcripts found. 0 is a real answer: the directory existed and
   * was empty. The *absence* of the directory is null, not zero. */
  agents: number;
  tokensIn: number;
  tokensOut: number;
  cacheWrite: number;
  /** tool_use blocks across every worker — the delegated tool calls that
   * `sessions.tool_calls` has been counting all along without saying so. */
  tools: number;
  /** Dominant worker tier by output tokens, read from the workers' own turns.
   * null when no worker declared a model. */
  topModel: string | null;
}

interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Usage for this session's delegated workers, or null when the session has no
 * `subagents/` directory — an older host, or a session that never delegated
 * through a version that wrote one. Null and zero mean different things and
 * the caller is expected to keep them apart. Never throws. */
export function readSubagentStats(transcriptPath: string, sessionId: string): SubagentStats | null {
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string") return null;
  if (transcriptPath === "" || sessionId === "") return null;

  const dir = join(dirname(transcriptPath), sessionId, "subagents");
  let files: string[];
  try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
    // Globbing `agent-*.jsonl` rather than walking: if the host ever nests
    // workers under a per-parent directory, this quietly finds fewer of them
    // instead of becoming wrong in the loud direction.
    files = readdirSync(dir)
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
      .slice(0, MAX_AGENT_FILES);
  } catch {
    return null;
  }

  const stats: SubagentStats = { agents: 0, tokensIn: 0, tokensOut: 0, cacheWrite: 0, tools: 0, topModel: null };
  // Streaming writes repeat a message id with growing usage, so the last one
  // wins — the same rule parseTranscript uses. Ids are unique per message, so
  // one map across every worker is both correct and cheaper than one each.
  const usageById = new Map<string, AgentUsage>();
  const modelById = new Map<string, string>();

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue; // unreadable worker — count the others
    }
    stats.agents += 1;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a half-written last line is normal on a live session
      }
      if (entry?.type !== "assistant" || !entry.message) continue;
      const msg = entry.message;
      const id = typeof msg.id === "string" ? msg.id : `${file}-${usageById.size}`;
      if (msg.usage) {
        usageById.set(id, msg.usage);
        if (typeof msg.model === "string") modelById.set(id, msg.model);
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) if (block?.type === "tool_use") stats.tools += 1;
      }
    }
  }

  const outByModel = new Map<string, number>();
  for (const [id, u] of usageById) {
    const out = u.output_tokens ?? 0;
    stats.tokensIn += u.input_tokens ?? 0;
    stats.tokensOut += out;
    stats.cacheWrite += u.cache_creation_input_tokens ?? 0;
    const m = modelById.get(id);
    if (m) outByModel.set(m, (outByModel.get(m) ?? 0) + out);
  }

  // Same tie-break as the main chain's attribution: the tier that produced the
  // most output did the work.
  let bestN = -1;
  for (const [m, n] of outByModel) {
    if (n > bestN) {
      stats.topModel = m;
      bestN = n;
    }
  }
  return stats;
}
