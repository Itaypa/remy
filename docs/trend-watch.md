# Trend watch — what the internet says people get wrong with Claude Code

The night shift's research memory. Each dated section is one sweep: what was found,
where, and the verdict it got. **Read this before searching** — a finding already
rejected here does not get re-proposed, and a finding already spec'd does not get
rediscovered.

Scope: mistakes developers make *driving Claude Code*. Not software anti-patterns.
Anything detectable only by reading prompt or code content is out of bounds by
construction (see the privacy invariant in `CLAUDE.md`) and is recorded here as
`out of scope` so the next sweep doesn't spend a search on it.

---

## 2026-08-05 — sweep 1

Sources, by type:

- **Anthropic official** — [Manage costs effectively](https://code.claude.com/docs/en/costs)
  (the authoritative list of what drives Claude Code spend), plus the model-config and
  MCP tool-search docs it links.
- **Practitioner** — [MCP server token costs](https://www.jdhodges.com/blog/claude-code-mcp-server-token-costs/),
  [Optimising MCP server context usage](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code),
  [Claude Code anti-patterns: what to stop doing](https://www.aicodex.to/articles/claude-code-antipatterns),
  [How to stop burning through Claude Code tokens](https://www.mindstudio.ai/blog/how-to-stop-burning-through-claude-code-tokens-context-management-guide-beginners),
  [12 ways to cut token consumption](https://www.firecrawl.dev/blog/claude-code-token-efficiency).
- **Team/adoption analysis** — [Claude Code anti-patterns: team adoption failure modes](https://www.digitalapplied.com/blog/claude-code-anti-patterns-team-adoption-failure-modes-2026)
  (names eight: skill sprawl, CLAUDE.md bloat, permission drift, hook spam,
  model-version drift, shared-skill orphans, subagent-governance gap, agent-blame).
- **Community friction** — the March 2026 quota crisis writeups
  ([roundup](https://blog.laozhang.ai/en/posts/claude-code-max-quota-consumption),
  r/ClaudeAI threads "20x max usage gone in 19 minutes" 330+ comments, "Limits were
  silently reduced" 360+ comments), and
  [anthropics/claude-code#7172](https://github.com/anthropics/claude-code/issues/7172)
  on MCP token management.

### Findings

| # | The mistake, in one line | Reported by | Claimed cost | Metadata-detectable? | Verdict |
|---|---|---|---|---|---|
| F1 | **Idle MCP servers tax every message.** Tool schemas ride on every turn, not once per session; you pay for servers you never call. | Anthropic docs ("disable unused servers", "prefer CLI tools"), two independent cost breakdowns, a GH feature request | 4-server setup ≈ 7k tokens *per message*; heavy setups >50k before you type | Usage half is free (`events.tool_name` already holds `mcp__*`); configured half needs a four-source probe | **parked — deferral cut it ~94%** |
| F2 | **Opus left as the default model for everything.** | Anthropic docs name it one of the two top causes of unexpected spend; every model-selection guide repeats "plan with Opus, execute with Sonnet" | Opus ≈5× Sonnet per token, and the weekly window is shared across models | Yes — model is already on the session row | **rejected** — already shipped as `model-fit`; see below |
| F3 | **Only ever auto-compacting** instead of a manual `/compact` at a phase boundary. | mindstudio, firecrawl, claudefast; Anthropic documents custom compaction instructions | a compaction of a full context is itself a large request | Yes, but the local data inverts the premise | **rejected** — see below |
| F4 | **Extended thinking left high on mechanical work.** Thinking tokens bill as output; `/effort`, `MAX_THINKING_TOKENS`. | Anthropic docs | "tens of thousands of tokens per request" at default budget | **No — the count does not exist in the data** | **rejected, with a revisit trigger** — see below |
| F5 | **Skill sprawl** — a skill deck you never draw from, loaded at every session start. | team-adoption analysis (cap ≈20, "top five are 90% of invocations"); Anthropic's "move instructions from CLAUDE.md to skills" implies the inverse failure | measured by the shipped probe: 35 skills, 10,176 B ≈ **2.5k tokens every session start**, level with this repo's CLAUDE.md (the council's 81/26,357 B counted the uninstalled marketplace catalog — see S12) | Yes — a near-clone of the shipped `claude_md_bytes` probe | **spec'd — S12**, reframed as attribution |
| F6 | **Scheduled tasks fire on idle sessions**, sending the full context each interval. | Anthropic docs, under "why usage climbs in a long session" | full context per tick, while you're not even there | Would coach a cron, not a developer | **rejected** — see below |
| F7 | **Skipping plan mode** on multi-file work. | aicodex, Anthropic ("prevents expensive re-work") | "20 minutes of correction vs 2 minutes upfront" | No known signal that plan mode was on | **out of scope for now** — not observable |
| F8 | **Never `/clear`ing between unrelated tasks.** | Anthropic names it the #1 habit to share | stale context taxes every later message | Yes, but | **already measured and dropped** — this is S7 (marathon), dropped on evidence. Do not re-propose without new data. |
| F9 | **Cache misses after a break.** | Anthropic's `/usage` now *flags* cache misses at ≥10% of recent usage | full context reprocessed | Yes | **already shipped** — S1 `cache-idle`. Note: Anthropic's own threshold is share-of-usage (10%), ours is a 30-min gap + ≥100k write. Worth a calibration pass someday. |
| — | Vague prompts, contradictory CLAUDE.md rules, off-topic questions in the main thread, agent-blame postmortems | various | — | No — all require reading prompt or file content | **out of scope — content-dependent** |

### Ground truth that moved

- Anthropic's `/usage` now ships **behavior flags** ("long context", "cache misses")
  fired at ≥10% of recent usage, and **attribution** of usage to skills, subagents,
  plugins, and individual MCP servers. That is the host shipping a coarse version of
  what REMY does. It validates the thesis and it raises the bar: REMY's edge is the
  *specific, quantified, deterministic* tip, not the observation that context is big.
- The docs now say MCP tool definitions are **deferred by default** (only names enter
  context until a tool is used). This weakens the raw "7k per message" numbers from the
  practitioner posts — F1's threshold has to survive deferral, which is exactly what the
  council argued about. See `docs/specs/S12-startup-pack-attribution.md`.

### Verdict notes — from the council (Opus seat: feasibility · Fable seat: value)

The two seats opened in direct collision: each one's strongest candidate was the other's
outright reject. Both moved.

- **F4 rejected — the number does not exist.** The Fable seat's case rested on "thinking
  tokens are a hard count we can show exactly." The Opus seat enumerated every `usage`
  key across all 7,766 main-chain turns in 27 local transcripts: `cache_creation`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `inference_geo`,
  `input_tokens`, `iterations`, `output_tokens`, `server_tool_use`, `service_tier`,
  `speed`. **There is no thinking count, no effort field.** The `thinking` content blocks
  that do exist average 67 characters — summarized digests, not billed thinking. The
  Fable seat conceded outright.
  The proposed fallback (a wisdom tip on a "hot" output/input ratio) was killed on
  measurement too, and this is the more interesting result: the distributions of turns
  with and without thinking overlap almost completely (p25-with = 0.0017 sits *below*
  p50-without = 0.0022), model tier dominates the effect (`fable-5` without thinking runs
  hotter than `opus-5` with it), and because the denominator is context size — which
  grows 10–100× over a session — the ratio is essentially `1/context`. It would fire at
  the start of every session and go quiet exactly when effort cost the most. Not a weaker
  F4; an anti-correlated context-size detector wearing F4's label.
  **Revisit trigger:** the day a thinking count appears in `usage`, this is a one-cycle
  build and ranks first. The fix (`/effort medium`) is genuinely good; only the trigger
  is missing. Until then it lives as a hints-deck line, where a citation stands in for
  evidence we don't have.
- **F5 spec'd, but not as a new tip — as attribution.** The Fable seat's objection was
  that auditing your toolbox rather than your behavior is nagware. The Opus seat's
  measurement answered it: the weight sits behind a one-command lever (`/plugin`
  disable), because the user did not install these skills one by one — they enabled a
  handful of plugins and inherited the rest. Nobody chooses 10KB of descriptions on
  purpose, which is exactly why it goes unnoticed. (The seat's *magnitude* was wrong —
  it walked the marketplace catalog and counted a disabled plugin; the shipped probe
  measures 10,176 B, not 26,357. The lever argument is unaffected.)
  The resolution dissolved the disagreement instead of winning it: **ship no new tip.**
  `context-tax` already bills the user for this pack and already says "audit MCP + prune
  CLAUDE.md" — it points at the *smaller* of the levers it can see. Teaching it to name
  its largest cause is zero new tips and zero new nag surface. See
  `docs/specs/S12-startup-pack-attribution.md`.
- **F2 rejected.** Already shipped in its only defensible form (`model-fit`, which fires
  on measured light sessions rather than on model choice). The blanket version fires on a
  deliberate identity-level choice — a large share of users are Max subscribers who
  bought the plan to use Opus — and every session it occupies the one tip slot is a
  session a real-mistake tip stayed silent. The real finding underneath it is a
  data-quality bug: `sessions.model` is *last-seen*, not dominant (one local session ran
  1,091 sonnet + 183 fable + 40 opus turns and records one value; 8 of 27 sessions switch
  mid-session). Logged as S13.
- **F3 rejected — the local data inverts the premise.** All 9 compactions in the corpus
  are `trigger: "manual"`; there are **zero** auto-compacts. The user isn't
  auto-compacting, they're compacting *late*. The only genuine delta over shipped
  `auto-compact` + `context-band` is a "late manual compact" rule, and that is blocked:
  `sessions.context_window` is populated on 11 of 65 sessions, so it would be silent on
  83% of them — and without the window you cannot tell 193k pre-tokens at 19% of a 1M
  window (fine) from 193k at 97% of 200k (bad).
- **F6 rejected on delivery, not measurement.** A scheduled run *is* a session, so REMY
  would attribute it to the developer and coach them for what a cron did — and all four
  coaching channels render to a screen nobody is watching. Zero instances locally.

---

## 2026-08-06 — sweep 2

Deliberately new ground: sweep 1 covered MCP surface, model choice, compaction,
extended thinking, skills and scheduled tasks, so none of those were searched again.

Sources, by type:

- **Practitioner measurement** — [The subagent tax](https://systima.ai/blog/subagent-tax)
  (a logging-proxy study running identical tasks sequentially vs 2 vs 5 subagents),
  [Why Claude Code subagents burn so many tokens](https://youcanbuildthings.com/articles/claude-code-subagents-token-usage/),
  [the 887k-tokens/min subagent cost explosion](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis).
- **Community friction** — `anthropics/claude-code` issues
  [#35166](https://github.com/anthropics/claude-code/issues/35166) (infinite loop
  re-sending a request every minute for hours, $500+),
  [#57535](https://github.com/anthropics/claude-code/issues/57535) (stuck re-running
  tsc from the wrong directory), [#41666](https://github.com/anthropics/claude-code/issues/41666)
  (a documented hook example causing silent repeat token waste).
- **Anthropic's own surface** — the per-session subagent cap
  (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, default 200) shipped explicitly "to stop
  runaway delegation loops", and the docs' "agent teams use ~7× tokens".
- **Workflow guidance** — [worktrees for parallel sessions](https://code.claude.com/docs/en/worktrees).

### Findings

| # | The mistake, in one line | Claimed cost | Metadata-detectable? | Verdict |
|---|---|---|---|---|
| G1 | **The subagent tax** — every worker is a fresh agent loop re-reading its own ~4k system prompt and ~24 tool schemas on every turn, and parallel spawns hit cold caches at premium write rates | 2 subagents = 2.6× metered input tokens on Opus (~5× price-weighted), 5.9× on Fable, 4.2× on Sonnet — and **never faster on any task**. Not worth it for small tasks, sequential dependencies, or review steps | Yes, but not where we look — see the ground-truth note below | **spec'd — S14** |
| G2 | **Runaway / repeated-request loops** — the same call re-issued indefinitely, `retry-loop` only catches consecutive identical *failures* | $500+ over hours in the reported case | Measured locally: max identical-command repeats in one session = **9**, over 157h; zero cases of a command re-run 3× with no intervening edit. `retry-loop` fires 0 times locally | **rejected** — see below |
| G3 | **Parallel-session collision** — a subagent reads files another session is mid-edit in, then cites line numbers that have shifted | hallucinated code, silent rework | Exposure is computable (`cwd_hash` + timestamps: 8.6% of active minutes locally have ≥2 live sessions) — the *harm* is not | **rejected** — see below |
| — | Fabricated test results; instructions inconsistently followed | — | Requires reading prompt/code content | **out of scope — content-dependent** |

### Ground truth that moved — and it invalidates code we ship

**`isSidechain` is dead on this host.** All **14,858** entries across the 27 local main
transcripts are `isSidechain:false`; the 44 files carrying `true` are the subagent
transcripts themselves, which now live in a separate tree:
`~/.claude/projects/<proj>/<session-id>/subagents/agent-<id>.jsonl` plus a `.meta.json`
carrying `{agentType, description, toolUseId, spawnDepth, model}`. The sidechain
exclusions in `transcript.ts` therefore never fire, and **subagent spend is not in
REMY's token totals in any form.**

Measured consequences:

- **15.1% of all local billable tokens are invisible to REMY** (3.34M subagent against
  18.74M main). Median 13.4% per session that used subagents; worst session **55.7%**,
  where REMY reported roughly half of what actually ran.
- The three numbers REMY shows count three different populations: `tool_calls` comes
  from hooks and **does** include subagent calls (832 stored vs 586 main + 256 subagent
  on one session), tokens come from the transcript parse and **don't**, and `cost_usd`
  comes from the host and **does**. This is S10, but larger than S10 described.
- Per agent: billable p25/p50/p75/max = 49k / 69k / 104k / 213k. The median agent spends
  ~69k to hand back ~2.4k of report — roughly **31×**.
- **Worker tier is inherited, not chosen:** of 44 local agents, `meta.model` is unset on
  24; of those with a tier, 18 are Opus and 2 Fable. `spawnDepth` is 1 on all 44, so
  nested-agent file placement is **unverified** — a depth-2 agent might not land in the
  same directory, which would undercount.

### Verdict notes — from the council

- **G2 rejected on measurement, not on principle.** The reported loops are real, but the
  local population is empty: across 1,623 Bash calls in 13 sessions the worst identical-
  command repeat was 9 over 157 hours, and widening `retry-loop` to successful repeats
  would pull in legitimate polling (204 browser calls at a 58s cadence, 20-long task-update
  runs). The reported case was also a *host* bug, and a runaway loop burns while nobody is
  watching the statusline — the same delivery objection that killed F6 in sweep 1.
- **G3 rejected — we can detect the exposure, never the harm.** Overlap is easy arithmetic
  and the local numbers are real (8.6% of active minutes have ≥2 live sessions, four
  sessions spend 38–68% of their minutes overlapping). But a read-after-write across
  sessions is not evidence anything went wrong, the harm is content, and the false-positive
  class *is* the intended workflow — a background research agent, a read-only second
  session, and this repo's own night-shift loop are indistinguishable from a collision.
  REMY would coach its own author for something he does deliberately every night. Its fix
  ("a worktree per code-writing agent") also has no metadata signature, so the tip could
  never be observed to have worked, and would re-fire forever. Demoted to a hints-deck line.

---

## 2026-08-06 — sweep 3

Started by re-checking ground truth rather than searching for new mistakes, which turned
out to be the higher-yield move: **a sweep-1 verdict was wrong and is now overturned.**

### The correction: `effort` is observable, and F4's blocker never existed

Sweep 1 rejected F4 (extended thinking / effort left high) because the Opus seat
enumerated every key inside `message.usage`, found no thinking count, and concluded the
effort setting "rides on no hook payload we receive." It had looked one level too deep.
**`effort` is a top-level field on each transcript entry**, a sibling of `type` and
`message`. Verified twice, independently:

- Deduped by `message.id` (the streaming rule `parseTranscript` uses): `effort` present on
  **4,065 of 4,077** main-chain turns. The 12 without it are all `<synthetic>` or
  API-error entries carrying zero output — so it is on **100% of real billed turns**.
- Values locally: `high` (3,569 turns), `max` (496). No `low`/`medium`/`none` ever seen.
- Subagent transcripts carry their own `effort` too (493 `high`, 7 `max`).
- `parseTranscript` walks straight past it; the insertion point is free.

**And a number of mine was wrong.** My first pass reported max turns producing ~2× the
output of high turns. That is a model-mix artifact: `max` occurs *only* on fable-5 and
opus-4-8, while opus-5 and sonnet-5 — which never run max — drag the `high` mean down.
Held within model it is **~1.5×**, and even that is confounded with task difficulty, since
max turns are plausibly the harder turns. **No multiplier ships.** One thing does survive:
mean context is *lower* on max turns (222,911 vs 245,336), so unlike sweep 1's rejected
output/input fallback this signal is not a disguised `1/context`.

The sweep-1 revisit trigger ("the day a thinking count appears in `usage`") is still
**unmet** — `effort` is a knob, not a count. Thinking still bills into `output_tokens`
inseparably.

### A bigger find, unlooked for: the host is attributing turns for us

Assistant entries carry top-level `attributionSkill` (2,042 locally),
`attributionMcpServer` (854), `attributionMcpTool` (854) and `attributionPlugin` (142) —
e.g. `attributionSkill:"night-shift"` ×1,204, `attributionMcpServer:"Claude Browser"` ×808.
The host is telling the transcript which skill, MCP server or plugin a turn belongs to.
That is the "configured half" F1 (idle MCP servers) was parked for in sweep 1, and a large
part of what S12's attribution had to infer. Logged as S19; it likely unparks F1 outright.
Note these are free-text-shaped names and would have to be hashed or enum-gated at ingest.

### Findings

| # | The mistake | Measured locally | Verdict |
|---|---|---|---|
| H2 | **Whole-file reads** — `Read` returning an entire large file where a slice was asked for | `Read` result sizes p50 2,179 chars, **p95 117,944, max 471,536 (~118k tokens in one result)**; 7.78M chars ≈ **1.95M tokens from Read results alone**. Bimodal: 2 of 13 sessions have ≥3 oversized reads, the rest have zero | **spec'd — S17** |
| F4′ | **Effort drift** — `/effort` is sticky and outlives the hard step it was set for | 0 all-max sessions, 1 mixed, 17 never max — and the mixed one is this repo's own night loop, which flips to max at turn 4 and never back | **collect only — S18** |
| H1a | **Hook-injected context** — hooks that inject on every event | `SessionStart:startup` injects **170,505 chars (~43k tokens, ~950/session)**; `Stop` 9,667 chars over 141 fires. Attachment entries carry `hookName`, `hookEvent`, `durationMs`, `exitCode` | **fold into `context-tax` attribution — S20** |
| H1b | **Slow hooks** — a 2s PreToolUse hook × thousands of calls | Measured means: 4–8ms PostToolUse, 37ms Stop, 206ms SessionStart. **Zero local instances** of the reported magnitude | **rejected** — see below |
| — | The reported "12k-token `npm test` log" | Backwards locally: Bash is the **best**-behaved tool, p95 2,222 chars. The waste is `Read`, not shell output | folded into H2 |

### Verdict notes

- **H1b rejected on three independent grounds.** Wrong unit: it is wall-clock
  milliseconds, and a tip with no 🪙 value clause loses the single active slot to every
  tip that has one. Wrong subject: hooks are configuration, often a plugin's rather than
  the driver's — locally *every* PostToolUse hook across 14,858 entries is REMY's own, so
  the rule would coach the developer for a plugin author's choice. And no population: the
  reported 2s-per-call magnitude has never once been observed here.
- **F4′ collected, not shipped, and the framing changed.** Seat B's reframe is the one
  that survives: firing on *"you used max effort"* punishes a dial the user deliberately
  turned minutes ago — F2 redux with a different knob — and it fires most reliably in the
  sessions where max was most justified. What is a real mistake is **drift**: the setting
  outliving its reason, the same shape as `cache-idle`. But the only local instance is
  this repo's own automation, so any rule calibrated today would be tuned to fire on its
  own author, at a screen nobody is watching. Collect; unpark when a human session
  inherits max at start, or when a `low`/`medium` value is ever observed.
- **The self-check that mattered:** REMY's own broken `bin/coach` path from an old dev
  build accounts for all 226 local PostToolUse hook entries, every one with a non-zero
  exit code. The mirror works, and the first thing it showed us was our own bug.
