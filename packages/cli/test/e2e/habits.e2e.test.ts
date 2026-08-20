import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TranscriptBuilder } from "../../../core/test/support/transcript-builder";
import { destroyWorld, hook, makeWorld, tipIds, type World } from "./harness";

// Some waste is only visible across sessions: no single "what's the git log
// syntax again?" on the top-tier model is wrong, but four of them in a week is
// a habit worth naming. Those rules run once per session, on SessionEnd — so
// unlike everything else in this suite they need whole sessions, in sequence,
// rather than one transcript.

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => destroyWorld(w));

/** One short question-and-answer session: a couple of turns, no tools, small
 * reply. Trivial by every measure the habit rule uses. */
async function trivialSession(w: World, id: string, model: string): Promise<void> {
  const t = new TranscriptBuilder().useModel(model);
  t.turn({ usage: { input_tokens: 800, output_tokens: 200 } });
  const path = join(w.root, `${id}.jsonl`);
  writeFileSync(path, t.jsonl());

  await hook(w, "SessionStart", { source: "startup" }, id);
  await hook(w, "Stop", { transcript_path: path }, id);
  await hook(w, "SessionEnd", { transcript_path: path }, id);
}

describe("model-fit — a run of trivial questions on the expensive model", () => {
  test("three quick opus sessions is not yet a pattern", async () => {
    for (const i of [1, 2, 3]) await trivialSession(w, `opus-${i}`, "claude-opus-5");
    expect(tipIds(w)).not.toContain("model-fit");
  });

  test("the fourth one names the habit", async () => {
    for (const i of [1, 2, 3, 4]) await trivialSession(w, `opus-${i}`, "claude-opus-5");
    expect(tipIds(w)).toContain("model-fit");
  });

  test("the same four sessions on a cheaper model say nothing", async () => {
    for (const i of [1, 2, 3, 4]) await trivialSession(w, `sonnet-${i}`, "claude-sonnet-5");
    expect(tipIds(w)).toEqual([]);
  });

  test("the habit tip is filed by SessionEnd, not by Stop", async () => {
    // Stop is the per-turn path and runs constantly; cross-session analysis
    // belongs at the end of a session, once.
    for (const i of [1, 2, 3] as const) await trivialSession(w, `opus-${i}`, "claude-opus-5");

    const path = join(w.root, "opus-4.jsonl");
    writeFileSync(
      path,
      new TranscriptBuilder()
        .useModel("claude-opus-5")
        .turn({ usage: { input_tokens: 800, output_tokens: 200 } })
        .jsonl(),
    );
    await hook(w, "SessionStart", { source: "startup" }, "opus-4");
    await hook(w, "Stop", { transcript_path: path }, "opus-4");
    expect(tipIds(w)).not.toContain("model-fit");

    await hook(w, "SessionEnd", { transcript_path: path }, "opus-4");
    expect(tipIds(w)).toContain("model-fit");
  });
});
