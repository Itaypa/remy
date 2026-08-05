---
name: night-shift
description: Run the autonomous overnight loop for REMY. Each cycle is one of three kinds — a research cycle that sweeps the web for trending Claude Code usage mistakes and anti-patterns and puts two different-model-family agents (Opus and Fable) in a council to turn them into a spec, then builds that spec in the same cycle; a build cycle that takes the top spec or backlog row from idea to a green commit on main; and a morning cycle that writes and opens a concise HTML report. Use whenever the user is going to sleep / stepping away and wants work to continue unattended, says "burn the backlog", "keep building while I sleep", "use up my remaining quota", "research what people are getting wrong", or asks to start or stop the night loop. This replaces the old /feature-cycle command.
---

# Night shift — unattended research, build, and report

One invocation = **one cycle**. At the end of a cycle you schedule the next one and your
context resets, which is the whole point: a fresh context per cycle is what lets this run
for eight hours without degrading. Never try to do a whole night in a single turn.

There are three kinds of cycle:

| Cycle | When it runs | What it produces |
|---|---|---|
| **Research** (§2–§4, then straight on into §5–§7) | first cycle of the night, and whenever the build queue empties | a trend dossier, a council verdict, a committed spec — and the detector built from it |
| **Build** (§5–§7) | every cycle with a spec or `backlog` row available | one green, revertible commit on `main` |
| **Morning** (§9) | after 08:00, or when a stop condition fires | `.claude/night-shift/report-<date>.html`, opened |

The user is asleep. Nobody will answer a question, unblock a stall, or notice a
half-finished refactor. Every rule below exists because of that: prefer **finishing one
small thing cleanly** over starting something ambitious you can't land.

## The one hard gate

