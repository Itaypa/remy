import { z } from "zod";
import type { Database } from "bun:sqlite";
import { BRAND, TIPS } from "./catalog";
import { isInCooldown, promoteNext } from "./tips";
import type { SessionRow } from "./store";

// The adaptive analyzer: once a day, a background process hands the user's
// session METADATA to a local `claude -p` call, which picks the catalog tip
// that best fits their actual pattern and writes a one-line "why". The inline
// coaching path (statusline, hooks, rules) never calls a model — this runs
// out-of-band and fails silent.
//
// Privacy: the outbound payload is the entire exposure surface, so it is
// schema-constrained the same way the sync wire is — every field is a number,
// a boolean, or an id validated against the tip whitelist. Free text is
// structurally impossible. The model's output stays local (tips never sync).

const TIP_ID = z.string().refine((id) => id in TIPS, "unknown tip id");
/** Model ids are charset-gated at ingest; re-assert here (no "/", no spaces). */
const MODEL_ID = z.string().regex(/^[A-Za-z0-9.:_-]{1,64}$/);
const COUNT = z.number().int().min(0);
const RATE = z.number().min(0).max(1);

export const AdaptPayloadSchema = z
  .object({
    window_days: z.literal(14),
    sessions: COUNT,
    plan_rate: RATE,
    subagent_rate: RATE,
    cache_hit_rate: RATE,
    avg_context_pct: z.number().min(0).max(100),
    max_context_pct: z.number().min(0).max(100),
    compacts_auto: COUNT,
    compacts_manual: COUNT,
    tool_fail_rate: RATE,
    models: z.record(MODEL_ID, COUNT),
    waste: z.record(TIP_ID, COUNT),
    dismissed: z.array(z.object({ tip_id: TIP_ID, days_ago: COUNT }).strict()),
    pending_tips: z.array(TIP_ID),
  })
  .strict();

export type AdaptPayload = z.infer<typeof AdaptPayloadSchema>;

export const AdaptResponseSchema = z.object({
  tip_id: TIP_ID,
  why: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1).optional(),
});

/** 14-day metadata profile. Throws if anything free-text-shaped sneaks in. */
export function buildAdaptPayload(db: Database, nowIso: string): AdaptPayload {
  const since = new Date(Date.parse(nowIso) - 14 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query(`SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at DESC`)
    .all(since) as SessionRow[];

  const n = rows.length;
  const rate = (pred: (r: SessionRow) => boolean): number =>
    n === 0 ? 0 : Math.round((rows.filter(pred).length / n) * 100) / 100;
  const cacheRead = rows.reduce((a, r) => a + r.cache_read, 0);
  const tokensIn = rows.reduce((a, r) => a + r.tokens_in, 0);
  const toolCalls = rows.reduce((a, r) => a + r.tool_calls, 0);
  const toolFails = rows.reduce((a, r) => a + r.tool_fails, 0);

  const models: Record<string, number> = {};
  for (const r of rows) {
    const m = r.model ?? "unknown";
    if (/^[A-Za-z0-9.:_-]{1,64}$/.test(m)) models[m] = (models[m] ?? 0) + 1;
  }

  const waste: Record<string, number> = {};
  for (const t of db
    .query(`SELECT tip_id, COUNT(*) AS c FROM tips WHERE created_at >= ? GROUP BY tip_id`)
    .all(since) as Array<{ tip_id: string; c: number }>) {
    if (t.tip_id in TIPS) waste[t.tip_id] = t.c;
  }

  // events.tool_name is stored in cleartext for every PostToolUse hook event
  // (independent of any coaching mechanic), so subagent usage is a direct
  // count, not derived from anything else.
  const subagentSessions = (
    db
      .query(`SELECT COUNT(DISTINCT session_id) AS c FROM events WHERE tool_name IN ('Task','Agent') AND ts >= ?`)
      .get(since) as { c: number }
  ).c;

  const dismissed = (
    db.query(`SELECT tip_id, last_dismissed_at FROM tip_memory WHERE last_dismissed_at IS NOT NULL`).all() as Array<{
      tip_id: string;
      last_dismissed_at: string;
    }>
  )
    .filter((d) => d.tip_id in TIPS)
    .map((d) => ({
      tip_id: d.tip_id,
      days_ago: Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(d.last_dismissed_at)) / 86_400_000)),
    }));

  const pending = (
    db.query(`SELECT DISTINCT tip_id FROM tips WHERE status IN ('active','queued')`).all() as Array<{ tip_id: string }>
  )
    .map((t) => t.tip_id)
    .filter((id) => id in TIPS);

  return AdaptPayloadSchema.parse({
    window_days: 14,
    sessions: n,
    plan_rate: rate((r) => r.used_plan_mode === 1),
    subagent_rate: subagentSessions && n ? Math.min(1, Math.round((subagentSessions / n) * 100) / 100) : 0,
    cache_hit_rate: cacheRead + tokensIn > 0 ? Math.round((cacheRead / (cacheRead + tokensIn)) * 100) / 100 : 0,
    avg_context_pct: n ? Math.round(rows.reduce((a, r) => a + r.max_context_pct, 0) / n) : 0,
    max_context_pct: Math.round(rows.reduce((a, r) => Math.max(a, r.max_context_pct), 0)),
    compacts_auto: rows.reduce((a, r) => a + r.compacts_auto, 0),
    compacts_manual: rows.reduce((a, r) => a + r.compacts_manual, 0),
    tool_fail_rate: toolCalls > 0 ? Math.round((toolFails / toolCalls) * 100) / 100 : 0,
    models,
    waste,
    dismissed,
    pending_tips: pending,
  });
}

