import { describe, expect, test } from "bun:test";
import { BRAND, HINTS, TIPS, type SessionRow, type TipRow } from "@ccpp/core";
import { ART, WELCOME_ART, awakeSeconds, bar, cacheField, contextAlarmLine, earnClause, earnDollars, fmtCost, fmtTok, hostCacheField, humanDur, linksEnabled, modelEmoji, modelField, prField, rateLimitBadge, rotatingHint, spendField, splash, tipLine, tipLineLong, weekTotals } from "../src/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const plainText = (s: string | null | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

function tipRow(overrides: Partial<TipRow>): TipRow {
  return {
    id: 1,
    tip_id: "edit-thrash",
    session_id: "s1",
    created_at: "2026-07-28T10:00:00Z",
    status: "active",
    evidence: null,
    est_savings_tokens: 0,
    est_class: "input",
    why: null,
    ...overrides,
  } as TipRow;
}

/** A session whose own numbers price a finding: $10 across 1M effective
 * tokens, so 1 effective token is worth exactly $0.00001 and the arithmetic
 * in these tests is checkable by hand. */
function pricedSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    cost_usd: 10,
    tokens_in: 1_000_000,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    ...over,
  } as SessionRow;
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

describe("earnDollars — the session prices its own findings", () => {
  test("converts an estimate using the session's measured cost, no price table", () => {
    // A hardcoded per-token price would go stale and would be simply wrong for
    // a subscription account. Two measured numbers and a division instead.
    expect(earnDollars(100_000, "input", pricedSession())).toBeCloseTo(1.0, 5);
  });

  test("cache-read tokens are worth a tenth — the whole reason the class exists", () => {
    // 28.7M raw cache-read tokens is what "+219M 🪙" was built from. Priced,
    // the same finding is worth a tenth of what a raw count implies.
    expect(earnDollars(100_000, "cache-read", pricedSession())).toBeCloseTo(0.1, 5);
    expect(earnDollars(100_000, "cold-write", pricedSession())).toBeCloseTo(1.9, 5);
  });

  test("an unclassified legacy row is priced at the neutral 1x, never dropped", () => {
    expect(earnDollars(100_000, null, pricedSession())).toBeCloseTo(1.0, 5);
  });

  test("the session's own mix is weighted the same way on both sides of the division", () => {
    // 1M cache reads is 100k effective, so $10 over it makes one effective
    // token worth $0.0001 — ten times the all-fresh session above.
    const cacheHeavy = pricedSession({ tokens_in: 0, cache_read: 1_000_000 });
    expect(earnDollars(100_000, "input", cacheHeavy)).toBeCloseTo(10.0, 5);
  });

  test("no measured cost means no dollar figure — we never show a number we can't derive", () => {
    // Measured on real data: 9 of 13 local sessions carry no cost at all,
    // because cost_usd only lands when the statusline runs.
    expect(earnDollars(100_000, "input", pricedSession({ cost_usd: 0 }))).toBeNull();
    expect(earnDollars(100_000, "input", pricedSession({ cost_usd: null as never }))).toBeNull();
    expect(earnDollars(100_000, "input", null)).toBeNull();
    expect(earnDollars(100_000, "input", undefined)).toBeNull();
  });

  test("a session with cost but no tokens divides by nothing, and says so", () => {
    const empty = pricedSession({ tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 });
    expect(earnDollars(100_000, "input", empty)).toBeNull();
  });

  test("a finding worth nothing is worth nothing, not $0.00", () => {
    expect(earnDollars(0, "input", pricedSession())).toBeNull();
    expect(earnDollars(-5, "input", pricedSession())).toBeNull();
    expect(earnDollars(Number.NaN, "input", pricedSession())).toBeNull();
  });
});

