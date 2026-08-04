```
            .                                   .     .
                                                                                    .     .
          .        .                     .                                              ...  ..
                        .                .              .                               .......
                                                   .              .           .       ........
    .                                                 ............           .     .............
                                                .     ....-+===-:... .            ..............
                .                                 .....:+++**++:...............................
                                                  ....+#####****=*#*.:=====+=-:.............
   .            .                        .        ...*###*:...=*##******+*+*****++++=-......   .
                          .                       ..:###=:......*++******+****#***++++++-...
          .                                     ....:%%#---%@%*=++*********#####*++======...
                                ..................=*%%%%=-=*%*=++++*****######%#*++=====-.......
                 .         .    ....:++++==+=++++**#%%%%%*=++++*****+*##*####%%%%*+++==:........   .
          ..                   ....:++====++++++++*%%#***#*****************###%%%%#.......==:...
                        .   .   ....+==---====++++*%######**#*###*********#####%%#... ...*=-........
          .                     ....-==-----=====+*%#######*####*##***###*######*...  ..=--..-==--..
          .                . .  .....-==----=====+*%####%%%%#%####*#*#########+........-=-:=---:....
          .                         ...++========+#%%##%%%%%**##**########*=.......-=--+=---:.---:..
     .             .             . ......:==+++++*#%%%%%%%#%%%#+#%@@----.............+-----------:..
  .                                      .....:-#%%%%%%%%###%%%%#++#@*=:......    ..-++----:....
..                                 .        ..-#%%%%%%%%####%%%%%%#+=-=:...........-##+==.......
               .     .                   .....*%%%%%%#######%%%%%%%%%****++++==-+**####:....   .
                                     .  ...:-#%%%%%#%%#############***********++**####=.....
.                   .                   ..:*#%%%%%%%#########***************++*****##-......  .   .
               .                    ...::+###%%%%#######****+***+***+*****++*****##=...   ..
                  .                 ..::*#############*************+*++*****#####+-....
                                 ....-=#####%########*****+*********++**#**#*:..
                      .         ....-*###%%###########**#***+****+++**+*#*-::.....            .
.            .                  .:-+####%%#######**#**##****+**++++++*=-:.........
            .    .           ....:+%###%%##*##########********++++=-.......           .
 .            .            . ..:-*#%%##%%###%###########******+++-..... .
     .       .             ...:+#%%%%%####################***+*==...                            .
                           ...=*#%%%%%#########*########******++-....                .
 .  .                      ..-*%%%%####%########*****#*******++=-....
  .                       ..-*%%%%%%%##########*+===*******+*++==...              .
                     .   ..=*%%%%%%%#%########%#*+===+*****+++=+=...
                        ..--#%%%%%%%#############==-+-+*****++==:....              .              .
            .   .       ..-=#%%%%%%#%############+==*=+***+++++-:...  .
            .           ...+%%%%%%%%%#####*#****#*+=#++***++++==-...              .           .
                     .   .-%%%%%%%%%%%####**************++++=++==...
          ..     .       .+#%%#%%%%%%#######*****++****+**+++=+=+-...                  .
 .                .      .-=%%%%#%%#########*+*+*+****+++++++=+++:...  .                     .
                         .:*%%%%%%########*#**+++**++*++++++==+++-...                     .
                         .:+%%%%%########**#*++++*+*+++++++++===+=-..               .
         .               ..-*%%%######*##***++++++*+++++++++++====-..
                        ...:*%%%%####*******++++++**+++*++++++++==-...          .             .
                      .....:+#%%######****++++++++**+**+*++++++++=-....
                    ........-*%%#%####*****=++*+++*+***++*****+++=-....
    ..................:=+****#%%%%####*****++=++***+***+**+******+:..   .  .    .        .
    ........:--=+++++******+++*%%%####***+*#++++************#*#**=...           .
  ...:-----=+*++=-::........:-=*#%%%##******#***#*********#####**=-:...           .
..:--==::.........  ..........:-=*#%####*#*###*##***##%####***+=--=-:....               . .
..==:.........           .......:-=#######*+*#+++===----::::::----......                     .
...:===-:.....           ..........:=+++==*+--=-:.......................          .              .
  ............        .         ......:-==-==-:....                                            .
  ............                      ..............  .
         ..                 .           ... .. ..   .                 .                            .
 .                                 .            ..                  .
 . .      .         .                                                 .
                        .                          .                                            .
            .                                           .                             ..
```

