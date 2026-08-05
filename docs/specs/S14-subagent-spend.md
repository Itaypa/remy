# S14 — See what the workers spent

## The mistake

You delegate. Claude Code spawns workers, each one a fresh agent loop that re-reads its
own ~4k system prompt and ~24 tool schemas **on every turn it takes**, and parallel spawns
land on cold caches at premium write rates. A logging-proxy study running identical tasks
sequentially, with 2 workers, and with 5 measured the tax: **2.6× the metered input tokens
on Opus (~5× price-weighted), 4.2× on Sonnet, 5.9× on Fable — and never faster on any
task.** Locally the median worker spends ~69k billable tokens to hand back ~2.4k of
report, roughly 31×. None of that is in any number REMY shows you.

## Trend evidence

- [The subagent tax](https://systima.ai/blog/subagent-tax) — the multipliers above, from a
  logging proxy over identical tasks. Not worth delegating: small tasks, sequential
  dependencies, review/verification steps. Worth it: genuinely independent work on large
  surfaces. Pinning workers to a cheaper model measured **37% fewer tokens at under half
  the wall-time**.
- [The 887k-tokens/min explosion](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis) —
  49 parallel workers, 2.5 hours, an estimated $8–15k in one session.
- Anthropic shipped `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` (default 200) explicitly "to
  stop runaway delegation loops", and its docs put agent teams at ~7× tokens. The host's
  own `/usage` now attributes spend to subagents — a coach that cannot see what the host
  already shows the user is behind the product it coaches.

## The ground truth this rests on (verified 2026-08-06, host 2.1.220)

**`isSidechain` is dead code on this host.** All **14,858** entries across the 27 local
main transcripts are `isSidechain:false`. Subagents no longer inline into the parent
transcript; they live in
`~/.claude/projects/<proj>/<session-id>/subagents/agent-<id>.jsonl`, each with a sibling
`agent-<id>.meta.json` carrying `{agentType, description, toolUseId, spawnDepth, model}`.
The 44 local agent files are where the `isSidechain:true` entries actually are.

Consequences, measured:

- **15.1% of all local billable tokens are invisible to REMY** (3.34M subagent vs 18.74M
  main). Median 13.4% per delegating session; worst **55.7%** — that session's real spend
  was roughly double what REMY recorded.
- REMY's three headline numbers count three different populations: `tool_calls` comes from
  hooks and **includes** subagent calls (832 stored vs 586 main + 256 subagent on one
  session), tokens come from the transcript parse and **exclude** them, `cost_usd` comes
  from the host and **includes** them. This is S10, bigger than S10 described.
- Worker tier is **inherited, not chosen**: `meta.model` is unset on 24 of 44 local
  agents; of those that carry one, 18 are Opus and 2 Fable.
- `spawnDepth` is 1 on all 44 local agents, so **nested-agent file placement is
  unverified** — if a depth-2 agent's file lands under its parent rather than in the
  session's `subagents/`, the total undercounts. Do not claim completeness.
- Agent files are the same shape as main transcripts (`type:"assistant"`,
  `message.usage`, `message.model`, `message.id`), so the existing parser reads them.

## Detection

No rule, no tip in this spec — this is the substrate. Per session, at analysis time:

1. Resolve `dirname(transcriptPath)/<sessionId>/subagents/`. Absent → NULL, stop.
2. For each `agent-*.jsonl`, sum `input_tokens + output_tokens + cache_creation_input_tokens`,
   de-duplicated by `message.id` (streaming writes repeat an id with growing usage —
   the same discipline `parseTranscript` already uses).
3. Resolve each worker's tier from **its own turns** (dominant by output tokens, the S13
   technique). Deliberately NOT from `meta.model`: that file also carries `description`,
   which is the task prompt — free text. Never opening it is a stronger guarantee than
   parsing it carefully, and it is unset on 24 of 44 agents anyway.

## What it must NOT do

1. **SessionEnd only — not even every Stop.** It walks a directory and reads files, and
   one local session carries **4.0 MB across 22 agent files**. Stop fires every turn, so
   walking there would blow the <50ms hook budget; the statusline, which re-runs ~1/s,
   must never see it. `analyzeTranscript` already takes a `sessionEnd` flag — gate on it.
2. **Never throw.** A missing directory, an unreadable file, a truncated line — all are
   "no data", never an exception that lands a path in the log.
3. **NULL ≠ 0.** Absent directory means "never walked", not "you delegated nothing". Every
   pre-existing row is NULL.
