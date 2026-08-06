import { describe, expect, test } from "bun:test";
import { TIPS, type SessionRow, type TipRow } from "@ccpp/core";
import { renderReport, renderWeek, tipVars, weekTotals } from "../src/ui";

// /remy and /remy-week are the two surfaces a user deliberately opens, and
// neither had any assertions — the end-to-end driver only checked that they
// exit 0 and print something. These pin what the output actually says.

const session = (o: Partial<SessionRow> = {}): SessionRow =>
  ({
    session_id: "abcdef1234567890", started_at: "2026-08-01T10:00:00.000Z", ended_at: null,
    model: "claude-opus-5", cwd_hash: null, repo_hash: null, tokens_in: 12_000, tokens_out: 800,
    cache_read: 0, cache_write: 0, cost_usd: null, tool_calls: 20, tool_fails: 0,
    compacts_auto: 0, compacts_manual: 0, used_plan_mode: 0, max_context_pct: 42,
    context_window: null, claude_md_bytes: null, perm_denials: 0, ...o,
  }) as SessionRow;

const tip = (o: Partial<TipRow> = {}): TipRow =>
  ({
    id: 1, tip_id: "edit-thrash", session_id: "s1", created_at: "2026-08-01T10:00:00.000Z",
    status: "active", evidence: JSON.stringify({ files: 1, edits: 14 }),
    est_savings_tokens: 55_000, why: null, ...o,
  }) as TipRow;

/** The report wraps long values across box-drawn continuation lines, so a
 * naive toContain() on a sentence fails for reasons that have nothing to do
 * with the behaviour under test. Strip the box and collapse whitespace. */
const flat = (s: string) => s.replace(/│/g, " ").replace(/\s+/g, " ").trim();

describe("renderReport", () => {
  test("shows the session line, truncating the id to something readable", () => {
    const out = renderReport({ session: session(), tips: [], active: null });
    expect(out).toContain("abcdef12");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("plan mode ✗ not used");
    expect(renderReport({ session: session({ used_plan_mode: 1 }), tips: [], active: null })).toContain("✓ used");
  });

  test("suppresses rows that would always read zero", () => {
    // The noise budget: a cache line with no cache, or "0 denied" on every
    // report, is a permanent zero nobody can act on.
    const quiet = renderReport({ session: session({ cache_read: 0, tokens_in: 0, perm_denials: 0 }), tips: [], active: null });
    expect(quiet).not.toContain("💾 cache");
    expect(quiet).not.toContain("denied");

    const loud = renderReport({ session: session({ cache_read: 90_000, tokens_in: 10_000, perm_denials: 3 }), tips: [], active: null });
    expect(loud).toContain("90% reused from cache");
    expect(loud).toContain("3 denied");
  });

  test("lists only waste worth recovering, and says so plainly when there is none", () => {
    const withWaste = renderReport({
      session: session(),
      tips: [tip({ est_savings_tokens: 55_000 }), tip({ id: 2, tip_id: "no-verify", est_savings_tokens: 0 })],
      active: null,
    });
    expect(withWaste).toContain("Edit ping-pong on one file");
    // The zero-value finding is filed but not shown — a "~0 🪙 recoverable"
    // row is noise, not insight.
    expect(withWaste).not.toContain("Edits shipped unverified");

    const clean = renderReport({ session: session(), tips: [], active: null });
    expect(clean).toContain("✨ none — clean session!");
  });

  test("a session whose only finding costs no tokens is not called clean", () => {
    // subagent-offload buys window headroom, not tokens back, so it carries no
    // estimate — and it is filtered out of the waste list above. Reusing the
    // "clean session!" line for that case had the report declaring the session
    // spotless and then coaching it in the very next box.
    const out = renderReport({
      session: session(),
      tips: [tip({ tip_id: "subagent-offload", est_savings_tokens: 0 })],
      active: null,
    });
    expect(out).not.toContain("none — clean session!");
    expect(out).toContain("no tokens left on the table");
  });

  test("the analyzer's own sentence replaces the generic explanation", () => {
    const out = renderReport({
      session: session(),
      tips: [],
      active: tip({ why: "you rewrote one file 14 times this week", evidence: JSON.stringify({ source: "adaptive" }) }),
    });
    expect(flat(out)).toContain("🤖 you rewrote one file 14 times this week");
    // …and the templated version does not also appear.
    expect(flat(out)).not.toContain("Same file edited");
  });

  test("an adaptive tip never leaks an unfilled placeholder into the report", () => {
    // renderReport calls renderTemplate(def.fix) directly — it does NOT go
    // through tipBody()'s title fallback. Today that is safe only because no
    // tip's `fix` carries a placeholder and `what` is skipped whenever `why`
    // is set. Both halves are pinned here and in the catalog test below,
    // because the day someone adds {count} to a fix, every adaptive tip starts
    // printing braces at the user.
    for (const tip_id of Object.keys(TIPS)) {
      const out = renderReport({
        session: session(),
        tips: [],
        active: tip({ tip_id, why: "because the week says so", evidence: JSON.stringify({ source: "adaptive" }), est_savings_tokens: 0 }),
      });
      expect(out, `${tip_id} leaked a placeholder`).not.toMatch(/\{\w+\}/);
    }
  });

  test("every placeholder in a `fix` has a fallback — the report renders it without evidence", () => {
    // This used to say "no fix may carry a placeholder at all", which was the
    // only way to hold the property before TipDef.fallbacks existed: the report
    // renders `fix` for adaptive rows that have no session numbers, straight
    // through renderTemplate with no title fallback to hide a stray brace.
    // A placeholder is now allowed exactly when the catalog can fill it itself.
    // The rendering test above is the real guard; this one localizes the blame
    // to the catalog entry instead of a diff of the whole report.
    for (const [key, def] of Object.entries(TIPS)) {
      for (const [, name] of def.fix.matchAll(/\{(\w+)\}/g)) {
        expect(
          def.fallbacks?.[name!],
          `${key} fix uses {${name}} with no fallback; an adaptive tip would print it raw`,
        ).toBeDefined();
      }
    }
  });

  test("the worth row appears only when there is something to recover", () => {
    const worth = renderReport({ session: session(), tips: [], active: tip({ est_savings_tokens: 55_000 }) });
    expect(worth).toContain("back in your pocket");
    const none = renderReport({ session: session(), tips: [], active: tip({ est_savings_tokens: 0 }) });
    expect(none).not.toContain("back in your pocket");
  });

  test("the adaptive footer reflects the actual state and offers the opposite toggle", () => {
    const on = renderReport({ session: session(), tips: [], active: null, adaptive: { enabled: true, lastRunHours: 5 } });
    expect(on).toContain("adaptive: on");
    expect(on).toContain("last analyzed 5h ago");
    expect(on).toContain("--off");

    const off = renderReport({ session: session(), tips: [], active: null, adaptive: { enabled: false, lastRunHours: null } });
    expect(off).toContain("adaptive: off");
    expect(off).toContain("--on");
    expect(off).not.toContain("last analyzed");
  });

  test("every box rule is the same terminal width, whatever the brand tag is", () => {
    // The header rule is padded to fill W, but the footer was `╰` + W dashes —
    // one column past it, because the corner glyph occupies a column too. The
    // widths must be measured with Bun.stringWidth, not `.length`: the header
    // carries BRAND, whose emoji is a surrogate pair, so a `.length` check
    // would compare a code-unit count against a rendered one and agree with
    // both the right answer and the wrong one.
    const out = renderReport({ session: session(), tips: [tip()], active: tip() });
    const rules = out.split("\n").filter((l) => /^[╭╰├]/.test(l));
    expect(rules.length).toBeGreaterThan(2); // head + at least one sep + foot
    const widths = new Set(rules.map((l) => Bun.stringWidth(l)));
    expect([...widths]).toEqual([52]);
  });
});

