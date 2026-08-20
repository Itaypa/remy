import {
  BRAND,
  EST_WEIGHT,
  effectiveTokens,
  envVar,
  HINTS,
  TIPS,
  renderTemplate,
  type EstClass,
  type SessionRow,
  type TipDef,
  type TipRow,
} from "@ccpp/core";

// Rendering only — no DB access, no host APIs. ANSI is allowed ONLY in the
// statusline; /remy report output lands in a markdown code block, so the
// report renderers stay plain unicode.

export function fmtTok(n: number): string {
  // Non-finite input renders as "NaN" or "InfinityM" otherwise — literal
  // nonsense on the statusline, the same failure family as an unfilled
  // {placeholder}. The negative clamp below already decided that a
  // nonsensical count shows as 0; this just finishes that thought.
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(n)));
}

export function fmtCost(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return `$${n.toFixed(2)}`;
}

/** Claude.ai Pro/Max only — payload.rate_limits is absent otherwise. Shows
 * whichever window (5h/7d) is closer to its cap, since that's the one
 * actually actionable right now. */
export function rateLimitBadge(rateLimits: unknown): string | null {
  const rl = rateLimits as { five_hour?: { used_percentage?: number }; seven_day?: { used_percentage?: number } } | null;
  const five = rl?.five_hour?.used_percentage;
  const seven = rl?.seven_day?.used_percentage;
  if (typeof five !== "number" && typeof seven !== "number") return null;
  const worse =
    typeof five === "number" && (typeof seven !== "number" || five >= seven)
      ? { pct: five, label: "5h" }
      : { pct: seven as number, label: "7d" };
  const rounded = Math.round(worse.pct);
  const pctStr = rounded >= 80 ? ansi("red", `${rounded}%`) : rounded >= 60 ? ansi("yellow", `${rounded}%`) : `${rounded}%`;
  return `⏳ ${pctStr} (${worse.label})`;
}

/** One spend field, chosen by plan type — never both. Falls back to $ cost
 * whenever rate-limit data isn't there yet (API accounts, or Pro/Max before
 * the first API response of a session) — rateLimitBadge() already returns
 * null when there's nothing usable inside it, so chaining `??` reuses that
 * check instead of duplicating it. */
export function spendField(cost: number | null | undefined, rateLimits: unknown): string | null {
  return rateLimitBadge(rateLimits) ?? fmtCost(cost);
}

/** What a finding is worth, in the only unit a developer can check against
 * their own bill.
 *
 * The derivation uses no price table — one would go stale, and it would be
 * wrong for subscription accounts. Instead the session prices itself: we know
 * what it cost (`cost_usd`, straight from the host) and we know its token mix,
 * so its own blended rate converts the estimate. Two measured numbers and one
 * division.
 *
 * Returns null when the session carries no cost — measured on real data, 9 of
 * 13 local sessions have none, because `cost_usd` only lands when the
 * statusline runs. The caller falls back to effective 🪙 rather than inventing
 * a rate, because a coach that shows a number it cannot derive is worse than
 * one that shows fewer numbers. */
export type TipLineSession = Pick<
  SessionRow,
  "cost_usd" | "tokens_in" | "tokens_out" | "cache_read" | "cache_write"
> | null | undefined;

/** The two things a coaching line needs that the tip row cannot carry: a
 * session to price the earn against, and the hash→filename map for the working
 * tree in front of the developer. Both are optional and both degrade to the
 * catalog's fallbacks, so a caller with neither still renders a valid line. */
export interface TipContext {
  session?: TipLineSession;
  files?: Map<string, string>;
}

export function earnDollars(
  estTokens: number,
  estClass: string | null | undefined,
  session: TipLineSession,
): number | null {
  const effective = effectiveTokens(estTokens, (estClass as EstClass) ?? "input");
  if (effective <= 0) return null;
  if (!session) return null;
  const cost = session.cost_usd;
  if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
  // The same weighting applied to the session itself, so the ratio is
  // base-input-equivalents on both sides of the division.
  const sessionEffective =
    (session.tokens_in ?? 0) +
    (session.tokens_out ?? 0) +
    (session.cache_read ?? 0) * EST_WEIGHT["cache-read"] +
    (session.cache_write ?? 0) * EST_WEIGHT["cold-write"];
  if (!Number.isFinite(sessionEffective) || sessionEffective <= 0) return null;
  return (effective * cost) / sessionEffective;
}

