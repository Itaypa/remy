import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPath } from "@ccpp/core";
import { fileHashesIn, fileVar, resolveTargets } from "../src/resolve";

// The filename is the most recognizable thing REMY can say, and the one thing
// the store may never keep. These tests pin both halves of that bargain: the
// name comes back for someone holding the files, and it silently does not for
// anyone else.

let dir: string;

function git(args: string[], cwd = dir): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remy-resolve-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  git(["add", "-A"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolving a stored hash back to a filename", () => {
  test("a tracked file resolves to its repo-relative path", () => {
    const target = hashPath(join(dir, "src", "index.ts"));
    expect(resolveTargets([target], dir).get(target)).toBe("src/index.ts");
  });

  test("several hashes resolve in one walk, and unknown ones simply do not", () => {
    const known = hashPath(join(dir, "README.md"));
    const foreign = hashPath("/some/other/project/app.ts");
    const out = resolveTargets([known, foreign], dir);
    expect(out.get(known)).toBe("README.md");
    expect(out.has(foreign)).toBe(false);
    expect(out.size).toBe(1);
  });

  test("a hash from another project never resolves — the guarantee, not a limitation", () => {
    // A name only comes back for someone who already has that file on disk.
    // That is what makes storing nothing an honest trade rather than a
    // technicality: REMY cannot name a file you do not have.
    const elsewhere = hashPath("/Users/someone/private/secrets.ts");
    expect(resolveTargets([elsewhere], dir).size).toBe(0);
  });

  test("a deleted file stops resolving, and nothing throws", () => {
    const target = hashPath(join(dir, "src", "index.ts"));
    rmSync(join(dir, "src", "index.ts"));
    // Still in the index, so git lists it; the hash still matches the path.
    // What must not happen is a throw on a render path.
    expect(() => resolveTargets([target], dir)).not.toThrow();
  });

  test("a directory that is not a git repo returns nothing instead of failing", () => {
    const plain = mkdtempSync(join(tmpdir(), "remy-nogit-"));
    try {
      expect(resolveTargets([hashPath(join(plain, "a.ts"))], plain).size).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("no hashes asked for means no git call at all", () => {
    expect(resolveTargets([], dir).size).toBe(0);
  });

  test("a trailing slash on the cwd does not break the join", () => {
    const target = hashPath(join(dir, "README.md"));
    expect(resolveTargets([target], `${dir}/`).get(target)).toBe("README.md");
  });
});

describe("pulling file hashes out of tip evidence", () => {
  test("collects every file_hash and ignores everything else", () => {
    expect(
      fileHashesIn([
        JSON.stringify({ edits: 9, file_hash: "0123456789abcdef" }),
        JSON.stringify({ turns: 4 }),
        null,
        undefined,
        "not json at all",
      ]),
    ).toEqual(["0123456789abcdef"]);
  });

  test("a non-string file_hash is not a hash", () => {
    expect(fileHashesIn([JSON.stringify({ file_hash: 12345 })])).toEqual([]);
  });

  test("fileVar yields the name when resolved, and nothing when not", () => {
    const files = new Map([["0123456789abcdef", "src/index.ts"]]);
    expect(fileVar(JSON.stringify({ file_hash: "0123456789abcdef" }), files)).toEqual({
      file: "src/index.ts",
    });
    // Nothing, not `{file: undefined}` and not a placeholder: an absent key is
    // what lets the catalog's `fallbacks` supply the generic wording.
    expect(fileVar(JSON.stringify({ file_hash: "deadbeefdeadbeef" }), files)).toEqual({});
    expect(fileVar(null, files)).toEqual({});
    expect(fileVar("{broken", files)).toEqual({});
  });
});
