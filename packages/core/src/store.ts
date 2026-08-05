import { Database } from "bun:sqlite";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "./env";
import { Hash16, ModelStr } from "./schema";
import type { SessionEvent } from "./schema";

/** `~/.remy`, unless an install predates the rename — then its `~/.coach`
 * stays exactly where it is. Moving a live SQLite database (WAL files, hooks
 * mid-write) to gain a prettier directory name is a bad trade.
 *
 * The test is the DATABASE, not the directory: ~/.remy/bin exists as soon as
 * anything is built there, and letting that flip the data dir would strand a
 * developer's whole history behind an empty new one. */
export function dataDir(): string {
  const explicit = envVar("DATA_DIR");
  const legacy = join(homedir(), ".coach");
  const current = join(homedir(), ".remy");
  const useLegacy = existsSync(join(legacy, "coach.db")) && !existsSync(join(current, "remy.db"));
  const dir = explicit ?? (useLegacy ? legacy : current);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same story one level down: a directory carried over from the coach era
 * keeps its `coach.db`; anything fresh gets `remy.db`. */
export function dbPath(dir = dataDir()): string {
  const current = join(dir, "remy.db");
  if (existsSync(current)) return current;
  const legacy = join(dir, "coach.db");
  return existsSync(legacy) ? legacy : current;
}

export function logError(context: string, err: unknown): void {
  try {
    const line = `${new Date().toISOString()} [${context}] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    appendFileSync(join(dataDir(), "remy.log"), line);
  } catch {
    // logging must never take the host down with it
  }
}

export function openDb(path?: string): Database {
  const db = new Database(path ?? dbPath(), { create: true });
  // busy_timeout MUST come first — before ANY other statement, not just before
  // the writes. The default is 0, so until it is set a SQLITE_BUSY fails
  // instantly instead of retrying, and the very first statement on a fresh
  // connection is the expensive one: it opens the file, reads the schema, and
  // attaches (or recovers) the WAL index. Any of those can return BUSY. A bare
  // SELECT fails here just as readily as a pragma — this is not about which
  // statement takes a write lock.
  //
  // What makes it constant rather than rare: under refreshInterval the
  // statusline opens the DB ~1/sec alongside hook opens, and the last
  // connection to close checkpoints and takes an exclusive lock to unlink the
  // -wal file. Anyone arriving in that window collides.
  //
  // This ordering was previously reversed, which is why raising the timeout
  // from 250ms to 2000ms didn't help: the failing statement ran before the
  // timeout existed. It cost 192 logged failures in a single day, each one a
  // statusline that fell back to a bare "⚡ remy". Note the trade — contended
  // opens now block (sub-second in practice) rather than failing fast.
  db.run("PRAGMA busy_timeout = 2000");
  db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    host TEXT NOT NULL,
    host_version TEXT,
    type TEXT NOT NULL,
    model TEXT,
    tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
    context_pct REAL,
    tool_name TEXT, tool_ok INTEGER, target_hash TEXT,
    compact_trigger TEXT,
    -- repo_hash is vestigial: never written, NULL in every row. The column
    -- stays because this is CREATE TABLE IF NOT EXISTS, so removing it would
    -- only affect fresh databases and make the two shapes diverge.
    repo_hash TEXT, cwd_hash TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    model TEXT,
    cwd_hash TEXT, repo_hash TEXT,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
    cost_usd REAL,
    tool_calls INTEGER DEFAULT 0, tool_fails INTEGER DEFAULT 0,
    compacts_auto INTEGER DEFAULT 0, compacts_manual INTEGER DEFAULT 0,
    used_plan_mode INTEGER DEFAULT 0,
    max_context_pct REAL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tip_id TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    evidence TEXT,
    est_savings_tokens INTEGER DEFAULT 0
  )`);
  // Adaptive-analyzer explanation ("why you're seeing this"); deterministic
  // tips render theirs from evidence templates and leave this NULL.
  addColumnIfMissing(db, "tips", "why", "why TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS tip_memory (
    tip_id TEXT PRIMARY KEY,
    last_shown_at TEXT,
    last_dismissed_at TEXT,
    times_shown INTEGER DEFAULT 0
  )`);
  // Separate from last_shown_at (the session-start splash's column): every
  // SessionStart with source==="startup" bumps last_shown_at, and a
  // /reload-plugins or session resume can trigger that far more often than
  // real turns happen — sharing one column made the Stop-hook nudge's
  // throttle look "just shown" right when it needed to fire. Its own column
  // keeps the two surfaces from resetting each other's clock.
  addColumnIfMissing(db, "tip_memory", "last_stop_nudge_at", "last_stop_nudge_at TEXT");
  // Host-reported context window size (context_window_size from the
  // statusline payload) — a plain number. Rules use it so a 170k-context
  // turn reads as red-zone on a 200k window but healthy on a 1M one.
  addColumnIfMissing(db, "sessions", "context_window", "context_window INTEGER");
  // Bytes of CLAUDE.md-family memory the host loads for this session's cwd
  // (see claudemd.ts) — a plain number, local-only, never on any wire.
  // NULL and 0 mean different things and the rules depend on the difference:
  // NULL is "never probed" (a row from before this shipped, or a session whose
  // SessionStart hook never fired), 0 is "probed, the user genuinely has none".
  // Collapsing them would fire the missing-CLAUDE.md tip at every old session.
  addColumnIfMissing(db, "sessions", "claude_md_bytes", "claude_md_bytes INTEGER");
  // Bytes of skill name+description frontmatter the host loads before turn one,
  // and how many distinct skills that is (see skills.ts). Same NULL-vs-0
  // discipline as claude_md_bytes, and it matters more here: this number is not
  // derivable after the fact. Plugins get enabled and disabled, so a session
  // that went unmeasured is unmeasurable forever — which is why the columns
  // ship ahead of the rule that will read them.
  addColumnIfMissing(db, "sessions", "skill_bytes", "skill_bytes INTEGER");
  addColumnIfMissing(db, "sessions", "skill_count", "skill_count INTEGER");
  // What the delegated workers spent (see subagents.ts). Kept SEPARATE from
  // tokens_in/tokens_out on purpose: every threshold in rules.ts was calibrated
  // against main-chain-only numbers, so folding these in would move all of them
  // at once and invisibly. NULL = no subagents/ directory (older host, or never
  // walked); 0 = walked and the session delegated nothing.
  addColumnIfMissing(db, "sessions", "sub_agents", "sub_agents INTEGER");
  addColumnIfMissing(db, "sessions", "sub_tokens_in", "sub_tokens_in INTEGER");
  addColumnIfMissing(db, "sessions", "sub_tokens_out", "sub_tokens_out INTEGER");
  addColumnIfMissing(db, "sessions", "sub_cache_write", "sub_cache_write INTEGER");
  addColumnIfMissing(db, "sessions", "sub_tools", "sub_tools INTEGER");
  addColumnIfMissing(db, "sessions", "sub_model", "sub_model TEXT");
  // Reasoning-effort mix, as counts (see transcript.ts). Collection only: no
  // rule reads these yet, because locally 17 of 18 sessions never use `max` and
  // the one that does is this repo's own overnight loop — a threshold set on
  // that would be tuned to fire on its author. NULL = never measured.
  addColumnIfMissing(db, "sessions", "effort_turns", "effort_turns INTEGER");
  addColumnIfMissing(db, "sessions", "effort_max_turns", "effort_max_turns INTEGER");
  addColumnIfMissing(db, "sessions", "effort_high_turns", "effort_high_turns INTEGER");
  addColumnIfMissing(db, "sessions", "effort_max_out", "effort_max_out INTEGER");
  // Tool calls denied by the host's auto-mode classifier (the PermissionDenied
  // hook). Defaults to 0 rather than NULL, so rows written before this shipped
  // are indistinguishable from genuinely denial-free ones — any future *rate*
  // rule has to scope its population by started_at rather than trusting a 0.
  addColumnIfMissing(db, "sessions", "perm_denials", "perm_denials INTEGER DEFAULT 0");
  // Generic local kv: tip throttles, spinner ownership, welcome_version,
  // the adaptive analyzer's clock. Named for a sync that no longer exists —
  // kept as-is so an existing ~/.remy/remy.db upgrades without a migration.
  db.run(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  runOnce(db, "subagent_offload_est_reset", () => {
    // `subagent-offload` used to carry a token estimate with the sign
    // backwards — it counted context relief as tokens not spent (see
    // detectSubagentOffload). Correcting the rule is not enough on its own:
    // tips persist, are only re-costed when the same rule fires again, and
    // nothing expires them, so an already-open row would keep the inflated
    // figure indefinitely and go on winning the one active-tip slot.
    db.query(`UPDATE tips SET est_savings_tokens = 0
              WHERE tip_id = 'subagent-offload' AND status IN ('active','queued')`).run();
  });
}

/** Run a one-shot data migration exactly once per database.
 *
 * Distinct from addColumnIfMissing: schema migrations are cheap to re-check
 * every open, but a data UPDATE is not — migrate() runs in every hook and on
 * every statusline tick (~1/s), and an unguarded UPDATE would be a write per
 * second forever. The marker makes it idempotent and, like everything else in
 * this file, a failure here must never take the host down with it. */
function runOnce(db: Database, key: string, fn: () => void): void {
  try {
    const done = db.query(`SELECT value FROM sync_state WHERE key = ?`).get(`migration:${key}`);
    if (done) return;
    fn();
    db.query(`INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)`).run(`migration:${key}`, "1");
  } catch {
    // A locked DB or a table that doesn't exist yet — try again next open.
  }
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** Idempotent ALTER TABLE ADD COLUMN, exported for its own test coverage.
 * Every hook and statusline invocation is a fresh process that opens the DB
 * and runs migrate() — with refreshInterval spawning ~1 statusline/sec,
 * several can land in the same instant right after a fresh column ships,
 * and a plain "if (!tableHasColumn) ALTER TABLE" has a check-then-act race:
 * two processes can both see the column missing and both try to add it, and
 * SQLite has no "ADD COLUMN IF NOT EXISTS". Swallow the loss of that race
 * (the column exists either way) but not a genuine failure. The race itself
 * is inter-process and can't be reproduced from a single-threaded test, but
 * the idempotency contract (safe to call when the column already exists)
 * can and should be locked down. */
export function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (tableHasColumn(db, table, column)) return;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (err) {
    if (!tableHasColumn(db, table, column)) throw err;
  }
}

export interface EventRow {
  id: number;
  session_id: string;
  ts: string;
  host: string;
  host_version: string | null;
  type: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  context_pct: number | null;
  tool_name: string | null;
  tool_ok: number | null;
  target_hash: string | null;
  compact_trigger: string | null;
  cwd_hash: string | null;
}

export interface SessionRow {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  cwd_hash: string | null;
  /** VESTIGIAL — nothing has ever written this, and nothing does now: it is
   * NULL for every row in every existing database. Kept only because the DDL
   * uses CREATE TABLE IF NOT EXISTS, so dropping the column would leave live
   * DBs and fresh DBs with different shapes. Do not build a rule on it without
   * wiring a writer first, and read the measurement in the backlog before
   * assuming a git-root hash is the grouping key you want — on the only real
   * corpus it duplicates cwd_hash or is null, and it splits worktrees apart. */
  repo_hash: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  tool_calls: number;
  tool_fails: number;
  compacts_auto: number;
  compacts_manual: number;
  used_plan_mode: number;
  max_context_pct: number;
  /** Host-reported context window size (local-only, never synced). */
  context_window: number | null;
  /** Bytes of CLAUDE.md memory loaded for this session's cwd (local-only).
   * NULL = never probed, 0 = probed and absent. */
  claude_md_bytes: number | null;
  /** Bytes of skill frontmatter the host loads before turn one, and how many
   * distinct skills that is (local-only). NULL = never probed, 0 = none. */
  skill_bytes: number | null;
  skill_count: number | null;
  /** What the delegated workers spent (subagents.ts), local-only and kept out
   * of the main totals on purpose. NULL = never walked, 0 = walked and none. */
  sub_agents: number | null;
  sub_tokens_in: number | null;
  sub_tokens_out: number | null;
  sub_cache_write: number | null;
  sub_tools: number | null;
  sub_model: string | null;
  /** Reasoning-effort mix as counts (local-only). NULL = never measured. */
  effort_turns: number | null;
  effort_max_turns: number | null;
  effort_high_turns: number | null;
  effort_max_out: number | null;
  /** Tool calls denied by the host's auto-mode classifier (local-only). */
  perm_denials: number;
}

export interface TipRow {
  id: number;
  tip_id: string;
  session_id: string | null;
  created_at: string;
  status: string;
  evidence: string | null;
  est_savings_tokens: number;
  why: string | null;
}

export function insertEvent(db: Database, ev: SessionEvent): void {
  db.query(
    `INSERT INTO events (session_id, ts, host, host_version, type, model,
      tokens_in, tokens_out, cache_read, cache_write, context_pct,
      tool_name, tool_ok, target_hash, compact_trigger, cwd_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.session_id,
    ev.ts,
    ev.host,
    ev.host_version ?? null,
    ev.type,
    ev.model ?? null,
    ev.tokens?.in ?? null,
    ev.tokens?.out ?? null,
    ev.tokens?.cache_read ?? null,
    ev.tokens?.cache_write ?? null,
    ev.context_pct ?? null,
    ev.tool?.name ?? null,
    ev.tool ? (ev.tool.ok ? 1 : 0) : null,
    ev.tool?.target_hash ?? null,
    ev.compact_trigger ?? null,
    ev.cwd_hash ?? null,
  );
}