/** The third part of every coaching line, composed here and never authored in
 * the catalog — so no tip can quietly claim a value nothing measured.
 *
 * Order of preference: real money, then effective 🪙 when the session has no
 * cost recorded, then the catalog's `worth` for the findings whose payoff
 * genuinely isn't tokens, then nothing at all. */
export function earnClause(
  tip: TipRow,
  def: TipDef,
  session: TipLineSession,
): string | null {
  const dollars = earnDollars(tip.est_savings_tokens, tip.est_class, session);
  if (dollars != null) {
    // Below a cent there is no honest way to render it, and "≈$0.00" reads as
    // a bug. Fall through to the coin figure, which still has resolution.
    if (dollars >= 0.01) return `saves ≈$${dollars < 10 ? dollars.toFixed(2) : Math.round(dollars)}`;
  }
  const effective = effectiveTokens(tip.est_savings_tokens, (tip.est_class as EstClass) ?? "input");
  if (effective > 0) return `saves ~${fmtTok(effective)} 🪙`;
  return def.worth ? `worth: ${def.worth}` : null;
}

/** Below this, the field goes yellow: the cache is nearly out and wrapping up
 * before you step away is still a choice you can make. */
const CACHE_LOW_MS = 10 * 60_000;

/** Model id without the host's context-window qualifier — `claude-opus-5[1m]`
 * and `claude-opus-5` are one model spelled by two different sources. */
const baseModel = (id: string): string => id.replace(/\[[^\]]*\]$/, "");

/** The live cache clock — how long this session's prompt cache has left, or
 * that it has already gone cold.
 *
 * This is the one thing on the statusline that a hook could never tell you.
 * Every other REMY surface speaks when something happens; the cache drains
 * while nothing happens, so the passive HUD is the only place the number can
 * land. Its actionable moment is the cold transition: a warm cache re-reads
 * your whole context at 0.1× the input price, a cold one re-writes it at 2×,
 * so resuming a fat session cold costs about 20× resuming it warm — which is
 * the point at which /clear and a one-line brief beats reheating.
 *
 * Minute resolution, never seconds. The statusline repaints ~1/s, and a field
 * that changed every repaint would be motion in the corner of the eye rather
 * than information.
 *
 * Returns null only when the TTL was never observed — the field is otherwise
 * always present, because a statusline that gains and loses fields is a
 * different layout every time you glance at it. */
export function cacheField(
  ttlMs: number | null | undefined,
  anchorAt: string | null | undefined,
  cacheModel: string | null | undefined,
  liveModel: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  const cold = ansi("cyan", "🧊 cache cold");
  // The cache is per-model: switching models leaves the old entry warm but
  // unreachable, so the session in front of you is cold whatever the clock
  // says. Switching BACK to a model you used minutes ago also reads as cold
  // here, which understates the warmth — deliberately the safe direction, and
  // cheaper than tracking a per-model anchor for a case that costs nothing to
  // get wrong.
  //
  // The two sides come from different places and do NOT spell the model the
  // same way: cacheModel is the transcript's `message.model`, liveModel is the
  // statusline payload's `model.id`, and only the payload carries the
  // context-window qualifier — `claude-opus-5[1m]` against a transcript that
  // says `claude-opus-5` for the very same turn (see the ModelStr note in
  // core/src/schema.ts). Compared raw, every 1M-context session reads
  // permanently cold, which is both wrong and aimed at exactly the users whose
  // contexts cost the most to re-write. Normalising means a switch BETWEEN
  // context variants of one model is invisible here — unavoidable, since the
  // transcript never records the variant at all.
  if (cacheModel && liveModel && baseModel(cacheModel) !== baseModel(liveModel)) return cold;
  const anchor = anchorAt ? Date.parse(anchorAt) : NaN;
  if (!Number.isFinite(anchor)) return null;
  const left = ttlMs - (now - anchor);
  if (left <= 0) return cold;
  // A clock in the future is a clock skew or a hand-edited row, not warmth we
  // measured — clamp rather than promise more than the TTL.
  const mins = Math.min(Math.ceil(ttlMs / 60_000), Math.floor(left / 60_000));
  const value = mins < 1 ? "<1m" : `${mins}m`;
  return `🔥 cache ${left <= CACHE_LOW_MS ? ansi("yellow", value) : value}`;
}

