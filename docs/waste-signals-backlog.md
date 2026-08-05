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
| S7 | **Marathon session** — one session spanning many hours / topics | Kitchen-sink sessions (taxonomy M1): every unrelated task pays for all the previous ones; `/clear` is free | Wall-clock span of the session's `events` rows ≥4h with ≥2 distinct activity bursts (gaps >30 min) — pure timestamps, no content | ~~`clear-between-tasks`~~ (stays a wisdom tip) | **dropped** — measured, see below |
| S8 | **Persist `cmd_class`** (taxonomy 2a — enabler, not a tip) | Would unlock a cross-session verify-habit rule | Measured before building; the enum is content-free but the `events` table is the wrong store — see below | — (infrastructure) | **deferred** — no consumer, wrong store |
| S11 | **Auto-mode denials** — calls the host's classifier refused | A denied call is a full round trip that buys nothing and usually gets re-issued | **`PermissionDenied`** hook registered; counted into local-only `sessions.perm_denials`. **Collection only — this is NOT S9's population** (see the note below) | — (no tip yet) | **collecting** — needs data before a threshold |
| S9 | **Permission-prompt churn** (taxonomy M13) | Every approval prompt is an interruption, and a denied call is a full round trip that usually gets re-issued — the fix is a one-line allowlist entry the user never makes because nobody counts the prompts | Register the **`PermissionRequest`** hook (it exists now — see the hook-surface note below) and count events per session, bucketed by the tool name we already whitelist. Nothing new is stored beyond a count and an existing enum | new tip `allowlist-the-routine` | **backlog** — needs collection before a threshold |
| S10 | **Attribute subagent tool calls** (accuracy fix, not a tip) | `sessions.tool_calls`/`tool_fails` count delegated work that main-chain rules never see; on one local session 98 of 331 Bash calls were the agent's own. Two numbers in the same UI count different populations | Per the host's own hook-input schema, `agent_id` rides on any hook fired inside a subagent (see the note below), so this should be a one-line filter rather than a bracketing scheme — read from the schema, not yet observed on a live payload | — (infrastructure) | **ready** — needs a call on the displayed numbers |
| S12 | **Startup-pack attribution** — `context-tax` bills you for a heavy pack but names only the two smaller levers | Measured locally: 81 distinct skills = 26,357 B of frontmatter ≈ 6.6k tokens **every session start**, 2.7× this repo's CLAUDE.md; 94% of it is plugin-inherited, behind a one-command `/plugin` lever the user never knew to pull | `sessions.skill_bytes` + `skill_count` — frontmatter only (bodies inflate 46×), enabled plugins only, plugin-cache duplicates deduped. NULL ≠ 0. Full spec: [S12](specs/S12-startup-pack-attribution.md) | — (no new tip: `context-tax` names its own cause) | **shipped** — probe, columns, and the attribution; `TipDef.fallbacks` came out of it, closing a latent bug where any placeholder added to a `fix` would render raw on adaptive and pre-existing tip rows |
| S13 | **`sessions.model` is last-seen, not dominant** (accuracy fix, not a tip) | One local session ran 1,091 sonnet + 183 fable + 40 opus turns and records a single value; 8 of 27 sessions switch model mid-session. Any model-aware rule (`model-fit`) is reasoning over the last turn's model, not the session's | Per-turn model already exists unused in `transcript.ts`'s `mainTurns[].model` — attribute by dominant-by-tokens rather than last-write | — (infrastructure) | **shipped** — dominant-by-output-tokens; re-attributed 6 of 27 local sessions, one of which was recorded as `<synthetic>` |

## The hook surface has grown — re-check "not detectable" before trusting it

Several taxonomy verdicts were written against an older Claude Code hook
surface and are now simply out of date. The current surface documents **31**
hook events, including a batch this project has never looked at:

- **`PermissionRequest`** (fires when a tool call needs a permission decision,
  matcher on tool name) and **`PermissionDenied`** (fires after a denial).
  M13's "permission events are not exposed to hooks today" is **false as of
  now** — that's S9.
- **`SubagentStart` / `SubagentStop`**, carrying `agent_id` and `agent_type` —
  the missing piece for attributing delegated tool calls (S10).
