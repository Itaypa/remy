import type { Database } from "bun:sqlite";
import type { Finding } from "./rules";
import { envVar } from "./env";
import { getSyncState, setSyncState, type TipRow } from "./store";

// One active tip at a time; the rest queue. Dismissed tip ids stay silent for
// 30 days — the noise budget is enforced here, not in the UI.

const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// The Stop-hook nudge (cli/src/index.ts) surfaces the active tip as a
// transient systemMessage right after a turn ends — a second, louder
// surface than the always-on statusline. Resurfacing it on every single
// Stop would be spam; throttle to once per window. Tracked in its OWN
// column (last_stop_nudge_at), separate from the splash's last_shown_at —
// a /reload-plugins or session resume re-fires the splash far more often
// than real turns happen, and sharing one column let that reset this
// throttle right when it needed to fire.
export const STOP_NUDGE_THROTTLE_MS = Number(envVar("STOP_NUDGE_THROTTLE_MS")) || 10 * 60 * 1000;

export function dueForStopNudge(db: Database, tipId: string, nowIso: string): boolean {
  const mem = db
    .query(`SELECT last_stop_nudge_at FROM tip_memory WHERE tip_id = ?`)
    .get(tipId) as { last_stop_nudge_at: string | null } | null;
  if (!mem?.last_stop_nudge_at) return true;
  return Date.parse(nowIso) - Date.parse(mem.last_stop_nudge_at) >= STOP_NUDGE_THROTTLE_MS;
}

export function markStopNudgeShown(db: Database, tipId: string, nowIso: string): void {
  db.query(
    `INSERT INTO tip_memory (tip_id, last_stop_nudge_at) VALUES (?, ?)
     ON CONFLICT(tip_id) DO UPDATE SET last_stop_nudge_at = excluded.last_stop_nudge_at`,
  ).run(tipId, nowIso);
}

export function recordFindings(
  db: Database,
  sessionId: string,
  findings: Finding[],
  nowIso: string,
): void {
  for (const f of findings) {
    if (isInCooldown(db, f.tipId, nowIso)) continue;
    const existing = db
      .query(`SELECT * FROM tips WHERE tip_id = ? AND status IN ('active','queued') LIMIT 1`)
      .get(f.tipId) as TipRow | null;
    if (existing) {
      // Re-analysis of the same session refreshes the numbers instead of
      // duplicating. This used to write MAX(existing, new), which made it a
      // high-water mark rather than a refresh: once a tip had been filed with
      // a big number it could never come down, so a corrected estimate — or a
      // session that turned out cheaper on the second look — silently kept the
      // old figure. That also meant a fix to any rule's arithmetic was inert
      // for every row already in a user's DB. The newest analysis wins.
      db.query(`UPDATE tips SET est_savings_tokens = ?, evidence = ?, session_id = ? WHERE id = ?`).run(
        f.estSavingsTokens,
        JSON.stringify(f.evidence),
        sessionId,
        existing.id,
      );
    } else {
      db.query(
        `INSERT INTO tips (tip_id, session_id, created_at, status, evidence, est_savings_tokens)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      ).run(f.tipId, sessionId, nowIso, JSON.stringify(f.evidence), f.estSavingsTokens);
    }
  }
  promoteNext(db);
}

export function isInCooldown(db: Database, tipId: string, nowIso: string): boolean {
  const mem = db
    .query(`SELECT last_dismissed_at FROM tip_memory WHERE tip_id = ?`)
    .get(tipId) as { last_dismissed_at: string | null } | null;
  if (!mem?.last_dismissed_at) return false;
  return Date.parse(nowIso) - Date.parse(mem.last_dismissed_at) < DISMISS_COOLDOWN_MS;
}

export function promoteNext(db: Database): void {
  const active = db.query(`SELECT id FROM tips WHERE status = 'active' LIMIT 1`).get();
  if (active) return;
  const next = db
    .query(`SELECT id FROM tips WHERE status = 'queued' ORDER BY est_savings_tokens DESC, id ASC LIMIT 1`)
    .get() as { id: number } | null;
  if (next) db.query(`UPDATE tips SET status = 'active' WHERE id = ?`).run(next.id);
}

export function activeTip(db: Database): TipRow | null {
  return db.query(`SELECT * FROM tips WHERE status = 'active' LIMIT 1`).get() as TipRow | null;
}

/** Everything the coach currently has to say, best-value first — the active
 * tip plus everything queued behind it. The spinner deck is built from this:
 * the host rotates through the entries on its own, so a developer sees the
 * whole queue over a session instead of one line until they dismiss it. */
export function openTips(db: Database, limit = 5): TipRow[] {
  return db
    .query(
      `SELECT * FROM tips WHERE status IN ('active','queued')
       ORDER BY est_savings_tokens DESC, id ASC LIMIT ?`,
    )
    .all(limit) as TipRow[];
}

export function sessionTips(db: Database, sessionId: string): TipRow[] {
  return db
    .query(
      `SELECT * FROM tips WHERE session_id = ? AND status != 'dismissed'
       ORDER BY est_savings_tokens DESC`,
    )
    .all(sessionId) as TipRow[];
}

/** Dismiss by catalog tip id, or the active tip when no id given. Returns the newly promoted tip, if any. */
export function dismissTip(db: Database, tipId: string | undefined, nowIso: string): TipRow | null {
  const target = tipId
    ? (db
        .query(`SELECT * FROM tips WHERE tip_id = ? AND status IN ('active','queued') LIMIT 1`)
        .get(tipId) as TipRow | null)
    : activeTip(db);
  if (!target) return null;
  db.query(`UPDATE tips SET status = 'dismissed' WHERE id = ?`).run(target.id);
  db.query(
    `INSERT INTO tip_memory (tip_id, last_dismissed_at) VALUES (?, ?)
     ON CONFLICT(tip_id) DO UPDATE SET last_dismissed_at = excluded.last_dismissed_at`,
  ).run(target.tip_id, nowIso);
  promoteNext(db);
  return activeTip(db);
}

export function markShown(db: Database, tipId: string, nowIso: string): void {
  db.query(
    `INSERT INTO tip_memory (tip_id, last_shown_at, times_shown) VALUES (?, ?, 1)
     ON CONFLICT(tip_id) DO UPDATE SET
       last_shown_at = excluded.last_shown_at,
       times_shown = tip_memory.times_shown + 1`,
  ).run(tipId, nowIso);
}

// The context-overflow alarm used to hijack the whole statusline at
// ctx>=80%; it's now a Stop-hook nudge instead (cli/src/index.ts), so the
// statusline stays one constant layout. Throttled much tighter than the tip
// nudge (3 min, not 10) — an overflowing context is an active, worsening
// problem, not a coaching aside, worth repeating sooner if /compact hasn't
// happened yet. Keyed by session id in sync_state, not tip_memory — this
// isn't about any one catalog tip.
export const CONTEXT_ALARM_THROTTLE_MS = Number(envVar("CTX_ALARM_THROTTLE_MS")) || 3 * 60 * 1000;

export function dueForContextAlarm(db: Database, sessionId: string, nowIso: string): boolean {
  const last = getSyncState(db, `ctx_alarm_at:${sessionId}`);
  if (!last) return true;
  return Date.parse(nowIso) - Date.parse(last) >= CONTEXT_ALARM_THROTTLE_MS;
}

export function markContextAlarmShown(db: Database, sessionId: string, nowIso: string): void {
  setSyncState(db, `ctx_alarm_at:${sessionId}`, nowIso);
}
