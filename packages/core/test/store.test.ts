import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addColumnIfMissing, openDb } from "../src/store";

describe("addColumnIfMissing", () => {
  test("adds a genuinely new column", () => {
    const db = openDb(":memory:");
    addColumnIfMissing(db, "tip_memory", "probe_col", "probe_col TEXT");
    const cols = db.query(`PRAGMA table_info(tip_memory)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "probe_col")).toBe(true);
  });

  test("is idempotent — calling it again on an existing column does not throw", () => {
    const db = openDb(":memory:");
    addColumnIfMissing(db, "tip_memory", "probe_col", "probe_col TEXT");
    expect(() => addColumnIfMissing(db, "tip_memory", "probe_col", "probe_col TEXT")).not.toThrow();
  });

  test("a raw duplicate ALTER TABLE ADD COLUMN throws — the exact failure mode the migration race hit", () => {
    // This documents the assumption addColumnIfMissing's catch relies on:
    // sqlite raises on a duplicate column, it doesn't silently no-op.
    const db = openDb(":memory:");
    db.run(`ALTER TABLE tip_memory ADD COLUMN probe_col TEXT`);
    expect(() => db.run(`ALTER TABLE tip_memory ADD COLUMN probe_col TEXT`)).toThrow(/duplicate column/i);
  });

  test("openDb runs the real migration (tip_memory.last_stop_nudge_at, tips.why) without throwing, repeatedly against the same file", () => {
    // Simulates what actually broke: many fresh processes (refreshInterval
    // spawns ~1 statusline/sec) each calling openDb() -> migrate() against
    // the same file — sequential here, not truly concurrent, but it locks
    // down that repeated migration against persisted (not :memory:) state
    // stays idempotent.
    const dir = mkdtempSync(join(tmpdir(), "coach-migrate-"));
    const path = join(dir, "remy.db");
    try {
      for (let i = 0; i < 5; i++) {
        expect(() => openDb(path)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
