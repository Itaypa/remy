import { describe, expect, test } from "bun:test";
import { BRAND, type TipRow } from "@ccpp/core";
import { bar, contextAlarmLine, rateLimitBadge, spendField, splash, tipLine } from "../src/ui";

function tipRow(overrides: Partial<TipRow>): TipRow {
  return {
    id: 1,
    tip_id: "edit-thrash",
    session_id: "s1",
    created_at: "2026-07-28T10:00:00Z",
    status: "active",
    evidence: null,
    est_savings_tokens: 0,
    why: null,
    ...overrides,
  } as TipRow;
}

describe("tipLine — [Brand]: emoji problem → solution → value", () => {
  test("brackets the brand with a colon — the whole signal this is a coaching message", () => {
    const line = tipLine(tipRow({ evidence: JSON.stringify({ edits: 36 }), est_savings_tokens: 165_000 }));
    expect(line.startsWith(`[${BRAND}]: `)).toBe(true);
  });

  test("a tip with no session evidence never renders literal {braces}", () => {
    // The adaptive analyzer queues tips with evidence {source:"adaptive"} and
    // is free to pick a rule-backed id, so a template written around {edits}
    // meets a row that has none. Falling back to the title keeps the surface
    // readable; leaking braces onto the statusline is the bug this guards.
    const line = tipLine(tipRow({ evidence: JSON.stringify({ source: "adaptive" }) }));
    expect(line).not.toMatch(/\{\w+\}/);
    expect(line).toContain("Edit ping-pong on one file");
  });

  test("evidence-free rendering still keeps the value clause", () => {
    const line = tipLine(
      tipRow({ evidence: JSON.stringify({ source: "adaptive" }), est_savings_tokens: 12_000 }),
    );
    expect(line).not.toMatch(/\{\w+\}/);
    expect(line).toContain(" → +12k 🪙");
  });

  test("a template whose evidence IS present is untouched by the fallback", () => {
    const line = tipLine(tipRow({ evidence: JSON.stringify({ edits: 36 }) }));
    expect(line).toContain("36×");
    expect(line).not.toContain("Edit ping-pong on one file");
  });

  test("a quantified finding gets a trailing value clause", () => {
    const line = tipLine(tipRow({ evidence: JSON.stringify({ edits: 36 }), est_savings_tokens: 165_000 }));
    expect(line).toContain(" → +165k 🪙");
    // problem → solution → value: exactly two arrows once the value clause is present.
    expect((line.match(/→/g) ?? []).length).toBe(2);
  });

  test("a wisdom tip (no est) renders problem → solution with no dangling value clause", () => {
    const line = tipLine(tipRow({ tip_id: "clear-between-tasks", evidence: "{}", est_savings_tokens: 0 }));
    expect(line).not.toContain("🪙");
    expect((line.match(/→/g) ?? []).length).toBe(1);
  });

  test("an unknown tip id falls back to a bracketed, non-crashing line", () => {
    const line = tipLine(tipRow({ tip_id: "does-not-exist" }));
    expect(line).toBe(`[${BRAND}]: 💡 /remy for your session report`);
  });

  test("this is the ONE format used everywhere — statusline, splash, and the Stop-hook nudge all call tipLine()", () => {
    const line = tipLine(tipRow({ evidence: JSON.stringify({ edits: 36 }), est_savings_tokens: 165_000 }));
    expect(line).toBe(`[${BRAND}]: 🔨 Same file edited 36×, 2+ misses → /clear + re-brief → +165k 🪙`);
  });
});

describe("contextAlarmLine — moved off the statusline, onto the Stop-hook nudge", () => {
  test("same [Brand]: format as tipLine(), names the numbers", () => {
    const line = contextAlarmLine(92, 184_000);
    expect(line.startsWith(`[${BRAND}]: `)).toBe(true);
    expect(line).toContain("92%");
    expect(line).toContain("184k 🪙");
  });

  test("matches the exact requested format", () => {
    expect(contextAlarmLine(100, 200_000)).toBe(`[${BRAND}]: context at 100% — every reply re-reads 200k 🪙`);
  });
});

