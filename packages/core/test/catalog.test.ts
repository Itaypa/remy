import { describe, expect, test } from "bun:test";
import { BRAND, HINTS, TIPS, renderTemplate } from "../src/catalog";

// Representative worst-case evidence per tip — generous digit widths, since
// shorts must stay statusline-sized (≤55 chars) after substitution — the
// caller (tipLine() in cli/src/ui.ts) adds "[Brand]: {emoji} " in front and
// up to " → +999k 🪙" after.
const SAMPLE_EVIDENCE: Record<string, Record<string, string | number>> = {
  "auto-compact": { count: 3 },
  "plan-mode": { tool_calls: 120, edits: 45 },
  "retry-loop": { runs: 4, run: 12, tool: "Bash" },
  "reread-churn": { files: 8, worst: 12 },
  "edit-thrash": { files: 3, edits: 14 },
  "no-verify": { edits: 25, bash_calls: 18 },
  "context-tax": { pct: 48, first_tokens: 96_000, skill_k: "~2.5k tokens" },
  "subagent-offload": { reads: 42, ctx_pct: 95 },
  "read-in-slices": { count: 5, worst_k: 118 },
  "model-fit": { n: 12, tier: "opus" },
  "tools-over-bash": { count: 42 },
  "claude-md-missing": { files: 8, worst: 12 },
  "claude-md-prune": { kb: 128 },
  // Wisdom tips carry no placeholders — empty evidence renders them as-is.
  "clear-between-tasks": {},
  "context-band": { turns: 12 },
  "compact-focus": {},
  "mistake-to-rule": {},
  "cli-over-mcp": {},
  "rule-of-five": {},
  "spec-first": {},
  "cache-idle": { count: 3, mins: 145 },
  "plan-review": {},
};

describe("tip catalog", () => {
  test("every tip id matches its key and has full copy", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      expect(def.id).toBe(key);
      expect(def.emoji.length).toBeGreaterThan(0);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.short.length).toBeGreaterThan(0);
      expect(def.what.length).toBeGreaterThan(0);
      expect(def.fix.length).toBeGreaterThan(0);
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

  test("every tip has sample evidence and every short renders ≤55 chars with no leftover placeholders", () => {
    for (const [key, def] of Object.entries(TIPS)) {
      const evidence = SAMPLE_EVIDENCE[key];
      expect(evidence, `missing sample evidence for ${key} — add it to this test`).toBeDefined();
      const rendered = renderTemplate(def.short, { ...evidence!, est: "999k" });
      expect(rendered, `unresolved placeholder in ${key} short`).not.toMatch(/\{\w+\}/);
      expect(rendered.length, `${key} short too long: "${rendered}"`).toBeLessThanOrEqual(55);
      const what = renderTemplate(def.what, { ...evidence!, est: "999k" });
      expect(what, `unresolved placeholder in ${key} what`).not.toMatch(/\{\w+\}/);
      const fix = renderTemplate(def.fix, { ...evidence!, est: "999k" });
      expect(fix, `unresolved placeholder in ${key} fix`).not.toMatch(/\{\w+\}/);
    }
  });

  test("every rule-backed tip has a live line: session evidence, ≤110 chars", () => {
    // The spinner surface has room for the evidence spoken back to the
    // player; wisdom tips have no session numbers to cite, so they're exempt.
    for (const [key, def] of Object.entries(TIPS)) {
      if (def.adaptiveOnly) continue;
      expect(def.live, `missing live copy for ${key}`).toBeDefined();
      const rendered = renderTemplate(def.live!, SAMPLE_EVIDENCE[key]!);
      expect(rendered, `unresolved placeholder in ${key} live`).not.toMatch(/\{\w+\}/);
      expect(rendered.length, `${key} live too long: "${rendered}"`).toBeLessThanOrEqual(110);
      expect(rendered, `${key} live embeds the brand tag — that's tipLineLong()'s job`).not.toContain(BRAND);
      // It must cite the session, not restate the rule in the abstract.
      expect(rendered, `${key} live carries no number from the evidence`).toMatch(/\d/);
    }
  });

  test("no fix carries a placeholder the adaptive analyzer can't fill", () => {
    // The adaptive analyzer files rows for ANY catalog id with evidence
    // {"source":"adaptive"} and no session numbers (adapt.ts). It always writes
    // a `why`, which the report substitutes for `what` — but `fix` is rendered
    // unconditionally (ui.ts) and through renderTemplate, which has no title
    // fallback to hide a stray placeholder. So an unfilled key in `fix` is a
    // literal "{skill_k}" in front of a real user.
    // This held by accident until now (no fix had a placeholder at all);
    // `fallbacks` is what makes it hold on purpose.
    for (const [key, def] of Object.entries(TIPS)) {
      const rendered = renderTemplate(def.fix, { ...def.fallbacks, source: "adaptive", est: "999k" });
      expect(rendered, `${key} fix leaves a placeholder on an adaptive row — add a fallback`).not.toMatch(
        /\{\w+\}/,
      );
    }
  });

  test("context-tax renders whole sentences against evidence written before skill_k existed", () => {
    // The migration case: tips persist, and tips.ts refreshes a row's evidence
    // only when the same rule fires again. Every context-tax row already in a
    // user's DB carries exactly {pct, first_tokens} — adding a placeholder to
    // the copy without a fallback would render "{skill_k}" in /remy until the
    // rule happened to re-fire.
    const def = TIPS["context-tax"]!;
    const legacy = { pct: 48, first_tokens: 96_000 };
    for (const tpl of [def.what, def.fix, def.short, def.live!]) {
      expect(renderTemplate(tpl, { ...def.fallbacks, ...legacy })).not.toMatch(/\{\w+\}/);
    }
  });

  test("a fallback never wins over a real measurement", () => {
    const def = TIPS["context-tax"]!;
    const measured = renderTemplate(def.fix, { ...def.fallbacks, skill_k: "~9.9k tokens" });
    expect(measured).toContain("~9.9k tokens");
    expect(measured).not.toContain(def.fallbacks!.skill_k!);
  });

  test("context-tax keeps both of the imperatives its suppression rests on", () => {
    // claude-md-prune is dropped whenever context-tax fires (rules.ts), and the
    // stated reason is that this fix already tells you to prune CLAUDE.md.
    // Losing either imperative would leave a user with a bloated CLAUDE.md and
    // a heavy pack told the numbers and never told to cut anything.
    const fix = TIPS["context-tax"]!.fix;
    expect(fix).toContain("prune CLAUDE.md");
    expect(fix).toContain("MCP servers");
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