/** The `sessions` row is written from the statusline payload, which is host
 * input — and unlike `events`, it never passes through `sanitizeEvent`. That
 * made this the one write site where a string reached the DB with no charset
 * gate at all, which is exactly the guarantee CLAUDE.md claims for every
 * stored string. The gates below are that guarantee, in the same spirit as
 * the coercion in `setClaudeMdBytes`: a value that doesn't parse is stored as
 * NULL, and COALESCE reads NULL as "leave what we already knew" — so a
 * malformed field loses one update rather than overwriting a good value with
 * a guess. */
export function upsertSession(
  db: Database,
  s: { session_id: string; ts: string; model?: string; cwd_hash?: string },
): void {
  const model = ModelStr.safeParse(s.model).data ?? null;
  const cwdHash = Hash16.safeParse(s.cwd_hash).data ?? null;
  db.query(
    `INSERT INTO sessions (session_id, started_at, model, cwd_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       model = COALESCE(excluded.model, sessions.model),
       cwd_hash = COALESCE(excluded.cwd_hash, sessions.cwd_hash)`,
  ).run(s.session_id, s.ts, model, cwdHash);
}

/** Record the CLAUDE.md byte count for a session. Coerces to a whole number
 * at the write site: SQLite's INTEGER affinity does NOT reject a string, so
 * the column's type is not the privacy guarantee — this coercion is. Anything
 * non-finite is stored as NULL ("never probed") rather than guessed at. */
