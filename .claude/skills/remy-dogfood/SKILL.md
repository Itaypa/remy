---
name: remy-dogfood
description: How to install, rebuild, and test the REMY plugin locally against real or synthetic Claude Code sessions. Use when developing the REMY plugin itself — installing it via the repo's own marketplace, rebuilding after a change, or exercising the waste rules end-to-end without a real session.
---

# Dogfooding install (local dev)

## Install

`/plugin marketplace add Itaypa/remy` (or a local repo path) → `/plugin install remy@remy`
→ `/reload-plugins` (or a new session) turns hooks + `/remy` commands on for real sessions.

`/plugin install` **copies** the plugin into `~/.claude/plugins/cache/remy/remy/<version>/`
— it does not link back to the repo. What it copies is the **launcher**
(`bin/remy`, ~3KB of POSIX sh), never the 60MB binary.

## How a rebuild reaches a running session

```
plugin's bin/remy  ──reads version from──▶  its own .claude-plugin/plugin.json
                   ──resolves──▶  ~/.remy/bin/remy-<version>-<os>-<arch>
                   ──claims──▶   ~/.remy/bin/current   (the statusline points here)
```

`bun run build` (never raw `bun build` — the wrapper bakes in
`REMY_VERSION`/`REMY_CHANNEL`/`REMY_BUILD_ID`) compiles to
`~/.remy/bin/remy-<repo version>-<host target>` and repoints `current`. Because
the plugin ships only a launcher, that one file is what every hook and the
statusline end up executing. There is no longer a "sync the binary into installed
copies" step — that existed when the plugin shipped a real binary, and is gone.

## ⚠️ The version-pinning trap (the one that will waste your afternoon)

**The launcher resolves the version from the INSTALLED plugin's manifest, not the
repo's.** So the moment you bump `plugin.json` in the repo, a plugin still
installed at the old version stops seeing your builds — silently, no error:

```
repo at 0.3.1 · installed plugin at 0.3.0
bun run build      → writes remy-0.3.1-darwin-arm64, points current at it
<any hook fires>   → launcher wants remy-0.3.0-*, finds it, runs it,
                     and DRAGS current back to the 0.3.0 binary
```

Verified empirically: pointing `current` at 0.3.1 and firing one hook from the
v0.3.0 plugin moves it straight back. The statusline follows `current`, so your
changes vanish from *both* surfaces at once.

After any version bump, re-sync the install (`/plugin update remy@remy`, or
uninstall + install) before trusting anything you see. To test a build without
touching the install, run the compiled binary directly.

(For real users this design is correct and self-healing: updating the plugin
raises the version, the launcher finds no matching binary, and downloads the new
one in the background.)

## Telling which build you are looking at

**There is no dev-build badge on the statusline** — it was dropped along with
the `💡 1 tip` link, because the line repaints every second and anything static
on it is a permanent banner. `remy version` prints `<version>+<build stamp>`,
and the session-start splash carries the version.

`bun run build` still stamps a channel (`--channel dev` by default,
`--channel release` for shipped binaries), but nothing reads it any more.
`packages/cli/test/launcher.test.ts` compiles **both** channels and asserts
neither renders a `⚙`: the badge came back once before, via an execPath test
that was wrong for every real install, and a compiled-binary check is the only
thing that would notice it returning.

## Exercising the waste rules without real sessions

Synthesize a transcript, pipe hook JSON into `remy ingest` with `REMY_DATA_DIR`
pointed at a temp dir, then render against the same dir:

```bash
D=$(mktemp -d)
REMY_DATA_DIR=$D ~/.remy/bin/current ingest <<< '{"hook_event_name":"Stop","session_id":"t1","transcript_path":"…"}'
REMY_DATA_DIR=$D ~/.remy/bin/current report
```

`REMY_HOME` retargets the bin dir (use it to simulate a fresh machine against a
real GitHub release); `REMY_SETTINGS_PATH` retargets settings.json for spinner
tests; `REMY_ADAPT_CMD` stubs the adaptive analyzer's backend.

**Never seed `~/.remy` with synthetic data casually** — `dismiss` writes a
30-day cooldown per tip id, and the real DB is your own session history.

## Verifying what a stranger actually gets

`bun run build` writes to the same path the launcher resolves, so a dev build
**shadows** the released binary. To check the real artifact, re-download and
verify the checksum:

```bash
cd ~/.remy/bin
curl -fsSLO https://github.com/Itaypa/remy/releases/download/v<ver>/remy-<ver>-darwin-arm64
curl -fsSL https://github.com/Itaypa/remy/releases/download/v<ver>/checksums.txt | grep darwin-arm64
```

`bun run preflight` gates a tag on everything that would otherwise fail *after*
one is pushed: manifest/package.json version agreement, the launcher being
tracked + executable + valid `sh`, no binary committed, every hook event
registered, typecheck, tests, and all four cross-compiles.
