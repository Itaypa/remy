import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// How much project memory the host loads before turn one — the signal behind
// the `claude-md-missing` and `claude-md-prune` tips.
//
// Two things make this file more careful than "stat CLAUDE.md in cwd":
//
// 1. Claude Code does NOT only read cwd. It walks cwd upward through every
//    parent, and separately loads user-level memory from ~/.claude/CLAUDE.md.
//    Checking cwd alone would report "you have no CLAUDE.md" to anyone who
//    ran the agent from a subdirectory of their project — including this
//    repo, whose CLAUDE.md sits at the root while work happens in packages/*.
//    A tip that wrong is worse than silence, so we resolve the way the host
//    does and sum what it would actually load.
//
// 2. Nothing here may throw. It runs inside the SessionStart hook, whose
//    thrown errors land in ~/.remy/remy.log with the raw path in the stack —
//    and the absent-file case is the exact case this exists to detect. Every
//    failure returns 0, which the caller reads as "probed, found nothing".
//
// Privacy: stat only, never a read. The single value that leaves this module
// is a byte count.

/** Files the host loads as memory, relative to each directory on the walk. */
const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md", join(".claude", "CLAUDE.md")];

/** Depth cap on the parent walk — a stat per level is cheap, but a pathological
 * cwd shouldn't turn a hook into a syscall storm. Deeper than any real repo. */
const MAX_WALK_DEPTH = 40;

function sizeOf(path: string): number {
  try {
    // throwIfNoEntry:false is the whole point — a missing file is the common
    // case here, and an ENOENT throw would log the user's absolute path.
    const st = statSync(path, { throwIfNoEntry: false });
    return st?.isFile() ? st.size : 0;
  } catch {
    // Permissions, a symlink loop, a cwd deleted mid-session — all "no data".
    return 0;
  }
}

/** Total bytes of CLAUDE.md-family memory the host would load for `cwd`:
 * the cwd → parent walk plus user-level ~/.claude/CLAUDE.md, de-duplicated.
 * Returns 0 when there is none (or when anything at all goes wrong). */
export function claudeMdBytes(cwd: string): number {
  if (typeof cwd !== "string" || cwd.length === 0) return 0;
  try {
    const seen = new Set<string>();
    let total = 0;

    const add = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      total += sizeOf(path);
    };

    // User-level memory applies to every session regardless of cwd. Added
    // first so the parent walk passing through $HOME can't double-count it.
    add(join(homedir(), ".claude", "CLAUDE.md"));

    let dir = cwd;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      for (const rel of MEMORY_FILES) add(join(dir, rel));
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }

    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}