export function bar(pct: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function modelEmoji(modelId: string | null | undefined): string {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("fable") || id.includes("mythos")) return "🐉";
  if (id.includes("opus")) return "🎭";
  if (id.includes("sonnet")) return "🎼";
  if (id.includes("haiku")) return "🍃";
  return "🤖";
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
/** Apply one or more codes, e.g. ansi("cyan", "underline", s) — the active
 * tip while Claude is generating gets underline + color, the same "this is
 * live, pay attention" cue Claude Code's own status line uses. */
export function ansi(...args: [...codes: (keyof typeof ANSI)[], s: string]): string {
  const s = args[args.length - 1] as string;
  const codes = args.slice(0, -1) as (keyof typeof ANSI)[];
  return `${codes.map((c) => ANSI[c]).join("")}${s}${ANSI.reset}`;
}

// OSC 8 hyperlinks (cmd/ctrl+click) — statusline only, like ANSI. Emitted only
// for terminals known to support them; everywhere else the text stays plain.
// REMY_LINKS=1/0 forces on/off.
const OSC8_TERM_PROGRAMS = new Set(["iTerm.app", "WezTerm", "vscode", "ghostty", "kitty", "Hyper", "Tabby", "rio"]);
export function linksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const forced = envVar("LINKS", env);
  if (forced === "1") return true;
  if (forced === "0") return false;
  return (
    OSC8_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? "") ||
    env.TERM === "xterm-kitty" ||
    env.TERM === "xterm-ghostty"
  );
}
export const osc8 = (s: string, url: string) => `\x1b]8;;${url}\x1b\\${s}\x1b]8;;\x1b\\`;
/** Wrap text in a clickable link when the terminal supports it; plain text otherwise. */
export const linkify = (s: string, url: string | undefined): string =>
  url && linksEnabled() ? osc8(s, url) : s;

/** "Same file edited 36×, 2+ misses → /clear + re-brief → +165k 🪙" — problem
 * → solution, plus a value clause appended here (not baked into `short`) so
 * wisdom tips (no est) render as problem → solution with nothing dangling. */
/** Template variables for a tip row, in the one precedence that is correct:
 * the catalog's fallbacks underneath, the row's own evidence on top, and any
 * caller-supplied extras (`est`) last.
 *
 * Extracted because it was written out twice — here and in the report — and
 * an ordering duplicated in two places is an ordering nothing checks. Flipping
 * either copy made a measured value lose to the generic fallback, silently,
 * with the whole suite still green. */
export function tipVars(
  def: TipDef,
  evidence: Record<string, string | number>,
  extra: Record<string, string | number> = {},
): Record<string, string | number> {
  return { ...def.fallbacks, ...evidence, ...extra };
}

function tipBody(
  tip: TipRow,
  def: TipDef,
  template = def.short,
  extra: Record<string, string | number> = {},
): string {
  let evidence: Record<string, string | number> = {};
  try {
    evidence = tip.evidence ? JSON.parse(tip.evidence) : {};
  } catch {
    // evidence is display-only
  }
  const rendered = renderTemplate(template, tipVars(def, evidence, extra));
  // Not every tip row carries the evidence its template asks for: the adaptive
  // analyzer files tips with evidence {source:"adaptive"} and no session
  // numbers at all (adapt.ts), and it may pick any catalog id, including a
  // rule-backed one whose `short` is written around {edits}/{count}/{files}.
  // renderTemplate passes unknown keys through verbatim — correct, since
  // inventing a number would be worse — so without this the statusline reads
  // "Same file edited {edits}×". The title says the same thing with no
  // evidence in it, which is exactly the right thing to say when we have none.
  return UNRESOLVED_PLACEHOLDER.test(rendered) ? def.title : rendered;
}

