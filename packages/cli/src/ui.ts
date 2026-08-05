import {
  BRAND,
  envVar,
  HINTS,
  TIPS,
  renderTemplate,
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
function tipBody(tip: TipRow, def: TipDef, template = def.short): string {
  let evidence: Record<string, string | number> = {};
  try {
    evidence = tip.evidence ? JSON.parse(tip.evidence) : {};
  } catch {
    // evidence is display-only
  }
  const value = tip.est_savings_tokens > 0 ? ` → +${fmtTok(tip.est_savings_tokens)} 🪙` : "";
  // Fallbacks first so a real measurement always wins over the default.
  const rendered = renderTemplate(template, { ...def.fallbacks, ...evidence });
  // Not every tip row carries the evidence its template asks for: the adaptive
  // analyzer files tips with evidence {source:"adaptive"} and no session
  // numbers at all (adapt.ts), and it may pick any catalog id, including a
  // rule-backed one whose `short` is written around {edits}/{count}/{files}.
  // renderTemplate passes unknown keys through verbatim — correct, since
  // inventing a number would be worse — so without this the statusline reads
  // "Same file edited {edits}×". The title says the same thing with no
  // evidence in it, which is exactly the right thing to say when we have none.
  const body = UNRESOLVED_PLACEHOLDER.test(rendered) ? def.title : rendered;
  return `${body}${value}`;
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
  return `[${BRAND}]: ${def.emoji} ${tipBody(tip, def)}`;
}

/** The same line, wide-surface form: `TipDef.live` instead of `short`, so a
 * surface with room gets the session's own evidence spoken back to the
 * player — "[🐭 REMY]: 🔨 you edited one file 56× this session, re-reading
 * between tries → /clear and re-brief beats another go → +265k 🪙". Same
 * skeleton as tipLine() (brand · emoji · problem → solution → value), just
 * the long problem clause; wisdom tips have no evidence and fall back to
 * `short`, which is why this can't simply replace tipLine() everywhere. */
export function tipLineLong(tip: TipRow): string {
  const def = TIPS[tip.tip_id];
  if (!def) return `[${BRAND}]: 💡 /remy for your session report`;
  return `[${BRAND}]: ${def.emoji} ${tipBody(tip, def, def.live ?? def.short)}`;
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

/** "claude-haiku-4-5-20251001" → "haiku-4-5" — the part a human reads. */
function shortModel(model: string | null): string {
  if (!model) return "unknown model";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function renderReport(opts: {
  session: SessionRow;
  tips: TipRow[];
  active: TipRow | null;
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
  const waste = opts.tips.filter((t) => t.est_savings_tokens > 0);
  if (waste.length > 0) {
    lines.push(sep("🔎 waste found this session"));
    for (const t of waste) {
      const def = TIPS[t.tip_id];
      lines.push(`│ ${def?.emoji ?? "•"} ${def?.title ?? t.tip_id} — ~${fmtTok(t.est_savings_tokens)} 🪙 recoverable`);
    }
  } else {
    lines.push(sep("🔎 waste found this session"), "│ ✨ none — clean session!");
  }

  if (opts.active) {
    const def = TIPS[opts.active.tip_id];
    lines.push(sep("💡 next tip"));
    if (def) {
      let evidence: Record<string, string | number> = {};
      try {
        evidence = opts.active.evidence ? JSON.parse(opts.active.evidence) : {};
      } catch {}
      // Same merge order as tipBody: a stored row from an older version, or an
      // adaptive row with no session numbers, still renders a whole sentence
      // here — this path has no title fallback to catch a stray placeholder.
      const vars = { ...def.fallbacks, ...evidence, est: fmtTok(opts.active.est_savings_tokens) };
      lines.push(`│ ${def.emoji} ${def.title}`);
      // Labeled rows: what happened → what it's worth → what to do. The
      // adaptive analyzer's own sentence (with the user's numbers) replaces
      // the generic "what happened" when present.
      lines.push(
        ...row("what happened", opts.active.why ? `🤖 ${opts.active.why}` : renderTemplate(def.what, vars)),
      );
      if (opts.active.est_savings_tokens > 0) {
        lines.push(...row("worth", `~${fmtTok(opts.active.est_savings_tokens)} 🪙 back in your pocket`));
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
