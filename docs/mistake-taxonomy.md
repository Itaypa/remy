# The agent-driving mistake taxonomy

The coaching roadmap's source of truth: every known way developers waste tokens or quality when driving AI coding agents, what the top-1% behavior looks like, what metadata signal reveals it, and where the coach stands on detecting it. Research base: Anthropic's official best-practices doc plus community mistake guides (July 2026 — sources at the bottom).

Detection status legend:
- **shipped** — deterministic rule live in `packages/core/src/rules.ts`, tip in `catalog.ts`
- **planned** — detectable, waiting on a batch-2 extension (see roadmap below)
- **partial** — an adjacent shipped rule covers part of the mistake
- **not detectable** — would require prompt/code content, which the privacy invariant forbids (metadata only, ever)

| # | Mistake | Top-1% behavior | Detection signal (metadata) | Status |
|---|---------|-----------------|------------------------------|--------|
| M1 | **Kitchen-sink sessions** — one session for many unrelated topics | `/clear` between unrelated tasks; one topic per session | No clean topic proxy — now measured, not assumed. Wall-clock span + activity bursts (S7) was tested and rejected: it measures *interruption*, not topic change (the gaps are overnight), and its firing set is a strict subset of `cache-idle`'s. Per-burst file-set disjointness was also built and tested and fires on the wrong sessions | partial (`auto-compact`); S7 **dropped** |
| M2 | **Marathon sessions / never compacting** — riding into auto-compact mid-task | Manual `/compact` at milestones, ~40–50% context | `PreCompact` hook with `trigger: "auto"`; plus per-turn red-zone riding — ≥3 main-chain turns with context ≥80% (each turn's own usage) | shipped: `auto-compact` + `context-band` |
| M3 | **Correction loops** — re-correcting the same output 3+ times | After 2 failed corrections: `/clear` + re-brief with what you learned | Same file-hash edited ≥6× with ≥3 interleaved re-reads (edit→re-read→edit rework) | shipped: `edit-thrash` |
| M4 | **Skipping plan mode** on multi-file/complex work | Plan-first for anything touching 3+ files or unfamiliar code | Big edit-heavy session (≥25 tool calls, ≥5 edits) with no plan-mode tool use; suppressed for users with an established plan-first habit | shipped: `plan-mode` |
| M5 | **Vague prompts** — no files, constraints, or success criteria | Name files, reference patterns, state pass/fail checks | Prompt length is persistable as a number (batch 2b), but short-prompt ≠ vague ("continue" is fine) — too false-positive-prone to coach on | not planned (FP risk) |
| M6 | **No verification loop** — edits shipped, tests never run | Give the agent a check it can run; end with a verify pass | ≥4 edits + shell used + zero Bash calls classified test/build/lint (classification in-memory, never persisted) | shipped: `no-verify` |
| M7 | **Missing or bloated CLAUDE.md** | Short CLAUDE.md of underivable facts; prune regularly | `stat` at SessionStart of the memory family the host actually loads (cwd walked up through its parents, plus `~/.claude/CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`), summed into a local-only `sessions.claude_md_bytes`. Missing rides on observed `reread-churn` and replaces it; bloat is measured in bytes and yields to `context-tax` | shipped: `claude-md-missing` + `claude-md-prune` (S4) |
| M8 | **Massive single tasks** — 300+ line one-shot generations | Decompose; verify between steps | No direct metadata signal; overflow/plan rules catch the fallout | partial (`auto-compact`, `plan-mode`) |
| M9 | **Re-read churn** — same files read over and over | Pin stable facts in CLAUDE.md/memory | Same Read target-hash ≥4× in a session | shipped: `reread-churn` |
| M10 | **Unscoped inline exploration** — "investigate X" reads 50 files into main context | Delegate wide searches to subagents; keep main context for conclusions | ≥15 distinct Read hashes + zero Task calls + context pressure (≥70% or an auto-compact) | shipped: `subagent-offload` |
| M11 | **MCP overload** — idle servers parking tool schemas in every session | Disconnect unused servers; lean startup | First main-chain assistant turn already ≥45k tokens | shipped: `context-tax` |
| M12 | **Wrong model choice** — top-tier model for trivial tasks | Match model tier to task; switch per task | ≥4 trivial sessions/week (≤5 tool calls, ≤3k out) on an opus-tier model, ≥50% of that week's opus sessions | shipped: `model-fit` |
| M13 | **Permission fatigue** — click-through approvals, or blanket skip-permissions | Allowlists for known-safe commands; sandbox for autonomy | **Now detectable** — the old "not exposed to hooks" verdict is stale. `PermissionRequest` (matcher on tool name) and `PermissionDenied` are documented hook events, and `permission_mode` rides on every hook payload. Count prompts per session, bucketed by the tool name already whitelisted | planned: S9 `allowlist-the-routine` |
| M14 | **Retry loops** — same failing command re-run unchanged | Stop after 2 identical failures; add the missing context | ≥3 consecutive identical failing calls (name + target-hash) | shipped: `retry-loop` |
| M15 | **Token/cost blindness** — no idea what a session costs | Watch context load; know the spend | Always-on statusline `[x/y 🪙]` badge, context alarm at 80%, `/remy` report | shipped (statusline) |
| M16 | **Dirty git state** — no clean baseline to diff or recover to | Clean state per session; checkpoints for risky work | Would need a git status probe at SessionStart (hook-time budget + privacy encoding TBD) | planned (unscheduled) |
| M17 | **No hooks/skills for repeated workflows** — re-typing the same instructions | Hooks for must-happen checks; skills for domain knowledge | Requires judging content of instructions | not detectable |
| M18 | **Agent as search engine** — trivia questions in agent context | Docs for facts; `/btw` for side questions | Requires prompt content | not detectable |
| M19 | **Idle-gap cache expiry** — stepping away past the prompt-cache TTL, then continuing: the next message re-writes the whole context at 1.25× where a warm return reads it at 0.1× | Wrap the session at a breakpoint before stepping away for a while — a fresh session with a one-line brief beats reheating a fat one | Timestamp-verified idle gap (≥30 min) + fat re-write (`cache_creation` ≥100k, `cache_read` collapsed); post-compact turns and model switches excluded; no-gap cache busts (tool-list changes) never blamed on idleness | shipped: `cache-idle` |
| M20 | **Shell reads where tools exist** — `cat`/`grep`/`find`/`ls` through Bash instead of Read/Grep/Glob | Ask for the built-in tools by name; pin it in CLAUDE.md once | ≥6 Bash calls classified `read-cmd` in a session (classification in-memory, never persisted); write/action forms of the same commands excluded | shipped: `tools-over-bash` |

New detectable signals get triaged in `docs/waste-signals-backlog.md` (S1–S8) before landing here.

## Batch-2 roadmap (schema/store extensions)

Each item widens what gets stored and is therefore a **breaking design change** per `CLAUDE.md`: its PR must update `packages/core/test/privacy.test.ts` and the server `ingest-privacy` suite, and may not add any free-text-capable field.

- **2a — persist `tool.cmd_class`**: **deferred** (see S8 in the backlog). The
  `classifyCommand` enum (`test|build|lint|git|pkg|run|read-cmd|other`, implemented in
  `transcript.ts`, used in-memory by `no-verify` and `tools-over-bash`) is genuinely
  content-free by construction, so the privacy question was never the problem. The
  problems are that it has no consumer, and that the `events` table is the wrong store:
  hook events fold **subagent** tool calls into the parent session while the rules read
  main-chain-only transcript data. The "admin hygiene aggregates" justification is struck —
  that dashboard is out of scope per CLAUDE.md. If a measured cross-session rule ever needs
  this, the right shape is a per-session aggregate written from the transcript, not a
  per-event field.
- **2b — UserPromptSubmit hook**: emit `type: "prompt"` events (already in the schema enum) for cadence only — no new field. Prompt char *length* could follow as a bounded number if a concrete rule ever needs it; none does today, and vague-prompt coaching (M5) is deliberately not planned.
- **2c — CLAUDE.md byte stat**: `stat` the fixed filename in the session cwd at SessionStart; store as a **local-only** `sessions.claude_md_bytes` column, never added to the sync wire schema. Unlocks a `claude-md-missing` tip (fired only alongside observed `reread-churn` waste, so it's tied to a real cost) and a mechanism line for `context-tax`.

## Sources

- [Claude Code best practices (official)](https://code.claude.com/docs/en/best-practices) — incl. the "Avoid common failure patterns" section
- [Common Claude Code mistakes — lowcode.agency](https://www.lowcode.agency/blog/claude-code-common-mistakes)
- [10 Claude Code mistakes beginners make](https://www.heyuan110.com/posts/ai/2026-02-25-claude-code-mistakes/)
- [Claude Code best practices — DataCamp](https://www.datacamp.com/tutorial/claude-code-best-practices)
- [10 tips to stop burning your tokens](https://medium.com/@habib23me/10-tip-to-stop-burning-your-tokens-in-claude-code-4776d4ac8956)
- [Context window management guide](https://explainx.ai/blog/claude-code-context-window-limit-management-2026)
- [Agentic coding best practices](https://abdus-muwwakkil.medium.com/agentic-coding-best-practices-fc167be3f7d5)
