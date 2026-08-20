# Claude Code surfaces used by the remy adapter

Quick reference for the host integration points and the payloads we consume.
Everything here is metadata — the privacy gate (`packages/core/src/schema.ts`)
is the only door into the store.

## Hooks (`hooks/hooks.json`)

Seven events are registered, all piping their stdin JSON to `remy ingest`.
Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.

| Event | Extra fields we use | What ingest does |
|---|---|---|
| `SessionStart` | `source` (`startup`/`resume`/`clear`/`compact`) | upsert session; on `startup` emit the splash via `systemMessage` JSON output (shown to the user, never added to model context) |
| `PostToolUse` | `tool_name`, `tool_input` (hashed target only) | record tool event, bump counters. **Fires only when a tool call succeeds** |
| — | `agent_id` rides on **every** hook fired from inside a subagent (a tool called by an AgentTool worker) and is absent on the main thread. It is the host's stated way to tell delegated calls from your own — see S10 in the backlog. We do not read it yet, which is why the counters include the agent's own work | |
| `PostToolUseFailure` | same | the failure half — without it `tool_fails` is structurally always 0 |
| `PermissionDenied` | — (payload deliberately unread) | bump `sessions.perm_denials`, print nothing |
| `PreCompact` | `trigger` (`auto`/`manual`) | record compact; `auto` immediately files an auto-compact finding |
| `Stop` | — | full transcript parse → session aggregates → rules → tips, then (see below) at most one transient `systemMessage` nudge |
| `SessionEnd` | — | same as Stop's transcript analysis + set `ended_at` |

**Permission hooks — what we register and what we refuse to.** `PermissionDenied`
is reactive: it fires after the auto-mode classifier has already refused a call,
and its stdout is read only for a `{"hookSpecificOutput":{"retry":true}}`
directive. We register it and print nothing, so it is purely an observation. Its
sibling **`PermissionRequest` is deliberately NOT registered**: there, exit 0
means "use the hook's decision if provided", so a process in that position can
allow or deny tool calls on the user's behalf. A coaching tool has no business
in the approval path, and `ingest` already prints JSON on two other branches —
one careless refactor is all it would take. (Note also that a non-zero exit on
these events is *not* ignored: it surfaces stderr to the user. REMY exits 0
unconditionally, so this cannot bite, but the contract is not "silent".)

Hook output contract: exit 0 always (a coaching tool must never break the
host); errors go to `~/.remy/remy.log`. `Stop`'s payload can carry raw
assistant response text (`last_assistant_message`) — `remy ingest` parses
its stdin defensively and logs a **fixed** string on a parse failure, never
the raw input, since V8's `JSON.parse` SyntaxError embeds a fragment of it.

`SessionEnd` may also spawn a **detached** `remy adapt --auto` child (once a
day at most, stdio ignored) — the hook process exits before the local
`claude -p` call begins. The statusline never spawns anything, and nothing
here ever touches the network.

## Stop-hook nudges

The `Stop` hook can fire at most one transient `systemMessage` per turn,
mutually exclusive between two kinds — never both, so a turn ending never
produces two messages:

1. **Context alarm** (checked first — the more urgent problem): fires when
   `sessions.max_context_pct >= 80`, throttled to once per
   `CONTEXT_ALARM_THROTTLE_MS` (default 3 min, `core/src/tips.ts`
   `dueForContextAlarm`/`markContextAlarmShown`, keyed by session id in
   `sync_state`). `contextAlarmLine()` in `cli/src/ui.ts`: `[🐭 REMY]: context
   at 92% — every reply re-reads 184k 🪙`.
2. **Tip nudge**: fires when a tip is active and due, throttled to once per
   `STOP_NUDGE_THROTTLE_MS` (default 10 min, `dueForStopNudge`/
   `markStopNudgeShown`, tracked in `tip_memory.last_stop_nudge_at` — its
   own column, deliberately not shared with the splash's `last_shown_at`,
   which a `/reload-plugins` or session resume re-fires far more often than
   real turns happen). Renders via `tipLine()` — the exact same function and
   output as the statusline tag and the splash line: `[🐭 REMY]: 🔨 Same file
   edited 36×, 2+ misses → /clear + re-brief → +165k 🪙`. While the session
   is in alarm territory (≥80%), context tips (`context-band`,
   `auto-compact`) never take this slot — one voice about context at a time;
   they still reach the splash and `/remy`.

