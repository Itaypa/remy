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

// --- Rate-limit pace --------------------------------------------------------
//
// A used-percentage on its own is not actionable: 43% of the 5-hour window
// with four hours still to run is a lockout in the making, and 43% with twenty
// minutes left is headroom about to go unspent. Same digits, opposite advice.
// The host hands us `resets_at` alongside the percentage, so the badge compares
// what you have used against how far through the window you are, and colours
// by THAT. A lockout is the single most expensive waste event a subscriber has
// (it costs the rest of the window), and pace is the earliest cheap warning.

/** Window lengths, in seconds, as the host names them. */
const WINDOW_SECONDS = { five_hour: 5 * 3600, seven_day: 7 * 86_400 } as const;
type WindowKey = keyof typeof WINDOW_SECONDS;
const WINDOW_LABEL: Record<WindowKey, string> = { five_hour: "5h", seven_day: "7d" };

/** Points over the clock before the field turns yellow, then red. Ten points
 * on a 5-hour window is half an hour of budget spent early — noticeable,
 * recoverable. Twenty-five is a quarter of the window gone ahead of time. */
export const PACE_WARN_POINTS = 10;
export const PACE_RED_POINTS = 25;
/** Past this, red regardless of pace: the wall is close enough that one fat
 * turn ends the window, however good the pacing looked. */
const PACE_HARD_PCT = 90;

/** The 7-day window is paced in AWAKE hours. A week has nights in it, and a
 * budget line that keeps rising while you sleep reads red every morning for
 * nothing you did. Default: the day rolls over at 2am and the next six hours
 * carry no weight. Local time, so the offset is a parameter — tests pass 0. */
export const PACE_DAY_START_HOUR = 2;
export const PACE_SLEEP_HOURS = 6;

/** Seconds in [a, b) that fall outside the nightly sleep block, in local time.
 * `tzOffsetMin` is `Date#getTimezoneOffset()` — minutes to ADD to local time
 * to reach UTC, so local = utc − offset. */
export function awakeSeconds(
  a: number,
  b: number,
  tzOffsetMin: number,
  dayStartHour: number = PACE_DAY_START_HOUR,
  sleepHours: number = PACE_SLEEP_HOURS,
): number {
  if (!(b > a)) return 0;
  const DAY = 86_400;
  const sleep = sleepHours * 3600;
  const la = a - tzOffsetMin * 60;
  const lb = b - tzOffsetMin * 60;
  let asleep = 0;
  // Walk every day-start from the one at or before `a` to the last before `b`.
  let dayStart = Math.floor((la - dayStartHour * 3600) / DAY) * DAY + dayStartHour * 3600;
  for (; dayStart < lb; dayStart += DAY) {
    const lo = Math.max(la, dayStart);
    const hi = Math.min(lb, dayStart + sleep);
    if (hi > lo) asleep += hi - lo;
  }
  return b - a - asleep;
}

/** "2h10m", "45m", "1d9h", "<1m" — minute resolution, like the cache clock. */
export function humanDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return "<1m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 === 0 ? `${hours}h` : `${hours}h${String(mins % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
}

interface Pace {
  pct: number;
  label: string;
  /** Points used minus points of the window elapsed. Positive = ahead of the
   * clock (burning too fast). null when the host sent no `resets_at`. */
  delta: number | null;
  /** Seconds until the window resets, or null without `resets_at`. */
  resetIn: number | null;
  /** Seconds until 100% at the current average rate, or null. */
  outIn: number | null;
}