**A cycle commits only when `bun test` and `bun run typecheck` both pass.** Red or
blocked means you commit nothing, log why, and move to the next item. Work lands directly
on `main` here (the user's explicit call), so the test suite is the only thing standing
between a bad idea and their Monday morning — do not weaken it, do not skip a failing
test to get a commit, do not commit "mostly working."

## 1. Guard — run first, every cycle

```bash
git status --porcelain
date "+%H:%M %A"
```

- **After 08:00 local → run the morning cycle (§9) and stop.** The user's approval gate
  reasserts by day; unattended commits to `main` are a night-only authorization.
- **Record the dirty set.** Any file already modified at cycle start belongs to the user.
  Never stage it, never revert it, never `git add -A` / `git commit -a`. Stage explicit
  paths only. If your item genuinely needs a file the user is mid-edit in, skip the item
  and take the next one — their uncommitted work outranks yours.
- **Three consecutive cycles with no commit → morning cycle and stop.** That pattern means
  something structural is broken (bad env, wrong assumption, flaky suite) and burning six
  more hours on it wastes the quota rather than spending it.

Then pick the cycle kind: is there an unbuilt spec in `docs/specs/` or a `backlog` row in
`docs/waste-signals-backlog.md`? Build cycle. Nothing queued? Research cycle.

---

# Research cycle

## 2. Sweep — what are people actually getting wrong *with Claude Code*

The subject is **how developers drive Claude Code and agentic coding tools**, not software
anti-patterns in general. "God object" is not our beat. "Everyone lets the context hit 95%
before compacting" is.

Load the tools first — they're deferred: `ToolSearch("select:WebSearch,WebFetch")`.

Read `docs/trend-watch.md` **before searching** (create it on the first night). It is the
loop's memory across nights: every finding already considered, with its verdict. Do not
re-propose something it already rejected, and don't spend the night's searches
rediscovering last night's findings.

Sweep 6–10 searches across genuinely different source types — one source type agreeing
with itself is not a trend:

- **Anthropic's own material** — engineering blog, Claude Code docs and release notes, the
  best-practices posts. Changes here move the ground truth: a new hook event or a new
  `/command` can make a previously undetectable mistake detectable, and can also make one
  of our shipped tips obsolete. Flag both.
- **Practitioner writeups** — blog posts and newsletters on driving Claude Code, CLAUDE.md
  patterns, subagent and context strategy, cost postmortems.
- **Community friction** — HN threads, r/ClaudeAI, X/Bluesky, GitHub issues on
  `anthropics/claude-code`. This is where the *real* waste shows up, because people
  complain about what actually costs them money and time.

For each candidate finding, capture: the mistake in one line, who reports it and where,
how often it shows up, and the claimed cost. **Discard anything you can only detect by
reading prompt or code content** — that is structurally out of bounds (see the privacy
invariant in `CLAUDE.md`), and carrying it into the council wastes the council.

Write the dossier to `docs/trend-watch.md` as a dated section: findings, sources,
and — later in the cycle — the verdict each one got.

## 3. The council — two model families, made to disagree

Spawn **two** subagents with explicitly different models. The point is not two opinions;
it is two priors. If they agree on everything, the round failed.

- **Seat A — `model: 'opus'`.** Lens: *feasibility and invariants.* Can this be detected
  from metadata we already store, or could store within the privacy invariant? What does
  the detector look like in `packages/core/src/rules.ts` terms? Where does it false-positive?
- **Seat B — `model: 'fable'`.** Lens: *user value and surfacing.* Would a developer
  change behavior because of this tip? Is it something they can act on tonight? Which
  surface carries it — statusline, splash, `Stop` nudge, spinner, `/remy` — given that the
  noise budget allows exactly one active tip at a time?

Give both the same dossier and the same three questions: **is it real, can we measure it
from metadata, and how would we surface it without spending the noise budget badly.**
Require each to name the strongest candidate *and* to name at least one finding it thinks
should be rejected outright.

Then make them actually consult. Load `ToolSearch("select:SendMessage")`, hand each seat
the other's position verbatim, and require a rebuttal round: what the other got wrong,
what it conceded, and where the disagreement is now narrowed to a single decision. Two
rounds is the budget. If they still disagree after round two, **you** decide and record
the losing argument in the spec — an unresolved objection written down is worth more than
a forced consensus.

The council's product is a ranked shortlist with reasons, not prose.

## 4. The spec

Write **one** spec — the top candidate only — to `docs/specs/<id>-<slug>.md`, where `<id>`
is the next free `S<n>`. A spec is buildable when a fresh context with no memory of the
council can implement it without guessing:

```
# S12 — <name>

**The mistake** (one paragraph, in the user's terms, with the cost)
**Trend evidence** — sources, how widespread, dated
**Detection** — exact signal, exact thresholds, and why those numbers
**What it must NOT fire on** — the negative cases, concretely
**Storage** — every new field, and why it's metadata-only (or: nothing new)
**Surface** — which channel, what suppresses it, what it suppresses
**Tip copy** — draft `short` (≤55 rendered chars) and long form
**Tests** — the fixtures to write, including the negative one
**Open objection** — the council disagreement, if any survived
```

Then append a row to `docs/waste-signals-backlog.md` linking the spec, status `spec`, and
record each dossier finding's verdict in `docs/trend-watch.md` (`spec'd`, `rejected — why`,
`out of scope — content-dependent`). Commit all three files together, on their own — the
research is worth keeping even if the build that follows goes red.

**Then build it in this same cycle.** Continue into §5–§7 with the spec you just wrote,
skipping the "pick the work" step: read the real code, run the adversarial review, build,
verify, and land the detector as a second commit. Same hard gate — green or nothing.

One escape hatch: if the sweep and the council have already eaten the context, or the
build stalls, stop after the spec commit and reschedule. The spec is durable and a fresh
context builds it next cycle — a spec read cold is also a fair test of whether it's any
good. Take that exit deliberately, not as a way to avoid a hard build.

---

# Build cycle

## 5. Pick and plan

Take the top spec in `docs/specs/` that isn't shipped; if there are none, take the topmost
`backlog` row in `docs/waste-signals-backlog.md` (already priority-ordered: measurable
token waste × detection confidence ÷ effort). One item per cycle.

Confirm nobody beat you to it: `git log --oneline -20 main` and grep the codebase for the
tip id. A backlog row can be stale.

Read the actual code before planning: `packages/core/src/rules.ts` for detector shape,
`catalog.ts` for tip copy, the matching `test/*.test.ts` for the fixture style. Ground the
plan in what you read, not in what the spec says — the spec was written before the code
was open.

Then spawn **one** Opus subagent (synchronous, one round, no ping-pong) to attack the plan
adversarially against the real codebase:

- Does it hold the **privacy invariant**? Metadata only — enums, 16-hex hashes,
  charset-constrained strings with no `/`. Any new stored field that could carry free text
  is a defect, not a tradeoff. Anything that widens storage must update
  `packages/core/test/privacy.test.ts` **in the same commit**.
- Does it stay **deterministic**? No model call anywhere in the statusline/hook/rules
  path. `remy adapt` is the only exception in the product and you are not extending it.
- **False positives**: a wrong tip is worse than silence. Check thresholds against
  realistic sessions, not the happy path the spec imagined.
- What the plan forgot: suppression interactions with existing rules, sessions with
  missing data, the first-run case.

Fold the critique in. If the critique says the item is a bad idea, that's a legitimate
outcome — set the row to `dropped` with the reason and take the next item. A cycle that
correctly kills a bad detector is a good cycle.

## 6. Build

Follow the conventions in `CLAUDE.md` and, more reliably, the ones visible in the
surrounding code:

- Detector in `packages/core/src/rules.ts`, thresholds as named `const`s at the top like
  every existing rule (they're the tuning surface — inline magic numbers hide it).
- Tip copy in `catalog.ts`: `[Brand]: {emoji} problem → solution → value`, `short` ≤55
  rendered chars, no brand/est/🪙 inside `short`.
- Tests are not optional and not an afterthought: detector unit tests in `rules.test.ts`
  or `transcript.test.ts`, catalog sample evidence in `catalog.test.ts`. Include a
  **negative** test — the session that looks like the pattern but shouldn't fire. That's
  the test that protects the user from a wrong tip, and the one a rushed cycle skips.
- No gamification (XP, levels, streaks, achievements) — deliberately removed.
- No network client. `core/src` containing `fetch`/WebSocket/`node:http` fails the privacy
  suite by design.

## 7. Verify, commit, record

```bash
bun test && bun run typecheck
```

If the item touched the plugin surface (hooks, statusline, commands, launcher), also
exercise it for real via the **`run-remy` skill** — the statusline and hooks have failed in
ways only a real boot revealed. Read the output; "tests passed" that you didn't actually
read is how a night shift produces eight commits and one working feature.

Stage explicit paths (never the user's dirty set) and commit to `main`:

```
<subject in the repo's voice — what changed and why, not "implement S12">

<body: what it detects, the threshold and why that number, what it deliberately
does not fire on>

Night-Shift: S12
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

The `Night-Shift:` trailer is the safety net: morning review is
`git log --grep="Night-Shift:" --oneline` and dropping one bad cycle is a single
`git revert`. One commit per cycle keeps that true. Update the spec's row to `shipped` in
the same commit — those files are the loop's memory across context resets, and a stale
status makes the next cycle redo your work.

- **Cycles that don't commit** (blocked, red, dropped, skipped) append one line to
  `.claude/night-shift-log.md` — item, what happened, what a human would need to decide —
  committed on its own. Without it, a no-commit cycle vanishes at the context reset and the
  next cycle repeats the same dead end.
- `ScheduleWakeup` with `delaySeconds: 60` and the same `/night-shift` prompt. The cycle
  itself is the pacing — it takes as long as it takes — so there's no reason to idle. The
  goal is to spend the night's quota, not to ration it.
- Send a PushNotification only for things worth waking up for: the loop stopping, or a
  discovery that changes the plan. Not one per cycle.

**Note on quota:** there's no API that reports remaining quota, so the loop can't pace
against it. It runs until a stop condition fires or requests start failing. That's the
intended behavior — don't invent a self-imposed budget.

## 8. Overflow — nothing queued and the sweep came back dry

Research is the primary generator now, so reach here only when a research cycle produced
nothing worth speccing. Work this ladder in order.

**Rung 1 — fix what's actually broken.** Full suite, `bun run typecheck`, `bun run build`,
`bun run preflight`, and boot the product via `run-remy`. Reality-testing beats new surface
area and is least likely to need a human.

**Rung 2 — harden weak tests.** Tests that would pass against a broken implementation:
assertions on `.length` alone, detectors with no negative case, error paths never
exercised, fixtures that don't resemble real transcripts. `privacy.test.ts` is the
highest-value target in the repo — it's the executable form of the product's core promise.
Strengthen in place; a hundred shallow tests is not progress.

**Rung 3 — mine `docs/mistake-taxonomy.md`.** Rows marked `partial`, `planned`, or `not
planned` are the seam. The only question that matters: *is there a metadata-only signal
that fires on the real mistake and stays silent otherwise?* If yes, spec it (§4). If the
honest answer is "only with prompt content," move it to Out-of-scope — writing that down is
also progress.

**Rung 4 — new product ideas**, only within the narrative in `CLAUDE.md`: local,
zero-token, deterministic coaching. No server, no network path, no account, no sync. If
nothing here is defensible, stop the loop and say so; inventing scope to fill hours is how
a night shift produces work the user deletes.

---

# Morning cycle

## 9. The HTML report

Write `.claude/night-shift/report-<YYYY-MM-DD>.html` and open it:

```bash
mkdir -p .claude/night-shift && open .claude/night-shift/report-<date>.html
```

Build it from evidence, not memory: `git log --grep="Night-Shift:" --since="yesterday 18:00"`,
the diffstat per commit, `.claude/night-shift-log.md`, tonight's `docs/trend-watch.md`
section, and the spec files written. Never report a commit you can't see in `git log`.

**The report is one card per feature developed, and every card is Why / How / What.**
That's the format — no other shape, no essay:

- **Why?** — up to 5 sentences. The mistake developers are making with Claude Code, what
  the research found about how widespread it is, and what it costs them. This is where the
  trend evidence goes; name the sources.
- **How?** — up to 5 sentences. How REMY detects it: the signal, the exact threshold and
  why that number, what it deliberately stays silent on, and what the council argued about
  (including a surviving objection, if there was one).
- **What?** — up to 5 sentences. What actually got built and what the user will now see:
  the tip copy, the surface it appears on, the tests that hold it, and its `git revert`
  hash so a bad one is one command away.

**Up to 5 sentences means up to 5.** Three good ones beat five padded ones, and a card that
runs long defeats the point of the format. Write per feature, not per commit — a spec and
its implementation are one card.

Around the cards, only this:

1. **Headline row**, above the cards — cycles run, features landed, tests before → after,
   hours spent.
2. **Do these first**, immediately under the headline — the 2–4 things needing a human,
   each with why it wasn't done unattended. This is the part the user actually reads.
3. **Also tonight**, after the cards, kept to a list: trend findings that were *rejected*
   and why (a well-argued rejection is a result), specs written but not built, and
   skipped/blocked cycles from the log with the decision each needs.

Single self-contained file — no CDN, no external fonts, no network requests at all (this
repo of all repos). Follow `docs/design-language.md`: Coin, playful, 🪙 as the token unit,
emoji headers, dark-on-light with a `prefers-color-scheme: dark` variant. It should read
in two minutes.

Report the path in your final message too, in case the `open` didn't surface a window.

Then `ScheduleWakeup {stop: true}` and one PushNotification saying the night is done and
the report is open.

## What a good morning looks like

The user wakes to a handful of small, individually revertible commits on `main`, each one
green, each explaining its own thresholds — plus a report where each feature answers, in
fifteen sentences flat, why it exists, how it detects, and what they'll now see. Two
minutes to read the night, and one `git revert` to undo any part of it.