Both use the bracketed `BRAND` tag (`core/src/catalog.ts` — currently
"🐭 REMY"), not a separate voice. An earlier version voiced the tip nudge with
a fictional mascot ("Byte:") specifically to avoid misattributing advice to
the real experts some tips cite — dropped once it was clear the product
name in brackets never had that problem to begin with.

Confirmed empirically (not just per docs) that `systemMessage` renders for
`Stop` in Claude Code 2.1.212: a minimal hand-written test hook
(`echo '{"systemMessage": "..."}'` registered directly in
`.claude/settings.local.json`) displayed as `└ Stop says: ...` in the
transcript. The `└ <HookName> says:` attribution is fixed host UI — also
confirmed empirically that adding `"suppressOutput": true` to the same JSON
output does **not** remove or change it. There is no known field that
suppresses or relabels it; don't spend time hunting for one again.

## Statusline

`settings.json` → `statusLine.command` runs `remy statusline`; stdin
carries `session_id`, `transcript_path`, `model.{id,display_name}`,
`workspace.current_dir`, `cost.total_cost_usd`, `rate_limits.
{five_hour,seven_day}.used_percentage` (Claude.ai Pro/Max only, absent
otherwise), and (recent hosts) `context_window.{total_input_tokens,
total_output_tokens,context_window_size,used_percentage,...}`. `remy init`
also writes `refreshInterval: 1` into the statusLine block — **the unit is
seconds**, not ms (schema: `v.number().min(1)`, "re-run the status line
command every N seconds"). Claude Code repaints the statusline on session
start, a new assistant message, `/compact` finishing, permission-mode/
vim-mode changes, and the `refreshInterval` timer — nothing else, so without
the timer the last render freezes for the length of a tool run or a quiet
thinking block. `remy init` merges into the existing `statusLine` block
rather than replacing it, preserving any `padding` / `hideVimModeIndicator`
already set.

Context size prefers `context_window` straight off the payload — no file
read — and falls back to tailing the last 256KB of the transcript on older
hosts that don't send it yet. The host-reported `context_window_size` is
also persisted to a `sessions.context_window` column, so
the rules engine measures red-zone/context percentages against the REAL
window instead of an assumed 200k — a 170k-context turn is red on a 200k
window but healthy on a 1M one. **Use `total_input_tokens + total_output_tokens`,
not `used_percentage`**: the host's `used_percentage` excludes output tokens,
while every other context number in this codebase includes them (contextOf()
in `packages/core/src/transcript.ts`) — using it would silently disagree with
the rest of the app. The tail-read fallback honors compact boundaries: a
`{"type":"system","subtype":"compact_boundary"}` entry carries
`compactMetadata.postTokens` (the exact post-compact context size), so between
a `/compact` (or auto-compact) and the next assistant reply the number resets
to `postTokens` instead of freezing at the stale pre-compact usage — this is
also why the tail read stays as a fallback rather than being deleted outright:
`context_window` is host React state and may lag a `/compact` by one reply.
Render budget: <50ms (measured ~38ms); with the timer running ~1/s per
session, the statusline also skips its DB write when nothing changed since
the last tick, so a quiet session stays read-only.

**One constant layout, always** — no alarm view, no tip/loading view (both
moved to the Stop-hook nudges above). Fields, in order: model (emoji + name)
· context (`⚡ 48% ctx ▓▓▓░░` — percent + bar, colored yellow at ≥60% / red
at ≥80%, but never restructuring the line) · **prompt-cache clock**
(`🔥 cache 52m` / `🧊 cache cold`, see below) · git branch + dirty marker
(`🌿 main ●`, the dot spaced and yellow so it isn't read as part of the
branch name; one `git status --porcelain=v1 --branch` subprocess, absent
outside a git repo — `gitStatus()` in `cli/src/index.ts`) · one **spend
field, chosen by plan type — never both**: session cost (`$1.23`) for
API/pay-per-token accounts, or rate-limit % (`⏳ 42% (5h)`, whichever of the
5h/7d window is closer to its cap) for Claude.ai Pro/Max subscribers
(`payload.rate_limits` present) — `spendField()` in `cli/src/ui.ts`, which
chains `rateLimitBadge() ?? fmtCost()`. That's the whole line — a pure HUD.
(A `💡 1 tip` link, the dev build badge, a session cache-hit % field, and
gamification — XP level, streak — were all tried and dropped; the tip renders
in the splash and the Stop-hook nudge, the version in `remy version` and the
splash. See `docs/design-language.md`.) The 🪙
coin is the brand's token unit. ANSI is allowed here and only here.

### The prompt-cache clock

`cacheField()` in `cli/src/ui.ts`. How long this session's prompt cache has
left — `🔥 cache 52m` while warm, yellow under 10 minutes, `🧊 cache cold`
(cyan) once it has expired or the model has changed. Minute resolution, never
seconds: the line repaints ~1/s and a per-repaint number would be motion, not
information. It carries the word `cache` for the same reason the context field
says `ctx` — the line already has four emoji and a bare `🔥 52m` reads as a
streak or a timer.

**Why it lives here and nowhere else.** Every other REMY surface is
event-driven, and the cache drains while *nothing happens*. The statusline is
the only surface that can speak during an idle window, which is exactly the
window that costs money: a warm cache re-reads the context at 0.1× the input
price, a cold one re-writes it at 2× (1-hour TTL), so resuming a fat session
cold is ~20× resuming it warm. `cache-idle` in the catalog is the retrospective
half of the same story; this is the half that arrives before the spend.

**Three stored values, none of them assumed** (`sessions.cache_ttl_ms`,
`cache_anchor_at`, `cache_model` — see the migration comment in
`core/src/store.ts`):

- **TTL** is read off `usage.cache_creation.{ephemeral_1h,ephemeral_5m}
  _input_tokens` during the Stop-hook transcript parse. Claude Code buys the
  **1-hour** cache — all 9,713 cached turns in the local corpus are
  `ephemeral_1h`, zero are 5-minute — but the raw API default is 5 minutes and
  a session can drop to it under usage overage, so it is measured per session.
  Mirrored to a machine-wide `sync_state` key so a session's first tick has a
  number. Never observed → the field renders nothing rather than a guess.
- **Anchor** is stamped by `touchCacheAnchor()` from the four hooks that fire
  at an API round-trip boundary (`SessionStart`, `PostToolUse`,
  `PostToolUseFailure`, `Stop`) — never by the statusline, which must stay
  read-only on a quiet session. Note the API measures the TTL from the *start*
  of the request, not the end of the response, so the anchor is generous by one
  response duration; immaterial at minute resolution on an hour clock, but read
  this before tightening the display.
- **Model** — the cache is per-model, so a `/model` switch reads as cold
  regardless of the clock. Switching *back* to a model used minutes ago also
  reads as cold: it understates warmth, which is the safe direction.

The statusline itself opens no transcript for any of this — it reads the
session row it was already fetching.

## Spinner tip line (`spinnerTipsOverride`)

The line the host prints under the spinner while it works —
`Forging… (2m 30s · ↓ 8.3k tokens) └ Tip: Double-tap esc to rewind…`. It is
**configurable**, which makes it REMY's fourth zero-token surface and the
only one a developer reads *while waiting* rather than while acting.

Host mechanics (settings.json; verified against Claude Code 2.1.220):

```jsonc
"spinnerTipsEnabled": false,                                  // kill the line entirely
"spinnerTipsOverride": { "excludeDefault": true, "tips": ["…"] },
"spinnerVerbs": { "mode": "replace", "verbs": ["Coaching"] }  // even "Forging…" is configurable
```

- Custom tips are built with `cooldownSessions: 0` and `isRelevant: () => true` —
  they skip every gate the host's own ~50 tips pass through, and
  `excludeDefault: true` removes those from the pool entirely.
- The picker takes the **least-recently-shown** entry (sessions since last
  shown, desc; ties by priority), keyed by position (`custom-tip-N`). So a
  one-entry array = that line, every wait; a multi-entry array = host-run
  rotation for free.
- The host reads settings at startup, so the SessionStart write is what sets
  the line for the session that follows.

REMY's side (`cli/src/spinner.ts`, `remy spinner`):

- **Opt-in, never automatic.** Hooks (SessionStart, Stop) only *refresh* a line
  REMY already owns; `remy spinner` is the one write that creates the key,
  `--off` removes it. Deleting the key by hand is a valid uninstall — REMY then
  leaves it alone. Nothing ever installs itself.
- **Never clobbers**: an override REMY didn't write (tracked in
  `sync_state.spinner_tips_written`) is the user's and is left untouched;
  malformed settings are left untouched; writes go temp + rename so a crash
  can't leave a half-written global config.
