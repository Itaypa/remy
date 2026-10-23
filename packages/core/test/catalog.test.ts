import { describe, expect, test } from "bun:test";
import { BRAND, HINTS, TIPS, renderTemplate } from "../src/catalog";

// Representative worst-case evidence per tip — generous digit widths, since
// shorts must stay statusline-sized (≤55 chars) after substitution — the
// caller (tipLine() in cli/src/ui.ts) adds "[Brand]: {emoji} " in front and
// up to " → +999k 🪙" after.
const SAMPLE_EVIDENCE: Record<string, Record<string, string | number>> = {
  "auto-compact": { count: 3, peak_pct: 98 },
  "plan-mode": { tool_calls: 120, edits: 45, top_tool: "Bash", top_tool_n: 62 },
  "retry-loop": { runs: 4, run: 12, tool: "Bash", file: "packages/core/src/rules.ts" },
  "reread-churn": {
    files: 8,
    worst: 12,
    file: "packages/cli/src/index.ts",
    more: "and 7 other files went the same way",
  },
  "edit-thrash": { files: 3, edits: 14, rereads: 19, next: 15, file: "packages/cli/src/index.ts" },
  "no-verify": {
    edits: 25,
    files: 6,
    bash_calls: 18,
    scope: "6 files",
    shell: "18 shell runs",
    bash_mix: "9 git, 4 file reads",
  },
  "context-tax": { pct: 48, first_tokens: 96_000, first_ctx: "96k", skill_k: "~2.5k tokens", biggest: "MCP add-on instructions (62k)" },
  "mcp-idle": { server: "claude_ai_Gmail", tokens_k: 24, tools_clause: "30 tool schemas", turns_clause: "41 turns", idle_servers: 2 },
  "subagent-offload": { reads: 42, ctx_pct: 95 },
  "read-in-slices": { count: 5, worst_k: 118, total_k: 640, file: "packages/cli/src/index.ts" },
  "noisy-tool": { tool: "Claude_Browser/snapshot", calls: 12, avg_k: 20, worst_k: 48, total_k: 240 },
  "model-fit": { n: 12, total: 20, tier: "opus", model: "opus-5[1m]" },
  "tools-over-bash": { count: 42, bash_total: 420, tool_reads: 132 },
  "claude-md-missing": { files: 8, worst: 12, file: "packages/core/src/rules.ts" },
  "claude-md-prune": { kb: 128, md_tokens: "~32k tokens" },
  // Wisdom tips carry no placeholders — empty evidence renders them as-is.
  "clear-between-tasks": {},
  "context-band": { turns: 12, total_turns: 210, peak_pct: 97 },
  "compact-focus": {},
  "mistake-to-rule": {},
  "cli-over-mcp": {},
  "rule-of-five": {},
  "spec-first": {},
  "cache-idle": { count: 3, mins: 145, gap: "2.4h", ctx: "~190k tokens" },
  "cache-miss": {
    count: 12,
    cause: "you paused more than 5 minutes between messages",
    ctx: "~190k tokens",
    remedy: "reply within 5 minutes, or set promptCacheTtl to 1h in settings",
  },
  "cache-clock": {},
  "plan-review": {},
};