# REMY 🐀

**The coaching layer for AI coding agents.** Live statusline stats, waste detection, and
quantified tips — inside Claude Code. Metadata-only, zero tokens burned, and nothing ever
leaves your machine.

Named after the rat who sits on the cook's head and guides his hands: he never cooks for
you, and he never touches your code.

```
  ,__,         REMY v0.3.0
 (o,o)         last 7d: 12 sessions · 6.4M 🪙
 (")_(")~~~    [🐭REMY]: 🔨 you edited one file 56× this session → +265k 🪙
```

## What it does

- **Statusline, in your face** — model, context % with a live bar, git branch, and either
  your cost or your rate-limit headroom (whichever your plan actually bills you on), right
  beneath your input box. One constant layout, always — it colors in place (yellow at 60%,
  red at 80% context) instead of restructuring the line.
- **Waste signatures** — deterministic rules (no model calls in the inline path, ever)
  detect auto-compact hits, long edit-heavy sessions without plan mode, retry loops, cache
  expiries, red-zone context turns, and shell reads that should have been tools — each one
  quantified: *"~200k 🪙 recoverable."*
- **Four zero-token surfaces** — the statusline, a session-start splash, a nudge right
  after a turn ends, and Claude Code's own spinner tip line (opt in with `remy spinner`).
  None of them costs you a token, because none of them enters the model's context.
- **`/remy`** — full session report. **`/remy-week`** — 7-day rollup. **`/remy-dismiss`** —
  snooze a tip for 30 days. One active tip at a time; the noise budget is enforced in code.

## Install (2 minutes)

```bash
# 1. Add the marketplace + plugin (inside Claude Code)
/plugin marketplace add Itaypa/remy
/plugin install remy@remy

# 2. Statusline (one-time)
~/.remy/bin/remy init          # this project
~/.remy/bin/remy init --global # everywhere

# 3. Optional: put your coaching line under Claude Code's spinner
~/.remy/bin/remy spinner       # --off hands it back
```

The plugin ships a small launcher, not the 60MB binary: on its first run it fetches the
build for your platform from GitHub Releases into `~/.remy/bin`, in the background. The
first session after install is uncoached; every one after that is instant. Building from
source instead: `bun install && bun run build`.

Restart Claude Code. Save tokens.

## Privacy

**Nothing ever leaves your machine.** There is no account, no server, no telemetry, no
upload — and no code path that could add one by accident. Everything REMY knows lives in
one SQLite file at `~/.remy/remy.db`.

What it stores there is metadata only: token counts, tool names, event types, and
sha256-hashed paths. No prompts, no code, no file contents, no raw paths — the schema is a
whitelist and the test suite proves it, including a check that no source file in `core`
contains a network call at all (`packages/core/test/privacy.test.ts`).

The one exception, stated plainly: the optional **adaptive coach** makes at most one
`claude -p --model haiku` call a day on your own machine, to pick which catalog tip fits
your recent habits. Its payload is numbers and tip ids — free text is structurally
impossible. Turn it off with `remy adapt --off`.

## Repo layout

| Path | What |
|---|---|
| `packages/core` | Host-agnostic: event schema (the privacy gate), SQLite store, transcript parser, rules engine, tip engine, tip catalog |
| `packages/cli` | The `remy` binary: `ingest` · `statusline` · `report` · `dismiss` · `init` · `spinner` · `links` · `adapt` |
| `packages/plugin-claude-code` | First host adapter: plugin manifest, hooks, `/remy` commands, the launcher |
| `docs/design-language.md` | "Coin" — the dev-facing design language and the noise budget |
| `docs/claude-code-surfaces.md` | Reference: hook payloads, statusline payload, `spinnerTipsOverride` mechanics |
| `.claude-plugin/marketplace.json` | This repo doubles as a plugin marketplace |
| `CLAUDE.md` | Full project doc |

## Development

```bash
bun install              # deps
bun test                 # 169 tests, incl. the privacy suite
bun run typecheck
bun run build            # compile the remy binary into ~/.remy/bin
bun run preflight        # release gate: run this before tagging a version
```

## Roadmap

Next: more waste signatures (see `docs/waste-signals-backlog.md`), a Windows launcher, and
Cursor/Codex/Copilot adapters via tiered depth — native where the host allows, MCP +
instruction files as the universal floor.

---
*He watches you drive, and tells you what it cost.*