describe("renderWeek", () => {
  const day = (d: string, tok: number, cost: number | null = null) =>
    session({ started_at: `${d}T10:00:00.000Z`, tokens_in: tok, tokens_out: 0, cost_usd: cost });

  test("one bar per day, oldest first, with the day's own totals", () => {
    const rows = [day("2026-08-03", 300), day("2026-08-01", 100), day("2026-08-02", 200)];
    const out = renderWeek({ rows, totals: weekTotals(rows), wasteTips: 0, wasteTokens: 0 });
    const days = out.split("\n").filter((l) => /^│ \d\d-\d\d /.test(l)).map((l) => l.slice(2, 7));
    expect(days).toEqual(["08-01", "08-02", "08-03"]);
  });

  test("sessions on the same day are merged into one bar", () => {
    const rows = [day("2026-08-01", 100), day("2026-08-01", 400)];
    const out = renderWeek({ rows, totals: weekTotals(rows), wasteTips: 0, wasteTokens: 0 });
    expect(out.split("\n").filter((l) => l.startsWith("│ 08-01"))).toHaveLength(1);
    expect(out).toContain("500");
  });

  test("an empty week says so instead of rendering an empty chart", () => {
    const out = renderWeek({ rows: [], totals: weekTotals([]), wasteTips: 0, wasteTokens: 0 });
    expect(out).toContain("no sessions recorded yet");
    expect(out).toContain("0 sessions");
  });

  test("totals and the waste line report what they were given", () => {
    const rows = [day("2026-08-01", 1_000, 2.5), day("2026-08-02", 3_000, 1.25)];
    const out = renderWeek({ rows, totals: weekTotals(rows), wasteTips: 3, wasteTokens: 120_000 });
    expect(out).toContain("4.0k 🪙");
    expect(out).toContain("$3.75");
    expect(out).toContain("2 sessions");
    expect(out).toContain("waste caught: 3 tips");
    expect(out).toContain("120k 🪙 recoverable");
  });
});

describe("tip template variables", () => {
  test("a measured value beats the catalog fallback, and est beats both", () => {
    // The precedence this pins was duplicated across two render sites and
    // guarded by neither: flipping either copy made a fallback outrank a real
    // measurement — the user shown generic words where a number existed — with
    // the whole suite still green.
    const def = TIPS["context-tax"]!;
    expect(def.fallbacks?.skill_k).toBeDefined();

    // No measurement: the fallback fills in.
    expect(tipVars(def, {}).skill_k).toBe(def.fallbacks!.skill_k);
    // A measurement: it wins.
    expect(tipVars(def, { skill_k: "~9.9k tokens" }).skill_k).toBe("~9.9k tokens");
    // Caller extras are applied last.
    expect(tipVars(def, { est: "1k" }, { est: "999k" }).est).toBe("999k");
  });

  test("the report prints the session's own number, not the fallback", () => {
    // The same invariant through the real render path, which is where it bites.
    const out = renderReport({
      session: session(),
      tips: [],
      active: tip({
        tip_id: "context-tax",
        evidence: JSON.stringify({ pct: 48, first_tokens: 96_000, skill_k: "~9.9k tokens" }),
        est_savings_tokens: 81_000,
      }),
    });
    // flat() because the report wraps long values across continuation lines —
    // the measurement is there, just not on one line.
    expect(flat(out)).toContain("~9.9k tokens");
    expect(flat(out)).not.toContain(TIPS["context-tax"]!.fallbacks!.skill_k!);
  });
});
