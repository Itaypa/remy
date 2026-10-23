# S22 — An MCP server you never called

**Status: shipped 2026-10-23** (v0.4.0), tip `mcp-idle`. Unparks trend-watch F1 and
backlog S19's "configured half".

## The mistake

A connected MCP server parks its tool schemas in the window on every turn, whether or not
the session ever calls it. `context-tax` could say "your pack is heavy" but not which
server, because nothing REMY had could see the window by category.

## The probe: a sensor mod

Claude Code's function hooks let a plugin run a module inside the host.
`packages/plugin-claude-code/hooks/register.ts` hooks `turn.complete`, and on the first
turn and every tenth after calls `$.session.usage({ breakdown: "summary" })` — `/context`
as data: per-MCP-tool schema tokens with the server and an `isLoaded` flag, memory files,
skills, agents, categories. It pipes the numbers into `remy ingest` as a `ContextProfile`
payload; server names travel as the wire segment of the tool name (`mcp__<server>__…`)
and are hashed at ingest. The mod stores, draws and calls nothing else — asserted in
`privacy.test.ts`. `"summary"` is local estimation; `"full"` (token-count API calls) is
never used.

## Detection

- `context_profile` table: one row per server per session (hash, tokens, tools, loaded).
- `mcpServerProfile` joins it to `events.tool_name` (the usage half REMY always had) on
  the hash of the server segment.
- `detectMcpIdle`: a server with ≥8k tokens of **loaded** schemas and zero calls this
  session; the heaviest is named. Estimate: tokens × turns at the cache-read class — what
  an idle schema actually costs.
- `context-tax` yields to it, and otherwise gains `{biggest}` ("MCP tool schemas (62k)").
- The name resolves at render time (`resolve.ts`) from the segments this machine has
  called plus `~/.claude.json` / `.mcp.json`, never from storage.

## Must NOT fire

- A server that was called even once.
- A server whose schemas are deferred (not loaded) — the host's default.
- Under 8k tokens.
- Any session the mod never reported (older host, mods off).

## Copy

`{server} parks {tokens_k}k of tool schemas in every turn, and this session never called it
once → disable it in /mcp until you need it`