- **`PostToolUseFailure`**, which is why `tool_fails` had been 0 forever
  (fixed) — the same class of stale assumption, caught the same way.
- `permission_mode` is a **standard field on every hook payload**, so the
  permission posture of a session is already arriving at our door on hooks we
  are registered for today.
- `UserPromptSubmit` exists and carries `user_input` — the prompt text. That
  is exactly what the privacy invariant forbids storing, so batch-2b stays
  cadence-only (an event type, no payload), and M5 stays not-planned on
  false-positive grounds rather than on availability grounds.

**S11 is not S9, and conflating them would poison the calibration.**
`PermissionDenied` fires only after the *auto-mode classifier* refuses a call.
A developer in default mode being interrupted by forty approval prompts a
session generates **zero** of them. S9 is those interruptions, and it needs
`PermissionRequest` — which is deliberately not registered, because stdout on
that event is an allow/deny decision (see `docs/claude-code-surfaces.md`).
So S9 is still uncollected, and `allowlist-the-routine` additionally needs
per-tool bucketing that S11 does not gather: a bare session counter can
calibrate a threshold and nothing more.

**Process note:** a "not detectable" row is a claim about a moving target. Two
of tonight's findings (`PostToolUseFailure`, the permission events) were stale
verdicts rather than hard limits. Re-check this list against the hooks doc
before concluding anything is impossible.

## Deferred — enablers without a consumer

- **S8 — persist `cmd_class`.** Measured against 53 local transcripts and the
  9-day event history before building. The privacy question was never the
  problem: the enum is closed and `privacy.test.ts` already proves hostile
  commands can't escape it. Three other things are:
  - **The `events` table measures a different population than the rules do.**
    Hook events fold **subagent** tool calls into the *parent* `session_id`,
    while the parent transcript holds no sidechain entries at all (subagent
    transcripts live in `<session-id>/subagents/`). One local session
    reconciles exactly: 26 Bash events = **1** main-chain call + **25**
    subagent calls. A persisted per-event `cmd_class` would credit the agent's
    `bun test` to the user's verify habit. The launcher's silent exit-0 on a
    missing binary makes the table lossy the other way too, so 8 of 9 sessions
    disagree with their transcript — in both directions, by up to 6×.
    `no-verify` and `tools-over-bash` read the transcript precisely because it
    is the complete, main-chain-accurate record.
  - **The one live justification has no rule behind it.** Of 10 sessions in
    `no-verify`'s population (≥4 edits, ≥1 Bash), 8 ran 5–30 verify commands
    and 2 ran none — and `no-verify` already fires on those 2 at a 10k
    estimate. A cross-session variant would re-serve dismissed advice under a
    new id, which is why S7 was dropped. The `shouldSuppressPlanMode` analogue
    doesn't transfer: `no-verify` needs *zero* in-session verifies, so a
    habitual verifier can't trigger it and there's no false positive to
    suppress. "Admin hygiene aggregates" is struck — that dashboard is out of
    scope per CLAUDE.md.
  - **Nothing is lost by waiting.** Unlike `tool_fails` (unobservable until the
    `PostToolUseFailure` fix) or `claude_md_bytes` (a point-in-time `stat`),
    verify counts are re-derivable from transcripts retroactively — the whole
    history above was reconstructed that way — and host retention comfortably
    exceeds `analyzeHabits`' 7-day window.

  What unblocks it: a *measured* cross-session rule that needs it. The right
  shape then is a per-session aggregate (`sessions.verify_calls`, written from
  the main-chain transcript like `used_plan_mode`, read straight by
  `analyzeHabits`) — ~47 rows instead of ~2,158, a count instead of a per-call
  trail, `SessionEventSchema` untouched. Ship it with its rule, the way every
  other session column landed.

## Resolved: `repo_hash` was dead, and wiring it would have made it wrong

`repo_hash` was whitelisted in `SessionEventSchema` and plumbed through
`insertEvent` and `upsertSession`, but no caller ever passed it: NULL for all
2,372 events and all 59 sessions. It has been **removed from the schema and the
writers**; the two DB columns stay (the DDL is `CREATE TABLE IF NOT EXISTS`, so
dropping them would only change fresh databases and make the shapes diverge)
and are annotated as vestigial in `store.ts`.