describe("earnClause — money, then coins, then honesty", () => {
  const def = TIPS["edit-thrash"]!;

  test("real money when the session can price it", () => {
    const tip = tipRow({ est_savings_tokens: 100_000, est_class: "input" });
    expect(earnClause(tip, def, pricedSession())).toBe("saves ≈$1.00");
  });

  test("large amounts drop the cents — ≈$18 reads, ≈$18.43 pretends", () => {
    const tip = tipRow({ est_savings_tokens: 1_843_000, est_class: "input" });
    expect(earnClause(tip, def, pricedSession())).toBe("saves ≈$18");
  });

  test("falls back to effective coins when the session has no cost", () => {
    const tip = tipRow({ est_savings_tokens: 2_000_000, est_class: "cache-read" });
    // Effective, not raw: 2M cache-read tokens are 200k of real value, and
    // quoting the raw figure here is what made the old deck unbelievable.
    expect(earnClause(tip, def, null)).toBe("saves ~200k 🪙");
  });

  test("sub-cent findings fall through to coins rather than rendering ≈$0.00", () => {
    const tip = tipRow({ est_savings_tokens: 100, est_class: "input" });
    expect(earnClause(tip, def, pricedSession())).toBe("saves ~100 🪙");
  });

  test("a finding with no token value says what it IS worth", () => {
    const noVerify = TIPS["no-verify"]!;
    const tip = tipRow({ tip_id: "no-verify", est_savings_tokens: 0 });
    expect(earnClause(tip, noVerify, pricedSession())).toBe("worth: fewer bugs, not fewer tokens");
  });

  test("and a wisdom tip with neither says nothing at all", () => {
    const wisdom = TIPS["clear-between-tasks"]!;
    const tip = tipRow({ tip_id: "clear-between-tasks", est_savings_tokens: 0 });
    expect(earnClause(tip, wisdom, pricedSession())).toBeNull();
  });
});

