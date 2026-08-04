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
| S4 | **CLAUDE.md missing / bloated** (taxonomy 2c) | Missing: agent re-derives project facts every session (Anthropic's #1 best practice). Bloated (>200 lines): competes with the task for attention, taxes every session | `stat()` the fixed filename at SessionStart; store byte/line count as a **local-only** `sessions` column (a number — never on the sync wire). Missing fires only alongside observed `reread-churn` waste so it's tied to real cost | new tip `claude-md-missing`; `claude-md-prune` (exists as wisdom tip → gains a real rule) | **backlog** |
| S5 | **Whole-file rewrite churn** — repeated `Write` to the same existing file instead of targeted `Edit` | Regenerating a whole file pays full output price for every unchanged line; Anthropic: surgical edits | ≥3 `Write` calls to the same target-hash in one session (first Write = create, rest = rewrites); est = rewrites × avg output cost | new tip `surgical-edits` | **backlog** |
| S6 | **Scattered tool failures** — high failure rate without consecutive runs | Each failed call pays a full round trip + error output + recovery turn; scattered failures signal a broken environment (missing dep, wrong cwd) that one fix would end. `retry-loop` only catches *consecutive* identical failures | `tool_fails / tool_calls ≥ 25%` with ≥12 calls in a session (both already on the session row) | new tip `fix-env-once` | **backlog** |
| S7 | **Marathon session** — one session spanning many hours / topics | Kitchen-sink sessions (taxonomy M1): every unrelated task pays for all the previous ones; `/clear` is free | Wall-clock span of the session's `events` rows ≥4h with ≥2 distinct activity bursts (gaps >30 min) — pure timestamps, no content | `clear-between-tasks` (exists as wisdom tip → gains a real rule) | **backlog** |
| S8 | **Persist `cmd_class`** (taxonomy 2a — enabler, not a tip) | Unlocks cross-session verify-habit rules and admin hygiene aggregates | Persist the existing closed `classifyCommand` enum onto `tool_use` events; closed enum → structurally content-free. Breaking design change: must update `privacy.test.ts` + server `ingest-privacy` suite | — (infrastructure) | **backlog** |

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