/** The full prompt for the headless call: catalog + profile + strict output contract. */
export function buildAdaptPrompt(payload: AdaptPayload): string {
  const catalog = Object.values(TIPS)
    .map((t) => `- ${t.id}: ${t.title} — ${t.what} Fix: ${t.fix}`.slice(0, 220))
    .join("\n");
  return [
    `You are the coaching analyzer for ${BRAND}, a tool that helps developers drive AI coding agents well.`,
    `Below is a developer's 14-day session profile (metadata only: rates, counts, ids) and a tip catalog.`,
    `Pick the ONE catalog tip whose advice this developer would benefit from most right now.`,
    ``,
    `Rules:`,
    `- Never pick an id in "dismissed" (recently snoozed) or "pending_tips" (already queued).`,
    `- Prefer the pattern the numbers actually show; weak signal → pick a broadly useful wisdom tip they haven't seen.`,
    `- "why" must be second person, ≤160 characters, and cite their concrete numbers (e.g. "plan mode in 1 of 12 sessions").`,
    ``,
    `Tip catalog:`,
    catalog,
    ``,
    `Developer profile JSON:`,
    JSON.stringify(payload),
    ``,
    `Respond with ONLY this JSON, no prose, no code fences:`,
    `{"tip_id": "<id from catalog>", "why": "<≤160 chars>", "confidence": <0..1>}`,
  ].join("\n");
}

/** Strip anything that could smuggle ANSI/newlines into the statusline. */
export function sanitizeWhy(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Validate a raw model response and queue the tip. Returns the queued tip id,
 * or null when the response is invalid / duplicate / in cooldown.
 */
export function applyAdaptResponse(db: Database, raw: unknown, nowIso: string): string | null {
  const parsed = AdaptResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { tip_id } = parsed.data;
  const why = sanitizeWhy(parsed.data.why);
  if (!why) return null;
  if (isInCooldown(db, tip_id, nowIso)) return null;
  const open = db
    .query(`SELECT id FROM tips WHERE tip_id = ? AND status IN ('active','queued') LIMIT 1`)
    .get(tip_id);
  if (open) return null;
  db.query(
    `INSERT INTO tips (tip_id, session_id, created_at, status, evidence, est_savings_tokens, why)
     VALUES (?, NULL, ?, 'queued', ?, 0, ?)`,
  ).run(tip_id, nowIso, JSON.stringify({ source: "adaptive" }), why);
  promoteNext(db);
  return tip_id;
}

/** Parse the stdout of the backend call — either bare JSON or the claude
 * CLI's --output-format json wrapper ({"type":"result","result":"…"}). */
export function parseAdaptOutput(stdout: string): unknown {
  const outer = extractJson(stdout);
  if (outer && typeof outer === "object" && "result" in (outer as Record<string, unknown>)) {
    const inner = (outer as Record<string, unknown>).result;
    if (typeof inner === "string") return extractJson(inner);
    return inner;
  }
  return outer;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
