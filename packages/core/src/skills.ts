import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// How much skill frontmatter the host loads before turn one — the largest
// measurable component of the startup pack, and the one nobody chose. You
// enable a handful of plugins and inherit dozens of skills; every one of their
// descriptions is in context before you type, invoked or not.
//
// Four things make this more careful than "find every SKILL.md under ~/.claude":
//
// 1. `~/.claude/plugins/marketplaces/` is a browsable CATALOG, not an install.
//    Walking it counts skills the user has never installed — on this developer's
//    machine that is the majority of the SKILL.md files on disk. Installs are
//    resolved from installed_plugins.json's installPath instead, which is the
//    only list that says what actually exists locally.
// 2. A plugin can be installed and DISABLED (`enabledPlugins: {"x": false}`).
//    Its skills sit on disk and never load. Billing someone for skills they
//    already turned off is the worst thing this probe could do, so a plugin
//    counts only when it is not explicitly disabled.
// 3. The same plugin appears under more than one install path (a version dir
//    and a hash dir). Counting both double-bills it, so skills are de-duplicated
//    by name.
// 4. Only FRONTMATTER loads at session start. Bodies are two orders of magnitude
//    larger — on this machine 1.2MB of body against 26KB of frontmatter — so
//    measuring whole files would overstate the tax ~46×.
//
// Privacy: this module reads files, but its entire output surface is two
// integers. Nothing derived from the content leaves it, and nothing here throws
// — a failure is 0, which the caller stores as "probed, found nothing".

/** Frontmatter sits at the head of the file; no need to read a 40KB body to
 * find it. Two sizes, because one is a trap: most skills close their
 * frontmatter inside 4KB, but the heaviest do not — the `ai-sdk` skill shipped
 * by the vercel plugin runs 15,705 B before its closing `---`. A single small
 * head silently drops exactly the skills that cost the most, biasing the
 * measurement toward zero precisely where it matters. So: read small, and on a
 * miss re-read big before giving up. */
const HEAD_BYTES = 4_096;
const HEAD_BYTES_MAX = 64_000;

/** A pathological plugin (or a symlink loop) shouldn't turn the SessionStart
 * hook into a syscall storm. Well above any real install: this machine's
 * heaviest single plugin ships 41. */
const MAX_SKILLS_PER_ROOT = 200;

function readHead(path: string, bytes: number): string {
  try {
    // Reading the whole file and slicing would defeat the point on a large
    // SKILL.md; the body is exactly what we must not pay for.
    const buf = Buffer.alloc(bytes);
    const fd = openSync(path, "r");
    try {
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** `name` and `description` from a SKILL.md's YAML frontmatter, or null when
 * there is no frontmatter to speak of. Deliberately not a YAML parser: the two
 * scalars we need are single-line in every skill the host ships, and a real
 * parser here would be a dependency plus an exception surface for zero gain. */
function frontmatterFields(head: string): { name: string; description: string } | null {
  if (!head.startsWith("---")) return null;
  const end = head.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = head.slice(3, end);
  const pick = (key: string): string => {
    const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1]!.trim() : "";
  };
  const name = pick("name");
  const description = pick("description");
  if (name === "" && description === "") return null;
  return { name, description };
}

/** Every `<root>/skills/<slug>/SKILL.md`, the layout the host loads from. */
function skillFilesUnder(root: string): string[] {
  const dir = join(root, "skills");
  try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (out.length >= MAX_SKILLS_PER_ROOT) break;
      const file = join(dir, entry, "SKILL.md");
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

/** Install paths of plugins that are installed AND not explicitly disabled. */
function enabledPluginRoots(home: string): string[] {
  const readJson = (path: string): Record<string, unknown> => {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      // Missing, unreadable, or malformed — all "no plugins we can vouch for".
      return {};
    }
  };

  const settings = readJson(join(home, ".claude", "settings.json"));
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = (installed.plugins ?? {}) as Record<string, unknown>;

  const roots: string[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    // Absent from enabledPlugins means "installed, nothing said against it" —
    // only an explicit false disables. Defaulting the other way would silently
    // measure nothing on any host that doesn't write the map.
    if (enabled[key] === false) continue;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const p = (e as { installPath?: unknown })?.installPath;
      if (typeof p === "string" && p.length > 0) roots.push(p);
    }
  }
  return roots;
}

/** Bytes of skill `name` + `description` the host would load for this session,
 * and how many distinct skills that is. Returns zeros when there are none, or
 * when anything at all goes wrong. */
export function skillPackBytes(cwd: string, home: string = homedir()): { bytes: number; count: number } {
  const none = { bytes: 0, count: 0 };
  if (typeof cwd !== "string" || cwd.length === 0) return none;
  try {
    const roots = [
      ...enabledPluginRoots(home),
      // User-level and project-level skills load the same way plugins' do.
      join(home, ".claude"),
      join(cwd, ".claude"),
    ];

    // De-duplicate by name, not by path: the same plugin lives under several
    // install paths, and the host loads one copy of each named skill.
    const seen = new Map<string, number>();
    for (const root of roots) {
      for (const file of skillFilesUnder(root)) {
        // Small read first; only the rare oversized header pays for a big one.
        const fm =
          frontmatterFields(readHead(file, HEAD_BYTES)) ??
          frontmatterFields(readHead(file, HEAD_BYTES_MAX));
        if (!fm) continue;
        const key = fm.name !== "" ? fm.name : file;
        if (seen.has(key)) continue;
        seen.set(key, Buffer.byteLength(fm.name, "utf8") + Buffer.byteLength(fm.description, "utf8"));
      }
    }

    let bytes = 0;
    for (const n of seen.values()) bytes += n;
    return { bytes, count: seen.size };
  } catch {
    return none;
  }
}
