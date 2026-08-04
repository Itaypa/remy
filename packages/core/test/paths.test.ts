import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFlag, envVar } from "../src/env";
import { dataDir, dbPath } from "../src/store";

// How REMY finds its own data. Everything here exists because the product was
// renamed from `coach` to `remy` after people were already using it: resolving
// these wrong does not throw, it silently opens an empty database and the
// developer's whole history disappears from every surface at once.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remy-paths-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.REMY_DATA_DIR;
  delete process.env.COACH_DATA_DIR;
});

describe("dbPath", () => {
  test("a fresh directory gets remy.db", () => {
    expect(dbPath(dir)).toBe(join(dir, "remy.db"));
  });

  test("a directory carried over from the coach era keeps its coach.db", () => {
    writeFileSync(join(dir, "coach.db"), "");
    expect(dbPath(dir)).toBe(join(dir, "coach.db"));
  });

  test("when both exist, remy.db wins — writes must never split across two files", () => {
    // The dangerous case: picking the legacy file here after a remy.db already
    // exists would fork the history, and neither file would hold the truth.
    writeFileSync(join(dir, "coach.db"), "");
    writeFileSync(join(dir, "remy.db"), "");
    expect(dbPath(dir)).toBe(join(dir, "remy.db"));
  });
});

describe("dataDir", () => {
  test("an explicit REMY_DATA_DIR wins and is created if absent", () => {
    const nested = join(dir, "does", "not", "exist", "yet");
    process.env.REMY_DATA_DIR = nested;
    expect(dataDir()).toBe(nested);
    // Every hook calls this before opening the DB; returning a path that isn't
    // there would make the first write fail on a fresh machine.
    expect(existsSync(nested)).toBe(true);
  });

  test("the legacy COACH_DATA_DIR is still honoured", () => {
    // An install from before the rename may still export the old name; the
    // whole point of the compatibility layer is that it keeps working.
    const nested = join(dir, "legacy");
    process.env.COACH_DATA_DIR = nested;
    expect(dataDir()).toBe(nested);
  });

  test("REMY_ wins over COACH_ when both are set", () => {
    process.env.REMY_DATA_DIR = join(dir, "new");
    process.env.COACH_DATA_DIR = join(dir, "old");
    expect(dataDir()).toBe(join(dir, "new"));
  });
});

describe("envVar / envFlag", () => {
  test("reads the REMY_ name, falls back to COACH_, and prefers REMY_", () => {
    expect(envVar("SPINNER", { REMY_SPINNER: "1" })).toBe("1");
    expect(envVar("SPINNER", { COACH_SPINNER: "1" })).toBe("1");
    expect(envVar("SPINNER", { REMY_SPINNER: "new", COACH_SPINNER: "old" })).toBe("new");
    expect(envVar("SPINNER", {})).toBeUndefined();
  });

  test("unset is undefined, not false — absent and disabled are different answers", () => {
    // Callers distinguish these: `adaptEnabled` treats unset as "on" and only
    // "0" as off, so collapsing undefined into false would silently disable
    // features nobody turned off.
    expect(envFlag("SPINNER", {})).toBeUndefined();
    expect(envFlag("SPINNER", { REMY_SPINNER: "0" })).toBe(false);
    expect(envFlag("SPINNER", { REMY_SPINNER: "false" })).toBe(false);
  });

  test("anything else counts as on", () => {
    for (const v of ["1", "true", "yes", "", "off"]) {
      expect(envFlag("SPINNER", { REMY_SPINNER: v })).toBe(true);
    }
  });
});