export function setClaudeMdBytes(db: Database, sessionId: string, bytes: unknown): void {
  const n = typeof bytes === "number" && Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : null;
  db.query(`UPDATE sessions SET claude_md_bytes = ? WHERE session_id = ?`).run(n, sessionId);
}

/** Record the skill-pack measurement for a session. Same coercion contract as
 * setClaudeMdBytes — the INTEGER affinity would happily store a string, so this
 * is what keeps the column numeric. Either both values are usable or neither is
 * stored: a byte count without its skill count is a number nothing can explain. */
export function setSkillPack(db: Database, sessionId: string, pack: unknown): void {
  const whole = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null;
  const p = pack as { bytes?: unknown; count?: unknown } | null;
  const bytes = whole(p?.bytes);
  const count = whole(p?.count);
  const ok = bytes !== null && count !== null;
  db.query(`UPDATE sessions SET skill_bytes = ?, skill_count = ? WHERE session_id = ?`).run(
    ok ? bytes : null,
    ok ? count : null,
    sessionId,
  );
}

/** Record what this session's delegated workers spent. Same coercion contract
 * as its siblings — the INTEGER affinity would store a string happily, so this
 * is what keeps the columns numeric — plus `ModelStr` on the one string, which
 * comes out of a file we don't control. All-or-nothing: a partial row here
 * would be a spend figure with no agent count to explain it. */
