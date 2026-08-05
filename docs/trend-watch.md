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
| F5 | **Skill sprawl** — a skill deck you never draw from, loaded at every session start. | team-adoption analysis (cap ≈20, "top five are 90% of invocations"); Anthropic's "move instructions from CLAUDE.md to skills" implies the inverse failure | measured on this machine: 81 distinct skills, 26,357 B of frontmatter ≈ **6.6k tokens every session start, 2.7× this repo's CLAUDE.md** | Yes — a near-clone of the shipped `claude_md_bytes` probe | **spec'd — S12**, reframed as attribution |
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
  council argued about. See `docs/specs/S12-mcp-surface-tax.md`.

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
  measurement answered it: **94% of the weight (78 of 81 skills, 24,860 B) is behind a
  one-command lever** (`/plugin` disable), because the user did not install 78 skills —
  they enabled 6 plugins and inherited 78. Nobody chooses 24,860 B of descriptions on
  purpose, which is exactly why it goes unnoticed.
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
