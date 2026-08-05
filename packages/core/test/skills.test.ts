import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillPackBytes } from "../src/skills";
import { openDb, upsertSession, setSkillPack, getSession } from "../src/store";
import type { Database } from "bun:sqlite";

/** An empty home, so the probe never picks up the developer's real plugins —
 * without this every assertion here measures whatever is installed on the
 * machine running the suite. */
const isolatedHome = join(tmpdir(), "remy-empty-home");

/** A throwaway tree shaped like the host's: `<root>/.claude/skills/<slug>/SKILL.md`. */
function scratch(): string {
  const dir = join(tmpdir(), `remy-skills-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(root: string, slug: string, front: string, body = "x".repeat(5_000)): void {
  const dir = join(root, ".claude", "skills", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${front}\n---\n${body}`);
}

describe("skill pack probe", () => {
  test("counts name + description frontmatter, never the body", () => {
    const cwd = scratch();
    try {
      // 5,000 bytes of body against a 21-byte header: if the body leaked in,
      // the number would be off by two orders of magnitude. This is the whole
      // reason the probe reads frontmatter rather than stat()ing the file.
      writeSkill(cwd, "alpha", "name: alpha\ndescription: does a thing");
      const { bytes, count } = skillPackBytes(cwd, isolatedHome);
      expect(count).toBe(1);
      expect(bytes).toBe("alpha".length + "does a thing".length);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("frontmatter larger than the first read is still counted", () => {
    // The regression that bit during development: with a single 4KB head, the
    // eight heaviest skills on this developer's machine parsed as "no
    // frontmatter" and vanished — 30% of the real weight, dropped from exactly
    // the skills that cost the most. A probe that under-counts the big ones is
    // worse than no probe, because the number looks plausible.
    const cwd = scratch();
    try {
      const huge = "y".repeat(20_000);
      writeSkill(cwd, "heavy", `name: heavy\ndescription: ${huge}`);
      const { bytes, count } = skillPackBytes(cwd, isolatedHome);
      expect(count).toBe(1);
      expect(bytes).toBe("heavy".length + huge.length);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the same skill under two install paths is counted once", () => {
    // A plugin lives on disk under both a version dir and a hash dir. Counting
    // both double-bills the user for one loaded skill.
    const cwd = scratch();
    try {
      writeSkill(cwd, "dup-a", "name: shared\ndescription: same skill, two paths");
      writeSkill(cwd, "dup-b", "name: shared\ndescription: same skill, two paths");
      const { bytes, count } = skillPackBytes(cwd, isolatedHome);
      expect(count).toBe(1);
      expect(bytes).toBe("shared".length + "same skill, two paths".length);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("malformed, empty, and absent skills contribute nothing and never throw", () => {
    const cwd = scratch();
    try {
      // No frontmatter at all.
      const plain = join(cwd, ".claude", "skills", "plain");
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, "SKILL.md"), "# just a heading, no frontmatter\n");
      // Frontmatter with neither field we measure.
      writeSkill(cwd, "other-keys", "allowed-tools: Read\nmodel: opus");
      // A directory with no SKILL.md in it at all.
      mkdirSync(join(cwd, ".claude", "skills", "empty-dir"), { recursive: true });
      expect(skillPackBytes(cwd, isolatedHome)).toEqual({ bytes: 0, count: 0 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a nonexistent cwd yields zeros rather than throwing — it runs inside a hook", () => {
    // Nothing in this module may throw: it runs in SessionStart, where a throw
    // would land the user's absolute path in the log via the stack trace.
    expect(skillPackBytes(join(tmpdir(), "remy-does-not-exist-ever"), isolatedHome)).toEqual({ bytes: 0, count: 0 });
    expect(skillPackBytes("", isolatedHome)).toEqual({ bytes: 0, count: 0 });
    // @ts-expect-error — hostile input from a host payload that lied about its type
    expect(skillPackBytes(null, isolatedHome)).toEqual({ bytes: 0, count: 0 });
  });

  test("the probe's entire output surface is two numbers", () => {
    // The privacy contract: paths and file content go in, only integers come
    // out. Asserted structurally so a future field addition has to face it.
    const cwd = scratch();
    try {
      writeSkill(cwd, "alpha", "name: alpha\ndescription: does a thing");
      const out = skillPackBytes(cwd, isolatedHome);
      expect(Object.keys(out).sort()).toEqual(["bytes", "count"]);
      for (const v of Object.values(out)) expect(typeof v).toBe("number");
      expect(JSON.stringify(out)).not.toContain(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("skill pack storage", () => {
  test("NULL and 0 stay different — never probed is not the same as none", () => {
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s1", ts: "2026-08-06T00:00:00.000Z" });
    // Untouched row: the entire back catalogue looks like this, and reading it
    // as 0 would claim "you have no skills" about sessions we never measured.
    expect(getSession(db, "s1")!.skill_bytes).toBeNull();
    expect(getSession(db, "s1")!.skill_count).toBeNull();

    setSkillPack(db, "s1", { bytes: 0, count: 0 });
    expect(getSession(db, "s1")!.skill_bytes).toBe(0);
    expect(getSession(db, "s1")!.skill_count).toBe(0);
  });

  test("a hostile value cannot reach the columns — INTEGER affinity is not the guarantee", () => {
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s1", ts: "2026-08-06T00:00:00.000Z" });
    setSkillPack(db, "s1", { bytes: "/Users/x/secret/SKILL.md", count: 3 });
    const dump = JSON.stringify((db as Database).query("SELECT * FROM sessions").all());
    expect(dump).not.toContain("/Users");
    // Neither half is stored: a byte count without its skill count, or vice
    // versa, is a number nothing can explain.
    expect(getSession(db, "s1")!.skill_bytes).toBeNull();
    expect(getSession(db, "s1")!.skill_count).toBeNull();

    setSkillPack(db, "s1", null);
    expect(getSession(db, "s1")!.skill_bytes).toBeNull();

    setSkillPack(db, "s1", { bytes: 10_176.7, count: 35 });
    expect(getSession(db, "s1")!.skill_bytes).toBe(10_176);
    expect(getSession(db, "s1")!.skill_count).toBe(35);
  });
});