export function setSubagentStats(db: Database, sessionId: string, s: unknown): void {
  const whole = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null;
  const st = s as Record<string, unknown> | null;
  const vals = [
    whole(st?.agents),
    whole(st?.tokensIn),
    whole(st?.tokensOut),
    whole(st?.cacheWrite),
    whole(st?.tools),
  ];
  const ok = vals.every((v) => v !== null);
  const model = ok ? (ModelStr.safeParse(st?.topModel).data ?? null) : null;
  db.query(
    `UPDATE sessions SET sub_agents = ?, sub_tokens_in = ?, sub_tokens_out = ?,
       sub_cache_write = ?, sub_tools = ?, sub_model = ? WHERE session_id = ?`,
  ).run(...(ok ? vals : [null, null, null, null, null]), model, sessionId);
}

/** Record the reasoning-effort mix for a session. Counts only — the effort
 * VALUE never reaches the database, so no new enum joins the whitelist. Same
 * all-or-nothing coercion as its siblings: a partial row here would be a
 * turn count with no total to read it against. */
export function setEffortMix(db: Database, sessionId: string, s: unknown): void {
  const whole = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null;
  const st = s as Record<string, unknown> | null;
  const vals = [whole(st?.effortTurns), whole(st?.effortMaxTurns), whole(st?.effortHighTurns), whole(st?.effortMaxOutTokens)];
  const ok = vals.every((v) => v !== null);
  db.query(
    `UPDATE sessions SET effort_turns = ?, effort_max_turns = ?, effort_high_turns = ?, effort_max_out = ?
     WHERE session_id = ?`,
  ).run(...(ok ? vals : [null, null, null, null]), sessionId);
}

