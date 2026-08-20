# Coin — the REMY design language

One register, one persona: **the developer, inside their coding agent**.
Everything they see is fast, playful, and quantified — a video game, not a
report card.

This used to be a two-register document ("Coin & Ledger"): the Coin register
for the developer, a Ledger register for an engineering lead reading a
dashboard. The admin plane moved to a private repo when this one went open
source, and the Ledger half of this file went with it. What remains is the
whole design language of the shipped product.

---

## The spine

1. **Numbers are the product.** Every numeral is set in monospace/tabular
   figures. Every number carries a unit. Every cost claim carries its
   mechanism ("caught 3 context overflows → ~600k tokens").
2. **Deterministic honesty.** Exact values over vibes; estimates are flagged
   (`est.`, `~`). We never show a number we can't derive.
3. **Density over decoration.** Structure encodes information; ornament that
   encodes nothing gets cut.
4. **Speaks tech.** Terminal lineage, worn openly — ASCII, ANSI, emoji —
   over the discipline underneath it: alignment, density, monospace figures.
5. **Privacy is a design element.** Every surface says out loud what is and
   isn't collected, and that none of it leaves the machine.

---

## The Coin register

**Value delivered: light, inline insights.** One glance, one line, one
number. Never a report to study — a HUD to notice.

### Voice

Second person, warm, a little nerdy, never scoldy. Emoji and ASCII art are
native. 🪙 is the token unit on every Coin surface.
Loading-screen hints are core vocabulary, and every playful line still
carries an exact number.

| ✅ Coin | ❌ not Coin |
|---|---|
| `💡 Plan mode before big tasks — fewer wrong turns, fewer tokens.` | `Warning: plan mode usage below recommended threshold.` |
| `[🐭 REMY]: context at 85% — every reply re-reads 170k 🪙` | `Context utilization high. Consider compacting.` |
| `✨ clean session — nothing wasteful detected` | `No issues found.` |
| `~200k 🪙 recoverable` | `Potential savings detected.` |

### Mechanics (law, enforced in code)

- **Noise budget:** one active tip at a time; dismiss = 30-day snooze;
  warnings only for imminent context overflow.
- **Zero tokens:** the coach never calls a model and never adds to context.
- **Fast:** statusline < 50ms; hooks exit before any network I/O.
- **ANSI only in the statusline.** Report output is plain unicode (it lands
  in markdown blocks).
- **One constant statusline layout — always.** The statusline never
  restructures itself: same fields, same order, every render. Two things
  used to hijack the whole line — a tip/loading view while Claude was
  generating, and a red alarm view at ctx≥80% — and both moved off the
  statusline entirely onto the Stop-hook nudge (below). What's left colors
  in place instead of reshaping: the context percentage goes yellow at ≥60%,
  red at ≥80%, but the line keeps its shape. Current fields, in order: model
  (emoji + name) · context (`⚡ 48% ctx ▓▓▓░░` — percent + bar; the separate
  `[used/limit 🪙]` token-count badge was dropped as a duplicate of the same
  number) · the prompt-cache clock (`🔥 cache 52m`, yellow under 10 min;
  `🧊 cache cold` in cyan once it expires or the model changes —
  `cacheField()` in `cli/src/ui.ts`; mechanics in
  `docs/claude-code-surfaces.md`). It carries the word `cache` for the same
  reason the field before it says `ctx`: the line already holds four emoji, so
  a bare `🔥 52m` reads as a streak or a timer. Minute resolution, never
  seconds — the line repaints every second, and a number that moved on every
  repaint would be motion rather than information. It is the one field that
  earns its place on a *passive* HUD, because the cache drains while nothing
  happens and every other surface here is event-driven: the statusline is the
  only place that can speak during an idle window · git branch + dirty marker
  (`🌿 main ●`, the dot spaced off the
  name and yellow so it reads as state rather than as part of the branch;
  from a single `git status --porcelain=v1 --branch` call — absent outside a
  git repo) · session cost
  a **spend field, chosen by plan type — one or the other, never both**:
  session cost (`$1.23`) for API/pay-per-token accounts, or rate-limit %
  (`⏳ 42% (5h)`, whichever of the 5h/7d window is closer to its cap) for
  Claude.ai Pro/Max subscribers (`payload.rate_limits` present) —
  `spendField()` in `cli/src/ui.ts`. Nothing else: the `💡 1 tip` indicator
  and the dev build badge were dropped as noise (the statusline repaints
  every second, so anything static on it is a permanent banner — the tip
  belongs to the splash and the Stop nudge, the version to `remy version`).
  Streak (`🔥 Nd`), session cache-hit % (`💾`), and XP level (`⭐ Lv`) were
  all tried and dropped — streak/achievements/XP are gone from the product
  entirely (see below), and cache-hit was low-signal clutter even before
  that. A
  `refreshInterval` in the statusLine settings (installed by `remy init`)
  keeps these fields fresh between host-triggered repaints; without it the
  statusline only updates on session start, a new assistant message,
  `/compact`, or a mode change.
