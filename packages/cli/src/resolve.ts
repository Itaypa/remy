import { hashPath } from "@ccpp/core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Map stored MCP server hashes back to server names, the same way and under
 * the same rules as `resolveTargets`: nothing is stored, a name only ever
 * appears for someone who already has that server, and an unresolvable hash
 * leaves the catalog's fallback wording in place.
 *
 * The hash is of the server's WIRE segment — the `<server>` in every
 * `mcp__<server>__<tool>` name the host emits — so the candidates are: every
 * segment this machine has ever called (`mcpServerSegments`, handed in by the
 * caller, since this file holds no DB handle), plus the server names in the
 * local MCP config files, spelled the way the host spells them on the wire.
 * Both are read-only; the config files are read, never written. */
export function resolveMcpServers(hashes: Iterable<string>, cwd: string, knownSegments: Iterable<string> = []): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = new Set([...hashes].filter((h) => typeof h === "string" && h.length > 0));
  if (wanted.size === 0) return out;
  const candidates = new Set<string>(knownSegments);
  for (const name of configuredMcpServers(cwd)) candidates.add(wireSegment(name));
  for (const seg of candidates) {
    const hash = hashPath(seg);
    if (wanted.has(hash)) out.set(hash, seg);
  }
  return out;
}

/** The host spells a server name into tool names with every character outside
 * `[A-Za-z0-9_-]` turned into `_` ("claude.ai Gmail" → `claude_ai_Gmail`).
 * Best effort: a segment the events table already holds needs no spelling. */
function wireSegment(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Server names from the two config files the host reads: the user's
 * `~/.claude.json` (global and per-project) and the project's `.mcp.json`.
 * Anything missing or malformed just contributes nothing. */
function configuredMcpServers(cwd: string): string[] {
  const names: string[] = [];
  const keysOf = (v: unknown): string[] => (v && typeof v === "object" ? Object.keys(v as object) : []);
  try {
    const user = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as Record<string, any>;
    names.push(...keysOf(user.mcpServers));
    for (const proj of Object.values(user.projects ?? {})) names.push(...keysOf((proj as any)?.mcpServers));
  } catch {
    // no user config, or not ours to parse
  }
  try {
    const project = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")) as Record<string, any>;
    names.push(...keysOf(project.mcpServers));
  } catch {
    // no project config
  }
  return names;
}

/** Collect the `server_hash` values out of a set of tip evidence blobs. */
export function serverHashesIn(evidenceBlobs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const blob of evidenceBlobs) {
    const h = hashIn(blob, "server_hash");
    if (h) out.push(h);
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
  return hashIn(blob, "file_hash");
}

function hashIn(blob: string | null | undefined, key: "file_hash" | "server_hash"): string | null {
  if (!blob) return null;
  try {
    const h = (JSON.parse(blob) as Record<string, unknown>)[key];
    return typeof h === "string" && h.length > 0 ? h : null;
  } catch {
    // evidence is display-only; an unparseable blob just has no name
    return null;
  }
}

/** The `{file}` and `{server}` template variables for one tip, or nothing —
 * in which case the catalog's `fallbacks` put the generic wording back ("one
 * file", "one MCP server"). Returning an empty object rather than a
 * placeholder string is what keeps an unresolvable hash from ever reaching a
 * rendered line. One map serves both: every hash in it is a sha256/16 of
 * something the caller resolved from the machine in front of it. */
export function fileVar(
  evidence: string | null | undefined,
  names: Map<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const file = fileHashIn(evidence);
  const fileName = file ? names.get(file) : undefined;
  if (fileName) out.file = fileName;
  const server = hashIn(evidence, "server_hash");
  const serverName = server ? names.get(server) : undefined;
  if (serverName) out.server = serverName;
  return out;
}