function paceOf(w: unknown, key: WindowKey, nowSec: number, tzOffsetMin: number): Pace | null {
  const o = w as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  if (!o || typeof o.used_percentage !== "number" || !Number.isFinite(o.used_percentage)) return null;
  const pct = o.used_percentage;
  const label = WINDOW_LABEL[key];
  const len = WINDOW_SECONDS[key];
  if (typeof o.resets_at !== "number" || !Number.isFinite(o.resets_at)) {
    return { pct, label, delta: null, resetIn: null, outIn: null };
  }
  const resetIn = Math.min(len, Math.max(0, o.resets_at - nowSec));
  const elapsed = len - resetIn;
  const start = o.resets_at - len;
  // The week is paced in awake hours; the 5-hour window is a plain clock.
  const elapsedShare =
    key === "seven_day"
      ? awakeSeconds(start, nowSec, tzOffsetMin) / Math.max(1, awakeSeconds(start, o.resets_at, tzOffsetMin))
      : elapsed / len;
  const delta = pct - Math.min(1, Math.max(0, elapsedShare)) * 100;
  // Linear projection on wall-clock elapsed: at this average rate, how long
  // until the budget is gone. Only shown when over pace, where by construction
  // it lands before the reset.
  const outIn = pct > 0 && elapsed > 0 ? ((100 - pct) / pct) * elapsed : null;
  return { pct, label, delta, resetIn, outIn };
}

/** Claude.ai Pro/Max only — payload.rate_limits is absent otherwise.
 *
 * Shows one window. With `resets_at` in hand, the one furthest ahead of its
 * clock, since that is the one that needs a decision; a window past 90% wins
 * outright, because at that point pace no longer matters. On an older host
 * that sends no `resets_at`, falls back to whichever is closer to its cap and
 * to the fixed 60/80 colouring.
 *
 * Renders `⏳ 43% (5h) ↻2h10m` on pace, and `⏳ 62% (5h) out in 1h20m` once
 * ahead of it — the forecast replaces the countdown because it is the more
 * actionable of the two numbers at that moment (and the gap between them is
 * the lockout you are heading for). Pace colours the percentage: yellow at
 * +10 points over the clock, red at +25 or past 90% used. Under pace there is
 * no colour, which is itself information — the quota will reset unspent, so
 * now is the time for the expensive run. */