- Content = the open finding queue (`openTips()`, best value first, capped at
  5) rendered by `tipLineLong()` — the `TipDef.live` template, which speaks
  the session's own evidence ("you edited one file 56× this session…") — or
  the whole `HINTS` deck when there's nothing to coach. Multiple entries are
  the point: the host rotates them, so the queue advances between waits
  without a dismiss. `REMY_SPINNER=0` disables all writes;
  `REMY_SETTINGS_PATH` retargets the file in tests.

## Commands

Plugin commands (`commands/*.md`) reference the binary via
`${CLAUDE_PLUGIN_ROOT}` and instruct the model to display `remy report`
output verbatim. Report output is plain unicode (no ANSI) because it lands in
a markdown code block.

## Context limit

`contextPct` assumes a 200k window; override with `REMY_CONTEXT_LIMIT` for
1M-context models until model→limit mapping ships.

## Known verify-on-install items

- `systemMessage` display on SessionStart and Stop JSON output (confirmed
  live on 2.1.212 for both; fallback: statusline boot state).
- `${CLAUDE_PLUGIN_ROOT}` substitution inside command markdown bodies.
- `refreshInterval` actually repaints the statusline on the installed host
  version (confirmed in Claude Code 2.1.212; verify on your oldest supported
  version before relying on it).
