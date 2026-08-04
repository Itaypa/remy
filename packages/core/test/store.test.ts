import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addColumnIfMissing,
  getSyncState,
  openDb,
  recentSessions,
  sessionDates,
  sessionWasteFor,
  setSyncState,
  upsertSession,
} from "../src/store";
import type { Database } from "bun:sqlite";

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

describe("the 7-day window", () => {
  // recentSessions decides what the splash totals, the week rollup and the
  // cross-session habit rules can see. It compares ISO timestamps as STRINGS,
  // which is only chronological because every writer uses `new Date().toISOString()`
  // — UTC, always `Z`. Note that schema.ts's IsoTs also permits a `+03:00`
  // offset form; nothing writes one today, and one would sort wrongly here.
  const seed = (db: Database, ids: Array<[string, string]>) => {
    for (const [id, ts] of ids) upsertSession(db, { session_id: id, ts });
  };

  test("the boundary is inclusive, and anything older is left out", () => {
    const db = openDb(":memory:");
    seed(db, [
      ["old", "2026-07-01T09:59:59.999Z"],
      ["exact", "2026-07-01T10:00:00.000Z"],
      ["newer", "2026-07-02T00:00:00.000Z"],
    ]);
    const got = recentSessions(db, "2026-07-01T10:00:00.000Z").map((r) => r.session_id);
    expect(got).toEqual(["exact", "newer"]);
  });

  test("results come back oldest first, whatever order they were written", () => {
    // analyzeHabits and weekTotals both walk this list; a reversed order would
    // silently change which sessions a "recent run" rule considers recent.
    const db = openDb(":memory:");
    seed(db, [
      ["c", "2026-07-03T00:00:00.000Z"],
      ["a", "2026-07-01T00:00:00.000Z"],
      ["b", "2026-07-02T00:00:00.000Z"],
    ]);
    expect(recentSessions(db, "2026-07-01T00:00:00.000Z").map((r) => r.session_id)).toEqual(["a", "b", "c"]);
  });

  test("an empty window is empty, not everything", () => {
    const db = openDb(":memory:");
    seed(db, [["a", "2026-07-01T00:00:00.000Z"]]);
    expect(recentSessions(db, "2027-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("sessionDates", () => {
  test("one entry per calendar day, newest first, honouring the limit", () => {
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "a1", ts: "2026-07-01T01:00:00.000Z" });
    upsertSession(db, { session_id: "a2", ts: "2026-07-01T23:00:00.000Z" });
    upsertSession(db, { session_id: "b1", ts: "2026-07-02T05:00:00.000Z" });
    upsertSession(db, { session_id: "c1", ts: "2026-07-03T05:00:00.000Z" });
    expect(sessionDates(db)).toEqual(["2026-07-03", "2026-07-02", "2026-07-01"]);
    expect(sessionDates(db, 2)).toEqual(["2026-07-03", "2026-07-02"]);
  });
});

describe("sessionWasteFor", () => {
  test("keeps the largest estimate per tip and stays inside its own session", () => {
    // Re-analysis re-files the same tip as the session grows, so without the
    // MAX/GROUP BY a session's waste list would repeat entries and the totals
    // beneath it would double-count.
    const db = openDb(":memory:");
    const insert = (session: string, tip: string, est: number) =>
      (db as Database)
        .query(`INSERT INTO tips (tip_id, session_id, created_at, status, est_savings_tokens) VALUES (?,?,?,'active',?)`)
        .run(tip, session, "2026-07-01T00:00:00.000Z", est);
    insert("s1", "reread-churn", 4_000);
    insert("s1", "reread-churn", 9_000);
    insert("s1", "no-verify", 10_000);
    insert("s2", "auto-compact", 60_000);

    const waste = sessionWasteFor(db, "s1").sort((a, b) => a.tip_id.localeCompare(b.tip_id));
    expect(waste).toEqual([
      { tip_id: "no-verify", est_tokens: 10_000 },
      { tip_id: "reread-churn", est_tokens: 9_000 },
    ]);
    expect(sessionWasteFor(db, "nobody")).toEqual([]);
  });
});

describe("sync_state kv", () => {
  test("round-trips, overwrites, and reports a missing key as null", () => {
    // Every throttle in the product rides on this: the adaptive clock, the
    // welcome version, spinner ownership. A get that returned null-ish for a
    // stored value would silently re-fire everything on every session.
    const db = openDb(":memory:");
    expect(getSyncState(db, "nope")).toBeNull();
    setSyncState(db, "welcome_version", "0.3.1");
    expect(getSyncState(db, "welcome_version")).toBe("0.3.1");
    setSyncState(db, "welcome_version", "0.4.0");
    expect(getSyncState(db, "welcome_version")).toBe("0.4.0");
    // A falsy-but-present value must not read as absent.
    setSyncState(db, "adapt_enabled", "0");
    expect(getSyncState(db, "adapt_enabled")).toBe("0");
  });
});