/** Non-global on purpose: a /g regex carries lastIndex between .test() calls. */
const UNRESOLVED_PLACEHOLDER = /\{\w+\}/;

/** "[🐭 REMY]: 🔨 Same file edited 36×, 2+ misses → /clear + re-brief → +165k 🪙"
 * — one format for every tip surface: the statusline, the session-start
 * splash, and the Stop-hook nudge all call this. The bracketed brand tag is
 * the whole signal this is a coaching message, not a stats line. */
export function tipLine(tip: TipRow): string {
  const def = TIPS[tip.tip_id];
  if (!def) return `[${BRAND}]: 💡 /remy for your session report`;
  // The narrow form keeps the raw-token value clause: the splash box has no
  // room for "saves ≈$0.40" alongside a 55-char body, and no session row to
  // price it with. Effective tokens rather than raw, so it can never disagree
  // with what the wide form says about the same finding.
  const effective = effectiveTokens(tip.est_savings_tokens, (tip.est_class as EstClass) ?? "input");
  const value = effective > 0 ? ` → +${fmtTok(effective)} 🪙` : "";
  return `[${BRAND}]: ${def.emoji} ${tipBody(tip, def)}${value}`;
}

/** The wide-surface line, and the shape the whole catalog is written to:
 *
 *   [🐭 REMY]: 🔨 packages/cli/src/index.ts took 14 edits with 19 re-reads
 *              between them → /clear and re-brief before attempt 15 → saves ≈$0.40
 *
 * — evidence you recognize, the thing to do, and what it's worth. Used by the
 * spinner deck and the Stop-hook nudge, both of which have the full terminal
 * width; `tipLine()` stays the narrow form for the boxed splash.
 *
 * `extra` carries the two values the renderer cannot derive from the row
 * alone: `file`, resolved from the stored hash by whoever has the working tree
 * in front of them (resolve.ts), and anything else a caller has measured. Left
 * out, the catalog's `fallbacks` put the old generic wording back, which is the
 * whole reason this degrades quietly instead of printing a `{placeholder}`.
 *
 * Wisdom tips have no session evidence, so they have no `problem` half and
 * fall back to `short` — which is why this can't simply replace tipLine(). */
export function tipLineLong(
  tip: TipRow,
  session?: TipLineSession,
  extra: Record<string, string | number> = {},
): string {
  const def = TIPS[tip.tip_id];
  if (!def) return `[${BRAND}]: 💡 /remy for your session report`;
  const template = def.problem && def.action ? `${def.problem} → ${def.action}` : def.short;
  const body = tipBody(tip, def, template, extra);
  const earn = earnClause(tip, def, session);
  return `[${BRAND}]: ${def.emoji} ${body}${earn ? ` → ${earn}` : ""}`;
}

/** "[🐭 REMY]: context at 92% — every reply re-reads 184k 🪙" — the
 * context-overflow alarm, moved off the statusline (it used to replace the
 * whole line at ctx>=80%) onto the Stop-hook nudge, so the statusline stays
 * one constant layout. Same [Brand]: format as tipLine(). */
export function contextAlarmLine(pct: number, contextTokens: number): string {
  return `[${BRAND}]: context at ${pct}% — every reply re-reads ${fmtTok(contextTokens)} 🪙`;
}

