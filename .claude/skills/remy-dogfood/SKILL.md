---
name: remy-dogfood
description: How to install, rebuild, and test the REMY plugin locally against real or synthetic Claude Code sessions. Use when developing the REMY plugin itself — installing it via the repo's own marketplace, rebuilding after a change, or exercising the waste rules end-to-end without a real session.
---

# Dogfooding install (local dev)

- The repo doubles as a plugin marketplace: `/plugin marketplace add <repo path>` → `/plugin install remy@remy` → `/reload-plugins` (or a new session) turns hooks + `/remy` commands on for real sessions.
- **`/plugin install` COPIES the plugin** into `~/.claude/plugins/cache/remy/remy/<version>/` — it does not link back to the repo. **Always rebuild with `bun run build`** (never raw `bun build`): `scripts/build-plugin.ts` stamps the binary (`<git-hash>.<MMDD-HHMM>`) and syncs it into every installed copy (atomic rename), so hooks always run the latest build.
- The statusline shows `⚙ v<version>+<stamp>` in dev installs only (binary running from outside `~/.claude/plugins`, or `REMY_DEV=1`) — pointing the project's `statusLine` at the repo binary (`packages/plugin-claude-code/bin/remy statusline`) keeps the live build stamp visible while iterating.
- To exercise the waste rules end-to-end without real sessions: synthesize a transcript, pipe hook JSON (`{"hook_event_name":"Stop","session_id":…,"transcript_path":…}`) into `remy ingest` with `REMY_DATA_DIR` pointed at a temp dir, then render `remy statusline`/`remy report` against the same dir. Never seed `~/.remy` with synthetic data casually — `dismiss` writes a 30-day cooldown per tip id.
