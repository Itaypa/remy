import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoMemoryBytes, claudeMdBytes } from "../src/claudemd";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "remy-claudemd-"));
}

describe("claudeMdBytes", () => {
  test("counts a CLAUDE.md in the session's own directory", () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(1234));
      expect(claudeMdBytes(dir)).toBe(1234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds a CLAUDE.md in a parent directory — the host walks up, so must we", () => {
    // The bug this exists to prevent: this very repo keeps CLAUDE.md at the
    // root while most work happens in packages/*. Checking only cwd would
    // report "you have no CLAUDE.md" to someone who plainly has one, which is
    // the false positive the backlog says is worse than staying silent.
    const dir = scratch();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(500));
      const nested = join(dir, "packages", "core", "src");
      mkdirSync(nested, { recursive: true });
      expect(claudeMdBytes(nested)).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sums the whole memory family the host would load, counting nothing twice", () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(100));
      writeFileSync(join(dir, "CLAUDE.local.md"), "x".repeat(20));
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "CLAUDE.md"), "x".repeat(3));
      expect(claudeMdBytes(dir)).toBe(123);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 0 for a directory with no memory files anywhere above it", () => {
    // Walks to the filesystem root without finding anything. Notably it must
    // return, not throw: the absent case is the one the missing-CLAUDE.md tip
    // is built on.
    expect(claudeMdBytes("/")).toBe(0);
  });

  test("never throws, whatever it is handed", () => {
    // It runs inside the SessionStart hook. A throw there doesn't just lose
    // the probe — it unwinds into the global handler, which writes the stack
    // (with the user's raw absolute path in it) to ~/.remy/remy.log, and it
    // takes the session-start splash down with it.
    const hostile = [
      "/nonexistent/path/that/cannot/be/there",
      "",
      "relative/path",
      "\0/nul-byte",
      "/dev/null",
      "x".repeat(5000),
    ];
    for (const cwd of hostile) {
      expect(() => claudeMdBytes(cwd)).not.toThrow();
      const n = claudeMdBytes(cwd);
      expect(typeof n).toBe("number");
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    // Callers are typed, but the hook payload is not — a non-string must also
    // be survivable rather than a crash inside a hook.
    expect(() => claudeMdBytes(undefined as unknown as string)).not.toThrow();
    expect(claudeMdBytes(null as unknown as string)).toBe(0);
  });
});

describe("auto memory", () => {
  function scratchRepo(): string {
    const root = join(tmpdir(), `remy-am-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }
  function plantMemory(home: string, repo: string, body: string): void {
    const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = join(home, ".claude", "projects", slug, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), body);
  }

  test("counts the index the host actually loads", () => {
    const repo = scratchRepo();
    const home = join(tmpdir(), `remy-home-${Math.random().toString(36).slice(2)}`);
    try {
      const body = "# Memory index\n- one fact\n";
      plantMemory(home, repo, body);
      expect(autoMemoryBytes(repo, home)).toBe(Buffer.byteLength(body));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("strips what the host strips, and caps what the host caps", () => {
    // The host measures its 200-line / 25KB caps AFTER removing frontmatter and
    // block HTML comments, so counting the raw file would overstate every
    // memory index that has either.
    const repo = scratchRepo();
    const home = join(tmpdir(), `remy-home-${Math.random().toString(36).slice(2)}`);
    try {
      plantMemory(home, repo, "---\nmodified: 2026-08-07\n---\n<!-- a note for humans -->\nkept\n");
      expect(autoMemoryBytes(repo, home)).toBe(Buffer.byteLength("kept\n"));

      // Only the first 200 lines load; the rest is dropped on the next read.
      plantMemory(home, repo, Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
      const lines = autoMemoryBytes(repo, home);
      expect(lines).toBeLessThan(Buffer.byteLength(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a linked worktree is unmeasured rather than mismeasured", () => {
    // Auto memory is keyed by the git REPOSITORY, so every worktree shares one
    // directory. A `.git` file means a linked worktree and resolving it means
    // parsing gitdir pointers — this repo runs its own tooling in worktrees, so
    // guessing wrong is worse than reporting nothing.
    const wt = join(tmpdir(), `remy-wt-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/x");
    try {
      expect(autoMemoryBytes(wt, tmpdir())).toBe(0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("outside a repo, or with nothing to read, it is silent rather than wrong", () => {
    expect(autoMemoryBytes(join(tmpdir(), "remy-not-a-repo-at-all"))).toBe(0);
    expect(autoMemoryBytes("")).toBe(0);
    // @ts-expect-error — hostile input from a payload that lied about its type
    expect(autoMemoryBytes(null)).toBe(0);
  });

  test("the memory content never leaves the probe — only a byte count does", () => {
    const repo = scratchRepo();
    const home = join(tmpdir(), `remy-home-${Math.random().toString(36).slice(2)}`);
    try {
      plantMemory(home, repo, "# index\n- SECRET-MEMORY-BODY at /Users/x/private\n");
      const out = autoMemoryBytes(repo, home);
      expect(typeof out).toBe("number");
      expect(JSON.stringify(out)).not.toContain("SECRET-MEMORY-BODY");
      expect(JSON.stringify(out)).not.toContain("/Users");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