The tempting fix — resolve the git root by walking up for `.git` and store its
hash — was measured first and rejected. Session cwds in the real DB:

| cwd | sessions | what a git-root hash would give |
|-----|----------|----------------------------------|
| the repo root | 36 | identical to `cwd_hash` |
| `$HOME` | 20 | null (no repo above it) |
| 3 others | 1 each | — |

**Zero sessions started from a subdirectory**, so the stated benefit (grouping
`packages/*` sessions with the root) has no instances: the column would be a
verbatim copy of `cwd_hash` where it resolved and null where it didn't. Claude
Code's cwd is wherever the agent was launched, and it gets launched at the root.

Three further ways a `.git` walk is the wrong identity, if this is revisited:
worktrees terminate the walk at the worktree (so it *splits* what it claims to
group — real identity is `git rev-parse --git-common-dir`, which a filesystem
walk can't reproduce); a `git init` in `$HOME` silently stamps one id onto every
otherwise-unrelated session; and a symlinked cwd (`/var` vs `/private/var` on
macOS) yields two ids for one repo.

## S10 is unblocked: `agent_id` is on every hook fired inside a subagent

The open question was whether the subagent's calls could be told apart without
bracketing `SubagentStart`/`SubagentStop`. They can. The host's own hook-input
schema (Claude Code 2.1.220) describes `agent_id` as:

> "Present only when the hook fires from within a subagent (e.g., a tool called
> by an AgentTool worker). Absent for the main thread, even in `--agent`
> sessions. **Use this field (not `agent_type`) to distinguish subagent calls
> from main-thread calls.**"

"a tool called by an AgentTool worker" is a `PostToolUse`, so the field should
be there, `agent_type` is explicitly the wrong one to use, and the whole fix is
`const isSubagent = typeof payload.agent_id === "string"`. `agent_id` must
**not** be stored — it is an opaque id we have no use for; only the boolean
matters, and even that only as a counter.

**Confidence, stated precisely:** this is read from the host's schema, not
observed on a live payload. That is a strong source but it is not the same
thing, and conflating the two is exactly what produced the retracted PreCompact
claim below. Whoever implements this should log `typeof payload.agent_id` once
from a real subagent tool call before building on it — a minute's work that
converts a documented expectation into a fact.

**Why this isn't already done.** It changes numbers the user already reads:
`/remy`'s "🧰 tools N calls · N failed" and the adaptive payload's
`tool_fail_rate` would both drop on subagent-heavy sessions. There are two
defensible designs — stop counting delegated work in `tool_calls`, or keep the
total and add a separate `subagent_tool_calls` — and picking one is a product
call about what the report means, not a bug fix. Left for an awake decision.

Worth knowing when deciding: the rules already disagree with the report.
`plan-mode`, `subagent-offload` and `reread-churn` read main-chain-only
transcript data, so today the report's totals and the tips beside them are
counting different populations.

## Unverified: nothing has compacted since `PreCompact` was registered

**An earlier version of this note claimed the hook never fires. That claim was
wrong and is retracted** — it confused "REMY was recording events" with "this
plugin's PreCompact hook was registered", which are different installs.

What is actually true on this machine:

- **Zero `compact` events, ever**, across 2,485 `tool_use` and 48
  `session_start`. `compacts_auto`/`compacts_manual` are 0 on all 59 sessions.
- **Eight compactions did happen** — `compact_boundary` entries across five
  transcripts, all `trigger: "manual"`, pre-token counts up to 460k.
- **But all eight predate the hook.** The marketplace clone's `hooks.json` —
  the file that registers `PreCompact` — dates to 2026-08-04 21:58, and the
  repo's first commit is 21:24 that evening. The most recent compaction was
  18:16, more than three hours earlier. Event recording before that came from
  an earlier install whose hook set is not inspectable.

So zero compact events is exactly what the timeline predicts. There is no
evidence of a defect, and none of an absence either.

