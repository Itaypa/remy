# REMY — the coaching layer for AI coding agents

> Product and binary name: **`remy`**, written **REMY** in prose and **🐭REMY** in the
> bracketed tag every coaching message carries (`BRAND` in `core/src/catalog.ts` — change
> it there). Named after the rat who sits on the cook's head and guides his hands: he
> never cooks for you, and he never touches your code.

This file is the single source of truth for working in this repo.

## What this product is

**One thing: a Claude Code plugin that coaches the developer driving it.** It watches
session *metadata* (never content), detects wasteful patterns with deterministic rules,
and delivers short, quantified tips through zero-token channels:

- **statusline** — model · context % with a live bar · git branch · your cost or your
  rate-limit headroom · a `💡 1 tip` link
- **session-start splash** — the rat, your 7-day totals, and one line worth reading
- **`Stop`-hook nudge** — at most one transient `systemMessage` per turn
- **the host's own spinner tip line** — via `spinnerTipsOverride` (opt-in, `remy spinner`)
- **`/remy`**, **`/remy-week`**, **`/remy-dismiss`** — the plugin commands

Think Grammarly, but for how you drive your coding agent.

**Cross-host strategy — tiered depth.** The core is host-agnostic; Claude Code is the
first and deepest adapter (hooks, statusline, transcripts, plugins). Cursor would be
partial (hooks), Copilot telemetry-only. Universal floor: MCP + instruction files. Never
assume feature parity across hosts; adapters must degrade gracefully.

**Deliberately out of scope (for now):** the multi-org server, the admin dashboard, the
Ledger UI kit, the GitHub radar, and everything that syncs. That work lives in a private
repo and is not coming back unless this one succeeds. Do not re-add a network client.

## The privacy invariant (non-negotiable)

**Nothing ever leaves your machine.** Everything REMY knows lives in one local SQLite
file at `~/.remy/remy.db`. There is no account, no server, no telemetry, no upload — and
no code path that could add one by accident.

What gets *stored* is metadata only: token counts, tool names, event types, and
sha256/16-hashed paths. No prompt text, no code bodies, no file contents, no raw paths.
`packages/core/src/schema.ts` is a whitelist — every string is an enum, a 16-hex hash, or
charset-constrained with no `/`, so path-shaped values structurally cannot parse; anything
else is dropped at ingest. Free-text fields in events are a **bug**, not a feature request.

The **one** thing that ever leaves the process is the Adaptive Coach's prompt to a *local*
`claude -p` call (see below), and its payload is zod-whitelisted to numbers, rates, and
catalog ids. `packages/core/test/privacy.test.ts` asserts this — including a test that no
file in `core/src` contains a `fetch`/WebSocket/`node:http` call. Any PR that widens what
gets stored, or adds a second outbound path, must update that suite and be treated as a
breaking design change.

## Repo layout

```
CLAUDE.md                        # this file
LICENSE                          # Apache-2.0
.claude-plugin/marketplace.json  # repo doubles as a plugin marketplace (/plugin marketplace add)
packages/
  core/                       # host-agnostic: event schema (the privacy gate), SQLite store,
                              #   transcript parser, rules engine, tip engine, tip catalog,
                              #   adaptive coach payload
  cli/                        # `remy` binary: ingest | statusline | report | dismiss | init
                              #   | spinner | links | adapt
  plugin-claude-code/         # first host adapter: plugin manifest, hooks, /remy commands,
                              #   bin/remy (the committed launcher — see Shipping below),
                              #   art/rat.txt (the source art)
scripts/                      # build-plugin.ts (compile) · preflight.ts (release gate)
docs/                         # design-language.md · claude-code-surfaces.md ·
                              #   mistake-taxonomy.md · waste-signals-backlog.md
```

## Stack & conventions

- **TypeScript + Bun.** Single compiled binary via `bun build --compile` (the statusline
  must start in ~30ms; no runtime deps at hook time). SQLite via `bun:sqlite` (WAL mode),
  DB at `~/.remy/remy.db`.
- Zod schemas in `core` are the contract at the storage boundary. The `sync_state` table
  is a generic local kv (tip throttles, spinner ownership, `welcome_version`, the adaptive
  clock) — the name is a leftover from the removed sync path and is kept so an existing DB
  upgrades without a migration.
