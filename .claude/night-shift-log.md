# Night-shift log

Cycles that produced no commit, and verification runs worth not repeating.
Committed cycles are in `git log --grep="Night-Shift:"`.

## 2026-08-05 · rung-1 sweep and compiled-binary soak — no code change

**The live log is fully explained.** `~/.coach/remy.log` contains exactly two
error kinds and nothing else:

| count | error | status |
|---|---|---|
| 192 | `[statusline] SQLiteError: database is locked` | fixed — `busy_timeout` now precedes every other statement (`cd57ad6`) |
| 164 | `[spinner] SyntaxError: JSON Parse error` | not a product bug — **all 164** trace to `spinner.test.ts`; the suite was writing into the real data dir (`e24de9d`) |

No third category, and no unexplained entry. Worth knowing before anyone reads
that file and re-investigates: the remaining lines are history, not symptoms.

**The compiled binary is clean under concurrency.** The lock fix was measured
through `bun run` on TypeScript, so it was re-checked against a real
`bun build --compile` artifact: 160 concurrent `statusline`/`ingest`/
`PermissionDenied` invocations against one database →

    non-zero exits 0 · "database is locked" 0 · any logged error 0
    statusline fell back to "⚡ remy" 0
    counters {tool_calls: 40, tool_fails: 0, perm_denials: 40}

Counters are exactly right: `PermissionDenied` correctly does not inflate
`tool_calls`. Not added to the run-remy driver — `store-lock.test.ts` already
guards the regression deterministically, and a soak stage would cost ~10s per
run and add timing flakiness for no extra signal.

**Repo hygiene checked, nothing found:** no `TODO`/`FIXME`/`HACK` markers in
tracked source, no skipped or todo tests, preflight green, `bun run mutate`
green (24/25 caught, 1 documented accepted survivor).

### Two things for a human

- **The live install is behind.** `~/.remy/bin/current` is `0.3.1+dfe56dd`,
  built 23:55, which predates the statusline lock fix and the
  `PermissionDenied` work. `bun run build` picks them up. Deliberately not run
  unattended: it replaces the live statusline and hooks, and the launcher fails
  silently, so a bad build is silently no coaching with nobody watching.
- **`packages/marketing/` is an empty shell** — only `.astro/` and
  `node_modules/`, no source, nothing tracked. Leftover from an abandoned
  package. It is in the untracked set, so it was left alone; delete it by hand
  if it is dead. `CLAUDE.md`'s repo layout does not list it, which is correct
  if it goes.
