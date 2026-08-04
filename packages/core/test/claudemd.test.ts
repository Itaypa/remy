import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMdBytes } from "../src/claudemd";

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