4. **Do not silently re-base the existing totals.** Every shipped rule threshold
   (`context-tax` at 45k, `model-fit`, the red-zone band) was calibrated against
   main-chain numbers. Folding subagent tokens into `tokens_in`/`tokens_out` would move
   every one of them at once, invisibly. Store separately; decide re-basing deliberately.
5. **Do not store `agentType`, `description`, `agent_id`, `toolUseId`, or `spawnDepth`.**
   Counts, plus one model string. `description` is free text; `agentType` is a
   config-authored slug. The `.meta.json` holding them is never opened at all.

## Storage

On `sessions`, all INTEGER except the tier, all local-only, coerced at the write site the
way `setClaudeMdBytes` and `setSkillPack` are:

- `sub_agents` — how many worker transcripts were found
- `sub_tokens_in`, `sub_tokens_out`, `sub_cache_write` — their billable usage
- `sub_model` — dominant worker tier, through `ModelStr` (the same gate `upsertSession`
  now enforces)

No change to `SessionEventSchema`: nothing here goes through the event path.

## Surface

**None, deliberately.** No rule, no catalog entry, nothing rendered — so the noise budget
is *provably* unchanged, which is what makes this a safe unattended commit. Collection
only, the posture S11 (`perm_denials`) shipped in.

Showing the number is the awake decision, and it is S10's stated blocker: `/remy`, the
statusline and the week rollup would all be restating the user's own history with
different figures than yesterday. That is a product call, not a night-shift commit.

**Nesting risk, checked and closed:** every session directory has exactly two children
(`subagents/` and `tool-results/`) with no per-agent subdirectory, so the `subagents/`
tree is flat and keyed by the root session id. A nested agent has nowhere else to land, so
the total cannot be undercounted by depth — at worst a grandchild is attributed to the
root session, which for a session-level spend number is the desired reading. The walk
globs `agent-*.jsonl`, so if the host ever introduces a per-parent subdirectory the count
silently drops rather than becoming wrong in the loud direction.

## The tip this unlocks (NOT in this spec — S15)

`delegate-tier`, once the columns have data. Both seats converged on it:

- Fires on inherited-default workers, never on the choice to delegate: the copy names the
  tier, e.g. `short` = `{n} subagents defaulted to {tier} → pin workers to sonnet` (53
  chars). Seat B's condition: fire only when `meta.model` was unset on the majority of
  workers — the tip is literally about the inherited default, so a user who deliberately
  chose a worker tier never sees it. This is what keeps it clear of sweep 1's rejected
  "stop using Opus", which failed on identity cost.
- Seat A's draft rule: countable worker := tier contains "opus" AND edits == 0 AND
  tools ≥ 5; fire at ≥3 countable workers AND ≥150k combined billable; est = 0.8 × that
  (the Opus:Sonnet price ratio, mirroring `model-fit`'s arithmetic so two tips don't quote
  the same lever differently). Locally that fires on 4 of 24 sessions.
- Known false-positive: a worker doing genuinely hard delegated reasoning (an adversarial
  review) looks identical to a search worker. `agentType` would separate them but must not
  be stored as-is.

## Tests

- Walk: sums a two-agent directory; de-duplicates a repeated `message.id`; ignores
  `.meta.json`; returns NULL for a session with no `subagents/` directory; returns zeros
  for an empty one; survives a truncated/garbage line; never throws on a nonexistent path.
- Store: hostile values cannot reach the columns (INTEGER affinity is not the guarantee);
  `sub_model` is gated by `ModelStr`.
- **Negative:** a session with no delegation is unchanged in every existing number — the
  point of storing separately.

## Open objection — resolved, and how

Seat B opened arguing for shipping the *tip* first and keeping `subagent-offload`
untouched; it conceded both after the correction, including that its stated mechanism
(`transcript.ts` excluding sidechain from totals) is dead code. It now argues attribution
must land first, on its own lens: "a coaching product whose headline number silently omits
15% of billable spend has a trust defect that no new tip can sit on top of."

**One real defect surfaced that this spec does not fix:** `subagent-offload`'s
`estSavingsTokens = (reads - 10) × 1500` books *context relief* as tokens *not spent*,
while the delegation it recommends costs ~69k billable at the local median. The sign is
inverted on the metered axis, and that field ranks the coaching queue — so it is
mis-prioritized coaching, not a cosmetic error. Both seats agreed. Fixed in S16 (shipped 2026-08-06): the value clause is gone and the tip stands on window
headroom, which is what its own citation always claimed.
