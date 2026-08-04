// Curated tip catalog — written once, reused by every host adapter.
// `short` templates render into every tip surface (statusline, splash,
// Stop-hook nudge — they all share one format) as
// "[🐭REMY]: {emoji} {problem} → {solution}" (the caller — tipLine() in
// cli/src/ui.ts — adds the bracketed brand tag and, when the finding has a
// quantified savings estimate, a trailing "→ +{est} 🪙" value clause). Write
// `short` itself as "{problem} → {solution}" — no brand, no value clause,
// no {est} placeholder. Placeholders come from finding evidence only. Keep
// it ≤55 chars after substitution so the full composed line stays
// statusline-sized. `live` is the same line for wide surfaces (the spinner
// tip, via tipLineLong()): second person, the session's own numbers in it,
// ≤110 chars rendered — every rule-backed tip needs one.

/** Product name shown with every tip. */
export const BRAND = "🐭REMY";

export interface TipCite {
  /** Publication or site name, e.g. "Claude Code docs", "The Pragmatic Engineer". */
  source: string;
  author?: string;
  url: string;
  /** Short citable quote, rendered in /remy as 📖. Keep it punchy. */
  quote?: string;
}

export interface TipDef {
  id: string;
  /** Official docs page that explains the fix — the tip's click-through target. */
  docs: string;
  emoji: string;
  title: string;
  short: string;
  /** One sentence: what the coach saw, numbers included. Plain words. */
  what: string;
  /** The wide-surface form of `short`: same problem → solution shape, but
   * spoken to the player with the session's own evidence in it ("you edited
   * one file 14× this session — …"). Used where the line has room (the
   * spinner tip), ≤110 chars rendered. Wisdom tips have no session evidence
   * to cite, so they fall back to `short`. */
  live?: string;
  /** One or two imperative sentences: exactly what to do next time. */
  fix: string;
  /** Expert citation backing the tip — the receipts behind the advice. */
  cite?: TipCite;
  /** Wisdom tips have no deterministic rule — only the adaptive analyzer selects them. */
  adaptiveOnly?: boolean;
}

