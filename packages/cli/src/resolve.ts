import { hashPath } from "@ccpp/core";

// Turning a stored target hash back into a filename, at RENDER time.
//
// Why this exists: a coaching line that says "you edited one file 14×" is
// unanswerable — the developer cannot connect it to anything they did. The
// filename is the single most recognizable thing REMY could say, and it is the
// one thing the store is forbidden to keep.
//
// Why it doesn't break the privacy invariant: it stores nothing. `schema.ts`
// remains a whitelist in which no charset admits a "/", so a path still cannot
// reach the database. What we exploit here is that `hashPath` is an unsalted
// sha256 of the path, so a process ALREADY SITTING in the project can hash its
// own working tree and join back to the hashes it wrote. The name is derived,
// used to render one line, and dropped. Nothing new is written and no new
// outbound path exists.
//
// The consequence, and it is the right one: a file resolves only for someone
// who already has it on disk in front of them. Hashes from another project, a
// scratch directory, or a deleted file simply do not resolve, and the tip falls
// back to its generic wording through the catalog's existing `fallbacks`.

/** Enumeration cost is dominated by `git ls-files`, not by hashing (measured:
 * 11ms to list 78 files, 20.5ms to hash 50,000 paths). Past this many tracked
 * files the walk stops being worth a coaching line, so it is skipped entirely
 * rather than made slow. */
const MAX_TRACKED_FILES = 50_000;

/** Wall-clock ceiling for the whole resolution. Hooks are the tightest caller;
 * blowing their budget to improve a sentence is a bad trade, so on a slow or
 * enormous repo we return what we have and the line degrades gracefully. */
const BUDGET_MS = 250;

/** Map the given 16-hex target hashes back to repo-relative filenames.
 *
 * Returns only what it could resolve — an empty map is a normal, expected
 * outcome (not a git repo, another project's hashes, git unavailable), never
 * an error. This function must not throw: every caller is a render path.
 */
export function resolveTargets(hashes: Iterable<string>, cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = new Set([...hashes].filter((h) => typeof h === "string" && h.length > 0));
  if (wanted.size === 0) return out;

  try {
    const started = Date.now();
    const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return out;

    const files = proc.stdout.toString().split("\0");
    if (files.length > MAX_TRACKED_FILES) return out;

    // The tool call recorded an absolute path, so that is what has to be
    // hashed — `cwd` here is the same directory the host reported as the
    // session's cwd, which is what made the original hash.
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    for (let i = 0; i < files.length; i++) {
      const rel = files[i]!;
      if (rel.length === 0) continue;
      const hash = hashPath(prefix + rel);
      if (wanted.has(hash)) {
        out.set(hash, rel);
        // Every wanted hash found: stop rather than hash the rest of the tree.
        if (out.size === wanted.size) break;
      }
      // Sampled, not per-file: Date.now() in a hot loop over a large repo would
      // cost more than the hashing it is guarding.
      if ((i & 0x3ff) === 0 && Date.now() - started > BUDGET_MS) break;
    }
  } catch {
    // git missing, cwd gone, spawn refused — all mean "no name to show".
  }
  return out;
}

/** Collect the `file_hash` values out of a set of tip evidence blobs.
 *
 * Kept here rather than at each call site so that adding a `file_hash` to a new
 * rule needs no change in the render paths — they already ask for whatever is
 * there. */
export function fileHashesIn(evidenceBlobs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const blob of evidenceBlobs) {
    const h = fileHashIn(blob);
    if (h) out.push(h);
  }
  return out;
}

function fileHashIn(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    const h = (JSON.parse(blob) as { file_hash?: unknown }).file_hash;
    return typeof h === "string" && h.length > 0 ? h : null;
  } catch {
    // evidence is display-only; an unparseable blob just has no filename
    return null;
  }
}

/** The `{file}` template variable for one tip, or nothing — in which case the
 * catalog's `fallbacks` put the generic wording back ("one file"). Returning
 * an empty object rather than a placeholder string is what keeps an
 * unresolvable hash from ever reaching a rendered line. */
export function fileVar(
  evidence: string | null | undefined,
  files: Map<string, string>,
): Record<string, string> {
  const hash = fileHashIn(evidence);
  const name = hash ? files.get(hash) : undefined;
  return name ? { file: name } : {};
}