export function rateLimitBadge(
  rateLimits: unknown,
  nowMs: number = Date.now(),
  tzOffsetMin: number = new Date(nowMs).getTimezoneOffset(),
): string | null {
  const rl = rateLimits as { five_hour?: unknown; seven_day?: unknown } | null | undefined;
  const nowSec = nowMs / 1000;
  const windows = [paceOf(rl?.five_hour, "five_hour", nowSec, tzOffsetMin), paceOf(rl?.seven_day, "seven_day", nowSec, tzOffsetMin)].filter(
    (p): p is Pace => p !== null,
  );
  if (windows.length === 0) return null;
  const byPct = [...windows].sort((a, b) => b.pct - a.pct)[0]!;
  const allPaced = windows.every((p) => p.delta !== null);
  const pick =
    byPct.pct >= PACE_HARD_PCT || !allPaced ? byPct : [...windows].sort((a, b) => b.delta! - a.delta!)[0]!;

  const rounded = Math.round(pick.pct);
  let tone: "red" | "yellow" | null;
  if (pick.delta === null) {
    tone = rounded >= 80 ? "red" : rounded >= 60 ? "yellow" : null;
  } else {
    tone =
      rounded >= PACE_HARD_PCT || pick.delta >= PACE_RED_POINTS
        ? "red"
        : pick.delta >= PACE_WARN_POINTS
          ? "yellow"
          : null;
  }
  const paint = (s: string) => (tone ? ansi(tone, s) : s);
  const overPace = pick.delta !== null && pick.delta >= PACE_WARN_POINTS && pick.outIn !== null;
  const tail = overPace
    ? ` ${paint(`out in ${humanDur(pick.outIn!)}`)}`
    : pick.resetIn !== null
      ? ` ${ansi("dim", `↻${humanDur(pick.resetIn)}`)}`
      : "";
  return `⏳ ${paint(`${rounded}%`)} (${pick.label})${tail}`;
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
export interface Earn {
  /** Full sentence for the three-line card: "This cost about $0.40." */
  sentence: string;
  /** Compact form for one-line surfaces: "≈$0.40", "~12k tokens 🪙". */
  compact: string;
}

export function earnOf(tip: TipRow, def: TipDef, session: TipLineSession): Earn | null {
  const dollars = earnDollars(tip.est_savings_tokens, tip.est_class, session);
  // Below a cent there is no honest way to render it, and "≈$0.00" reads as a
  // bug. Fall through to the token figure, which still has resolution.
  if (dollars != null && dollars >= 0.01) {
    const money = `$${dollars < 10 ? dollars.toFixed(2) : Math.round(dollars)}`;
    return { sentence: `This cost about ${money}.`, compact: `≈${money}` };
  }
  const effective = effectiveTokens(tip.est_savings_tokens, (tip.est_class as EstClass) ?? "input");
  if (effective > 0) {
    // The coin is decoration next to a number a beginner can read on its own.
    const tokens = `${fmtTok(effective)} tokens 🪙`;
    return { sentence: `That's about ${tokens}.`, compact: `~${tokens}` };
  }
  if (def.worth) return { sentence: `What you gain: ${def.worth}.`, compact: `gain: ${def.worth}` };
  return null;
}

/** The cost as one sentence, for callers that only want the words. */
export function earnClause(tip: TipRow, def: TipDef, session: TipLineSession): string | null {
  return earnOf(tip, def, session)?.sentence ?? null;
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
  return warmField(left, ttlMs);
}

/** `🔥 cache 52m` for a cache with `leftMs` to live. A clock in the future is
 * a clock skew or a hand-edited row, not warmth we measured — clamped to the
 * TTL when one is known rather than promising more than the host sells. */
function warmField(leftMs: number, ttlMs: number | null): string {
  const cap = ttlMs !== null ? Math.ceil(ttlMs / 60_000) : Infinity;
  const mins = Math.min(cap, Math.floor(leftMs / 60_000));
  const value = mins < 1 ? "<1m" : `${mins}m`;
  return `🔥 cache ${leftMs <= CACHE_LOW_MS ? ansi("yellow", value) : value}`;
}

/** The same clock, fed by the host instead of by us. Claude Code ≥ 2.1.251
 * ships a `prompt_cache` object on the statusline payload with the exact
 * `expires_at` of the main conversation's cached prefix, which beats a TTL we
 * inferred from the transcript and an anchor we stamped one response late.
 * cacheField() stays as the fallback for older hosts.
 *
 * Three-way result, because the fallback is only right in one of the three:
 *   - a string: the host told us warm-with-expiry or cold → render it;
 *   - null: the host says caching is not happening at all
 *     (`caching_observed: false` — API-side disabled, or a gateway that drops
 *     the markers), so there is nothing to clock and our derived number would
 *     be a fiction → render no field;
 *   - undefined: no usable object (older host, pre-first-response) → the
 *     caller falls back to cacheField().
 * The per-model override stays on top: the host's `warm` describes the entry
 * the LAST request touched, and a `/model` switch makes the next one miss
 * before that flag has any reason to move. */
export function hostCacheField(
  promptCache: unknown,
  cacheModel: string | null | undefined,
  liveModel: string | null | undefined,
  now: number = Date.now(),
): string | null | undefined {
  const o = promptCache as
    | { warm?: unknown; caching_observed?: unknown; ttl?: unknown; expires_at?: unknown }
    | null
    | undefined;
  if (!o || typeof o !== "object") return undefined;
  if (o.caching_observed === false) return null;
  const cold = ansi("cyan", "🧊 cache cold");
  if (cacheModel && liveModel && baseModel(cacheModel) !== baseModel(liveModel)) return cold;
  if (o.warm === false) return cold;
  if (typeof o.expires_at !== "number" || !Number.isFinite(o.expires_at)) return undefined;
  const left = o.expires_at * 1000 - now;
  if (left <= 0) return cold;
  const ttlMs = o.ttl === "5m" ? 5 * 60_000 : o.ttl === "1h" ? 60 * 60_000 : null;
  return warmField(left, ttlMs);
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

/** The effort levels the host documents. Anything else — a future level, a
 * typo, a hostile payload — is dropped rather than rendered. */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** `🐉 Fable/xhigh ↯fast` — the model, and the two dials that multiply its
 * price. Effort and fast mode belong on the model field rather than on their
 * own because that is what they are: `max` on a top-tier model is the most
 * expensive seat in the house, and fast mode doubles the token price of
 * whatever is in it. Both are quiet until they cost something — only `max`
 * and the fast marker take colour, in the dirty-dot's "attention, not alarm"
 * yellow. The slash binds the level to the model so `Fable max` is never read
 * as a model called that. Absent effort (a model without the dial) renders the
 * plain name, as before. */
export function modelField(
  modelId: string | null | undefined,
  displayName: string | null | undefined,
  effortLevel: unknown,
  fastMode: unknown,
): string {
  let s = `${modelEmoji(modelId)} ${displayName ?? "Claude"}`;
  if (typeof effortLevel === "string" && EFFORT_LEVELS.has(effortLevel)) {
    s += `/${effortLevel === "max" ? ansi("yellow", effortLevel) : effortLevel}`;
  }
  if (fastMode === true) s += ` ${ansi("yellow", "↯fast")}`;
  return s;
}

/** Review state glyphs for the PR field. The approved tick is the one green
 * thing on the line, which is deliberate: it is the only state that says "you
 * are done here". A function, not a module const: it needs ansi(), whose
 * colour table is declared further down this file. */
function prStateGlyph(state: string): string | undefined {
  switch (state) {
    case "approved":
      return ansi("green", "✔");
    case "changes_requested":
      return ansi("red", "✘");
    case "pending":
      return ansi("dim", "○");
    case "draft":
      return ansi("dim", "✎");
    default:
      return undefined;
  }
}

/** `🔀 #123 ✔` — the branch's open pull request and where its review stands.
 * Straight off the host's `pr` object (it mirrors the footer badge, so no
 * network call of ours); a GitLab merge request renders `!123`. The number is
 * a cmd-click link to the PR on terminals that support OSC 8. Absent outside a
 * repo, before a PR exists, and once it merges — the host drops the object. */
export function prField(pr: unknown): string | null {
  const p = pr as { number?: unknown; url?: unknown; review_state?: unknown; kind?: unknown } | null | undefined;
  if (!p || typeof p !== "object") return null;
  if (typeof p.number !== "number" || !Number.isInteger(p.number) || p.number <= 0) return null;
  const ref = `${p.kind === "mr" ? "!" : "#"}${p.number}`;
  const url = typeof p.url === "string" && /^https:\/\/\S+$/.test(p.url) ? p.url : undefined;
  const state = typeof p.review_state === "string" ? prStateGlyph(p.review_state) : undefined;
  return `🔀 ${linkify(ref, url)}${state ? ` ${state}` : ""}`;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
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
  const value = effective > 0 ? ` → ~${fmtTok(effective)} tokens 🪙` : "";
  return `[${BRAND}]: ${def.emoji} ${tipBody(tip, def)}${value}`;
}

/** "claude edited x" → "Claude edited x." — catalog fields are written as
 * clauses so they compose on one line; the card shows them as sentences. */
function sentence(s: string): string {
  const head = capFirst(s.trim());
  if (!head) return head;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

function capFirst(s: string): string {
  return /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The three parts of a tip, rendered against its evidence: what happened,
 * why it matters, how to fix. `problem` falls back to the adaptive coach's own
 * sentence, then to the title, when the row cannot fill its placeholders. */
function tipParts(
  tip: TipRow,
  def: TipDef,
  extra: Record<string, string | number>,
): { problem: string; impact: string; action: string } {
  let evidence: Record<string, string | number> = {};
  try {
    evidence = tip.evidence ? JSON.parse(tip.evidence) : {};
  } catch {
    // evidence is display-only
  }
  const vars = tipVars(def, evidence, extra);
  const fill = (tpl: string) => renderTemplate(tpl, vars);
  const problem = fill(def.problem);
  return {
    problem: UNRESOLVED_PLACEHOLDER.test(problem) ? (tip.why ?? def.title) : problem,
    impact: fill(def.impact),
    action: fill(def.action),
  };
}

/** The one-line form, for surfaces that can only show one line (the spinner
 * deck under `Forging…`):
 *
 *   [🐭 REMY]: 🔨 Claude edited index.ts 14 times, re-reading it 17 times in
 *   between — every new try re-sends all the failed tries before it (≈$0.40)
 *   → type /clear, then explain the problem again in a sentence or two
 *
 * Same three parts as tipCard(), in the same order, with the cost beside the
 * impact it measures. `extra` carries what the renderer cannot derive from the
 * row alone: `file`, resolved from the stored hash by whoever has the working
 * tree in front of them (resolve.ts). Left out, the catalog's `fallbacks`
 * restore generic wording rather than printing a `{placeholder}`. */
export function tipLineLong(
  tip: TipRow,
  session?: TipLineSession,
  extra: Record<string, string | number> = {},
): string {
  const def = TIPS[tip.tip_id];
  if (!def) return `[${BRAND}]: 💡 /remy for your session report`;
  const p = tipParts(tip, def, extra);
  const earn = earnOf(tip, def, session);
  return `[${BRAND}]: ${def.emoji} ${capFirst(p.problem)} — ${p.impact}${earn ? ` (${earn.compact})` : ""} → ${p.action}`;
}

/** Labels for the three-line card, padded to one column. */
const CARD_LABELS = ["What happened", "Why it matters", "How to fix"] as const;
const CARD_LABEL_W = 16; // "What's happening", the alarm's first label
/** Wrap width for the card's text column — a Stop nudge is full terminal
 * width, but most terminals open at 80 columns. */
const CARD_TEXT_W = 60;

function card(header: string, rows: [string, string][]): string {
  const lines = [header];
  for (const [label, text] of rows) {
    wrap(text, CARD_TEXT_W).forEach((t, i) => lines.push(`  ${(i === 0 ? label : "").padEnd(CARD_LABEL_W)} ${t}`));
  }
  return lines.join("\n");
}

/** The end-of-turn nudge, and the shape the whole catalog is written to:
 *
 *   [🐭 REMY] 🔨 Stuck fixing the same file
 *     What happened   Claude edited index.ts 14 times, re-reading it 17
 *                     times in between.
 *     Why it matters  Every new try re-sends all the failed tries before
 *                     it. This cost about $0.40.
 *     How to fix      Type /clear, then explain the problem again in a
 *                     sentence or two.
 *
 * Plain labels so a first-week user never has to decode an arrow chain. */
export function tipCard(
  tip: TipRow,
  session?: TipLineSession,
  extra: Record<string, string | number> = {},
): string {
  const def = TIPS[tip.tip_id];
  if (!def) return `[${BRAND}] 💡 /remy for your session report`;
  const p = tipParts(tip, def, extra);
  const earn = earnOf(tip, def, session);
  return card(`[${BRAND}] ${def.emoji} ${def.title}`, [
    [CARD_LABELS[0], sentence(p.problem)],
    [CARD_LABELS[1], `${sentence(p.impact)}${earn ? ` ${earn.sentence}` : ""}`],
    [CARD_LABELS[2], sentence(p.action)],
  ]);
}

/** The context-overflow alarm, as a card in the same shape as a tip — moved
 * off the statusline (it used to replace the whole line at ctx>=80%) onto the
 * Stop-hook nudge, so the statusline stays one constant layout. */
export function contextAlarmLine(pct: number, contextTokens: number): string {
  return card(`[${BRAND}] ⚠️ Claude's memory is almost full`, [
    ["What's happening", `This chat is using ${pct}% of Claude's memory (${fmtTok(contextTokens)} tokens).`],
    [
      CARD_LABELS[1],
      "Every reply re-sends all of it, and near 100% Claude summarizes itself automatically, which can lose details.",
    ],
    [CARD_LABELS[2], "Type /compact at a good stopping point, or /clear if you're starting something new."],
  ]);
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

/** The mouse with the sign — Joan G. Stark's (jgs) ASCII mouse, the sign
 * re-lettered. This array IS `packages/plugin-claude-code/art/remy.txt`, byte
 * for byte (ui.test.ts asserts it), so the README hero and the welcome can't
 * drift apart the way the old hand-downsampled halftone did.
 *
 * Shown ONCE per version — the first session after an install or an upgrade —
 * because a session starts far more often than people think (/clear, resume,
 * /reload-plugins), and art that appears every time stops being art and
 * becomes scrollback. */
export const WELCOME_ART = [
  "             __",
  "          __/  \\",
  "         /  \\-./",
  "         \\_   66\\_",
  "           \\  ____)o",
  "            )_(___________",
  "   .-.     /| T O K E N S |",
  "(_/   \\   / |  B E I N G  ()",
  "       |  \\ \\  S A V E D  |",
  "        \\  \\_)            |",
  "         '-'/ \\\"\\\"\"\"\"\"\"\"\"\"`",
  "           / / \\ \\/^)",
  "          (  \\  \\  /",
  "   jgs     \\__)  \"`",
];

// The everyday mascot: the same mouse's face (lines 2–5 of the welcome art,
// left-trimmed), padded to one column so the text beside it lines up. Four
// lines, not three — an ear, a brow, the eyes and the nose are the minimum
// that still reads as him; the previous three-line mark was an owl.
export const ART = [" __/  \\    ", "/  \\-./    ", "\\_   66\\_  ", "  \\  ____)o"];

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
        `${ART[0]}`,
        `${ART[1]}   REMY v${opts.version}`,
        `${ART[2]}   last 7d: ${opts.week.sessions} sessions · ${fmtTok(spend)} 🪙`,
        `${ART[3]}   ${line3}`,
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
  const out: Record<string, string> = {};
  const file = typeof evidence.file_hash === "string" ? files?.get(evidence.file_hash) : undefined;
  if (file) out.file = file;
  // Same map, same contract, for the one other thing a tip can name: an MCP
  // server, resolved from its wire segment's hash (resolve.ts).
  const server = typeof evidence.server_hash === "string" ? files?.get(evidence.server_hash) : undefined;
  if (server) out.server = server;
  return out;
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
      ? [`│ 💾 cache    ${cacheHit}% of the chat re-read at the cheap cached price (${fmtTok(s.cache_read)} tokens)`]
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
  lines.push(sep("🔎 what cost you extra this session"));
  if (waste.length > 0) {
    for (const { t, worth } of waste) {
      const def = TIPS[t.tip_id];
      const eff = effectiveTokens(t.est_savings_tokens, (t.est_class as EstClass) ?? "input");
      const amount = worth != null && worth >= 0.01 ? `≈$${worth.toFixed(2)}` : `~${fmtTok(eff)} tokens 🪙`;
      lines.push(`│ ${def?.emoji ?? "•"} ${def?.title ?? t.tip_id} — could have saved ${amount}`);
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
      // The same three parts as every other surface. The adaptive analyzer's
      // own sentence (with the user's numbers) replaces "What happened" when
      // present, and a row the evidence can't fill falls back to the title
      // rather than printing a {placeholder}.
      const problem = renderTemplate(def.problem, vars);
      const happened = opts.active.why
        ? `🤖 ${opts.active.why}`
        : sentence(UNRESOLVED_PLACEHOLDER.test(problem) ? def.title : problem);
      lines.push(...row("What happened", happened));
      const earn = earnOf(opts.active, def, s);
      lines.push(...row("Why it matters", `${sentence(renderTemplate(def.impact, vars))}${earn ? ` ${earn.sentence}` : ""}`));
      lines.push(...row("How to fix", sentence(renderTemplate(def.action, vars))));
      if (def.detail) lines.push(...row("Tip", sentence(renderTemplate(def.detail, vars))));
      if (def.cite?.quote) {
        lines.push(...row("The experts", `📖 "${def.cite.quote}" — ${def.cite.author ?? def.cite.source}`));
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
    `│ habits that cost extra: ${opts.wasteTips} · could have saved ~${fmtTok(opts.wasteTokens)} tokens 🪙`,
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
