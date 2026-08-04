# Waste-signal backlog — the attack list

Working backlog for new **deterministic waste detectors**: signals of bad AI
usage (token burn, anti-patterns, Anthropic best-practice violations) that we
can detect from data we already collect — or could collect within the privacy
invariant — but don't yet. Companion to `docs/mistake-taxonomy.md` (the full
research map, M1–M18); this file is the prioritized execution queue. Attack
top-down, one at a time; update Status as items land.

Priority = measurable token waste × detection confidence (low false
positives) ÷ effort. Every detector stays deterministic (no model calls) and
metadata-only.

| # | Signal | Why it burns tokens / violates best practice | Detection (all metadata we already have unless noted) | Tip | Status |
|---|--------|---------------------------------------------|--------------------------------------------------------|-----|--------|
| S1 | **Cache-expiry re-read** — resuming after an idle gap re-writes the whole context at full price (prompt cache TTL ≈ 5 min) | The single biggest invisible cost: a 150k-token context reheated after every coffee break; cache write bills 1.25×, would have been 0.1× reads | Timestamp-verified idle gap (≥30 min between entries) AND a fat re-write (`cache_creation` ≥100k with `cache_read` collapsed) — the gap requirement keeps tool-list changes/prompt drift from being blamed on idleness, the size floor keeps coffee-break reheats (cheaper than re-briefing) silent; post-compact turns and model switches excluded | `cache-idle` (was a wisdom tip, now rule-backed) | **shipped** |
| S2 | **Red-zone riding** — many turns at ≥80% context without compacting | Every turn at 80% re-reads ~160k+ tokens; accuracy also degrades (context rot) — Anthropic: stay in the 40–60% band | Main-chain turns with per-turn context ≥80% of the **host-reported window** (`context_window_size` persisted as a local-only `sessions.context_window` column — a 170k turn is red on 200k, healthy on 1M); ≥3 fires; est = tokens above the 60% line; suppressed when auto-compact fired the same session | `context-band` (was a wisdom tip, now rule-backed) | **shipped** |
| S3 | **Bash instead of dedicated tools** — `cat`/`grep`/`find`/`head`/`ls` via Bash | Anthropic explicitly instructs agents to prefer Read/Grep/Glob: Bash variants dump unbounded output into context, skip pagination/truncation, and often re-run after permission prompts | `classifyCommand` gained a `read-cmd` class (in-memory, like `no-verify` — nothing persisted); ≥6 such calls per session fires, first 2 free at ~1.5k each. Write/action forms of the same words (`cat > file`, `find … -delete`, any redirect) fall back to `other` — a false negative is silence, a false positive is a wrong tip | `tools-over-bash` | **shipped** |
| S4 | **CLAUDE.md missing / bloated** (taxonomy 2c) | Missing: agent re-derives project facts every session (Anthropic's #1 best practice). Bloated: competes with the task for attention, taxes every session | `stat()` (never a read) the memory family the host would actually load — cwd walked up through its parents, plus `~/.claude/CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` — summed into a **local-only** `sessions.claude_md_bytes` column. Resolving cwd alone was rejected: it reports "no CLAUDE.md" to anyone running from a subdirectory (this repo included). NULL ≠ 0 (never probed vs genuinely absent). Missing fires only alongside `reread-churn` and **replaces** it; bloat is measured in bytes (≥20k), not lines — bytes/line is too unstable to convert — and yields to `context-tax`, whose fix already says to prune | new tip `claude-md-missing`; `claude-md-prune` (was a wisdom tip, now rule-backed) | **shipped** |
| S5 | **Whole-file rewrite churn** — repeated `Write` to the same existing file instead of targeted `Edit` | Regenerating a whole file pays full output price for every unchanged line; Anthropic: surgical edits | ≥3 `Write` calls to the same target-hash in one session | ~~`surgical-edits`~~ | **dropped** — measured, see below |
| S6 | **Scattered tool failures** — high failure rate without consecutive runs | Each failed call pays a full round trip + error output + recovery turn; scattered failures signal a broken environment (missing dep, wrong cwd) that one fix would end. `retry-loop` only catches *consecutive* identical failures | `tool_fails / tool_calls ≥ 25%` with ≥12 calls in a session (both already on the session row) | new tip `fix-env-once` | **backlog** — unblocked, needs calibration data (see note) |
| S7 | **Marathon session** — one session spanning many hours / topics | Kitchen-sink sessions (taxonomy M1): every unrelated task pays for all the previous ones; `/clear` is free | Wall-clock span of the session's `events` rows ≥4h with ≥2 distinct activity bursts (gaps >30 min) — pure timestamps, no content | `clear-between-tasks` (exists as wisdom tip → gains a real rule) | **backlog** |
| S8 | **Persist `cmd_class`** (taxonomy 2a — enabler, not a tip) | Unlocks cross-session verify-habit rules and admin hygiene aggregates | Persist the existing closed `classifyCommand` enum onto `tool_use` events; closed enum → structurally content-free. Breaking design change: must update `privacy.test.ts` + server `ingest-privacy` suite | — (infrastructure) | **backlog** |

## S6 is unblocked but not yet calibratable

S6 reads `tool_fails / tool_calls` off the session row, and that column was
structurally always zero until the `PostToolUseFailure` hook landed:
`PostToolUse` fires *only after a tool call succeeds*, so the old
`tool_response`-sniffing never returned true once in 2,125 recorded calls.

The counter is correct from that fix onward, but there is **no historical data
to pick a threshold against** — every stored session reads 0% failure. The
draft floor (≥25% over ≥12 calls) is therefore still a guess. Give it a few
days of real sessions, measure the actual distribution the way S5 was measured,
*then* build it. Shipping a threshold calibrated on nothing is how a tip gets a
reputation for crying wolf.

## Dropped after measurement

- **S5 — whole-file rewrite churn.** Measured against 50 real local transcripts
  (7,285 assistant entries, 277 `Write` calls) before building, and the numbers
  killed it:
  - **It barely fires, and fires on the wrong things.** At a floor of 3 it hits
    3 of 50 sessions / 9 (session, file) pairs. Three of those nine are
    markdown the host itself asks the agent to write wholesale (`~/.claude/plans/`,
    the memory dir) where "use Edit instead" is simply wrong advice; two more are
    already reported as `edit-thrash`. That leaves ~4 real hits in 50 sessions.
  - **The waste is too small to be worth a tip.** Whole-file `Write` content
    measures p50 ≈ 2.7k chars (~666 tokens), p90 ≈ 7.7k. A qualifying session
    wastes ~1k tokens — against `reread-churn` 4k, `no-verify` 10k,
    `auto-compact` 60k. It could never win `promoteNext`, so it would sit
    permanently queued in a spinner slot; the only way to surface it is to
    publish a number ~4× the observable truth, which this product does not do.
  - **The counts are inflated by a different problem.** 3 of one file's 9
    "rewrites" were the host's own `"File has not been read yet"` guardrail
    rejecting the write, followed by an identical retry — a permission story
    that `retry-loop` already owns, not a tool-choice story.
  - **The planned refinement was worthless.** "A `Read` before the first `Write`
    proves the file existed" fired for 0 of the 9 qualifying hashes: the agent
    reaches for `Write` precisely when it hasn't read the file.

  What would revive it: per-call content *size* on `ToolCall` (derived in memory
  like `bashClass`, never persisted), which would turn the estimate into a
  measurement and let it fire only on genuinely expensive files. That derives a
  number from file content rather than a command string, so it is a deliberate
  boundary decision for an awake human, not a detector tweak.

## Out of scope (and why)

- **Vague prompts (M5)** — prompt *length* is persistable, but short ≠ vague
  ("continue" is fine); too false-positive-prone to coach on.
- **Permission fatigue (M13)** — permission events aren't exposed to hooks.
- **Hooks/skills gaps (M17), agent-as-search-engine (M18)** — require prompt
  content; the privacy invariant forbids it.
- **ESC-interrupt habits** — no hook fires on user interrupt; not observable.

## Ground rules for every item

1. Deterministic rule in `packages/core/src/rules.ts` (or transcript-derived
   stats in `transcript.ts`) — no model calls in the detection path.
2. Tip copy in `catalog.ts` follows `[Brand]: {emoji} problem → solution →
   value` (`short` ≤55 chars rendered, no brand/est/🪙 in `short`).
3. Anything that widens what gets **stored** is a breaking design change:
   update `packages/core/test/privacy.test.ts` (+ server suites if the sync
   wire is touched) in the same PR.
4. Estimated savings stay rough-but-derivable; the UI prefixes `~`.
5. Tests: detector unit tests in `rules.test.ts` / `transcript.test.ts`,
   catalog sample evidence in `catalog.test.ts`.
