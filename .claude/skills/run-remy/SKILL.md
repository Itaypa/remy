---
name: run-remy
description: Build, launch and drive REMY end-to-end — the Claude Code coaching plugin in this repo. Use this whenever you need to run REMY, start or build the binary, exercise the hooks or waste detectors, check the statusline / splash / report / spinner output, verify a change actually works in the real app rather than just in tests, or reproduce what a user would see. Also use before tagging a release.
---

# Running REMY

REMY has no window and no prompt. Its real interface is **JSON on stdin from
Claude Code hooks**, and everything it produces lands on surfaces that only
exist inside a running host — a statusline, a session-start splash, a
`systemMessage` nudge, and the host's spinner line. So "run the app" here means
*substitute for the host*: synthesize a transcript, fire the hook events, and
render the surfaces.

`driver.mjs` in this directory does all of that and asserts on the results. It
is the primary path — reach for it before running anything by hand.

All paths below are relative to the repo root.

## Run it (agent path)

```bash
bun .claude/skills/run-remy/driver.mjs
```

Builds the binary, drives all five hook events, renders all four surfaces, runs
the adaptive coach against a stubbed backend, exercises `init` + the launcher,
and checks the privacy invariant. 34 assertions, ~15s. Exits non-zero on any
failure, so it works as a pre-commit gate.

```bash
bun .claude/skills/run-remy/driver.mjs surfaces        # same run, prints the rendered surfaces
bun .claude/skills/run-remy/driver.mjs --keep          # leave the temp env for poking
bun .claude/skills/run-remy/driver.mjs --bin ~/.remy/bin/current   # skip the build
```

**It never touches your real `~/.remy`.** Everything runs in a throwaway HOME
with `REMY_HOME` / `REMY_DATA_DIR` / `REMY_SETTINGS_PATH` redirected, and the
build uses `--out` so it can't repoint `~/.remy/bin/current`. This matters:
the real DB is the developer's own session history, and `dismiss` writes a
30-day cooldown per tip id — a careless run could silently mute a tip for a
month.

## Driving one surface by hand

When you're iterating on a single thing, the driver's temp env is more
ceremony than you need. Build once, then redirect the data dir:

```bash
bun run build                                    # → ~/.remy/bin/current
D=$(mktemp -d)
E="REMY_DATA_DIR=$D REMY_HOME=$D REMY_SETTINGS_PATH=$D/settings.json"

# a hook (this is what Claude Code actually sends)
env $E ~/.remy/bin/current ingest <<< '{"hook_event_name":"SessionStart","source":"startup","session_id":"s1","cwd":"'$PWD'"}'

# the statusline (payload shape matters — see docs/claude-code-surfaces.md)
env $E ~/.remy/bin/current statusline <<< '{"session_id":"s1","workspace":{"current_dir":"'$PWD'"},"model":{"id":"claude-opus-5","display_name":"Opus 5"},"cost":{"total_cost_usd":1.23},"context_window":{"total_input_tokens":90000,"total_output_tokens":5000,"context_window_size":200000}}'

env $E ~/.remy/bin/current report          # /remy
env $E ~/.remy/bin/current report --week   # /remy-week
env $E ~/.remy/bin/current report --raw    # JSON: session, tips, active, totals
```

`report --raw` is the fastest way to see what the rules engine actually
concluded.

## Tripping a detector on purpose

Detectors read a transcript, so making one fire means writing JSONL that clears
its threshold (thresholds live in `packages/core/src/rules.ts`). The driver's
`transcript()` function builds one that trips five at once — copy it rather
than starting from scratch. The shape of an entry:

```jsonc
{"type":"assistant","isSidechain":false,"timestamp":"2026-08-01T09:00:00.000Z",
 "message":{"id":"m1","model":"claude-opus-5",
            "usage":{"input_tokens":1200,"output_tokens":300},
            "content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/app/src/api.ts"}}]}}
```

Then `ingest` a `Stop` payload pointing `transcript_path` at the file.

## Tests, typecheck, release gate

```bash
bun test           # 170 tests
bun run typecheck
bun run preflight  # gates a tag: version agreement, launcher tracked+executable+valid sh,
                   # no binary committed, every hook event registered, typecheck, tests,
                   # all four cross-compiles
```

`bun test` is a sanity check, not evidence the app works — none of it drives a
compiled binary through a hook. That's what the driver is for.

## Gotchas

Things that cost real time to discover:

- **The launcher goes silent, it doesn't fail.** Hooks call
  `bin/remy` (a POSIX shim), not the binary. If `~/.remy/bin/current` is
  missing, the shim exits **0 with no output** — by design (a coaching tool
  must never break the host), but it means a broken statusline shows up as *no
  statusline* with zero diagnostics. `bun scripts/build-plugin.ts --out PATH`
  does **not** create `current`; only a plain `bun run build` does.
- **Version pinning: your build can be silently ignored.** The launcher
  resolves the version from the *installed plugin's* manifest, not the repo's.
  Bump `plugin.json` and a plugin still installed at the old version keeps
  running the old binary — and drags `current` back to it on every hook fire.
  See the `remy-dogfood` skill for the full trap; re-sync with
  `/plugin update remy@remy` after any version bump.
- **Adaptive tips appear in neither obvious place.** They are filed with
  `session_id = NULL` and `est_savings_tokens = 0`, so they show up in *neither*
  the session waste list (no session) nor `active` (the noise budget keeps the
  higher-value deterministic finding in the one active slot). They sit in the
  queue until the deterministic tips are dismissed. Asserting on `tips` after
  running `adapt` passes vacuously forever — query the DB, or dismiss down to it.
- **`REMY_ADAPT_CMD` is split on spaces**, so a stub can't contain a spaced
  payload. Write the response to a file and use `cat <file>` — `cat` ignores the
  prompt arriving on stdin.
- **One tip at a time is enforced.** Five findings produce one visible tip. If a
  change looks like it "didn't fire", check `report --raw` — it's probably
  queued behind a higher-value one.
- **`remy links` is macOS-only and writes to LaunchServices.** It compiles an
  AppleScript app and registers a `remy://` URL scheme. Don't run it in a
  verification pass; it mutates state outside the repo.
- **A dev build shadows the release.** `bun run build` writes to the same path
  the launcher resolves, so you stop testing what users get. Re-download from
  Releases and check the checksum when that matters.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `driver.mjs surfaces` fails at "binary is executable" | Fixed — was `args.indexOf("--bin") + 1` resolving to `args[0]`. If it returns, check flag parsing at the top of the driver. |
| Statusline renders nothing, exit 0 | `~/.remy/bin/current` missing. `bun run build` (no `--out`). |
| Your change doesn't show up in a real session | Installed plugin version ≠ repo version. `/plugin update remy@remy`, then `/reload-plugins`. |
| `report` says "no sessions recorded yet" | Nothing has been ingested into that `REMY_DATA_DIR`, or you pointed it at a fresh temp dir. |
| `adapt` prints "claude CLI unavailable" | No `claude` on PATH and no `REMY_ADAPT_CMD`. Expected — coaching degrades to deterministic silently. |
| Hook errors mentioning `bin/coach` | A stale pre-rename plugin install. Remove the old marketplace + plugin. |

## Related

- `remy-dogfood` skill — installing the plugin and the rebuild loop against
  *real* sessions. This skill drives the app; that one wires it into the host.
- `docs/claude-code-surfaces.md` — hook and statusline payload shapes.
- `packages/core/src/rules.ts` — detector thresholds.