describe("rateLimitBadge", () => {
  test("no rate_limits field (not a Pro/Max subscriber, or pre-first-response) → null", () => {
    expect(rateLimitBadge(undefined)).toBeNull();
    expect(rateLimitBadge(null)).toBeNull();
    expect(rateLimitBadge({})).toBeNull();
  });

  test("shows whichever window is closer to its cap", () => {
    const fiveWorse = rateLimitBadge({ five_hour: { used_percentage: 80 }, seven_day: { used_percentage: 20 } });
    expect(fiveWorse).toContain("80%");
    expect(fiveWorse).toContain("(5h)");

    const sevenWorse = rateLimitBadge({ five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 55 } });
    expect(sevenWorse).toContain("55%");
    expect(sevenWorse).toContain("(7d)");
  });

  test("handles only one window being present", () => {
    expect(rateLimitBadge({ five_hour: { used_percentage: 42 } })).toContain("(5h)");
    expect(rateLimitBadge({ seven_day: { used_percentage: 33 } })).toContain("(7d)");
  });

  test("escalates colour at 60 and 80 — the warning has to arrive with room to act", () => {
    // Pins where the badge turns yellow and red. Nothing tested these, so the
    // red line could drift to 95% and the user would first see it when the
    // headroom was nearly gone — which is the one moment the field exists for.
    const red = "\x1b[31m";
    const yellow = "\x1b[33m";
    expect(rateLimitBadge({ five_hour: { used_percentage: 80 } })).toContain(red);
    expect(rateLimitBadge({ five_hour: { used_percentage: 79 } })).not.toContain(red);
    expect(rateLimitBadge({ five_hour: { used_percentage: 79 } })).toContain(yellow);
    expect(rateLimitBadge({ five_hour: { used_percentage: 60 } })).toContain(yellow);
    expect(rateLimitBadge({ five_hour: { used_percentage: 59 } })).not.toContain(yellow);
  });
});

describe("spendField — one field chosen by plan type, never both", () => {
  test("rate-limit data present (Pro/Max) → % of plan, not $ cost", () => {
    const field = spendField(1.23, { five_hour: { used_percentage: 42 } });
    expect(field).toContain("42%");
    expect(field).not.toContain("$");
  });

  test("no rate-limit data (API/pay-per-token) → $ cost", () => {
    expect(spendField(1.23, undefined)).toBe("$1.23");
    expect(spendField(1.23, null)).toBe("$1.23");
    expect(spendField(1.23, {})).toBe("$1.23");
  });

  test("neither present → null (statusline just omits the field)", () => {
    expect(spendField(null, undefined)).toBeNull();
    expect(spendField(undefined, {})).toBeNull();
  });

describe("splash — the welcome is a moment, not wallpaper", () => {
  const week = { sessions: 3, tokensIn: 1, tokensOut: 1, cacheRead: 0, cost: 0, planSessions: 0, autoCompacts: 0 };

  test("the full rat only shows up on a welcome", () => {
    const welcome = splash({ version: "0.2.0", week, tip: null, welcome: true });
    const routine = splash({ version: "0.2.0", week, tip: null });
    // The halftone art is many lines of @ and #; the everyday mark is three.
    expect(welcome.split("\n").length).toBeGreaterThan(15);
    expect(welcome).toContain("@@@");
    expect(routine.split("\n")).toHaveLength(3);
    expect(routine).not.toContain("@@@");
    expect(routine).toContain("(o,o)");
  });

  test("both forms still carry the version, the week, and the tip line", () => {
    for (const welcome of [true, false]) {
      const out = splash({ version: "0.2.0", week, tip: null, welcome });
      expect(out).toContain("REMY v0.2.0");
      expect(out).toContain("3 sessions");
    }
  });
});

describe("bar", () => {
  test("renders a fixed width across the normal range", () => {
    for (const pct of [0, 1, 50, 99, 100]) {
      expect(bar(pct)).toHaveLength(10);
    }
    expect(bar(0)).toBe("░░░░░░░░░░");
    expect(bar(100)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(bar(50)).toBe("▓▓▓▓▓░░░░░");
  });

  test("clamps out-of-range input instead of throwing", () => {
    // The clamp is not cosmetic: String.prototype.repeat throws RangeError on
    // a negative count, so an unclamped pct over 100 or under 0 takes the
    // whole statusline down. A context percentage is a computed ratio and
    // nothing upstream guarantees it lands inside 0-100.
    for (const pct of [-50, -1, 101, 150, 1e6]) {
      expect(() => bar(pct)).not.toThrow();
      expect(bar(pct)).toHaveLength(10);
    }
    expect(bar(150)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(bar(-50)).toBe("░░░░░░░░░░");
  });
});
});
