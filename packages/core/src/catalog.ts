// Curated tip catalog — written once, reused by every host adapter.
//
// EVERY tip is three parts, in this order, written for someone in their first
// week of Claude Code. catalog.test.ts enforces the shape and the vocabulary:
//
//   What happened → Why it matters → How to fix   (+ the cost, never authored)
//   problem         impact           action
//
//   - `problem`: what went wrong, in evidence the developer RECOGNIZES — a
//     filename where one resolves, otherwise a tool name, a count with its
//     denominator, a peak, a duration. Rule tips carry ≥1 {placeholder} and
//     render ≥1 digit. Wisdom tips have no session numbers and say it plainly.
//   - `impact`: why it costs something, as one clause with no numbers. The
//     renderer appends the measured cost after it ("This cost about $0.40."),
//     derived from the finding's estimate and the session's own cost — or
//     `worth`, when what the fix buys is not tokens.
//   - `action`: one concrete step. Commands stay literal (/clear, /compact,
//     Shift+Tab) and say what they do.
//
// Plain words only. A user who does not know what a context window, a cache
// prefix or a tool schema is must still understand the line: say "Claude's
// memory for this chat", "the cache", "the add-on's instructions". The
// jargon list in catalog.test.ts fails the build on the old terms.
//
// No field may contain a 🪙, a $, an arrow or the brand tag: the renderer owns
// the cost, the separators and the tag. Anything that could meet a 1 ("{n}
// files") is pre-composed in the rule as a clause, not assembled here.
//
// `short` is the narrow form for the boxed session-start splash (≤55 chars);
// `detail` is an optional extra line for the /remy report.

/** Product name shown with every tip. */
export const BRAND = "🐭 REMY";

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
  /** Plain name of the problem. No placeholders: it is the render-time
   * fallback when a row's evidence can't fill the templates. */
  title: string;
  /** Splash form, "problem → fix", ≤55 chars. */
  short: string;
  /** [1 of 3] What happened — evidence the developer recognizes. Rule tips:
   * ≥1 {placeholder}, renders ≥1 digit. */
  problem: string;
  /** [2 of 3] Why it matters — the mechanism in one clause, no numbers. The
   * renderer appends the measured cost after it. */
  impact: string;
  /** [3 of 3] How to fix — one concrete step, commands explained. */
  action: string;
  /** Optional extra advice, shown only in the /remy report. */
  detail?: string;
  /** What the fix is worth when there is no honest number. Most tips leave
   * this unset and let the renderer derive money from the finding's estimate;
   * `no-verify` and `subagent-offload` set it because what they buy is not
   * tokens, and inventing a token figure to fill the slot is exactly the
   * habit that made the old numbers untrustworthy. */
  worth?: string;
  /** Default values for placeholders a tip row might not carry.
   *
   * Two render paths need this and neither is hypothetical. The adaptive
   * analyzer files rows with evidence `{"source":"adaptive"}` and no session
   * numbers at all, and any tip row already sitting in a user's DB keeps the
   * evidence it was written with — `tips.ts` refreshes it only when the same
   * rule fires again. So the moment a template gains a placeholder, both of
   * those render it as a literal `{skill_k}` in the report, on real databases,
   * until the rule happens to re-fire.
   *
   * The one-line forms survive that on their own (tipBody falls back to the
   * title), but the report renders `problem`/`detail` with no such guard.
   * Merged UNDER the row's real evidence, so a measured value always wins. */
  fallbacks?: Record<string, string>;
  /** Expert citation backing the tip — the receipts behind the advice. */
  cite?: TipCite;
  /** Wisdom tips have no deterministic rule — only the adaptive analyzer selects them. */
  adaptiveOnly?: boolean;
}