export function getSession(db: Database, sessionId: string): SessionRow | null {
  return db.query(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRow | null;
}

export function latestSessionForCwd(db: Database, cwdHash: string): SessionRow | null {
  return db
    .query(`SELECT * FROM sessions WHERE cwd_hash = ? ORDER BY started_at DESC LIMIT 1`)
    .get(cwdHash) as SessionRow | null;
}

export function sessionEvents(db: Database, sessionId: string): EventRow[] {
  return db
    .query(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as EventRow[];
}

export function recentSessions(db: Database, sinceIso: string): SessionRow[] {
  return db
    .query(`SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at ASC`)
    .all(sinceIso) as SessionRow[];
}

/** Distinct local dates (YYYY-MM-DD) that have sessions, newest first. */
export function sessionDates(db: Database, limit = 60): string[] {
  const rows = db
    .query(`SELECT DISTINCT substr(started_at, 1, 10) AS d FROM sessions ORDER BY d DESC LIMIT ?`)
    .all(limit) as Array<{ d: string }>;
  return rows.map((r) => r.d);
}

// --------------------------------------------------------------- local kv

export function getSyncState(db: Database, key: string): string | null {
  const row = db.query(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setSyncState(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Per-signature waste rollup for one session — catalog ids and integers only. */
export function sessionWasteFor(
  db: Database,
  sessionId: string,
): Array<{ tip_id: string; est_tokens: number }> {
  return db
    .query(
      `SELECT tip_id, MAX(est_savings_tokens) AS est_tokens
       FROM tips WHERE session_id = ? GROUP BY tip_id`,
    )
    .all(sessionId) as Array<{ tip_id: string; est_tokens: number }>;
}
