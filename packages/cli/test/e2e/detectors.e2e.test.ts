import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SCENARIOS } from "../../../core/test/support/scenarios";
import {
  activeTipId,
  destroyWorld,
  driveSession,
  makeWorld,
  privacyLeaks,
  session,
  systemMessage,
  tipIds,
  type World,
} from "./harness";

// The same toxic sessions as the fast tier, driven through the real CLI: a
// process per hook, JSON on stdin, findings read back out of SQLite. If a
// detector works in isolation but the pipeline never reaches it — a column
// left NULL, a hook that fires in the wrong order, a suppression applied at
// the wrong layer — this is the tier that notices.

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => destroyWorld(w));

describe("driving Claude Code badly, end to end", () => {
  for (const s of SCENARIOS) {
    test(`${s.name}: ${s.why}`, async () => {
      const { outputs } = await driveSession(w, s);

      expect(tipIds(w).sort()).toEqual([...s.expect].sort());
      for (const forbidden of s.forbid ?? []) expect(tipIds(w)).not.toContain(forbidden);

      // The noise budget holds no matter how much went wrong.
      const active = activeTipId(w);
      if (s.expect.length === 0) expect(active).toBeNull();
      else expect(s.expect).toContain(active!);

      // A hook that throws would take the host's turn down with it.
      for (const o of outputs) expect(o.code).toBe(0);
      expect(privacyLeaks(w, outputs)).toEqual([]);
    });
  }
});

describe("hooks that carry no coaching signal", () => {
  test("a permission denial is counted and never printed about", async () => {
    const s = SCENARIOS.find((x) => x.name.startsWith("permission denials"))!;
    const { outputs } = await driveSession(w, s);

    expect(session(w).perm_denials).toBe(3);
    // stdout on PermissionDenied is the host's retry channel — a coaching
    // tool writing there would be steering the approval flow.
    const denials = outputs.slice(1, 4);
    for (const d of denials) expect(d.stdout).toBe("");
  });

  test("failures reported only by hooks are counted but prove no retry loop", async () => {
    const s = SCENARIOS.find((x) => x.name.startsWith("tool failures"))!;
    await driveSession(w, s);

    expect(session(w).tool_fails).toBe(3);
    expect(session(w).tool_calls).toBe(3);
    expect(tipIds(w)).not.toContain("retry-loop");
  });
});

describe("what the developer actually sees at the end of a turn", () => {
  test("a bad session gets exactly one transient nudge", async () => {
    const chaos = SCENARIOS.find((s) => s.name.startsWith("chaos"))!;
    const { stop } = await driveSession(w, chaos);
    const message = systemMessage(stop);

    expect(message).toBeTruthy();
    expect(message).toContain("REMY");
    // The nudge is the active tip, not some other one from the queue.
    expect(message).toContain("🪙");
  });

  test("a well-driven session is never interrupted", async () => {
    const clean = SCENARIOS.find((s) => s.name === "clean: a well-driven session")!;
    const { stop } = await driveSession(w, clean);

    expect(stop.stdout).toBe("");
    expect(tipIds(w)).toEqual([]);
  });
});