**How to settle it in one minute:** run `/compact` in any session, then check
`SELECT compacts_manual FROM sessions ORDER BY started_at DESC LIMIT 1`. A 1
means the hook works and this note can be deleted. A 0 means it genuinely does
not fire, and then it matters a great deal — `index.ts` files `auto-compact`
(the catalog's largest estimate, ~60k 🪙) **only** from the `PreCompact`
branch, and `detectRedZoneRiding`'s `autoCompacts > 0` suppression would be
unreachable too.

Worth knowing either way: the host now also has a `PostCompact` event and a
`microcompact` path, neither of which this adapter looks at.

## Open: the statusline still loses races on the database

`remy.log` shows repeated `[statusline] SQLiteError: database is locked` —
5 times on 2026-08-04 alone. `busy_timeout` was already raised to 2000ms for
exactly this, and it is still happening under `refreshInterval` polling plus
hook writes. The failure is soft (the statusline falls back to `⚡ remy`), which
is why it went unnoticed. Worth a look at WAL settings and at whether the
statusline needs a write path at all — it currently calls `syncSessionStats`.

## Known: hook counters and transcript rules count different things

`sessions.tool_calls` / `tool_fails` are incremented from hook events, which
**include subagent tool calls**, while `plan-mode`, `subagent-offload` and
`reread-churn` read main-chain-only transcript calls. So `/remy`'s "N calls"
and the adaptive payload's fail rate are inflated by delegated work on
subagent-heavy sessions (one local session: 98 of 331 Bash calls were the
agent's). Defensible as-is — the session *did* make those calls — but two
numbers in the same UI currently count different populations. Changing it
changes user-visible reported numbers, so it wants a deliberate decision
rather than a silent fix.

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

- **S7 — marathon session.** Measured against 47 local sessions (39 with ≥2
  events) and their real transcripts before building:
  - **Its firing set is a strict subset of `cache-idle`'s.** Only 7 of 39
    sessions contain any gap >30 min — the entire universe S7 can draw from.
    Six clear the ≥4h span, and all six already fire `cache-idle`. The seventh
    (2.1h span, one 42-min gap) fires neither. S7 flags **zero** sessions the
    coach isn't already speaking to.
  - **That overlap is structural, not an artifact of this corpus.** S7's burst
    boundary and `CACHE_EXPIRY_MIN_GAP_MS` are the same 30 minutes, so both are
    subsets of "session has a ≥30 min idle gap". The only sessions S7 could own
    alone are those whose resumed context fell under the 100k re-write floor —
    exactly the cases where leaving the session open cost nothing.
  - **Span measures interruption, not topic change.** The gaps producing the
    "bursts" run 438–4,229 minutes: overnight and multi-day. Two of the six are
    a work block, an overnight gap, then a handful of events — one of them a
    single event. For that developer "/clear between unrelated tasks" isn't a
    weaker tip than `cache-idle`, it's a **wrong** one, and it would re-serve
    under a new id advice they may have already dismissed as `cache-idle`.
  - **The topic-proxy alternative was built and tested, and is worse.** Per-burst
    sets of `target_hash` restricted to file-shaped tools, with disjoint
    consecutive bursts as the topic-change signal: across 22 bursts, 5 have zero
    file targets and 9 have ≤2, so half the boundaries can't be judged at all.
    It fires on 2 sessions — both on sets of 1–4 files, where disjointness is a
    coin flip — and stays **silent** on the 157-hour, 7-burst session whose
    bursts overlap by 7–14 files each. `target_hash` can't support it anyway: it
    hashes `file_path ?? notebook_path ?? path ?? command ?? url`, so all 640
    Bash events carry a command hash indistinguishable from a file hash, and
    ~600 tool_use events (MCP, Task*, Agent, WebSearch) carry none. `cwd_hash`
    is no fallback — 1 of 47 sessions has more than one.

  What would revive it: a genuine topic proxy that isn't elapsed time — a cheap,
  content-free marker that the user *started something new*. Until such a signal
  exists, M1 stays `partial` and the idle-gap half of the story belongs to
  `cache-idle` (M19), which already measures it in tokens.

  Side finding, since chased and resolved: `repo_hash` was populated on **0**
  events — see the note below.

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
