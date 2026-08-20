import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AdaptPayloadSchema } from "../../../core/src/adapt";
import { TIPS } from "../../../core/src/catalog";
import { CHAOS } from "../../../core/test/support/scenarios";
import { MARKER } from "../../../core/test/support/transcript-builder";
import {
  adaptStub,
  destroyWorld,
  driveSession,
  makeWorld,
  remy,
  tips,
  type AdaptStub,
  type World,
} from "./harness";

// The adaptive coach is the one place REMY talks to a model, and the one byte
// stream that ever leaves the process. `REMY_ADAPT_CMD` swaps the real
// `claude -p` for a shell stub, which makes both halves deterministic:
//
//   outbound — does the profile we hand the model actually describe the
//              session, and does it carry nothing it shouldn't?
//   inbound  — the reply is untrusted input. Every way a model can misbehave
//              (a hallucinated id, escape codes, an envelope, silence) has to
//              land somewhere safe.
//
// Gating (the kill switch, the daily budget, non-blocking SessionEnd) is
// covered by adapt-gate.test.ts; this file is about content.

const VALID = '{"tip_id":"clear-between-tasks","why":"you kept one session open all day","confidence":0.8}';

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => destroyWorld(w));

/** Drive a bad session, then run the analyzer against a scripted backend. */
async function analyze(reply: string): Promise<AdaptStub> {
  await driveSession(w, CHAOS);
  const stub = adaptStub(w, reply);
  const run = await remy(w, ["adapt", "--force"]);
  expect(run.code).toBe(0);
  return stub;
}

function profileFrom(prompt: string): unknown {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Developer profile JSON:"));
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[at + 1]!);
}

/** Every string anywhere in a value — keys included, since tip ids and model
 * ids are carried as object keys. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  }
  return [];
}

describe("what REMY tells the model about you", () => {
  test("the profile is a valid, whitelisted, metadata-only payload", async () => {
    const stub = await analyze(VALID);
    expect(stub.calls()).toBe(1);

    // .strict() — an extra key anywhere would throw here.
    const profile = AdaptPayloadSchema.parse(profileFrom(stub.prompts()[0]!));
    expect(profile.window_days).toBe(14);
    expect(profile.sessions).toBe(1);
  });

  test("the profile actually describes the session that was driven", async () => {
    // A well-formed payload that says nothing true would be worse than none:
    // the model's advice is only as good as this summary.
    const stub = await analyze(VALID);
    const profile = AdaptPayloadSchema.parse(profileFrom(stub.prompts()[0]!));

    expect(Object.keys(profile.waste).sort()).toEqual([...CHAOS.expect].sort());
    expect(profile.plan_rate).toBe(0);
    expect(profile.max_context_pct).toBe(83);
    expect(profile.pending_tips.sort()).toEqual([...CHAOS.expect].sort());
    expect(Object.keys(profile.models)).toEqual(["claude-fable-5"]);
  });

  test("nothing about the work itself goes out with it", async () => {
    // This is the entire outbound exposure surface of the product. The prompt
    // is two parts: a static catalog of product copy, and the profile. Only
    // the profile is derived from the developer, so that is what has to be
    // airtight.
    const stub = await analyze(VALID);
    const prompt = stub.prompts()[0]!;
    expect(prompt).not.toContain(MARKER);
    expect(prompt).not.toContain("/toxic/");
    expect(prompt).not.toContain("api.ts");

    const profile = profileFrom(prompt);
    // No "/" anywhere means a path or a command could not be in here even in
    // principle — the structural version of the whitelist.
    expect(JSON.stringify(profile)).not.toContain("/");

    for (const value of strings(profile)) {
      const known = value in TIPS || /^[A-Za-z0-9.:_-]{1,64}$/.test(value);
      expect(known, `unexpected free text in the payload: ${value}`).toBe(true);
    }
  });
});

describe("the model's reply is untrusted input", () => {
  const queued = () => tips(w).find((t) => t.session_id === null);

  test("a good answer is queued as advice, not as session waste", async () => {
    await analyze(VALID);
    const tip = queued();
    expect(tip?.tip_id).toBe("clear-between-tasks");
    expect(tip?.why).toBe("you kept one session open all day");
    // Zero savings and no session: it is a judgement, not a measurement, so it
    // never inflates the numbers REMY reports.
    expect(tip?.est_savings_tokens).toBe(0);
  });

  test("a hallucinated tip id is refused", async () => {
    await analyze('{"tip_id":"stop-being-bad","why":"invented out of thin air"}');
    expect(queued()).toBeUndefined();
  });

  test("escape codes and newlines cannot reach the statusline", async () => {
    // A `why` is rendered into a single-line surface; a raw ESC would let the
    // model repaint the terminal.
    await analyze('{"tip_id":"clear-between-tasks","why":"red \\u001b[31m and \\n newline"}');
    const why = queued()?.why ?? "";
    expect(why).not.toContain("");
    expect(why).not.toContain("\n");
    expect(why).toContain("red");
  });

  test("an over-long explanation is refused rather than truncated", async () => {
    await analyze(`{"tip_id":"clear-between-tasks","why":"${"x".repeat(500)}"}`);
    expect(queued()).toBeUndefined();
  });

  test("a reply wrapped in a code fence is still understood", async () => {
    await analyze(['```json', VALID, '```'].join("\n"));
    expect(queued()?.tip_id).toBe("clear-between-tasks");
  });

  test("the claude CLI's own JSON envelope is unwrapped", async () => {
    await analyze(JSON.stringify({ type: "result", result: VALID }));
    expect(queued()?.tip_id).toBe("clear-between-tasks");
  });

  test("a tip already in the queue is not queued twice", async () => {
    await analyze('{"tip_id":"edit-thrash","why":"the rules already caught this one"}');
    expect(tips(w).filter((t) => t.tip_id === "edit-thrash").length).toBe(1);
    expect(queued()).toBeUndefined();
  });

  test("silence from the backend degrades to deterministic coaching", async () => {
    await analyze("");
    expect(queued()).toBeUndefined();
    // The session's own findings are untouched by the analyzer failing.
    expect(tips(w).length).toBe(CHAOS.expect.length);
  });

  test("prose instead of JSON changes nothing", async () => {
    await analyze("I think you should probably try using plan mode more often!");
    expect(queued()).toBeUndefined();
  });
});