describe("tip catalog", () => {
  test("every tip id matches its key and has full copy", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      expect(def.id).toBe(key);
      expect(def.emoji.length).toBeGreaterThan(0);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.short.length).toBeGreaterThan(0);
      // The three parts every surface renders, rule tip or wisdom tip alike.
      expect(def.problem.length, `${key} has no "what happened"`).toBeGreaterThan(0);
      expect(def.impact.length, `${key} has no "why it matters"`).toBeGreaterThan(0);
      expect(def.action.length, `${key} has no "how to fix"`).toBeGreaterThan(0);
    }
  });

  test("no title carries a placeholder — it is the render-time fallback", () => {
    // tipBody() in cli/src/ui.ts falls back to the title when a tip's evidence
    // can't fill its template (the adaptive analyzer files rule-backed tips
    // with no session numbers). A title with its own {placeholder} would leak
    // exactly the braces that fallback exists to prevent.
    for (const [key, def] of Object.entries(TIPS)) {
      expect(def.title, `${key} title carries a placeholder`).not.toMatch(/\{\w+\}/);
    }
  });

  test("every tip carries a well-formed https docs link (the click-through target)", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      expect(def.docs, `missing docs url for ${key}`).toMatch(/^https:\/\/[^\s"\\]+$/);
    }
  });

  test("the citation is well-formed too — it is the link the report actually uses", () => {
    // /remy renders `read more ↗ ${def.cite?.url ?? def.docs}`, so for the tips
    // that carry a citation the URL a user clicks is cite.url, not docs. Only
    // docs was checked above: the guarded field was the fallback, and the field
    // in use was unguarded.
    for (const [key, def] of Object.entries(TIPS)) {
      if (!def.cite) continue;
      expect(def.cite.url, `${key} cite url is not a clean https link`).toMatch(/^https:\/\/[^\s"\\]+$/);
      // The attribution renders as `— ${author ?? source}`, so an empty source
      // with no author prints a dangling dash.
      expect((def.cite.author ?? def.cite.source).length, `${key} cite has nothing to attribute to`).toBeGreaterThan(0);
      // A quote is a claim about what a source says; an empty one is worse than
      // none, because the report still renders the quotation marks.
      if ("quote" in def.cite) expect(def.cite.quote!.length, `${key} has an empty quote`).toBeGreaterThan(0);
    }
  });

  test("every tip has sample evidence and every short renders ≤55 chars with no leftover placeholders", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      const evidence = SAMPLE_EVIDENCE[key];
      expect(evidence, `missing sample evidence for ${key} — add it to this test`).toBeDefined();
      const rendered = renderTemplate(def.short, { ...evidence!, est: "999k" });
      expect(rendered, `unresolved placeholder in ${key} short`).not.toMatch(/\{\w+\}/);
      expect(rendered.length, `${key} short too long: "${rendered}"`).toBeLessThanOrEqual(55);
      for (const field of ["problem", "impact", "action", "detail"] as const) {
        const tpl = def[field];
        if (!tpl) continue;
        const out = renderTemplate(tpl, { ...def.fallbacks, ...evidence! });
        expect(out, `unresolved placeholder in ${key} ${field}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  // --- The three-part shape ------------------------------------------------
  //
  // This block is the reason the shape exists in the type at all. The previous
  // contract was one free-form `live` string with a length cap and a digit
  // check, and under it every one of these shipped: "you edited one file 14×"
  // (the rule knew the filename and dropped it), "1 files … one of them 4×",
  // "1333 min" for 22 hours, and a value clause in raw cache-read tokens.
  // Nothing here would have caught the last two on its own — the plural test
  // below and the price class do that — but everything here would have caught
  // a tip with no evidence, no action, or a hand-written price.

  test("every tip is What happened → Why it matters → How to fix", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      const vars = { ...def.fallbacks, ...SAMPLE_EVIDENCE[key]! };
      const problem = renderTemplate(def.problem, vars);
      const impact = renderTemplate(def.impact, vars);
      const action = renderTemplate(def.action, vars);

      if (!def.adaptiveOnly) {
        // A problem with no placeholder cannot be about THIS session — it is a
        // slogan, which is what `short` is for.
        expect(def.problem, `${key} problem cites no evidence`).toMatch(/\{\w+\}/);
        expect(problem, `${key} problem carries no number from the evidence`).toMatch(/\d/);
      }
      // The impact is the mechanism, not a measurement: the renderer appends the
      // cost right after it, and a session number beside that one would compete.
      // Durable ratios ("10× cheaper", "20× more") are the mechanism, so allowed.
      expect(def.impact, `${key} impact carries a placeholder — the cost sentence owns numbers`).not.toMatch(/\{\w+\}/);
      expect(impact.replace(/\d+×/g, ""), `${key} impact carries a number`).not.toMatch(/\d/);

      // The cost, the separators and the tag are the renderer's job. A tip that
      // writes its own price can claim anything, which is how "+219M 🪙" shipped.
      for (const [part, text] of [["problem", problem], ["impact", impact], ["action", action]] as const) {
        expect(text, `${key} ${part} embeds the brand tag`).not.toContain(BRAND);
        expect(text, `${key} ${part} prices itself in coins`).not.toContain("🪙");
        expect(text, `${key} ${part} prices itself in dollars`).not.toContain("$");
        expect(text, `${key} ${part} carries an arrow — the renderer joins the parts`).not.toContain("→");
      }

      // Each part reads as one clause a beginner can take in at a glance, and
      // the one-line spinner form stays short enough to read before it rotates.
      expect(problem.length, `${key} problem too long: "${problem}"`).toBeLessThanOrEqual(120);
      expect(impact.length, `${key} impact too long: "${impact}"`).toBeLessThanOrEqual(95);
      expect(action.length, `${key} action too long: "${action}"`).toBeLessThanOrEqual(100);
      const oneLine = `${problem} — ${impact} (≈$0.40) → ${action}`;
      expect(oneLine.length, `${key} one-line form too long: "${oneLine}"`).toBeLessThanOrEqual(260);
    }
  });

  // Words a first-week Claude Code user does not know. Every one of these was
  // in the copy before the rewrite, and users said they did not understand it.
  // Citations are exempt: a quote is what its author said.
  const JARGON = [
    /context window/i,
    /\bthe window\b/i,
    /red zone/i,
    /\bprefix\b/i,
    /schema/i,
    /re-brief/i,
    /cache-write/i,
    /\bturn one\b/i,
    /ephemeral/i,
    /context rot/i,
    /\bre-?deriv/i,
    /\bfat (session|context)\b/i,
  ];

  test("no tip or hint uses the jargon users didn't understand", () => {
    const texts: Array<[string, string]> = [];
    for (const [key, def] of Object.entries(TIPS)) {
      const vars = { ...def.fallbacks, ...SAMPLE_EVIDENCE[key]! };
      for (const field of ["title", "short", "problem", "impact", "action", "detail", "worth"] as const) {
        const tpl = def[field];
        if (tpl) texts.push([`${key}.${field}`, renderTemplate(tpl, vars)]);
      }
      for (const [k, v] of Object.entries(def.fallbacks ?? {})) texts.push([`${key}.fallbacks.${k}`, v]);
    }
    // Attributed quotes ("💬 …") are someone else's words; advice hints are ours.
    for (const hint of HINTS) if (!hint.startsWith("💬")) texts.push(["hint", hint]);
    for (const [where, text] of texts) {
      for (const word of JARGON) {
        expect(text, `${where} uses jargon ${word}: "${text}"`).not.toMatch(word);
      }
    }
  });

  // The smallest value each rule can actually emit, from its own thresholds in
  // rules.ts. Anything not listed can be 1, and its copy must survive that.
  //
  // This map is the honest version of the plural test: driving every count to 1
  // unconditionally would demand plural-safety from copy whose rule cannot fire
  // below 25 ("1 tool calls" is unreachable), and paying for that with vaguer
  // wording everywhere would be a real cost for an imaginary bug. Where a floor
  // is claimed here, it is the rule's constant — if one is lowered, this map is
  // wrong and the test that depends on it should be re-read.
  const RULE_FLOORS: Record<string, Record<string, number>> = {
    "plan-mode": { tool_calls: 25, edits: 5 }, // LONG_SESSION_TOOL_CALLS / _EDITS
    "retry-loop": { run: 3 }, // RETRY_RUN_MIN
    "reread-churn": { worst: 4 }, // REREAD_MIN
    "claude-md-missing": { worst: 4 },
    "edit-thrash": { edits: 6, rereads: 3, next: 7 }, // EDIT_THRASH_MIN_EDITS / _CYCLES
    "no-verify": { edits: 4 }, // NO_VERIFY_MIN_EDITS
    "read-in-slices": { count: 3 }, // FAT_READ_MIN
    "noisy-tool": { calls: 3, avg_k: 6 }, // NOISY_MIN_CALLS / NOISY_RESULT_TOKENS
    "mcp-idle": { tokens_k: 8 }, // MCP_IDLE_MIN_TOKENS
    "subagent-offload": { reads: 15 }, // SUBAGENT_MIN_DISTINCT_READS
    "tools-over-bash": { count: 6, bash_total: 6 }, // BASH_READ_MIN
    "context-band": { turns: 3, total_turns: 3 }, // RED_ZONE_MIN_TURNS
    "cache-miss": { count: 2 }, // CACHE_MISS_MIN
    "model-fit": { n: 4, total: 4 }, // MODEL_FIT_MIN_SESSIONS
  };

  test("a count of 1 never meets a plural noun", () => {
    // "1 files got read again and again, one of them 4×" shipped to a real
    // spinner deck. The old suite passed it because its sample evidence used
    // comfortable two-digit counts and nothing ever tried a 1.
    const PLURALS =
      /\b1 (files|edits|reads|replies|turns|sessions|calls|runs|times|tool calls|shell runs|other files|file reads|shell commands)\b|\bone of them\b/;
    for (const [key, def] of Object.entries(TIPS)) {
      if (def.adaptiveOnly) continue;
      const floors = RULE_FLOORS[key] ?? {};
      const ones = Object.fromEntries(
        Object.entries(SAMPLE_EVIDENCE[key]!).map(([k, v]) => [
          k,
          typeof v === "number" ? (floors[k] ?? 1) : v,
        ]),
      );
      for (const half of [def.problem, def.impact, def.action, def.short, def.detail ?? ""]) {
        const rendered = renderTemplate(half, { ...def.fallbacks, ...ones });
        expect(rendered, `${key} renders a plural noun against a count of 1: "${rendered}"`).not.toMatch(
          PLURALS,
        );
      }
    }
  });

  test("no impact, action or detail carries a placeholder the adaptive analyzer can't fill", () => {
    // The adaptive analyzer files rows for ANY catalog id with evidence
    // {"source":"adaptive"} and no session numbers (adapt.ts). It always writes
    // a `why`, which replaces "What happened" — but the other parts render
    // through renderTemplate with no title fallback to hide a stray
    // placeholder. `fallbacks` is what keeps "{skill_k}" away from a real user.
    for (const [key, def] of Object.entries(TIPS)) {
      for (const field of ["impact", "action", "detail"] as const) {
        const tpl = def[field];
        if (!tpl) continue;
        const rendered = renderTemplate(tpl, { ...def.fallbacks, source: "adaptive" });
        expect(rendered, `${key} ${field} leaves a placeholder on an adaptive row — add a fallback`).not.toMatch(
          /\{\w+\}/,
        );
      }
    }
  });

  test("context-tax renders whole sentences against evidence written before skill_k existed", () => {
    // The migration case: tips persist, and tips.ts refreshes a row's evidence
    // only when the same rule fires again. Every context-tax row already in a
    // user's DB carries exactly {pct, first_tokens}.
    const def = TIPS["context-tax"]!;
    const legacy = { pct: 48, first_tokens: 96_000 };
    for (const tpl of [def.short, def.problem, def.impact, def.action, def.detail!]) {
      expect(renderTemplate(tpl, { ...def.fallbacks, ...legacy })).not.toMatch(/\{\w+\}/);
    }
  });

  test("a fallback never wins over a real measurement", () => {
    const def = TIPS["context-tax"]!;
    const measured = renderTemplate(def.detail!, { ...def.fallbacks, skill_k: "~9.9k tokens" });
    expect(measured).toContain("~9.9k tokens");
  });

  test("context-tax still gets CLAUDE.md and the add-on surface dealt with", () => {
    // claude-md-prune is dropped whenever context-tax fires (rules.ts), and the
    // reason is that this action already gets CLAUDE.md handled. Losing either
    // half would leave a user with a bloated CLAUDE.md and a heavy start told
    // the numbers and never told to act.
    const action = TIPS["context-tax"]!.action;
    expect(action, "must still direct the user at CLAUDE.md").toMatch(/CLAUDE\.md/);
    expect(action, "must still direct the user at the add-on/skill surface").toMatch(/MCP add-ons|skills/);
    // And the measured number survives: a host command may replace an
    // instruction we could not verify, never a figure we measured.
    expect(TIPS["context-tax"]!.detail).toContain("{skill_k}");
  });

  test("short is Problem → Solution — no brand tag, no value clause, no {est}", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      expect(def.short, `${key} short still references {est} — value belongs in tipLine(), not short`).not.toContain(
        "{est}",
      );
      expect(def.short, `${key} short embeds a 🪙 value clause — that's tipLine()'s job now`).not.toContain("🪙");
      expect(def.short, `${key} short embeds the brand tag — that's tipLine()'s job now`).not.toContain(BRAND);
    }
  });

  test("hints are one-liners", () => {
    for (const hint of HINTS) {
      expect(hint.length).toBeLessThanOrEqual(90);
      expect(hint).not.toContain("\n");
    }
  });
});
