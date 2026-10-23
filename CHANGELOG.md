# Changelog

## v0.5.0 — every tip says what happened, why it matters, and how to fix it

Users told us they didn't fully understand REMY's tips. A line like
`index.ts took 14 edits with 17 re-reads between them → /clear and re-brief rather than
attempt 15 → saves ≈$0.47` names a number and a command, but never says *why* it is bad,
and assumes words like "re-brief", "red zone", "tool schemas" and "cache-write price".

Every tip and alert is rewritten for someone in their first week of Claude Code, and every
surface now shows the same three parts.

**The end-of-turn nudge is a three-line card:**

```
[🐭 REMY] 🔨 Stuck fixing the same file
  What happened    Claude edited index.ts 14 times, re-reading it 9 times
                   in between.
  Why it matters   Every new try re-sends all the failed tries before it.
                   This cost about $0.40.
  How to fix       Type /clear, then explain the problem again in a
                   sentence or two.
```

The spinner line carries the same three parts on one line, the `/remy` report uses the same
labels, and the context alarm follows the same shape ("Claude's memory is almost full").

**Plain words throughout.** "Claude's memory for this chat" instead of context window,
"over 80% full" instead of red zone, "the Gmail MCP add-on's instructions" instead of tool
schemas, "explain the problem again" instead of re-brief. Token amounts are spelled out
("~12k tokens 🪙"); the coin is decoration, never the only unit. All 26 tips, the rotating
hints, and the report labels changed; rules, thresholds and stored data did not, so tips
already in your database render in the new shape.

**Enforced.** `catalog.test.ts` now requires all three parts on every tip, caps each one's
length, and fails the build on a ban list of the old jargon.

## v0.4.0 — a mouse with a sign, a sensor inside the host, and two tips about a bloated window

**The art.** The welcome is now Joan G. Stark's ASCII mouse holding a sign that reads
TOKENS BEING SAVED (`art/remy.txt`, embedded byte for byte — `ui.test.ts` asserts the
file and the binary agree, which the old hand-downsampled halftone never did). The everyday
mark is his face: four lines, cropped from the same art. The previous three-line mark was,
on inspection, an owl.

**REMY now ships a mod.** `hooks/hooks.json` names one function-hooks module
(`hooks/register.ts`) that runs inside Claude Code. It is a sensor, not a surface: after
the first completed turn and every tenth after, it reads the context window broken down
the way `/context` draws it — including every MCP server's schema weight and whether the
schema is loaded — and pipes the numbers to `remy ingest` as a `ContextProfile`. Server
names are hashed at the door exactly as file paths are; the mod stores nothing, draws
nothing, and calls no model, and `privacy.test.ts` asserts its source touches nothing on
the engine but `session.usage`, `session.id`, `plugin.root` and `process.run`. A host
without function hooks ignores it and nothing changes.

**Two new tips about a window full of something that shouldn't be there.**
- `🔌 mcp-idle` — "claude_ai_Gmail parks 24k of tool schemas in every turn, and this
  session never called it once → disable it in /mcp until you need it". The configured
  half comes from the mod, the usage half from the tool events REMY already keeps, joined on
  a hash; only *loaded* schemas count, since the host defers them by default. `context-tax`
  yields to it, and gains a `{biggest}` attribution ("mostly MCP tool schemas (62k)") when
  the mod has reported. This unparks trend-watch F1 and backlog S19.