export function rotatingHint(): string {
  const dayOfYear = Math.floor(
    (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000,
  );
  return HINTS[dayOfYear % HINTS.length]!;
}

export interface WeekTotals {
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cost: number;
  planSessions: number;
  autoCompacts: number;
}

export function weekTotals(rows: SessionRow[]): WeekTotals {
  return {
    sessions: rows.length,
    tokensIn: rows.reduce((a, r) => a + r.tokens_in, 0),
    tokensOut: rows.reduce((a, r) => a + r.tokens_out, 0),
    cacheRead: rows.reduce((a, r) => a + r.cache_read, 0),
    cost: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    planSessions: rows.filter((r) => r.used_plan_mode).length,
    autoCompacts: rows.reduce((a, r) => a + r.compacts_auto, 0),
  };
}

/** The full halftone rat (packages/plugin-claude-code/art/rat.txt) downsampled
 * to a greeting. Shown ONCE per version — the first session after an install
 * or an upgrade — because a session starts far more often than people think
 * (/clear, resume, /reload-plugins), and art that appears every time stops
 * being art and becomes scrollback. */
const WELCOME_ART = [
  "                ...      :::",
  "              .:#@#+---::::.",
  "            . :@@#%@@@@@#*:.",
  "         :=##%@@@@@@@@@@+-+:.",
  "         .:+*#@@@@@@@@#=-+++-",
  ".           :+@@@@@@%+==%#-:",
  "           -%@@@@@@@@@@@%:.",
  "         :+@@@@@@@@@@%=:",
  "        :#@@@@@@@@%=..",
  "        #@@@@@@@@@#:",
  "       -@@@@@@@%@%*:",
  "       -@@@@@@@@@%%-",
  "       :@@@@@%@%%%#+.",
  " ...:-+*@@@@@%@@@@@+.",
  "-====:::-%@@@@@@@@#+:",
  ".--:    ..:=+=:.    .",
];

// The everyday mascot, three lines tall, padded to one column so the text
// beside it lines up. The tail deliberately runs toward line 3 — the tip
// line, which is the one thing on the splash worth reading.
const ART = ["  ,__,      ", " (o,o)      ", ' (")_(")~~~ '];

export function splash(opts: {
  version: string;
  week: WeekTotals;
  tip: TipRow | null;
  /** Existing install with a remy statusLine but no refreshInterval — the
   * loading-screen tip can never repaint mid-turn. Doesn't compete for the
   * line3 spotlight (it's rare and one-shot per week); appended as its own
   * line instead. */
  refreshNudge?: boolean;
  /** First session on this version — the one time the full rat shows up. */
  welcome?: boolean;
}): string {
  const spend = opts.week.tokensIn + opts.week.tokensOut;
  // One line, strict priority: your personal tip, else a rotating hint.
  const line3 = opts.tip ? `${tipLine(opts.tip)}  · /remy` : rotatingHint();
  // The welcome takes the art full-size and stacks the text underneath; every
  // other session keeps the compact mark with the text beside it.
  const lines = opts.welcome
    ? [
        ...WELCOME_ART,
        "",
        ` REMY v${opts.version} — he watches you drive, and tells you what it cost`,
        ` last 7d: ${opts.week.sessions} sessions · ${fmtTok(spend)} 🪙`,
        ` ${line3}`,
      ]
    : [
        `${ART[0]}   REMY v${opts.version}`,
        `${ART[1]}   last 7d: ${opts.week.sessions} sessions · ${fmtTok(spend)} 🪙`,
        `${ART[2]}   ${line3}`,
      ];
  if (opts.refreshNudge) {
    lines.push(`     ⚙ run "remy init" — turns on live loading-screen tips`);
  }
  return lines.join("\n");
}

const W = 52;
const head = (label: string) => `╭─ ${label} ${"─".repeat(Math.max(2, W - label.length - 4))}`;
const sep = (label: string) => `├─ ${label} ${"─".repeat(Math.max(2, W - label.length - 4))}`;
// `W - 1` because the corner glyph itself occupies the first column, the same
// way `╭─ ` does in head(): head/sep both come out exactly W wide, and a foot
// of W dashes plus the corner would run one past them.
const foot = () => `╰${"─".repeat(W - 1)}`;

/** Labeled report row with a hanging indent:
 * `│   what happened  One file took 15 edit…`
 * `│                  attempts, with re-reads…` */
const ROW_LABEL_W = 14;
function row(label: string, text: string): string[] {
  return wrap(text, W - 4 - ROW_LABEL_W - 1).map(
    (t, i) => `│   ${(i === 0 ? label : "").padEnd(ROW_LABEL_W)} ${t}`,
  );
}

/** `{file}` from an already-parsed evidence object, or nothing.
 *
 * Local rather than imported from resolve.ts on purpose: this file is pure
 * rendering, and resolve.ts spawns a subprocess. Keeping the lookup here means
 * ui.ts never pulls process-spawning code into its import graph — the caller
 * does the resolving and hands the map in. */
function fileVarFrom(
  evidence: Record<string, string | number>,
  files: Map<string, string> | undefined,
): Record<string, string> {
  const hash = evidence.file_hash;
  const name = typeof hash === "string" ? files?.get(hash) : undefined;
  return name ? { file: name } : {};
}

/** "claude-haiku-4-5-20251001" → "haiku-4-5" — the part a human reads. */
function shortModel(model: string | null): string {
  if (!model) return "unknown model";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function renderReport(opts: {
  session: SessionRow;
  tips: TipRow[];
  active: TipRow | null;
  /** hash → repo-relative filename, resolved by the caller (resolve.ts). */
  files?: Map<string, string>;
  adaptive?: { enabled: boolean; lastRunHours: number | null };
}): string {
  const s = opts.session;
  const lines: string[] = [head("🐭 REMY · session report")];
  const cacheDenom = s.cache_read + s.tokens_in;
  const cacheHit = cacheDenom > 0 ? Math.round((s.cache_read / cacheDenom) * 100) : null;
  const cost = fmtCost(s.cost_usd);
  lines.push(
    `│ 🎮 session  ${s.session_id.slice(0, 8)} · ${shortModel(s.model)} · plan mode ${s.used_plan_mode ? "✓ used" : "✗ not used"}`,
    `│ ⚡ tokens   ${fmtTok(s.tokens_in)} in → ${fmtTok(s.tokens_out)} out${cost ? ` · ${cost}` : ""}`,
    ...(cacheHit != null
      ? [`│ 💾 cache    ${cacheHit}% reused from cache (${fmtTok(s.cache_read)} tokens ≈ free)`]
      : []),
    // Denials are appended only when there were any — a permanent "0 denied"
    // on every report is noise, and the noise budget is law.
    `│ 🧰 tools    ${s.tool_calls} calls · ${s.tool_fails} failed${s.perm_denials > 0 ? ` · ${s.perm_denials} denied` : ""}`,
    `│ 🧠 context  ${bar(s.max_context_pct)} peaked at ${Math.round(s.max_context_pct)}% · compacts: ${s.compacts_auto} auto / ${s.compacts_manual} manual`,
  );

  // Waste rows worth ~0 tokens are noise, not insight — only show real losses.
  // Measured in effective tokens and priced off this session, so the figure
  // here is the same one the coaching line quotes rather than a raw count that
  // silently disagrees with it.
  const waste = opts.tips
    .map((t) => ({ t, worth: earnDollars(t.est_savings_tokens, t.est_class, s) }))
    .filter((w) => effectiveTokens(w.t.est_savings_tokens, (w.t.est_class as EstClass) ?? "input") > 0);
  lines.push(sep("🔎 waste found this session"));
  if (waste.length > 0) {
    for (const { t, worth } of waste) {
      const def = TIPS[t.tip_id];
      const eff = effectiveTokens(t.est_savings_tokens, (t.est_class as EstClass) ?? "input");
      const amount = worth != null && worth >= 0.01 ? `≈$${worth.toFixed(2)}` : `~${fmtTok(eff)} 🪙`;
      lines.push(`│ ${def?.emoji ?? "•"} ${def?.title ?? t.tip_id} — ${amount} recoverable`);
    }
  } else if (opts.tips.length === 0) {
    lines.push("│ ✨ none — clean session!");
  } else {
    // Findings that cost no tokens still exist — `subagent-offload` buys room
    // in the window rather than tokens back. Calling the session clean and
    // then coaching it in the very next box is the report contradicting itself
    // on one screen, so say what is actually true instead.
    lines.push("│ ✨ no tokens left on the table — one habit worth a look below");
  }

  if (opts.active) {
    const def = TIPS[opts.active.tip_id];
    lines.push(sep("💡 next tip"));
    if (def) {
      let evidence: Record<string, string | number> = {};
      try {
        evidence = opts.active.evidence ? JSON.parse(opts.active.evidence) : {};
      } catch {}
      // A stored row from an older version, or an adaptive row with no session
      // numbers, still renders a whole sentence here — this path has no title
      // fallback to catch a stray placeholder.
      const activeEff = effectiveTokens(
        opts.active.est_savings_tokens,
        (opts.active.est_class as EstClass) ?? "input",
      );
      const vars = tipVars(def, evidence, {
        est: fmtTok(activeEff),
        // Resolved from the working tree, never stored — see resolve.ts. Absent
        // when it could not be resolved, which lets `fallbacks` stand in.
        ...fileVarFrom(evidence, opts.files),
      });
      lines.push(`│ ${def.emoji} ${def.title}`);
      // Labeled rows: what happened → what it's worth → what to do. The
      // adaptive analyzer's own sentence (with the user's numbers) replaces
      // the generic "what happened" when present.
      lines.push(
        ...row("what happened", opts.active.why ? `🤖 ${opts.active.why}` : renderTemplate(def.what, vars)),
      );
      const worth = earnDollars(opts.active.est_savings_tokens, opts.active.est_class, s);
      if (worth != null && worth >= 0.01) {
        lines.push(...row("worth", `≈$${worth.toFixed(2)} back in your pocket`));
      } else if (activeEff > 0) {
        lines.push(...row("worth", `~${fmtTok(activeEff)} 🪙 back in your pocket`));
      } else if (def.worth) {
        lines.push(...row("worth", def.worth));
      }
      lines.push(...row("next time", renderTemplate(def.fix, vars)));
      if (def.cite?.quote) {
        lines.push(...row("the experts", `📖 "${def.cite.quote}" — ${def.cite.author ?? def.cite.source}`));
      }
      lines.push(`│`, `│   read more ↗ ${def.cite?.url ?? def.docs}`, `│   not helpful? snooze 30 days: /remy-dismiss`);
    } else {
      lines.push(`│ ${tipLine(opts.active)}`, `│   snooze 30 days: /remy-dismiss`);
    }
  }

  if (opts.adaptive) {
    const a = opts.adaptive;
    lines.push(
      `│ 🤖 adaptive: ${a.enabled ? "on" : "off"}` +
        (a.enabled && a.lastRunHours != null ? ` · last analyzed ${a.lastRunHours}h ago` : "") +
        ` · "remy adapt --${a.enabled ? "off" : "on"}" to ${a.enabled ? "disable" : "enable"}`,
    );
  }
  lines.push(foot());
  return lines.join("\n");
}

export function renderWeek(opts: {
  rows: SessionRow[];
  totals: WeekTotals;
  wasteTips: number;
  wasteTokens: number;
}): string {
  const lines: string[] = [head("🗓 COACH · last 7 days")];
  const byDay = new Map<string, { tok: number; cost: number }>();
  for (const r of opts.rows) {
    const d = r.started_at.slice(0, 10);
    const cur = byDay.get(d) ?? { tok: 0, cost: 0 };
    cur.tok += r.tokens_in + r.tokens_out;
    cur.cost += r.cost_usd ?? 0;
    byDay.set(d, cur);
  }
  const max = Math.max(1, ...[...byDay.values()].map((v) => v.tok));
  for (const [day, v] of [...byDay.entries()].sort()) {
    const cost = fmtCost(v.cost);
    lines.push(`│ ${day.slice(5)}  ${bar((v.tok / max) * 100)} ${fmtTok(v.tok)}${cost ? ` · ${cost}` : ""}`);
  }
  if (byDay.size === 0) lines.push("│ no sessions recorded yet — start a session and he'll watch");
  const t = opts.totals;
  const cost = fmtCost(t.cost);
  lines.push(
    sep("Σ totals"),
    `│ ${fmtTok(t.tokensIn + t.tokensOut)} 🪙${cost ? ` · ${cost}` : ""} · ${t.sessions} sessions · ${t.planSessions} plan-mode`,
    `│ waste caught: ${opts.wasteTips} tips · ~${fmtTok(opts.wasteTokens)} 🪙 recoverable`,
    foot(),
  );
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}
