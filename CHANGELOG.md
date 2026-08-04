# Changelog

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