- `🔊 noisy-tool` — "Claude_Browser/snapshot returned ~20k tokens per call, 12 times —
  240k parked in the window → ask for less: a filter, a range, a page". Every tool's
  results are now weighed, not just `Read`'s, and **images are priced by their pixels**
  (~1.6k each, the API's ceiling) rather than by their base64 — the mis-measurement that
  made a browser session look like a 100k offender and got every non-Read tool excluded in
  0.3.x. The median result has to be big: one oversized answer is an answer.

**The adaptive coach runs on `sonnet`.** The one daily headless call used a hard-coded
`haiku`. It now runs on the `sonnet` alias by default (Sonnet 5.5 on the Anthropic API
today — an alias, so it tracks what the CLI resolves it to), retries once on `haiku` if
that fails, and takes `REMY_ADAPT_MODEL` or `remy adapt --model <alias>`; `--status` shows
which. At one ~2k-token call a day the price difference rounds to nothing on any plan.

**The statusline learns to pace.** The rate-limit field coloured by raw percentage, which is
the wrong signal: 43% of the 5-hour window with four hours left is a lockout in the making,
43% with twenty minutes left is headroom about to reset unspent. The host sends `resets_at`
with the percentage, so `⏳ 43% (5h) ↻2h10m` now compares what you've used with how far
through the window you are, colours by that (+10 points over the clock yellow, +25 red, 90%
red regardless), and once over pace swaps the countdown for a forecast — `out in 1h20m`.
The 7-day window is paced in awake hours (2am plus six hours asleep carry no weight), so a
night does not read as falling behind every morning. Under pace there is no colour, which is
its own message: the quota will reset unspent, run the big one now.

**Three more host fields on the HUD.** The model field carries the two dials that multiply
its price — `🐉 Fable/xhigh ↯fast`, with `max` and the fast marker in yellow. The branch's
open PR and its review state follow the branch, straight off the host's `pr` object:
`🔀 #42 ✔`. And the cache clock reads the host's own `prompt_cache.expires_at` when a host
≥ 2.1.251 sends one, falling back to the transcript-derived TTL and hook-stamped anchor
otherwise — so a session now has a clock from its first tick, before any hook has run.

**New rule, `cache-miss`.** Claude Code ≥ 2.1.260 diagnoses *why* a request missed its
cached prefix (`tools_changed`, `system_prompt_changed`, `ttl_expired_5m`, …). The
statusline copies the count, the re-written tokens and the most frequent cause into the
session row — write-on-change only, so a quiet session stays read-only — and the rule
repeats the diagnosis as a tip with a cause-specific remedy from a closed set. One new
TEXT column, `cache_miss_cause`, charset-gated to the host's snake_case enum shape and
registered in the privacy suite; `likely_server_side` is deliberately never coached.

**One ping a day, carrying nothing — and the privacy promise reworded to match.** REMY had
no way to know how many people run it. The launcher (`bin/remy`) now GETs a one-byte
`ping-<os>-<arch>` asset on the running version's GitHub release, once per machine per UTC
day, detached from the hook so nothing ever waits on it: no payload, no id, no cookie,
nothing from any session. GitHub's download counter for that asset is the daily-active
count; `bun run analytics` reads it back. `remy analytics --off` or `REMY_ANALYTICS=0`
stops it, and a dev build never pings. The promise therefore changes from *nothing ever
leaves your machine* to **nothing about your work ever leaves your machine** — in
CLAUDE.md, the README, the marketplace listing and `remy help` — and `privacy.test.ts` now
pins every `curl` in the launcher to a download of a release asset that sends nothing.

Also: `claude plugin validate` is a preflight gate; `.mcp.json`/`~/.claude.json` are read
(never written) to name a server at render time; the stray 🐀 is a 🐭 everywhere.

## v0.3.1 — the dev-build badge stops following real installs

`isDevInstall()` decided the `⚙ v0.3.0+…` statusline badge by testing whether
the running binary sat under `.claude/plugins`. It never does: the plugin ships
a launcher and the real binary always lives in `~/.remy/bin`, so the test was
false for **every install that has ever existed** and every user saw a dev
badge. It now reads the channel baked in at build time (`REMY_CHANNEL`), which
is what the docs always claimed. Covered by a test that compiles both channels
and inspects the rendered statusline.

## v0.3.0 — REMY goes open source, and local-only

**The admin plane is gone.** The multi-org server, the dashboard, the Ledger UI
kit and the marketing site left this repo. What ships is one thing: the Claude
Code coaching plugin. That work is paused, not cancelled — but nothing here
depends on it any more.

**Nothing ever leaves your machine.** With the sync client removed there is no
account, no server, no telemetry, and no upload — so the privacy story stops
being "metadata only, split by API shape" and becomes a much simpler claim the
code can actually prove. `packages/core/test/privacy.test.ts` now asserts that
no source file in `core` contains a `fetch`, WebSocket, or `node:http` call at
all. The one remaining outbound path is the adaptive coach's prompt to a
*local* `claude -p`, whose payload is numbers and catalog ids.

**Breaking: `remy login`, `remy logout`, `remy sync` and `remy pull` are
removed**, along with the `📡` org-recommendations line on the session splash.
Your local database is untouched and upgrades in place; the `sync_state` table
keeps its name (it is now just the local kv the tip throttles and spinner
ownership live in) so no migration is needed.

**Rebranded to 🐭REMY.** `BRAND` is now `🐭REMY`, prose says REMY, and the
arcade vocabulary (`🕹`, "insert coin") is gone from the product and the docs.

**Fixed: the Stop hook is back.** It had been removed while chasing hook errors
that turned out to come from a *stale plugin install* still shelling out to a
`bin/coach` deleted in the v0.2.0 rename — not from the hook itself. Stop alone
owns the tip nudge, the ≥80% context alarm, mid-session analysis and the
spinner refresh, so preflight now fails if any hook event goes missing.

## v0.2.0 — first shippable release

The release that makes `/plugin install` work for someone who isn't the author.

**Distribution.** The plugin now ships a launcher (`bin/remy`), not a 60–90MB
binary. On first run it resolves `~/.remy/bin/remy-<version>-<os>-<arch>` and,
when that's missing, fetches it from GitHub Releases in a **detached**
background download and exits immediately — a hook never waits on the network,
and every failure path (unsupported platform, no curl, offline, checksum
mismatch) is silent. Tagging a version cross-compiles darwin-arm64/x64 and
linux-x64/arm64 and publishes them with `checksums.txt`. `bun run preflight`
gates a tag on everything that would otherwise fail *after* it.

**Renamed `coach` → `remy`.** Binary, plugin, slash commands (`/remy`,
`/remy-week`, `/remy-dismiss`), data directory, and `REMY_*` environment
variables. Existing installs keep working: `COACH_*` variables are still read,
and a `~/.coach` directory holding a database stays exactly where it is — the
data directory is chosen by looking for the database, never the folder.

**The spinner tip line is now a coaching surface.** Claude Code's
`spinnerTipsOverride` lets the line under the spinner be replaced, so `remy
spinner` puts your open findings there — the one surface a developer reads
while *waiting* rather than while acting. The whole finding queue rides the
deck, so it rotates on its own between waits instead of parking on one tip
until dismissed. Opt-in only: hooks refresh a line remy already owns but never
create one, an override remy didn't write is never touched, and deleting the
key by hand is a valid uninstall.

**Evidence-first tip copy.** Every rule-backed tip gained a `live` line that
speaks the session's own numbers — "you edited one file 56× this session,
re-reading between tries → /clear and re-brief beats another go → +265k 🪙" —
enforced at ≤110 chars and required to contain a number from the evidence.

**New detector: `tools-over-bash`.** Reading and searching through the shell
(`cat`/`grep`/`find`/`ls`) where Read/Grep/Glob exist dumps unpaginated,
untruncated output into the context. Fires at ≥6 such calls in a session;
write and action forms of the same commands (`cat > file`, `find … -delete`)
are excluded.

**Fixes.** `remy init` writes a stable launcher path into settings.json instead
of a version-pinned binary path that broke on every upgrade; the version now
lives in one place (`plugin.json`) and is baked into the binary at build time.

## v0.1.0

Initial coach plugin: statusline HUD, session splash, waste rules, tip
catalog, admin plane (multi-org server + dashboard), and radar.