describe("tipLineLong — evidence you recognize → what to do → what it's worth", () => {
  test("composes all three parts, in that order", () => {
    const tip = tipRow({
      evidence: JSON.stringify({ files: 1, edits: 14, rereads: 19, next: 15 }),
      est_savings_tokens: 100_000,
      est_class: "input",
    });
    expect(tipLineLong(tip, pricedSession(), { file: "packages/cli/src/index.ts" })).toBe(
      `[${BRAND}]: 🔨 packages/cli/src/index.ts took 14 edits with 19 re-reads between them` +
        ` → /clear and re-brief rather than attempt 15 → saves ≈$1.00`,
    );
  });

  test("an unresolved filename degrades to the catalog's wording, never a placeholder", () => {
    const tip = tipRow({
      evidence: JSON.stringify({ files: 1, edits: 14, rereads: 19, next: 15 }),
      est_savings_tokens: 100_000,
    });
    const line = tipLineLong(tip, pricedSession());
    expect(line).not.toMatch(/\{\w+\}/);
    expect(line).toContain("one file took 14 edits");
  });

  test("a wisdom tip has no problem half and falls back to short", () => {
    const tip = tipRow({ tip_id: "clear-between-tasks", evidence: "{}" });
    expect(tipLineLong(tip, pricedSession())).toBe(
      `[${BRAND}]: 🚿 New task, old context → /clear between unrelated tasks`,
    );
  });

  test("an unknown id still renders a bracketed, non-crashing line", () => {
    expect(tipLineLong(tipRow({ tip_id: "does-not-exist" }))).toBe(
      `[${BRAND}]: 💡 /remy for your session report`,
    );
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

describe("rateLimitBadge — pace, once the host says when the window resets", () => {
  // Fixed clock, UTC, so the awake-hours arithmetic is checkable by hand:
  // 2026-08-20 12:00:00Z is a Thursday noon.
  const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
  const sec = NOW / 1000;
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const badge = (rl: unknown) => rateLimitBadge(rl, NOW, 0);

  test("the same percentage is calm or alarming depending on how far through the window you are", () => {
    // 43% used, 4h left of 5h: 20% of the window gone, 23 points ahead → yellow.
    const early = badge({ five_hour: { used_percentage: 43, resets_at: sec + 4 * 3600 } });
    expect(early).toContain(yellow);
    expect(plainText(early)).toContain("out in");
    // 43% used, 20 minutes left: 93% of the window gone → nothing to say.
    const late = badge({ five_hour: { used_percentage: 43, resets_at: sec + 20 * 60 } });
    expect(late).not.toContain(yellow);
    expect(late).not.toContain(red);
    expect(plainText(late)).toBe("⏳ 43% (5h) ↻20m");
  });

  test("on pace, the tail is the countdown to reset; over pace, it is the forecast", () => {
    // 50% used, 50% elapsed → on the line exactly.
    expect(plainText(badge({ five_hour: { used_percentage: 50, resets_at: sec + 2.5 * 3600 } }))).toBe(
      "⏳ 50% (5h) ↻2h30m",
    );
    // 60% used after 1h of 5h: 60%/h → the rest (40%) goes in 40 minutes.
    expect(plainText(badge({ five_hour: { used_percentage: 60, resets_at: sec + 4 * 3600 } }))).toBe(
      "⏳ 60% (5h) out in 40m",
    );
  });

  test("escalation: +10 points yellow, +25 red, and 90% red whatever the pace", () => {
    const at = (pct: number, elapsedH: number) =>
      badge({ five_hour: { used_percentage: pct, resets_at: sec + (5 - elapsedH) * 3600 } });
    expect(at(30, 1)).toContain(yellow); // +10
    expect(at(29, 1)).not.toContain(yellow); // +9
    expect(at(45, 1)).toContain(red); // +25
    expect(at(44, 1)).not.toContain(red); // +24, yellow
    expect(at(44, 1)).toContain(yellow);
    // 92% used with the window nearly over: on pace, but one fat turn from
    // the wall.
    expect(at(92, 4.9)).toContain(red);
  });

  test("picks the window that is furthest ahead of its clock, not the highest number", () => {
    // 5h: 80% used, 10 min left → well under pace. 7d: 60% used, 30% elapsed
    // → 30 points ahead. The week is the one that needs a decision.
    const out = badge({
      five_hour: { used_percentage: 80, resets_at: sec + 10 * 60 },
      seven_day: { used_percentage: 60, resets_at: sec + 0.7 * 7 * 86_400 },
    });
    expect(plainText(out)).toContain("(7d)");
    expect(out).toContain(red);
  });

  test("…unless one of them is about to hit the wall", () => {
    const out = badge({
      five_hour: { used_percentage: 91, resets_at: sec + 10 * 60 },
      seven_day: { used_percentage: 60, resets_at: sec + 0.7 * 7 * 86_400 },
    });
    expect(plainText(out)).toContain("91% (5h)");
  });

  test("a window without resets_at falls back to the fixed thresholds and no tail", () => {
    const out = badge({ five_hour: { used_percentage: 70 } });
    expect(plainText(out)).toBe("⏳ 70% (5h)");
    expect(out).toContain(yellow);
  });

  test("the week is paced in awake hours, so a night asleep does not read as falling behind", () => {
    // Window started exactly 24h ago. Wall share = 1/7 ≈ 14.3%. Awake share:
    // one full day of 18 awake hours out of 7×18 → also 1/7 — the sleep block
    // (02:00–08:00) falls wholly inside both the elapsed day and every other
    // day, so the two agree. Now move the start to 3h ago at 09:00: no sleep
    // elapsed yet, so awake share (3/126 = 2.4%) runs AHEAD of wall share
    // (3/168 = 1.8%) and a developer at 2.4% used is exactly on the line.
    const start = sec - 3 * 3600;
    const resets = start + 7 * 86_400;
    const out = badge({ seven_day: { used_percentage: 2.4, resets_at: resets } });
    expect(out).not.toContain(yellow);
  });
});

describe("awakeSeconds — the week has nights in it", () => {
  const DAY = 86_400;
  // 2026-08-20T00:00Z; with offset 0 the sleep block is 02:00–08:00 UTC.
  const T0 = Date.UTC(2026, 7, 20) / 1000;
  test("a whole day is 18 awake hours", () => {
    expect(awakeSeconds(T0, T0 + DAY, 0)).toBe(18 * 3600);
  });
  test("an interval entirely inside the sleep block is zero", () => {
    expect(awakeSeconds(T0 + 3 * 3600, T0 + 5 * 3600, 0)).toBe(0);
  });
  test("an interval that straddles the block loses only the overlap", () => {
    // 01:00 → 09:00: 8 wall hours, 6 asleep.
    expect(awakeSeconds(T0 + 1 * 3600, T0 + 9 * 3600, 0)).toBe(2 * 3600);
  });
  test("a week is 7 × 18 hours", () => {
    expect(awakeSeconds(T0 + 5 * 3600, T0 + 5 * 3600 + 7 * DAY, 0)).toBe(7 * 18 * 3600);
  });
  test("the timezone offset moves the block with local time", () => {
    // UTC−3 (offset +180): local 02:00 is 05:00Z, so 03:00Z–05:00Z is awake.
    expect(awakeSeconds(T0 + 3 * 3600, T0 + 5 * 3600, 180)).toBe(2 * 3600);
  });
  test("a backwards or empty interval is zero, never negative", () => {
    expect(awakeSeconds(T0, T0, 0)).toBe(0);
    expect(awakeSeconds(T0 + 10, T0, 0)).toBe(0);
  });
});

describe("humanDur — minute resolution, like the cache clock", () => {
  test("renders the way a developer would say it", () => {
    expect(humanDur(30)).toBe("<1m");
    expect(humanDur(45 * 60)).toBe("45m");
    expect(humanDur(2 * 3600 + 10 * 60)).toBe("2h10m");
    expect(humanDur(2 * 3600 + 5 * 60)).toBe("2h05m");
    expect(humanDur(3 * 3600)).toBe("3h");
    expect(humanDur(33 * 3600)).toBe("1d9h");
    expect(humanDur(48 * 3600)).toBe("2d");
  });
  test("nonsense is a floor, not NaN on the statusline", () => {
    expect(humanDur(NaN)).toBe("<1m");
    expect(humanDur(-5)).toBe("<1m");
  });
});

describe("modelField — the model and the two dials that multiply its price", () => {
  const yellow = "\x1b[33m";
  test("plain name when the host sends no effort and no fast mode", () => {
    expect(modelField("claude-fable-5-1", "Fable", undefined, undefined)).toBe("🐉 Fable");
  });
  test("effort rides on the model with a slash, so it cannot read as the model's name", () => {
    expect(modelField("claude-opus-5-5", "Opus", "high", false)).toBe("🎭 Opus/high");
  });
  test("max effort and fast mode are the two settings that cost, so they are the two that colour", () => {
    const out = modelField("claude-fable-5-1", "Fable", "max", true);
    expect(plainText(out)).toBe("🐉 Fable/max ↯fast");
    expect(out).toContain(`${yellow}max`);
    expect(out).toContain(`${yellow}↯fast`);
    expect(modelField("claude-fable-5-1", "Fable", "xhigh", false)).not.toContain(yellow);
  });
  test("an effort level the host does not document is dropped, not rendered", () => {
    expect(modelField("claude-fable-5-1", "Fable", "turbo", false)).toBe("🐉 Fable");
    expect(modelField("claude-fable-5-1", "Fable", 7, "yes")).toBe("🐉 Fable");
  });
});

describe("prField — the branch's PR and where its review stands", () => {
  test("nothing without a PR object or a positive integer number", () => {
    expect(prField(undefined)).toBeNull();
    expect(prField({})).toBeNull();
    expect(prField({ number: 0 })).toBeNull();
    expect(prField({ number: "12" })).toBeNull();
  });
  test("GitHub PRs are #n, GitLab merge requests are !n", () => {
    expect(plainText(prField({ number: 123 }))).toBe("🔀 #123");
    expect(plainText(prField({ number: 45, kind: "mr" }))).toBe("🔀 !45");
  });
  test("each review state has its own glyph, and the approved one is green", () => {
    expect(plainText(prField({ number: 1, review_state: "approved" }))).toBe("🔀 #1 ✔");
    expect(prField({ number: 1, review_state: "approved" })).toContain("\x1b[32m");
    expect(plainText(prField({ number: 1, review_state: "changes_requested" }))).toBe("🔀 #1 ✘");
    expect(plainText(prField({ number: 1, review_state: "pending" }))).toBe("🔀 #1 ○");
    expect(plainText(prField({ number: 1, review_state: "draft" }))).toBe("🔀 #1 ✎");
    expect(plainText(prField({ number: 1, review_state: "merged?" }))).toBe("🔀 #1");
  });
  test("a non-https url never becomes a link target", () => {
    const prev = process.env.REMY_LINKS;
    process.env.REMY_LINKS = "1";
    try {
      expect(prField({ number: 1, url: "https://github.com/o/r/pull/1" })).toContain("\x1b]8;;https://github.com/o/r/pull/1");
      expect(prField({ number: 1, url: "javascript:alert(1)" })).not.toContain("\x1b]8;;");
    } finally {
      if (prev === undefined) delete process.env.REMY_LINKS;
      else process.env.REMY_LINKS = prev;
    }
  });
});

describe("hostCacheField — the clock, fed by the host's own prompt_cache object", () => {
  const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
  const sec = T0 / 1000;
  test("no object → undefined, so the caller falls back to the derived clock", () => {
    expect(hostCacheField(undefined, null, null, T0)).toBeUndefined();
    expect(hostCacheField(null, null, null, T0)).toBeUndefined();
    expect(hostCacheField({ warm: true }, null, null, T0)).toBeUndefined(); // no expiry to count down
  });
  test("caching_observed false → null: nothing is cached, so there is no clock to show", () => {
    expect(hostCacheField({ caching_observed: false, warm: false }, null, null, T0)).toBeNull();
  });
  test("warm with an expiry counts down in minutes", () => {
    expect(plainText(hostCacheField({ warm: true, ttl: "1h", expires_at: sec + 52 * 60 + 30 }, null, null, T0))).toBe(
      "🔥 cache 52m",
    );
    expect(hostCacheField({ warm: true, ttl: "1h", expires_at: sec + 8 * 60 }, null, null, T0)).toContain("\x1b[33m");
  });
  test("the host's TTL caps a skewed expiry, like the derived clock does", () => {
    expect(plainText(hostCacheField({ warm: true, ttl: "5m", expires_at: sec + 3600 }, null, null, T0))).toBe(
      "🔥 cache 5m",
    );
  });
  test("warm:false, or an expiry in the past, is cold", () => {
    expect(plainText(hostCacheField({ warm: false, expires_at: sec + 3600 }, null, null, T0))).toBe("🧊 cache cold");
    expect(plainText(hostCacheField({ warm: true, expires_at: sec - 1 }, null, null, T0))).toBe("🧊 cache cold");
  });
  test("a model switch is cold whatever the host's flag says — the next request will miss", () => {
    expect(
      plainText(hostCacheField({ warm: true, expires_at: sec + 3600 }, "claude-sonnet-5", "claude-opus-5", T0)),
    ).toBe("🧊 cache cold");
    // …but the context-window qualifier is not a model switch.
    expect(
      plainText(hostCacheField({ warm: true, expires_at: sec + 3600 }, "claude-opus-5", "claude-opus-5[1m]", T0)),
    ).toBe("🔥 cache 60m");
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

describe("cacheField — the one number no hook could ever tell you", () => {
  const HOUR = 60 * 60_000;
  const T0 = Date.parse("2026-08-20T12:00:00.000Z");
  const at = (minsAgo: number) => new Date(T0 - minsAgo * 60_000).toISOString();
  const plain = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

  test("says the word 'cache' — an emoji alone is not self-explanatory", () => {
    // The line already carries four emoji. "🔥 52m" reads as a streak, a timer,
    // anything; the context field beside it solves this the same way ("48%
    // ctx"), so the noun is house style. Dropping it back to a bare emoji to
    // save three columns is what this assertion exists to catch.
    expect(plain(cacheField(HOUR, at(8), null, null, T0))).toBe("🔥 cache 52m");
    expect(plain(cacheField(HOUR, at(120), null, null, T0))).toBe("🧊 cache cold");
  });

  test("counts down in whole minutes, and never in seconds", () => {
    // The statusline repaints ~1/s. A seconds field would be motion in the
    // corner of the eye every single repaint; minutes change 60× less often
    // and carry the same decision.
    expect(plain(cacheField(HOUR, at(0), null, null, T0))).toBe("🔥 cache 60m");
    // Exactly a minute left still reads as a minute; only the final partial
    // one collapses to "<1m", because rounding it up to "1m" would promise
    // time that has already gone.
    expect(plain(cacheField(HOUR, at(59), null, null, T0))).toBe("🔥 cache 1m");
    expect(plain(cacheField(HOUR, at(59.5), null, null, T0))).toBe("🔥 cache <1m");
    expect(plain(cacheField(HOUR, at(60), null, null, T0))).toBe("🧊 cache cold");
  });

  test("goes yellow in the last ten minutes — while wrapping up is still a choice", () => {
    expect(cacheField(HOUR, at(49), null, null, T0)).not.toContain("\x1b[33m");
    expect(cacheField(HOUR, at(51), null, null, T0)).toContain("\x1b[33m");
  });

  test("a 5-minute TTL counts down from 5 — nothing here is hardcoded to an hour", () => {
    // Claude Code buys the 1-hour cache today (all 9,713 cached turns in the
    // local corpus are ephemeral_1h), but the raw API default is 5 minutes and
    // a session can drop to it under usage overage. The TTL is measured per
    // session precisely so this case renders honestly rather than promising
    // 55 more minutes of warmth that do not exist.
    expect(plain(cacheField(5 * 60_000, at(2), null, null, T0))).toBe("🔥 cache 3m");
    expect(plain(cacheField(5 * 60_000, at(6), null, null, T0))).toBe("🧊 cache cold");
  });

  test("a model switch is cold however fresh the anchor", () => {
    // The cache is per-model: /model leaves the old entry warm but unreachable.
    expect(plain(cacheField(HOUR, at(1), "claude-sonnet-5", "claude-opus-5", T0))).toBe("🧊 cache cold");
    expect(plain(cacheField(HOUR, at(1), "claude-opus-5", "claude-opus-5", T0))).toBe("🔥 cache 59m");
  });

  test("the 1M-context qualifier is not a different model", () => {
    // Caught on a real session, not in review. The stored side is the
    // transcript's `message.model` and the live side is the statusline
    // payload's `model.id`, and only the payload carries the context-window
    // qualifier — the same turn is "claude-opus-5" in one and
    // "claude-opus-5[1m]" in the other. Compared raw, every 1M-context session
    // renders permanently cold: the clock would be broken for precisely the
    // users with the most expensive contexts to re-write, and it would look
    // like working software.
    expect(plain(cacheField(HOUR, at(1), "claude-opus-5", "claude-opus-5[1m]", T0))).toBe("🔥 cache 59m");
    expect(plain(cacheField(HOUR, at(1), "claude-opus-5[1m]", "claude-opus-5", T0))).toBe("🔥 cache 59m");
    // A real switch across the qualifier is still cold.
    expect(plain(cacheField(HOUR, at(1), "claude-sonnet-5", "claude-opus-5[1m]", T0))).toBe("🧊 cache cold");
  });

  test("an unobserved TTL renders nothing rather than a guessed hour", () => {
    // "We never show a number we can't derive" — and a wrong warm reading is
    // worse than no field, because it tells you to keep a fat session open.
    expect(cacheField(null, at(1), null, null, T0)).toBeNull();
    expect(cacheField(0, at(1), null, null, T0)).toBeNull();
    expect(cacheField(HOUR, null, null, null, T0)).toBeNull();
    expect(cacheField(HOUR, "not-a-timestamp", null, null, T0)).toBeNull();
  });

  test("an anchor in the future is clamped to the TTL, not trusted", () => {
    // Clock skew or a hand-edited row. Promising 70 minutes of a 60-minute
    // cache would be the one thing this field must never do.
    expect(plain(cacheField(HOUR, at(-10), null, null, T0))).toBe("🔥 cache 60m");
  });
});

describe("splash — the welcome is a moment, not wallpaper", () => {
  const week = { sessions: 3, tokensIn: 1, tokensOut: 1, cacheRead: 0, cost: 0, planSessions: 0, autoCompacts: 0 };

  test("the whole mouse only shows up on a welcome", () => {
    const welcome = splash({ version: "0.2.0", week, tip: null, welcome: true });
    const routine = splash({ version: "0.2.0", week, tip: null });
    // The welcome carries the sign; the everyday mark is his face, four lines.
    expect(welcome.split("\n").length).toBeGreaterThan(15);
    expect(welcome).toContain("T O K E N S");
    expect(welcome).toContain("jgs");
    expect(routine.split("\n")).toHaveLength(4);
    expect(routine).not.toContain("T O K E N S");
    expect(routine).toContain("66");
  });

  test("the welcome art IS art/remy.txt — the README hero and the splash cannot drift", () => {
    // The old welcome was a hand-downsampled copy of the hero that nothing
    // kept in sync. Now the file is the source and the array is asserted
    // against it byte for byte.
    const file = readFileSync(
      join(import.meta.dir, "..", "..", "plugin-claude-code", "art", "remy.txt"),
      "utf8",
    ).replace(/\n$/, "");
    expect(WELCOME_ART.join("\n")).toBe(file);
    // And the everyday face is a crop of the same art, not a second drawing.
    for (const [i, line] of ART.entries()) {
      expect(WELCOME_ART[i + 1]!.slice(9)).toBe(line.trimEnd());
    }
  });

  test("the sign is a rectangle — every row's right border lands in one column", () => {
    // Re-lettering the sign widened it by two columns; a row left at the old
    // width would hang its border in the wrong place.
    const rows = WELCOME_ART.slice(6, 10);
    const edge = rows[0]!.length - 1;
    for (const i of [0, 2, 3]) {
      expect(rows[i]!.length - 1, `row ${i} width`).toBe(edge);
      expect(rows[i]![edge]).toBe("|");
    }
    // The second row hangs the sign on its nail: "()" where the border goes.
    expect(rows[1]!.slice(edge)).toBe("()");
    // The top edge stops one short of the corner, the bottom edge reaches it.
    expect(WELCOME_ART[5]!.length - 1).toBe(edge - 1);
    expect(WELCOME_ART[10]!.length - 1).toBe(edge);
  });

  test("both forms still carry the version, the week, and the tip line", () => {
    for (const welcome of [true, false]) {
      const out = splash({ version: "0.2.0", week, tip: null, welcome });
      expect(out).toContain("REMY v0.2.0");
      expect(out).toContain("3 sessions");
    }
  });
});

describe("fmtTok — the token counts on every surface", () => {
  test("switches unit at 1k and 1M, and drops the decimal once the number is wide", () => {
    // 🪙 counts appear in a 55-char statusline budget, so precision is traded
    // for width as the number grows. These boundaries are the whole contract.
    expect(fmtTok(0)).toBe("0");
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1_000)).toBe("1.0k");
    expect(fmtTok(9_999)).toBe("10.0k");
    expect(fmtTok(10_000)).toBe("10k");
    expect(fmtTok(1_000_000)).toBe("1.00M");
    expect(fmtTok(10_000_000)).toBe("10M");
  });

  test("never renders something that isn't a number", () => {
    // A count is derived from sums and ratios; a NaN reaching the statusline
    // would render literally, and "InfinityM" is not a quantity anyone can act
    // on. Nonsense in, 0 out — matching the existing negative clamp.
    expect(fmtTok(-5)).toBe("0");
    expect(fmtTok(NaN)).toBe("0");
    expect(fmtTok(Infinity)).toBe("0");
    expect(fmtTok(-Infinity)).toBe("0");
    for (const n of [0, 1, 1e3, 1e6, NaN, Infinity, -1]) {
      expect(fmtTok(n)).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

describe("fmtCost", () => {
  test("renders real spend and nothing else", () => {
    // Returning null is what lets the caller drop the field entirely rather
    // than print "$0.00" at someone who is on a plan with no per-call cost.
    expect(fmtCost(1.239)).toBe("$1.24");
    expect(fmtCost(0)).toBeNull();
    expect(fmtCost(-1)).toBeNull();
    expect(fmtCost(null)).toBeNull();
    expect(fmtCost(undefined)).toBeNull();
    expect(fmtCost(NaN)).toBeNull();
    expect(fmtCost(Infinity)).toBeNull();
  });
});

describe("weekTotals", () => {
  const row = (o: Partial<SessionRow>): SessionRow =>
    ({
      session_id: "s", started_at: "2026-08-01T00:00:00Z", ended_at: null, model: null,
      cwd_hash: null, repo_hash: null, tokens_in: 0, tokens_out: 0, cache_read: 0,
      cache_write: 0, cost_usd: null, tool_calls: 0, tool_fails: 0, compacts_auto: 0,
      compacts_manual: 0, used_plan_mode: 0, max_context_pct: 0, context_window: null,
      claude_md_bytes: null, perm_denials: 0, ...o,
    }) as SessionRow;

  test("sums the week and counts plan sessions rather than summing them", () => {
    const totals = weekTotals([
      row({ tokens_in: 100, tokens_out: 10, cache_read: 1_000, cost_usd: 1.5, used_plan_mode: 1, compacts_auto: 2 }),
      row({ tokens_in: 200, tokens_out: 20, cache_read: 2_000, cost_usd: 2.25, used_plan_mode: 0, compacts_auto: 1 }),
      row({ tokens_in: 300, tokens_out: 30, cache_read: 3_000, cost_usd: null, used_plan_mode: 1 }),
    ]);
    expect(totals.sessions).toBe(3);
    expect(totals.tokensIn).toBe(600);
    expect(totals.tokensOut).toBe(60);
    expect(totals.cacheRead).toBe(6_000);
    expect(totals.cost).toBeCloseTo(3.75, 5);
    // Pins the number, not the method: used_plan_mode is written via
    // MAX(used_plan_mode, ?) so it is only ever 0 or 1, which makes counting
    // and summing indistinguishable. Nothing here can tell them apart, and a
    // fixture with used_plan_mode > 1 would be testing a state the store
    // cannot produce.
    expect(totals.planSessions).toBe(2);
    expect(totals.autoCompacts).toBe(3);
  });

  test("a session with no recorded cost contributes nothing to the week", () => {
    // Note what this does NOT prove: `null` coerces to 0 in JS arithmetic, so
    // the `?? 0` in weekTotals is defensive against `undefined`, not against
    // the null this fixture uses. Removing it keeps this test green. What the
    // assertion pins is the outcome a user sees — an unpriced session leaves
    // the week's total alone instead of blanking it.
    const totals = weekTotals([row({ cost_usd: null }), row({ cost_usd: 2 })]);
    expect(totals.cost).toBe(2);
    expect(Number.isFinite(totals.cost)).toBe(true);
  });

  test("an empty week is all zeroes, not NaN", () => {
    const totals = weekTotals([]);
    expect(totals).toEqual({
      sessions: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0, planSessions: 0, autoCompacts: 0,
    });
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

describe("surfaces nothing was testing", () => {
  test("modelEmoji covers every family it claims to, and falls back for the rest", () => {
    // Rendered on the statusline roughly once a second and asserted nowhere.
    expect(modelEmoji("claude-fable-5")).toBe("🐉");
    expect(modelEmoji("claude-opus-5[1m]")).toBe("🎭");
    expect(modelEmoji("claude-sonnet-5")).toBe("🎼");
    expect(modelEmoji("claude-haiku-4-5")).toBe("🍃");
    // Case and vendor prefixes must not defeat it — Bedrock-style ids are real.
    expect(modelEmoji("anthropic.claude-3-5-SONNET-v2:0")).toBe("🎼");
    // Unknown, absent, and null all land on the generic robot rather than "".
    for (const id of ["gpt-4", "", null, undefined]) {
      expect(modelEmoji(id), `${String(id)} should fall back`).toBe("🤖");
    }
  });

  test("hyperlinks are emitted only where the terminal supports them", () => {
    // Getting this wrong sprays OSC-8 escape codes across the statusline of
    // every terminal that can't render them.
    expect(linksEnabled({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(linksEnabled({ TERM: "xterm-kitty" })).toBe(true);
    expect(linksEnabled({ TERM: "xterm-ghostty" })).toBe(true);
    expect(linksEnabled({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(linksEnabled({})).toBe(false);
    // The override wins in both directions, whatever the terminal says.
    expect(linksEnabled({ REMY_LINKS: "1", TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(linksEnabled({ REMY_LINKS: "0", TERM_PROGRAM: "iTerm.app" })).toBe(false);
  });

  test("every hint is reachable — the deck must not outgrow the year", () => {
    // rotatingHint indexes by day-of-year modulo HINTS.length, so a deck longer
    // than 366 entries would contain hints no user could ever see. Cheap
    // invariant, and the failure is silent.
    expect(HINTS.length).toBeGreaterThan(0);
    expect(HINTS.length).toBeLessThanOrEqual(366);
    expect(HINTS).toContain(rotatingHint());
  });

  test("the spinner line speaks the session's own numbers, and survives an unknown tip", () => {
    // tipLineLong is the wide-surface renderer — the only consumer of `live` —
    // and had no assertions at all.
    const line = tipLineLong({
      id: 1, tip_id: "reread-churn", session_id: "s1", created_at: "2026-08-06T00:00:00.000Z",
      status: "active", evidence: JSON.stringify({ files: 8, worst: 12 }),
      est_savings_tokens: 16_000, why: null,
    } as TipRow);
    expect(line).toContain(BRAND);
    expect(line).toContain("12");
    expect(line).not.toMatch(/\{\w+\}/);

    const unknown = tipLineLong({
      id: 2, tip_id: "no-such-tip", session_id: "s1", created_at: "2026-08-06T00:00:00.000Z",
      status: "active", evidence: "{}", est_savings_tokens: 0, why: null,
    } as TipRow);
    expect(unknown).toContain("/remy");
  });
});