export const TIPS: Record<string, TipDef> = {
  "auto-compact": {
    id: "auto-compact",
    docs: "https://code.claude.com/docs/en/context-window",
    emoji: "🧹",
    title: "Auto-compact hit mid-task",
    short: "Auto-compact fired mid-task → /compact at breakpoints",
    live: "auto-compact fired {count}× mid-task — run /compact at your next milestone instead of hitting the wall",
    what: "Auto-compact fired {count}× mid-task — Claude summarized at the worst moment, with the window already full.",
    fix: "Run /compact yourself at a natural breakpoint (after a milestone, before a new task). Scoping tasks smaller avoids the overflow entirely.",
    cite: {
      source: "Chroma Research",
      url: "https://research.trychroma.com/context-rot",
      quote: "Models do not use their context uniformly; performance grows increasingly unreliable as input length grows — 30–50% accuracy loss well before the window limit.",
    },
  },
  "plan-mode": {
    id: "plan-mode",
    docs: "https://code.claude.com/docs/en/permission-modes",
    emoji: "🧠",
    title: "Big task, no plan",
    short: "Long build, no plan mode → plan first (Shift+Tab ×2)",
    live: "{edits} edits across {tool_calls} tool calls, no plan — Shift+Tab ×2 first next time, fewer wrong turns",
    what: "{edits}+ edits across {tool_calls} tool calls — and plan mode was never used.",
    fix: "Before a big task, press Shift+Tab twice: Claude explores first, you approve the plan, then it builds. Fewer wrong turns.",
    cite: {
      source: "The Pragmatic Engineer",
      author: "Boris Cherny, creator of Claude Code",
      url: "https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny",
      quote: "Once there is a good plan, it will one-shot the implementation almost every time.",
    },
  },
  "retry-loop": {
    id: "retry-loop",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🔁",
    title: "Retry loop detected",
    short: "{tool} failed {run}× in a row → stop, add missing context",
    live: "the same {tool} call failed {run}× in a row — stop after two and paste what it was missing",
    what: "The same {tool} call failed {run}× in a row — a retry loop.",
    fix: "After two identical failures, stop the loop: press Esc, paste the missing context (error output, file state, constraint), or change approach.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Correcting it quickly generally produces better solutions faster.",
    },
  },
  "reread-churn": {
    id: "reread-churn",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "📚",
    title: "Re-reading the same files",
    short: "Same file read {worst}× → pin the facts in CLAUDE.md",
    live: "{files} files got read again and again, one of them {worst}× — pin those facts in CLAUDE.md",
    what: "{files} file(s) were read again and again (worst one: {worst}×).",
    fix: "Facts Claude keeps re-deriving belong in CLAUDE.md — written once, cached forever.",
  },
  "edit-thrash": {
    id: "edit-thrash",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🔨",
    title: "Edit ping-pong on one file",
    short: "Same file edited {edits}×, 2+ misses → /clear + re-brief",
    live: "you edited one file {edits}× this session, re-reading between tries — /clear and re-brief beats another go",
    what: "One file took {edits} edit attempts, with re-reads between tries — every retry paid for all the failed ones before it.",
    fix: "After 2 failed fixes on the same spot: /clear, then re-brief with what you learned (the missing constraint, the error that kept coming back).",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "A clean session with a better prompt almost always outperforms a long session with accumulated corrections.",
    },
  },
  "no-verify": {
    id: "no-verify",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🧪",
    title: "Edits shipped unverified",
    short: "{edits} edits shipped, 0 verify runs → end with tests/build",
    live: "{edits} edits shipped and not one test, build or lint run — end with a verify pass",
    what: "{edits} edits shipped — and not one test, build, or lint run to check them.",
    fix: "End with a verify pass: give Claude a check it can run (tests, build, typecheck) and ask it to iterate until green.",
    cite: {
      source: "WorkOS",
      author: "Boris Cherny, creator of Claude Code",
      url: "https://workos.com/blog/boris-cherny-claude-code-acquired-interview-takeaways",
      quote: "Self-verification is worth 2–3x on the quality of the final result.",
    },
  },
  "context-tax": {
    id: "context-tax",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🎒",
    title: "Heavy pack before turn one",
    short: "{pct}% context used before turn 1 → audit MCP + CLAUDE.md",
    live: "{pct}% of your window was gone before turn one — audit MCP servers and prune CLAUDE.md",
    what: "{pct}% of the window was full before any work happened ({first_tokens} tokens) — a tax you pay again every session.",
    fix: "Disconnect MCP servers you rarely use and prune CLAUDE.md — /context shows what's eating the space.",
  },
  "subagent-offload": {
    id: "subagent-offload",
    docs: "https://code.claude.com/docs/en/sub-agents",
    emoji: "🔀",
    title: "Exploration bloated main context",
    short: "{reads} files read inline → offload search to a subagent",
    live: "{reads} files read straight into main context (peak {ctx_pct}%) — next hunt, ask for a subagent",
    what: "{reads} files were read into the main context (peak {ctx_pct}%) — exploration bloated the window.",
    fix: 'Next codebase hunt, say: "use a subagent to investigate …" — it reads in its own window and reports back just the summary.',
    cite: {
      source: "Anthropic Engineering",
      url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
      quote: "Each subagent might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary.",
    },
  },
  "tools-over-bash": {
    id: "tools-over-bash",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🐚",
    title: "Shell reads where tools exist",
    short: "{count}× cat/grep in Bash → let it use Read + Grep",
    live: "{count} reads went through the shell — ask for Read/Grep/Glob and stop dumping whole files in",
    what: "{count} reads and searches went through the shell (cat, grep, find) — that output lands in the context whole: no pagination, no truncation, no cap.",
    fix: 'Ask for the built-in tools by name: "use Read/Grep/Glob instead of shell commands". Pin it in CLAUDE.md once and every session starts that way.',
  },
  "model-fit": {
    id: "model-fit",
    docs: "https://code.claude.com/docs/en/model-config",
    emoji: "🎛",
    title: "Big model, small jobs",
    short: "{n} light sessions on {tier} → try Sonnet for quick tasks",
    live: "{n} light sessions on {tier} this week — /model sonnet handles the quick ones",
    what: "{n} sessions this week ran the {tier}-tier model for light work — a few tool calls, small output.",
    fix: "/model sonnet for quick tasks stretches the same budget further; switch back up when the task actually needs the big model.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "Reserve Opus for complex architectural decisions or multi-step reasoning.",
    },
  },
  // ---- Wisdom tips: no deterministic rule fires these. Only the adaptive
  // analyzer selects them, matching them to the user's metadata profile.
  "clear-between-tasks": {
    id: "clear-between-tasks",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🚿",
    title: "One session, many tasks",
    short: "New task, old context → /clear between unrelated tasks",
    what: "A session that hops between unrelated tasks pays for ALL of them on every single message.",
    fix: "/clear when you switch topics — it costs nothing, and the stale context stops taxing you.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "Stale context wastes tokens on every subsequent message.",
    },
    adaptiveOnly: true,
  },
  "context-band": {
    id: "context-band",
    docs: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
    emoji: "🎯",
    title: "Rode the red zone",
    short: "{turns} turns above 80% context → /compact at 60%",
    live: "{turns} replies ran above 80% context — /compact at 60%, not at the wall",
    what: "{turns} replies ran with the context ≥80% full — each one dragged the whole window through the model again, right where accuracy sags (context rot).",
    fix: "Work in the 40–60% band: /compact early and on purpose at a natural breakpoint, and distill progress into small notes instead of letting raw output pile up.",
    cite: {
      source: "HumanLayer, Advanced Context Engineering",
      author: "Dex Horthy",
      url: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
      quote: "It's essential to use as little of the context window as possible.",
    },
  },
  "compact-focus": {
    id: "compact-focus",
    docs: "https://code.claude.com/docs/en/context-window",
    emoji: "🧭",
    title: "Compact with instructions",
    short: "/compact with instructions → tell it what to keep",
    what: "A bare compact summarizes with generic priorities — it doesn't know what matters to you.",
    fix: 'Compact with instructions: "/compact focus on the API changes" controls what survives. No continuity needed at all? /clear is free.',
    cite: {
      source: "Anthropic Engineering",
      url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
      quote: "Compaction distills the contents of a context window in a high-fidelity manner, enabling the agent to continue with minimal performance degradation.",
    },
    adaptiveOnly: true,
  },
  "claude-md-prune": {
    id: "claude-md-prune",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "✂️",
    title: "Prune CLAUDE.md ruthlessly",
    short: "CLAUDE.md bloat → cut what can't cause a mistake",
    what: "CLAUDE.md is loaded every single session — and a bloated one competes with your actual task for attention.",
    fix: "For every line ask: would deleting this cause a mistake? If not, cut it. Aim under 200 lines.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!",
    },
    adaptiveOnly: true,
  },
  "mistake-to-rule": {
    id: "mistake-to-rule",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "📌",
    title: "Turn corrections into rules",
    short: "Same correction twice → write it once in CLAUDE.md",
    what: "Corrections you type in a session evaporate when it ends — Claude makes the same mistake tomorrow.",
    fix: "Corrected the same thing twice? Write it into CLAUDE.md once. Checked into git, the whole team stops paying for it.",
    cite: {
      source: "The Pragmatic Engineer",
      author: "Boris Cherny, creator of Claude Code",
      url: "https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny",
      quote: "Anytime Claude does something incorrectly we add it to the CLAUDE.md, so Claude knows not to do it next time.",
    },
    adaptiveOnly: true,
  },
  "cli-over-mcp": {
    id: "cli-over-mcp",
    docs: "https://code.claude.com/docs/en/mcp",
    emoji: "⌨️",
    title: "CLIs before MCP servers",
    short: "Prefer CLIs (gh, aws, …) over MCP → zero context tax",
    what: "Every connected MCP server parks its tool list in your context permanently — even when you never use it.",
    fix: "Prefer CLIs Claude already knows (gh, aws, …). /context shows what's eating space; /mcp disables idle servers.",
    cite: {
      source: "simonwillison.net",
      author: "Simon Willison",
      url: "https://simonwillison.net/2025/Sep/30/designing-agentic-loops/",
      quote: "Coding agents are really good at running shell commands!",
    },
    adaptiveOnly: true,
  },
  "rule-of-five": {
    id: "rule-of-five",
    docs: "https://steve-yegge.medium.com/six-new-tips-for-better-coding-with-agents-d4e9c86e42a9",
    emoji: "🖐",
    title: "The Rule of Five",
    short: "Ask for 4–5 self-review passes → quality converges",
    what: "Claude's first pass is rarely its best — quality keeps improving with self-review.",
    fix: 'Ask "review your own work and fix what you find" 4–5 times — quality reliably plateaus around pass five.',
    cite: {
      source: "Six New Tips for Better Coding With Agents",
      author: "Steve Yegge",
      url: "https://steve-yegge.medium.com/six-new-tips-for-better-coding-with-agents-d4e9c86e42a9",
      quote: "It typically takes 4 to 5 iterations before the agent declares that it's as good as it can get.",
    },
    adaptiveOnly: true,
  },
  "spec-first": {
    id: "spec-first",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "📝",
    title: "Spec first, fresh session second",
    short: "Big feature → interview, spec it, then run it fresh",
    what: "Big features built straight from a chat prompt drift — edge cases surface too late.",
    fix: "Have Claude interview you and write a spec first, then execute it in a FRESH session: focused context, zero exploration residue.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Time spent making the spec precise pays off more than time spent watching the implementation.",
    },
    adaptiveOnly: true,
  },
  "cache-idle": {
    id: "cache-idle",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🫗",
    title: "A fat session left open",
    short: "Came back cold {count}× → wrap up before stepping away",
    live: "you left this session idle {mins} min — coming back re-wrote the whole context at full price",
    what: "{count}× this session sat idle (longest {mins} min) until the cache expired — coming back re-wrote a 100k+ context at full price each time.",
    fix: "Stepping away for a while? Land the milestone and wrap the session first — a fresh session with a one-line brief beats reheating a fat one. Quick break? Carry on, the cache holds.",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "A one-line question in a session that has been open all day uses tokens for the whole conversation, not just the one line.",
    },
  },
  "plan-review": {
    id: "plan-review",
    docs: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
    emoji: "🔍",
    title: "Review the plan harder than the code",
    short: "Review plans harder → bad lines become bad code",
    what: "Errors compound: one bad plan line becomes hundreds of bad code lines across every file Claude touches.",
    fix: "Read the plan like it's the code — your attention is worth most BEFORE the build starts, not at the diff.",
    cite: {
      source: "HumanLayer, Advanced Context Engineering",
      author: "Dex Horthy",
      url: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
      quote: "A bad line of code is a bad line of code. But a bad line of a plan could lead to hundreds of bad lines of code.",
    },
    adaptiveOnly: true,
  },
};

