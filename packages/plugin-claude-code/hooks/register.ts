import type { EngineInterface, Register } from "claude-code";

// REMY's sensor — the one piece of REMY that runs INSIDE Claude Code rather
// than beside it. It reads one thing the hooks and the statusline can never
// see: the context window broken down by category, the way /context draws it
// (which MCP server's schemas weigh what, how big the memory files and skill
// listings are). It then hands those NUMBERS to the `remy` binary over a local
// pipe, where the same whitelist that gates every hook event decides what is
// stored. The mod itself keeps nothing, shows nothing, and calls no model:
// coaching stays with the Stop hook and the noise budget it enforces.
//
// Everything here is best effort. A host without function hooks never loads
// this file; a host whose breakdown shape has moved sends nothing; a failure
// anywhere is swallowed, because a sensor that could ever cost the person a
// turn is worse than no sensor.

/** Report on the first completed turn (the window has its first response by
 * then) and every tenth after — schemas load on demand, so the picture moves. */
const EVERY_TURNS = 10;

/** `mcp__linear__create_issue` → `linear`: the segment the host spells the
 * server into every tool name. Hashing THIS on the other side is what lets the
 * binary join "configured" (here) to "called" (its own tool events). */
function wireSegment(toolName: string, fallback: string): string {
  return toolName.match(/^mcp__(.+?)__/)?.[1] ?? fallback;
}

export const register: Register = (on) => {
  let turns = 0;

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    turns += 1;
    if (turns === 1 || turns % EVERY_TURNS === 0) {
      try {
        await report($);
      } catch {
        // never let a sensor cost a turn
      }
    }
    return result;
  });
};

async function report($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: "summary" });
  const b = usage?.context?.breakdown;
  if (!b) return;

  const byServer = new Map<string, { tools: number; loaded_tools: number; tokens: number }>();
  for (const t of b.mcpTools ?? []) {
    const server = wireSegment(String(t.name ?? ""), String(t.serverName ?? ""));
    if (!server) continue;
    const cur = byServer.get(server) ?? { tools: 0, loaded_tools: 0, tokens: 0 };
    cur.tools += 1;
    if (t.isLoaded) {
      cur.loaded_tools += 1;
      cur.tokens += Math.max(0, Math.round(Number(t.tokens) || 0));
    }
    byServer.set(server, cur);
  }

  // The rows /context prints, matched on their labels. `kind` only tells
  // used from free, so the label is the one handle there is; a row we do
  // not recognise simply contributes nothing.
  const category = (needle: RegExp): number => {
    const row = (b.categories ?? []).find((c) => c.kind === "used" && needle.test(c.name));
    return Math.max(0, Math.round(Number(row?.tokens) || 0));
  };
  const sum = (rows: ReadonlyArray<{ tokens: number }> | undefined): number =>
    Math.max(0, Math.round((rows ?? []).reduce((a, r) => a + (Number(r.tokens) || 0), 0)));

  const payload = {
    hook_event_name: "ContextProfile",
    session_id: await $.session.id(),
    window: Math.max(0, Math.round(Number(b.rawMaxTokens) || 0)),
    system_prompt_tokens: category(/^system prompt/i),
    system_tools_tokens: category(/^system tools/i),
    memory_tokens: sum(b.memoryFiles),
    skills_tokens: Math.max(0, Math.round(Number(b.skills?.tokens) || 0)),
    agents_tokens: sum(b.agents),
    messages_tokens: category(/^messages/i),
    mcp: [...byServer.entries()].map(([server, m]) => ({ server, ...m })),
  };

  // The binary's own launcher, the same one every classic hook runs; it
  // hashes the server names before the whitelist sees them. Five seconds is
  // generous — ingest takes tens of milliseconds — and a timeout is silent.
  await $.process.run([`${$.plugin.root}/bin/remy`, "ingest"], {
    stdin: JSON.stringify(payload),
    timeoutMs: 5_000,
  });
}