- **No gamification.** XP, levels 1–50, arcade tier titles, streaks, and
  achievement badges were all removed as redundant — the coaching signal is
  the tip itself, not a points system layered on top. The playful Coin
  register (🪙 token unit, the rat, ASCII art, emoji) stays; only the
  progression mechanics went. `packages/core/src/xp.ts` and the `xp_ledger`
  table are both gone; an existing local DB simply keeps an orphan table
  nothing reads, which is cheaper than a destructive migration.
- **Every coaching message is one format, everywhere — `[Brand]: {emoji}
  problem → solution → value`.** One function (`tipLine()` in
  `cli/src/ui.ts`) renders the statusline tag, the session-start splash
  line, and the Stop-hook tip nudge — they are byte-for-byte identical, not
  three related formats. The bracketed, colon-suffixed product name (`BRAND`
  in `core/src/catalog.ts` — currently "🐭 REMY") is the entire signal that a
  line is a coaching message — no separate persona voice, no other label
  needed. The two arrows are load-bearing: problem (what the coach saw, with
  a number) → solution (the one imperative action) → value (`+{est} 🪙`,
  omitted when there's nothing quantified — most wisdom tips). `TipDef.short`
  holds only `"{problem} → {solution}"` — no brand, no value clause, no
  `{est}` placeholder; `tipLine()` composes the rest: `[🐭 REMY]: 🔨 Same file
  edited 36×, 2+ misses → /clear + re-brief → +165k 🪙`. An earlier version
  voiced the Stop-hook nudge with a separate fictional mascot ("Byte:")
  instead of the bracket, specifically to avoid misattributing advice to the
  real experts cited in some tips (Boris Cherny, Simon Willison, Steve
  Yegge, Dex Horthy…) — dropped once it was clear the bracketed *product*
  name never had that problem in the first place; one consistent format
  everywhere is simpler and just as safe.
- **The Stop-hook nudge — where tips and the context alarm actually live.**
  The `Stop` hook fires a transient `systemMessage` right after a turn ends,
  so a tip lands at the same beat Claude Code's own native nudges do — the
  statusline stays passive HUD. Two nudges share this one channel, mutually
  exclusive per Stop (never both, so a turn ending never produces two
  systemMessages): an overflowing context takes priority as the more urgent
  problem.
  - **Tip nudge** — `tipLine()`, same as everywhere else: `[🐭 REMY]: 🔨 Same
    file edited 36×, 2+ misses → /clear + re-brief → +165k 🪙`. Throttled
    (`dueForStopNudge()` in `core/src/tips.ts`, `STOP_NUDGE_THROTTLE_MS` =
    10 min, tracked in its own `tip_memory.last_stop_nudge_at` column,
    deliberately **not** sharing a column with the splash's
    `last_shown_at` — a `/reload-plugins` or session resume re-fires the
    splash far more often than real turns happen, and an earlier version
    that shared the column let that silently reset this throttle right when
    it needed to fire).
  - **Context alarm** — `contextAlarmLine()`: `[🐭 REMY]: context at 92% —
    every reply re-reads 184k 🪙`. Fires at ctx≥80%, throttled tighter than
    the tip nudge (`dueForContextAlarm()`, `CONTEXT_ALARM_THROTTLE_MS` =
    3 min, keyed by session id in `sync_state`) — an active, worsening
    problem is worth repeating sooner than a coaching aside if `/compact`
    still hasn't happened.

  **One voice about context at a time.** While a session sits in alarm
  territory (≥80%), context-related tips (`context-band`, `auto-compact`)
  never take the tip-nudge slot — the live alarm owns the context story,
  and "you should have compacted at 60%" minutes after "compact now" is a
  second nag, not coaching. Those tips still reach the splash and `/remy`.
  Same principle at the rules layer: `context-band` doesn't file at all in
  a session where auto-compact already fired — one tip per incident.
- **The mascot appears once, not always.** The full halftone rat
  (`packages/plugin-claude-code/art/rat.txt`, 62 lines) is the README hero and
  the session-start welcome — but the welcome fires **once per version**
  (keyed on `sync_state.welcome_version`, so an upgrade re-introduces him and
  nothing else does), downsampled to 16 lines. Every routine session gets the
  three-line mark with the stats and tip beside it, tail running into the tip
  line. A session starts far more often than it feels like it does (`/clear`,
  resume, `/reload-plugins`); art on every one of them stops being art and
  becomes scrollback. Same reasoning as the noise budget, applied to pixels
  instead of words.
- **The spinner tip line — the coach's line during the wait.** Claude Code
  prints a rotating tip under its spinner (`└ Tip: Double-tap esc to
  rewind…`) and lets settings.json replace that deck
  (`spinnerTipsOverride`). The coach takes it: the **whole open finding
  queue** (best value first), or the `HINTS` deck when there's nothing to
  coach — still zero tokens (it's a file write, not a message). The host
  rotates between deck entries on its own, so the line **moves to the next
  finding by itself between waits** — dismissing is for silencing a tip for
  30 days, not for advancing the queue.
  **Wide-surface copy (`TipDef.live`, rendered by `tipLineLong()`).** Same
  skeleton as everywhere else — `[Brand]: {emoji} problem → solution →
  value` — but the problem clause is the long form, spoken to the player
  with the session's own numbers: `[🐭 REMY]: 🔨 you edited one file 56× this
  session, re-reading between tries → /clear and re-brief beats another go
  → +265k 🪙`. Every rule-backed tip carries one (≤110 chars rendered,
  enforced in `catalog.test.ts`, and it must contain a number from the
  evidence — advice without the receipt is off-register). Wisdom tips have no
  session evidence, so they fall back to `short`; the hint deck carries
  attributed quotes instead. That's the rule: **live evidence when we have
  it, a citation when we don't.**
  It's the only surface read *while waiting* rather than while acting, which
  is exactly when advice is cheap to absorb. Mechanics in
  `docs/claude-code-surfaces.md`. Two rules make it safe: **opt-in** (`coach
  spinner` claims it; hooks only refresh a line the coach already owns —
  silently rewriting a user's global settings is the same sin as
  auto-installing a tool), and **never clobber** (an override the coach
  didn't write is the user's; deleting the key by hand is a valid uninstall).
  Noise budget is unchanged — it's the same one active tip, shown where it's
  already being waited on, not an extra interruption.
- **Every tip shows its why — as labeled rows, idiot-proof by design.** In
  `/remy` a tip is never a paragraph; it's a scan-able ledger of rows:
  `what happened` (one sentence with the player's numbers — the analyzer's
  `🤖` line for adaptive tips, the `what` template for rule tips) ·
  `worth` (`~165k 🪙 back in your pocket`, only when > 0) · `next time`
  (one imperative action, the `fix` template) · `the experts`
  (`📖 "<quote>" — <author>` when cited). Advice without a mechanism or a
  source is off-register; tip copy lives in `what`/`fix` on each TipDef.
- **Adaptive Coach (the one model call):** out-of-band, ≤1/day, metadata-only
  payload (zod whitelist), silent on failure. Its output enters the same
  one-tip queue — noise budget unchanged. `/remy` footer states it plainly:
  `🤖 adaptive: on · last analyzed 3h ago · "remy adapt --off" to disable`.

---

## Application map

| Surface | Register |
|---|---|
| statusline, splash, `/remy*` output, CLI stdout, tip catalog copy | Coin |
| README, GitHub page | Marketing voice per CLAUDE.md — may quote Coin surfaces in their own styling |

## Change control

CLAUDE.md remains the product source of truth; this document is the
**design** source of truth and is referenced from it. A change that adds a
surface, moves one out of the Coin register, or alters the noise budget
updates this file in the same PR.