- Whether `context_window.current_usage` on the statusline payload updates
  immediately after `/compact` or lags until the next assistant reply — if it
  lags, the number should keep preferring the transcript-tail fallback over
  the payload value until it does.
- `git status --porcelain=v1 --branch` output shape on very old git versions
  (the `## branch...upstream [ahead N]` header format) — not exhaustively
  tested outside recent git.


## `InstructionsLoaded` — the surface we are not using yet

Discovered 2026-08-07 (sweep 6). The host fires a hook reporting exactly which instruction
files it loaded, which is the ground truth REMY's `claudemd.ts` probe currently
approximates by walking the filesystem itself.

Payload, read from the 2.1.220 binary rather than the rendered docs:

```
{ hook_event_name: "InstructionsLoaded", file_path, memory_type, load_reason,
  globs, trigger_file_path, parent_file_path }
memory_type ∈ User | Project | Local | Managed
load_reason ∈ session_start | nested_traversal | path_glob_match | include | compact
```

**There is no `file_content` field**, contrary to the rendered documentation — do not
design around one.

Verified live against a fixture: it fires for the root CLAUDE.md, for unscoped
`.claude/rules/*.md`, and for each hop of an `@path` import chain (with `parent_file_path`
set), and correctly stays silent for `paths:`-scoped rules, subdirectory CLAUDE.md files,
and a backticked `` `@README` ``. It does **not** fire for auto memory.

**Why it is not registered.** One `remy` process spawn per instruction file, measured at
~32 ms each. A monorepo with twenty unscoped rules would add ~640 ms to session start and
twenty contending WAL writers — the hook-spam pattern this project rejected as a coaching
target in `docs/trend-watch.md` (sweep 3, H1b), and it would be worse to commit it
ourselves. `nested_traversal` and `path_glob_match` also make the count unbounded per
session. Its results arrive after the SessionStart splash has already rendered.

The shape that would work: a matcher limited to `session_start|include`, a hook that only
appends a line to a file, and one ingest at SessionEnd.