- Rules are **deterministic** — no model calls in the inline path (statusline, hooks,
  rules). The one exception is the **Adaptive Coach** (`remy adapt`, `core/src/adapt.ts`):
  an out-of-band background analysis, at most one headless `claude -p --model haiku` call
  per day, detached from the SessionEnd hook (never blocking, never from the statusline).
  Its payload is metadata-only and zod-whitelisted (`AdaptPayloadSchema` — numbers, rates,
  catalog ids; free text is structurally impossible); the model picks a catalog tip and
  writes a "why you're seeing this" line that stays local. On by default;
  `remy adapt --off` / `REMY_ADAPT=0` disables; `REMY_ADAPT_CMD` stubs the backend for
  tests. If the claude CLI is missing or fails, coaching degrades to pure deterministic —
  silently.
- **Design language = `docs/design-language.md` ("Coin").** Playful, emoji + ASCII art,
  **🪙 is the token unit**. The noise budget is law: one active tip at a time,
  dismiss-with-memory (30 days), warnings only for imminent context overflow. Splash line
  priority: your personal tip, else a rotating hint. No gamification
  (XP/levels/streaks/achievements) — deliberately removed as redundant; the coaching
  signal is the tip itself.
- Dev commands: `bun install` · `bun test` · `bun run typecheck` · `bun run build`
  (plugin binary) · `bun run preflight` (release gate).
- Claude Code surfaces used by the adapter: hooks (`SessionStart`, `PostToolUse`,
  `PreCompact`, `Stop`, `SessionEnd`), statusline command (constant single-layout HUD;
  `refreshInterval` keeps it fresh between host repaints), plugin commands, and
  `${CLAUDE_PLUGIN_ROOT}` for portable paths. Hook handlers read the event JSON from stdin
  and must exit fast (<50ms target). `Stop`'s payload carries raw assistant response text
  — handlers never let a JSON-parse failure log the raw input (see
  `docs/claude-code-surfaces.md`). `Stop` can also fire one transient `systemMessage` nudge
  per turn (context alarm or a coaching tip, never both). The **spinner tip line** (the
  text under `Forging…`) is ours too, via `spinnerTipsOverride` in settings.json — opt-in
  through `remy spinner`, refreshed by the SessionStart/Stop hooks, never created or
  clobbered by them (`cli/src/spinner.ts`; mechanics in `docs/claude-code-surfaces.md`).

## Dogfooding install (local dev)

Installing, rebuilding, and testing the plugin locally — see the `remy-dogfood` skill
(`.claude/skills/remy-dogfood/SKILL.md`).

## Shipping (how a stranger gets a working install)

`/plugin install` clones the repo, and a `bun build --compile` artifact is ~60MB per
platform — so **the repo ships a launcher, not a binary**.
`packages/plugin-claude-code/bin/remy` is a committed POSIX shim: it reads the version
from `plugin.json`, resolves `~/.remy/bin/remy-<version>-<os>-<arch>`, and execs it; when
that file is missing it starts a **detached** download from GitHub Releases and exits 0
immediately (a hook never waits on the network, and every failure path — unsupported
platform, no curl, offline, checksum mismatch — is silent). It also keeps
`~/.remy/bin/current` pointed at whatever ran, which is what `remy init` writes into
settings.json: a version-pinned path there would break on the next upgrade.

Releasing = tag the version in `plugin.json` (`git tag v0.3.0 && git push origin v0.3.0`).
`.github/workflows/release.yml` refuses a tag that disagrees with the manifest (the
launcher builds its URL from that manifest, so a mismatch = every install silently finds
nothing), cross-compiles darwin-arm64/x64 + linux-x64/arm64, and publishes the assets plus
`checksums.txt`. `ci.yml` runs typecheck + tests + `sh -n` on the launcher for every push.
Version lives in **one** place — `plugin.json` — and is baked into the binary via
`--define REMY_VERSION`; `REMY_CHANNEL=release` is what turns off the dev build badge.

**Known gaps:** the `.github/workflows/` files are not in git — the `gh` OAuth token
lacks the `workflow` scope, so releases are cut by hand (`bun run preflight`, build four
targets, `gh release create`) until that's granted. Windows has no launcher (the shim is
POSIX sh; it exits 0 there, so hooks stay silent rather than erroring).
