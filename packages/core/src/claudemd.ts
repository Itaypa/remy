import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envVar } from "./env";

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
      // De-duplicate by resolved path, not by the string we happened to build.
      // The host's own docs recommend `ln -s AGENTS.md CLAUDE.md`, and a
      // symlinked `.claude/CLAUDE.md -> ../CLAUDE.md` reaches this walk under
      // two different names — counted twice before this.
      let key = path;
      try {
        key = realpathSync.native(path);
      } catch {
        // Missing file (the common case) or a broken link: the raw path is a
        // fine key, and sizeOf() will score it 0 anyway.
      }
      if (seen.has(key)) return;
      seen.add(key);
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

// ---------------------------------------------------------------- auto memory

/** The host loads the first 200 lines or 25KB of MEMORY.md, whichever comes
 * first. Both caps are measured AFTER frontmatter and block comments are
 * stripped, so this strips before measuring too. */
const AUTO_MEMORY_MAX_BYTES = 25_000;
const AUTO_MEMORY_MAX_LINES = 200;

/** How the host names a project's directory under ~/.claude/projects:
 * every non-alphanumeric character becomes a dash. Verified against the live
 * directory on this machine rather than inferred. */
function projectSlug(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Repository root for `cwd`, or null when we shouldn't guess.
 *
 * The host keys auto memory by the GIT REPOSITORY, so every worktree of a repo
 * shares one memory directory — deriving it from cwd would look in the wrong
 * place for exactly the worktrees this repo's own tooling runs in. A `.git`
 * that is a FILE means a linked worktree, and resolving that properly means
 * parsing gitdir pointers; unmeasured beats mismeasured, so that returns null. */
function repoRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const st = statSync(join(dir, ".git"), { throwIfNoEntry: false });
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) return null; // linked worktree — don't guess
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Bytes of auto-memory index the host loads for this session.
 *
 * Auto memory is ON BY DEFAULT and its MEMORY.md is "loaded at the start of
 * every conversation", so for most users this is real context that
 * `claudeMdBytes` has never counted. It is returned SEPARATELY and never added
 * to that number: `claude-md-prune` renders its byte count as "your CLAUDE.md
 * is {kb}KB" and tells you to cut lines, and these bytes belong to a file
 * Claude wrote and `/memory` manages — summing them would make that tip wrong
 * about the file it names.
 *
 * Reads the file, unlike the rest of this module, because the host's caps are
 * measured on the stripped content. The output surface is still one integer;
 * nothing derived from the content escapes, and nothing here throws. */
export function autoMemoryBytes(cwd: string, home = homedir()): number {
  if (typeof cwd !== "string" || cwd.length === 0) return 0;
  try {
    if (envVar("DISABLE_AUTO_MEMORY", process.env as Record<string, string>) === "1") return 0;
    const root = repoRoot(cwd);
    if (root === null) return 0;
    const path = join(home, ".claude", "projects", projectSlug(root), "memory", "MEMORY.md");
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) return 0;
    // Bounded read: the host never loads more than the cap, and a runaway file
    // must not turn a SessionStart hook into a large read.
    const raw = readFileSync(path, "utf8").slice(0, AUTO_MEMORY_MAX_BYTES * 4);
    const stripped = raw
      .replace(/^---\n[\s\S]*?\n---\n/, "") // YAML frontmatter
      .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, ""); // block-level HTML comments
    const capped = stripped.split("\n").slice(0, AUTO_MEMORY_MAX_LINES).join("\n");
    return Math.min(Buffer.byteLength(capped, "utf8"), AUTO_MEMORY_MAX_BYTES);
  } catch {
    return 0;
  }
}
