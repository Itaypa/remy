import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/store";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeTip,
  CONTEXT_ALARM_THROTTLE_MS,
  dismissTip,
  dueForContextAlarm,
  dueForStopNudge,
  markContextAlarmShown,
  markShown,
  markStopNudgeShown,
  openTips,
  recordFindings,
  sessionTips,
  STOP_NUDGE_THROTTLE_MS,
} from "../src/tips";
import type { Finding } from "../src/rules";

const NOW = "2026-07-26T10:00:00.000Z";
const f = (tipId: string, est: number): Finding => ({
  tipId,
  evidence: { count: 1 },
  estSavingsTokens: est,
  // Neutral 1x class: these tests are about the queue mechanics, so every
  // finding is priced the same and raw order equals worth order.
  estClass: "input",
});

describe("tip engine", () => {
  test("one active tip; biggest savings wins; rest queue", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("reread-churn", 5_000), f("auto-compact", 60_000)], NOW);
    expect(activeTip(db)!.tip_id).toBe("auto-compact");
    expect(sessionTips(db, "s1")).toHaveLength(2);
  });

  test("a later, bigger finding queues behind the active tip instead of taking its place", () => {
    // The noise budget is one active tip at a time, and "at a time" means the
    // line does not change under the user mid-session. The test above records
    // everything in one call, so promotion never runs while a tip is already
    // active — which is exactly the case that decides this. Without the guard,
    // a bigger finding arriving later promotes itself and the session ends up
    // with two active rows.
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("reread-churn", 5_000)], NOW);
    expect(activeTip(db)!.tip_id).toBe("reread-churn");

    recordFindings(db, "s2", [f("auto-compact", 60_000)], NOW);
    expect(activeTip(db)!.tip_id).toBe("reread-churn");

    const active = (db as Database).query(`SELECT tip_id FROM tips WHERE status = 'active'`).all();
    expect(active).toHaveLength(1);
    // The bigger one is not lost — it is waiting its turn.
    expect(openTips(db).map((t) => t.tip_id)).toContain("auto-compact");
  });

  test("re-analysis is idempotent and keeps the max estimate", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000)], NOW);
    recordFindings(db, "s1", [f("auto-compact", 30_000)], NOW);
    recordFindings(db, "s1", [f("auto-compact", 90_000)], NOW);
    const tips = sessionTips(db, "s1");
    expect(tips).toHaveLength(1);
    expect(tips[0]!.est_savings_tokens).toBe(90_000);
  });

  test("dismiss promotes the next queued tip and starts a 30-day cooldown", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000), f("plan-mode", 40_000)], NOW);
    const next = dismissTip(db, undefined, NOW);
    expect(next!.tip_id).toBe("plan-mode");

    // Within cooldown: the dismissed tip does not come back.
    recordFindings(db, "s2", [f("auto-compact", 99_000)], "2026-08-10T10:00:00.000Z");
    const ids = sessionTips(db, "s2").map((t) => t.tip_id);
    expect(ids).not.toContain("auto-compact");

    // After cooldown: it may return.
    recordFindings(db, "s3", [f("auto-compact", 99_000)], "2026-09-01T10:00:00.000Z");
    const later = sessionTips(db, "s3").map((t) => t.tip_id);
    expect(later).toContain("auto-compact");
  });

  test("dismissing with no active tip is a no-op", () => {
    const db = openDb(":memory:");
    expect(dismissTip(db, undefined, NOW)).toBeNull();
  });

  test("dueForStopNudge: due on a never-shown tip, not due right after markStopNudgeShown", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000)], NOW);
    expect(dueForStopNudge(db, "auto-compact", NOW)).toBe(true);
    markStopNudgeShown(db, "auto-compact", NOW);
    expect(dueForStopNudge(db, "auto-compact", NOW)).toBe(false);
  });

  test("dueForStopNudge: due again once the throttle window has elapsed", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000)], NOW);
    markStopNudgeShown(db, "auto-compact", NOW);
    const justUnder = new Date(Date.parse(NOW) + STOP_NUDGE_THROTTLE_MS - 1_000).toISOString();
    expect(dueForStopNudge(db, "auto-compact", justUnder)).toBe(false);
    const justOver = new Date(Date.parse(NOW) + STOP_NUDGE_THROTTLE_MS + 1_000).toISOString();
    expect(dueForStopNudge(db, "auto-compact", justOver)).toBe(true);
  });

  test("regression: the splash's markShown does NOT reset the Stop-nudge throttle", () => {
    // This is the actual bug found while dogfooding: a /reload-plugins or
    // session resume re-fires the session-start splash (markShown) far more
    // often than real turns happen. When the two surfaces shared one
    // column, that silently reset the nudge's throttle every time.
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000)], NOW);
    markStopNudgeShown(db, "auto-compact", NOW);
    expect(dueForStopNudge(db, "auto-compact", NOW)).toBe(false);

    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    markShown(db, "auto-compact", later); // splash re-fires; nudge state must be untouched
    expect(dueForStopNudge(db, "auto-compact", later)).toBe(false);
    expect(dueForStopNudge(db, "auto-compact", NOW)).toBe(false);
  });

  test("regression: markStopNudgeShown does NOT touch the splash's last_shown_at / times_shown", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("auto-compact", 60_000)], NOW);
    markShown(db, "auto-compact", NOW);
    markStopNudgeShown(db, "auto-compact", new Date(Date.parse(NOW) + 60_000).toISOString());
    const mem = (db as Database)
      .query(`SELECT last_shown_at, times_shown FROM tip_memory WHERE tip_id = 'auto-compact'`)
      .get() as { last_shown_at: string; times_shown: number };
    expect(mem.last_shown_at).toBe(NOW);
    expect(mem.times_shown).toBe(1);
  });

  test("dueForContextAlarm: due on a fresh session, not due right after markContextAlarmShown", () => {
    const db = openDb(":memory:");
    expect(dueForContextAlarm(db, "s1", NOW)).toBe(true);
    markContextAlarmShown(db, "s1", NOW);
    expect(dueForContextAlarm(db, "s1", NOW)).toBe(false);
  });

  test("dueForContextAlarm: due again once its (tighter) throttle window has elapsed", () => {
    const db = openDb(":memory:");
    markContextAlarmShown(db, "s1", NOW);
    const justUnder = new Date(Date.parse(NOW) + CONTEXT_ALARM_THROTTLE_MS - 1_000).toISOString();
    expect(dueForContextAlarm(db, "s1", justUnder)).toBe(false);
    const justOver = new Date(Date.parse(NOW) + CONTEXT_ALARM_THROTTLE_MS + 1_000).toISOString();
    expect(dueForContextAlarm(db, "s1", justOver)).toBe(true);
  });

  test("dueForContextAlarm is scoped per session — one session's alarm doesn't silence another's", () => {
    const db = openDb(":memory:");
    markContextAlarmShown(db, "s1", NOW);
    expect(dueForContextAlarm(db, "s1", NOW)).toBe(false);
    expect(dueForContextAlarm(db, "s2", NOW)).toBe(true);
  });

  test("the context-alarm throttle is tighter than the tip-nudge throttle", () => {
    // It's an active, worsening problem, not a coaching aside — worth
    // repeating sooner than a tip if /compact still hasn't happened.
    expect(CONTEXT_ALARM_THROTTLE_MS).toBeLessThan(STOP_NUDGE_THROTTLE_MS);
  });

  test("openTips returns the whole open queue, best value first", () => {
    const db = openDb(":memory:");
    recordFindings(db, "s1", [f("no-verify", 10_000), f("reread-churn", 50_000), f("context-tax", 20_000)], NOW);
    expect(openTips(db).map((t) => t.tip_id)).toEqual(["reread-churn", "context-tax", "no-verify"]);
    // Dismissed tips leave the deck — that's what makes a snooze visible on
    // every surface at once.
    dismissTip(db, "reread-churn", NOW);
    expect(openTips(db).map((t) => t.tip_id)).toEqual(["context-tax", "no-verify"]);
    expect(openTips(db, 1)).toHaveLength(1);
  });

  test("re-analysis refreshes an estimate downward, not just upward", () => {
    // This was MAX(existing, new), which made it a high-water mark rather than
    // a refresh: once a tip was filed with a big number it could never come
    // down. That meant correcting a rule's arithmetic was inert for every row
    // already in a user's DB — the stale, inflated figure went on winning the
    // one active-tip slot, because promoteNext ranks by exactly this column.
    const db = openDb(":memory:");
    recordFindings(db, "s1", [{ tipId: "context-tax", evidence: { pct: 50 }, estSavingsTokens: 90_000, estClass: "input" }], NOW);
    expect(openTips(db)[0]!.est_savings_tokens).toBe(90_000);

    recordFindings(db, "s1", [{ tipId: "context-tax", evidence: { pct: 20 }, estSavingsTokens: 5_000, estClass: "input" }], NOW);
    expect(openTips(db)[0]!.est_savings_tokens).toBe(5_000);
    expect(openTips(db)).toHaveLength(1); // refreshed, not duplicated
  });

  test("a tip already filed with the old inflated subagent-offload estimate is corrected on open", () => {
    // Tips persist, are only re-costed when the same rule fires again, and
    // nothing expires them — so fixing the rule alone would leave an open row
    // carrying the wrong number indefinitely.
    const path = join(tmpdir(), `remy-mig-${Math.random().toString(36).slice(2)}.db`);
    try {
      const db = openDb(path);
      (db as Database)
        .query(
          `INSERT INTO tips (tip_id, session_id, created_at, status, evidence, est_savings_tokens)
           VALUES ('subagent-offload', 's1', ?, 'active', '{}', 22500)`,
        )
        .run(NOW);
      // A database from before this migration existed has no marker for it.
      (db as Database).query(`DELETE FROM sync_state WHERE key LIKE 'migration:%'`).run();
      (db as Database).close();

      // The next process to open this database is what applies the correction.
      const reopened = openDb(path);
      expect(activeTip(reopened)!.est_savings_tokens).toBe(0);

      // And it must not undo a legitimate value on a later open, nor keep
      // rewriting — the marker makes it one-shot.
      (reopened as Database)
        .query(`UPDATE tips SET est_savings_tokens = 7 WHERE tip_id = 'subagent-offload'`)
        .run();
      (reopened as Database).close();
      expect(activeTip(openDb(path))!.est_savings_tokens).toBe(7);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
