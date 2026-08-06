# Night-shift log

Committed cycles are in `git log --grep="Night-Shift:"`. This file holds the
morning report and any cycle that produced no commit.

---

# Morning report — night of 2026-08-04 → 05

29 cycles, 30 commits, all on `main`, each individually revertible via its
`Night-Shift:` trailer. Suite went 170 → 257 tests; line coverage 88.9% → 95.9%.

## Do these three first (each needs a human, none takes long)

1. **`bun run build`.** `~/.remy/bin/current` is `0.3.1+dfe56dd` from 23:55 and
   predates every fix below, so none of them are live for you yet. Not run
   unattended: it replaces the statusline and hooks, the launcher fails
   silently, and a bad build would mean silently no coaching with nobody
   watching.
2. **Run `/compact` once, then check `compacts_manual`** on the newest session.
   No compaction has happened since `PreCompact` was registered, so whether it
   fires is genuinely unknown. A 1 closes the question. A 0 makes it urgent —
   `auto-compact` (~60k 🪙, the catalog's largest) is filed only from that
   branch.
3. **Decide what `/remy`'s tool counts mean** (S10). They currently include
   subagent work while the tips beside them are main-chain only. Two defensible
   designs, both ~10 minutes; the choice is about what the report says, not a
   bug fix.

## What was actually broken, and is now fixed

- **The statusline lost 192 database races in one day.** `busy_timeout` was set
  on the line *after* the statement that needed it, so raising it from 250ms to
  2000ms had never helped. Reordering is the whole fix; verified at 960
  contended opens (old: 8–68 failures per run, new: 0) and again at 480
  concurrent compiled-binary invocations.
- **Tool failures were never counted.** `PostToolUse` fires only on success;
  `PostToolUseFailure` was never registered, so `tool_fails` was 0 across 2,125
  calls for the product's entire life. `/remy` said "0 failed" always, and the
  adaptive coach was told you never fail a tool.
- **The statusline could print `{edits}` at you.** The adaptive analyzer files
  tips with no session evidence and may pick any catalog id, so rule-backed
  templates rendered raw. Now falls back to the tip's title.
- **`bun test` was writing into your real `~/.remy` log.** 164 `[spinner]`
  entries in a live diagnostic file, from a test fixture.
- **S4 shipped**: `claude-md-missing` / `claude-md-prune`, resolving the memory
  family the host actually loads rather than just cwd.

## What was deliberately *not* built

Four proposals died on measurement, which is the point of measuring:

- **S5** (whole-file rewrites) — fires on 3 of 50 sessions, a third of them on
  plan/memory markdown where the advice is wrong; ~1k tokens of real waste.
- **S7** (marathon sessions) — its firing set is a strict subset of
  `cache-idle`'s. Measures interruption, not topic change.
- **S8** (persist `cmd_class`) — deferred; the events table folds subagent work
  into the parent, so it would measure a different population than the rules do.
- **`remy doctor`** — proposed and killed: its checks would have been green
  through both bugs they were meant to catch.

## One retraction

I reported that `PreCompact` appears never to fire, near-certain, citing a
compaction inside a session REMY was recording. Wrong: the hook was registered
at 21:58 that evening and every recorded compaction predates it. I had conflated
"REMY was recording" with "this hook was registered". Corrected in the backlog;
item 2 above is what settles it.

## Standing tools

- `bun run mutate` — breaks one invariant at a time in a throwaway worktree and
  fails if the suite doesn't notice. 35 entries, 34 caught, 1 documented
  accepted survivor. Two harness bugs were found and fixed by using it.
- `preflight` now derives its hook checks from source rather than a hardcoded
  list that had stopped growing.

## Why the loop stopped

The backlog is resolved, rung 1 is clean and re-verified, coverage is 95.9%
with what remains being `ansi()`, `binDir()` and defensive catches, and rung 3's
findings are recorded. Continuing would have meant adding marginal commits that
make the ~8 that matter harder to find. Restart any time with `/night-shift`.


---

## 2026-08-06 01:15 — verification cycle, one item for a human

**Mutation harness run against HEAD (`caf9457`): 35/37 caught, 1 accepted survivor,
1 STALE entry.** The stale one is mine, and it is a one-line fix I could not make.

`scripts/mutation.ts` pins `ModelStr`'s regex to defend "model ids are charset-gated, so
no free text rides in on them". Tonight's first commit (`c67d4cd`) widened that regex to
admit the bracket and angle forms the host actually emits (`claude-opus-5[1m]`,
`<synthetic>`), so the entry's `from` string no longer matches anything and the harness
skips it. The harness's own header says widening the whitelist means editing this catalog
too — that is the step I owed and could not take, because `scripts/mutation.ts` is in the
developer's uncommitted set and the night shift never stages their files.

**What a human needs to do:** one line in `scripts/mutation.ts` — change the entry's
`from` to the current regex:

```
export const ModelStr = z.string().min(1).max(80).regex(/^[\w.:<>\[\]-]+$/);
```

**How urgent it is — verified, not assumed:** the *invariant* is still covered. I removed
the regex by hand and re-ran the privacy suite: 2 tests fail, including the
`sessions.model` gate added in the same commit. So the suite would still catch a
regression today; what is missing is only the harness's proof that the suite would.

Also worth knowing from the same run: the harness reported "2 uncommitted change(s) are
NOT under test" — the developer's own working-tree edits to `package.json` and
`scripts/mutation.ts` (which adds two new mutation entries, both of which passed).


## 2026-08-06 02:10 — verification cycle, nothing to fix

Two investigations, one clean bill, no code change.

**Background sessions: a real concern with no measured impact, so not fixed.**
Transcripts carry `sessionKind` and `entrypoint`. Locally: one session is entirely
`sessionKind:"bg"` (608 entries), and entrypoints split `cli` 13,781 / `claude-desktop`
1,727 / `sdk-cli` 55. REMY does not distinguish any of them, so in principle a session the
developer never drove could file a tip and take the single active slot — the delivery
objection that killed F6, G2 and M16. Checked the live DB: that bg session has a row
(122k output, 181 tool calls) and has filed **zero** tips. Its tokens do land in the 7-day
totals, which is arguably correct — they were spent on the same account. Held to the same
standard as the rejections above: real in principle, empty in practice, not shipped.

**Full end-to-end verification after 22 commits.** `bun run preflight` green, including
typecheck, the whole suite, and cross-compilation for all four release targets. Then drove
the real binary against a real transcript: SessionStart rendered the splash, the statusline
rendered model/context/git/dev-badge, SessionEnd ran the analysis and the subagent walk,
and `/remy` printed six findings — including tonight's `read-in-slices` at ~700k, matching
the figure measured when it was built.

One thing the run makes visible rather than breaks: `/remy` showed `🧰 tools 0 calls`
beside 740k output tokens, because tool counts come from hooks (which don't fire in a
synthetic replay) while tokens come from the transcript. That is the population mismatch
S10 and S14 describe, on screen, and it is the display decision still waiting on a human.


## 2026-08-06 02:15 — S6 calibrated, and it is not what the row said

The backlog listed S6 (`fix-env-once`, scattered tool failures) as **unblocked, needs
calibration data**. It has the data now, and the row was wrong: it is blocked, and the
clock only started on 2026-08-04.

Measured across the live DB: 12 sessions have tool calls, 11 have ≥12. The highest failure
rate in the corpus is **1.6%** (10 of 629). Every candidate threshold — 10%, 15%, 20%,
25%, 30% — fires on **0 of 11**.

**A wrong turn I caught before writing it down.** Comparing DB counts to transcripts looked
alarming: `c469065c` records 0 failures while its transcript holds 11 `is_error` results,
`5e00e0d7` 0 against 11, `5606c645` 0 against 10. That reads like the `PostToolUseFailure`
hook not working, contradicting CLAUDE.md. Checking dates instead of writing it up: the
handling landed 2026-08-04 in `bcbdafc`, and every session showing that gap started before
it. The hook is fine — `b87b7ddb` (2026-08-05) records 10 failures and proves it fires.
The zeros are pre-fix binaries, not a defect.

One real observation survives, and it is S10's point again rather than a new bug:
`b87b7ddb` records **10** hook-counted failures against only **2** `is_error` results in
its main-chain transcript. Hooks count subagent failures; the transcript does not. Same
population mismatch, now visible in the failure counter as well as the token counts.

**Unpark condition for S6:** ≥10 sessions recorded after 2026-08-04. Today there is one.


## 2026-08-07 01:20 — a real fix, not shipped, because it collides with your uncommitted tests

Testing the migration path on a copy of the live DB turned up a genuine false positive:
three sessions on 1M-context models are scored against the assumed 200k window, and one is
stored as having ridden a 100% full context while it sat near a fifth of its real one. Full
evidence in `docs/trend-watch.md`.

The fix is small — `detectRedZoneRiding` stays silent when the window was never reported,
rather than borrowing the default. **It is not committed.** It makes three tests fail in
`packages/cli/test/e2e/surfaces.e2e.test.ts`, which is yours and uncommitted, and the
night shift neither stages your files nor commits a red suite. The change was reverted and
the suite is green.

**What a human needs to decide:** those e2e tests build sessions with no `context_window`
and then assert on tips that depend on the window. Once the limit is only trusted when the
host reported it, those fixtures need to say which window they mean. That is a one-line
fixture change you'll make in seconds and I should not make inside your working file.

Also worth knowing before you apply it: `max_context_pct` is written with
`MAX(max_context_pct, ?)` in three places, so a corrected lower percentage can never land —
the fix is incomplete until that MAX comes off the analysis-side write.