export const TIPS: Record<string, TipDef> = {
  // No memory size in the copy: 200k and 1M are both common and old rows never recorded it.
  // The peak needs no excuse, because the automatic summary only fires when memory is full.
  "auto-compact": {
    id: "auto-compact",
    docs: "https://code.claude.com/docs/en/context-window",
    emoji: "🧹",
    title: "Claude ran out of room mid-task",
    short: "Memory filled up mid-task → /compact between steps",
    problem: "Claude's memory filled up ({peak_pct}% full) and it summarized itself {count}× in the middle of your task",
    impact: "an automatic summary can drop details Claude still needed",
    action: "type /compact yourself between steps, at a moment you choose",
    detail: "Smaller tasks avoid it altogether: one goal per chat, then /clear.",
    fallbacks: { peak_pct: "100" },
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
    title: "Big job without a plan",
    short: "Big job, no plan → Shift+Tab twice to plan first",
    problem: "Claude made {edits} edits across {tool_calls} steps without a plan first",
    impact: "with no plan to check, wrong turns get built and then redone",
    action: "press Shift+Tab twice before a big job, so you approve a plan first",
    detail: "In plan mode Claude looks around first and shows you its plan. Nothing is changed until you say yes.",
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
    title: "The same step kept failing",
    short: "{tool} failed {run}× in a row → Esc, share the error",
    problem: "{tool} failed {run} times in a row on {file}",
    impact: "each retry costs the same and fails for the same reason",
    action: "press Esc after two failures and paste the error it keeps hitting",
    detail: "What it is missing is usually one fact: the error text, the file's real state, or a rule it does not know.",
    fallbacks: { file: "the same target" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Correcting it quickly generally produces better solutions faster.",
    },
  },
  // Deliberately NOT "save what Claude keeps re-deriving": /doctor cuts exactly that from CLAUDE.md,
  // so a user who followed us and then ran /doctor would watch it delete what we told them to add.
  "reread-churn": {
    id: "reread-churn",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "📚",
    title: "Claude keeps re-reading a file",
    short: "Same file read {worst}× → save the facts in CLAUDE.md",
    problem: "Claude read {file} {worst} times this session, {more}",
    impact: "every re-read pays again for something it already saw",
    action: "save the facts it keeps looking up in CLAUDE.md, the notes file it reads at the start",
    detail: "Write down what Claude gets wrong, not what it can look up: the rule it keeps missing, the trap, the limit. Notes about one folder can go in a CLAUDE.md inside that folder, which loads only when needed.",
    fallbacks: { file: "one file", more: "with nothing new to find most of those times" },
  },
  "edit-thrash": {
    id: "edit-thrash",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🔨",
    title: "Stuck fixing the same file",
    short: "Stuck editing one file {edits}× → /clear, explain again",
    problem: "Claude edited {file} {edits} times, re-reading it {rereads} times in between",
    impact: "every new try re-sends all the failed tries before it",
    action: "type /clear, then explain the problem again in a sentence or two",
    detail: "Include what you learned: the rule it kept missing, or the error that kept coming back. A fresh chat with a clear ask beats a long one full of failed tries.",
    fallbacks: { file: "one file", rereads: "several" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "A clean session with a better prompt almost always outperforms a long session with accumulated corrections.",
    },
  },
  // The one thing this tip is NOT worth is tokens. Skipping a check does not spend tokens, it ships bugs,
  // and saying so is more persuasive than an invented figure.
  "no-verify": {
    id: "no-verify",
    docs: "https://code.claude.com/docs/en/best-practices",
    emoji: "🧪",
    title: "Changes were never tested",
    short: "{edits} edits, never tested → ask it to run the tests",
    problem: "Claude made {edits} edits across {scope} and never ran a test or a build",
    impact: "bugs stay hidden until you find them yourself",
    action: "finish by asking Claude to run the tests and fix until they pass",
    detail: "Any check Claude can run works: tests, a build, a type check, a linter.",
    worth: "fewer bugs, not saved tokens",
    fallbacks: { scope: "several files" },
    cite: {
      source: "WorkOS",
      author: "Boris Cherny, creator of Claude Code",
      url: "https://workos.com/blog/boris-cherny-claude-code-acquired-interview-takeaways",
      quote: "Self-verification is worth 2–3x on the quality of the final result.",
    },
  },
  // The action must keep naming CLAUDE.md and the add-on surface: claude-md-prune yields to this tip
  // (rules.ts) because this line already gets CLAUDE.md dealt with. {skill_k} is a number we measured,
  // so it stays even though /doctor now does the audit.
  "context-tax": {
    id: "context-tax",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🎒",
    title: "The chat starts already crowded",
    short: "{pct}% full before you start → /doctor to trim",
    problem: "{pct}% of Claude's memory was used before your first message, mostly by {biggest}",
    impact: "you pay for that space on every message, in every session",
    action: "run /doctor to find skills, MCP add-ons and CLAUDE.md notes you don't use",
    detail: "/doctor asks before it changes anything. Skill descriptions alone take {skill_k} of it, and /context shows the rest.",
    fallbacks: { skill_k: "part", biggest: "skills, MCP add-ons and CLAUDE.md" },
  },
  // `server` resolves at render time from the stored hash (resolve.ts), the way `file` does;
  // unresolved, it reads "the one MCP add-on".
  "mcp-idle": {
    id: "mcp-idle",
    docs: "https://code.claude.com/docs/en/mcp",
    emoji: "🔌",
    title: "An add-on you never used",
    short: "{server} add-on unused → turn it off in /mcp",
    problem: "the {server} MCP add-on takes ~{tokens_k}k tokens of Claude's memory every message, and this session never used it",
    impact: "you pay for its instructions on every message anyway",
    action: "turn it off in /mcp, and back on the day you need it",
    detail: "You can turn add-ons on just for the projects that use them. /context shows what each one costs.",
    fallbacks: { server: "one" },
    cite: {
      source: "simonwillison.net",
      author: "Simon Willison",
      url: "https://simonwillison.net/2025/Sep/30/designing-agentic-loops/",
      quote: "Coding agents are really good at running shell commands!",
    },
  },
  "read-in-slices": {
    id: "read-in-slices",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "📖",
    title: "Whole files read when a part would do",
    short: "{count} whole files read → ask for just the part",
    problem: "Claude read {count} whole files; the biggest, {file}, was ~{worst_k}k tokens",
    impact: "the whole file stays in Claude's memory and is paid for on every later message",
    action: "ask for the function or lines you need, or have it search first",
    detail: "A search returns the matching lines, not the whole file.",
    fallbacks: { file: "one of them" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "A single \u201cgo to definition\u201d call replaces what might otherwise be a grep followed by reading multiple candidate files.",
    },
  },
  "noisy-tool": {
    id: "noisy-tool",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🔊",
    title: "One tool returns far too much",
    short: "{tool}: ~{avg_k}k a call → ask it for less",
    problem: "{tool} returned ~{avg_k}k tokens a call over {calls} calls, {total_k}k in all",
    impact: "all of it stays in Claude's memory and is paid for on every later message",
    action: "ask it for less: a filter, one page, or text instead of a screenshot",
    detail: "If it can't return less, have a helper agent (a subagent) run it, so only a short summary comes back to your chat.",
    fallbacks: { tool: "one tool", total_k: "a lot" },
    cite: {
      source: "Anthropic Engineering",
      url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
      quote: "Each subagent might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary.",
    },
  },
  // Delegating COSTS more tokens than reading inline (the rule measures it). What it buys is room,
  // so that is what the slot says instead of a savings figure it would have to invent.
  "subagent-offload": {
    id: "subagent-offload",
    docs: "https://code.claude.com/docs/en/sub-agents",
    emoji: "🔀",
    title: "Searching filled up the chat",
    short: "{reads} files read while searching → use a subagent",
    problem: "Claude read {reads} files into this chat while searching, filling its memory to {ctx_pct}%",
    impact: "the chat gets crowded, and Claude's answers get worse",
    action: "next time, say \"use a subagent to look into this\"",
    detail: "A subagent is a helper that searches in its own space and sends back only a short summary.",
    worth: "room for the real work, not saved tokens",
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
    title: "Reading files the hard way",
    short: "{count} file reads via the shell → ask for Read",
    problem: "{count} of {bash_total} shell commands were just reading or searching files",
    impact: "shell output comes back whole, with no size limit",
    action: "tell Claude \"use Read and Grep, not shell commands\", and add that line to CLAUDE.md",
    detail: "Read and Grep return a page at a time, so a big file can't flood the chat.",
    fallbacks: { bash_total: "your" },
  },
  "model-fit": {
    id: "model-fit",
    docs: "https://code.claude.com/docs/en/model-config",
    emoji: "🎛",
    title: "The biggest model for small jobs",
    short: "{n} quick sessions on {tier} → /model sonnet",
    problem: "{n} of {total} sessions this week used {model} for a few quick steps",
    impact: "the top model costs several times more for work a smaller one does as well",
    action: "type /model sonnet for quick jobs, and switch back for hard ones",
    fallbacks: { model: "the top model", total: "your" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "Reserve Opus for complex architectural decisions or multi-step reasoning.",
    },
  },
  "clear-between-tasks": {
    id: "clear-between-tasks",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🚿",
    title: "One chat, many tasks",
    short: "New task, old chat → /clear between tasks",
    problem: "you started a new task in the same chat",
    impact: "every message still pays for the old task's history",
    action: "type /clear when you switch to something unrelated; it's free",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "Stale context wastes tokens on every subsequent message.",
    },
    adaptiveOnly: true,
  },
  // "80+" is not a guess dressed as a measurement: the rule only counts replies at or above 80%.
  "context-band": {
    id: "context-band",
    docs: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
    emoji: "🎯",
    title: "Kept working with memory almost full",
    short: "Memory over 80% full → /compact around 60%",
    problem: "{turns} of {total_turns} replies ran with Claude's memory over 80% full (peak {peak_pct}%)",
    impact: "a nearly full memory costs more per reply, and Claude gets less accurate",
    action: "type /compact at a good stopping point, around 60% full",
    detail: "/compact shrinks the chat into a summary. Doing it yourself, at a break, means you choose what gets kept.",
    fallbacks: { total_turns: "your", peak_pct: "80+" },
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
    title: "Tell /compact what to keep",
    short: "Plain /compact → say what to keep",
    problem: "a plain /compact doesn't know what matters to you",
    impact: "it may summarize away the part you still need",
    action: "say what to keep, like \"/compact keep the API changes\"",
    detail: "Don't need any of it? /clear is free.",
    cite: {
      source: "Anthropic Engineering",
      url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
      quote: "Compaction distills the contents of a context window in a high-fidelity manner, enabling the agent to continue with minimal performance degradation.",
    },
    adaptiveOnly: true,
  },
  "claude-md-missing": {
    id: "claude-md-missing",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "📄",
    title: "No notes file for this project",
    short: "No CLAUDE.md, same files re-read → type /init",
    problem: "Claude read {file} {worst} times, and this project has no CLAUDE.md notes file",
    impact: "every session rediscovers the same facts and pays for them again",
    action: "type /init to create one, or write down the few facts you keep repeating",
    detail: "CLAUDE.md is read once at the start of every session, instead of the same files being re-read all day.",
    fallbacks: { file: "one file" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "CLAUDE.md is a special file that Claude reads at the start of every conversation.",
    },
  },
  "claude-md-prune": {
    id: "claude-md-prune",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "✂️",
    title: "The notes file is too long",
    short: "CLAUDE.md is {kb}KB → cut lines that prevent nothing",
    problem: "your CLAUDE.md is {kb}KB ({md_tokens}), loaded at the start of every session",
    impact: "you pay for it every session, and long notes get followed less well",
    action: "run /doctor, then delete any line that wouldn't cause a mistake if it were gone",
    detail: "/doctor trims the project's CLAUDE.md and asks first. Your personal ~/.claude/CLAUDE.md is yours to trim by hand.",
    fallbacks: { md_tokens: "several thousand tokens" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!",
    },
  },
  "mistake-to-rule": {
    id: "mistake-to-rule",
    docs: "https://code.claude.com/docs/en/memory",
    emoji: "📌",
    title: "Turn corrections into rules",
    short: "Same correction twice → write it in CLAUDE.md",
    problem: "you corrected Claude on the same thing twice",
    impact: "corrections are forgotten when the chat ends, so the mistake comes back",
    action: "write the rule once in CLAUDE.md",
    detail: "Commit it to git and the whole team gets the fix.",
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
    title: "Command-line tools before add-ons",
    short: "Prefer gh, aws… over MCP add-ons → no idle cost",
    problem: "each connected MCP add-on loads its instructions into every message",
    impact: "you pay for them even when you don't use them",
    action: "prefer command-line tools Claude knows, like gh or aws, and turn idle add-ons off in /mcp",
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
    title: "Ask for a few review passes",
    short: "Ask it to review its own work → better results",
    problem: "Claude's first answer is rarely its best",
    impact: "stopping at the first draft leaves fixable mistakes in",
    action: "ask \"review your work and fix what you find\" a few times",
    detail: "Quality usually stops improving around the fifth pass.",
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
    title: "Write a short spec first",
    short: "Big feature → spec it first, build it fresh",
    problem: "big features started from a quick message tend to drift",
    impact: "edge cases show up late, when they cost the most to fix",
    action: "have Claude interview you and write a short spec, then build it in a fresh chat",
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/best-practices",
      quote: "Time spent making the spec precise pays off more than time spent watching the implementation.",
    },
    adaptiveOnly: true,
  },
  // "{gap}", not "{mins} min": the worst real gap on this machine was 1333 minutes, which is 22 hours
  // nobody converts in their head. Fallbacks are words, never a placeholder glued to a unit.
  "cache-idle": {
    id: "cache-idle",
    docs: "https://code.claude.com/docs/en/costs",
    emoji: "🫗",
    title: "Came back after the cache ran out",
    short: "Back after a long break → start a new chat",
    problem: "you left this chat idle for {gap}, so coming back re-sent {ctx} at full price",
    impact: "a fresh chat is 10× cheaper to re-read, and a long break loses that discount",
    action: "before a long break, finish the step, and start a new chat when you return",
    detail: "A quick break is fine: the 🔥 timer on the status line shows how long the discount lasts.",
    fallbacks: { gap: "a long time", ctx: "the whole chat" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/costs",
      quote: "A one-line question in a session that has been open all day still draws usage for the whole conversation.",
    },
  },
  // The remedy depends on the cause, so the rule supplies it from a closed set in rules.ts, never from
  // host text. The fallback covers adaptive rows and rows written before the host named a cause.
  "cache-miss": {
    id: "cache-miss",
    docs: "https://code.claude.com/docs/en/prompt-caching",
    emoji: "🧩",
    title: "Mid-task changes reset the cache",
    short: "Cache reset {count}× → change settings between tasks",
    problem: "the cache reset {count} times because {cause}, re-sending {ctx} each time",
    impact: "each reset pays full price for the whole chat again",
    action: "{remedy}",
    detail: "/usage names the likely cause of the last reset, under Prompt cache.",
    fallbacks: { cause: "something in the chat's setup changed", ctx: "the whole chat", remedy: "pick the model, settings and add-ons at the start, and /clear before changing them" },
    cite: {
      source: "Claude Code docs",
      url: "https://code.claude.com/docs/en/prompt-caching",
      quote: "Pick your model and effort level at the top of a session, then save /compact for natural breaks between tasks. The fewer changes you make mid-task, the higher your cache hit rate.",
    },
  },
  // States no TTL: it is 1h on Claude Code today and 5m on the raw API. The 20× IS durable: the ratio
  // of the two published multipliers, 2× to write against 0.1× to read.
  "cache-clock": {
    id: "cache-clock",
    docs: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    emoji: "🧊",
    title: "The cache timer is real money",
    short: "🔥 timer running out → finish the step first",
    problem: "the 🔥 cache timer on the status line is running down",
    impact: "once it turns 🧊, your next message costs about 20× more",
    action: "finish the step before it runs out, or start a new chat after",
    cite: {
      source: "Anthropic, Prompt caching",
      url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      quote: "1-hour cache write tokens are 2 times the base input tokens price… Cache read tokens are 0.1 times the base input tokens price.",
    },
    adaptiveOnly: true,
  },
  "plan-review": {
    id: "plan-review",
    docs: "https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md",
    emoji: "🔍",
    title: "Check the plan before the code",
    short: "Read the plan closely → bad plans make bad code",
    problem: "a mistake in the plan becomes many mistakes in the code",
    impact: "fixing it after the build costs far more than fixing the plan",
    action: "read the plan as carefully as you would read the code",
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
  "💡 Big job ahead? Shift+Tab twice gets you a plan to approve before Claude builds.",
  "🧠 Claude keeps getting something wrong? Write it in CLAUDE.md once.",
  "🧹 Chat filling up? /compact at a break beats an automatic summary mid-task.",
  "🔀 Big search? Ask for a subagent: it searches, and only a summary comes back.",
  "⎋ Going the wrong way? Press Esc to stop it early, before you pay for it.",
  "🔓 Approving the same command all day? /fewer-permission-prompts fixes that.",
  "🗂 Resuming a big chat later costs full price. A fresh chat is often cheaper.",
  "🔥 The cache timer is money: once it turns 🧊, your next message costs ~20× more.",
  "🔖 Undo history isn't a backup. Commit before letting Claude try something risky.",
  '💬 "Once there is a good plan, it will one-shot the implementation." — Boris Cherny',
  '💬 Self-verification is "worth 2–3x on the quality of the final result." — Boris Cherny',
  '💬 "A bad line of a plan could lead to hundreds of bad lines of code." — Dex Horthy',
  '💬 "Crashes are tolerable; hangs are problematic." — Armin Ronacher, on agent tools',
  '💬 "Own your context window." — 12-Factor Agents',
  '💬 "If you could describe the diff in one sentence, skip the plan." — Claude Code docs',
  '💬 "Coding agents are really good at running shell commands!" — Simon Willison',
  "📉 A nearly full chat makes Claude less accurate, well before it runs out of room.",
  '💬 "AI tools amplify existing expertise." — Simon Willison. Review like a senior.',
  '💬 "I endeavor to always have an agent doing something." — Mitchell Hashimoto',
];

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}