/** Loading-screen hints — rotated in the statusline while Claude thinks and on
 * the session-start splash when no personal tip is active. Quotes carry their
 * attribution in the string — the receipts are part of the fun. */
export const HINTS: string[] = [
  "💡 Plan mode (Shift+Tab ×2) before big tasks — fewer wrong turns, fewer tokens.",
  "🧠 CLAUDE.md remembers so Claude doesn't re-read — pin project facts there.",
  "🧹 /compact at a natural breakpoint beats auto-compact mid-flight.",
  "🔀 Subagents keep your main context clean during big searches.",
  "⎋ Esc interrupts — steer early instead of paying for the wrong path.",
  "🗂 --resume picks up where you left off — cache-warm and cheaper.",
  '💬 "Once there is a good plan, it will one-shot the implementation." — Boris Cherny',
  '💬 Self-verification is "worth 2–3x on the quality of the final result." — Boris Cherny',
  '💬 "A bad line of a plan could lead to hundreds of bad lines of code." — Dex Horthy',
  '💬 "Crashes are tolerable; hangs are problematic." — Armin Ronacher, on agent tools',
  '💬 "Own your context window." — 12-Factor Agents',
  '💬 "If you could describe the diff in one sentence, skip the plan." — Claude Code docs',
  '💬 "Coding agents are really good at running shell commands!" — Simon Willison',
  "📉 Context rot is real: accuracy sags 30–50% before the window fills (Chroma, 18 models).",
  '💬 "AI tools amplify existing expertise." — Simon Willison. Review like a senior.',
  '💬 "I endeavor to always have an agent doing something." — Mitchell Hashimoto',
];

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}
