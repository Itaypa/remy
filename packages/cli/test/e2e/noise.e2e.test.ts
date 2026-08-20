import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHAOS, SCENARIOS } from "../../../core/test/support/scenarios";
import {
  activeTipId,
  destroyWorld,
  driveSession,
  hook,
  makeWorld,
  remy,
  systemMessage,
  tips,
  type World,
} from "./harness";

// The noise budget is the product. A coach that catches everything and says so
// every turn is worse than no coach, so these tests are about REMY keeping its
// mouth shut: once per throttle window, once per problem, and never again
// about something you snoozed.
//
// Note the throttle env knobs take "1" (one millisecond) rather than "0" —
// the reader is `Number(x) || default`, so a zero falls back to the default.

const THRASH = SCENARIOS.find((s) => s.name === "edit-thrash")!;

let w: World;
afterEach(() => destroyWorld(w));

describe("the Stop nudge throttle", () => {
  beforeEach(() => {
    w = makeWorld();
  });

  test("the same tip is not repeated on the very next turn", async () => {
    const { stop, transcriptPath } = await driveSession(w, THRASH);
    expect(systemMessage(stop)).toBeTruthy();

    const second = await hook(w, "Stop", { transcript_path: transcriptPath });
    expect(second.stdout).toBe("");
    // The tip is still there to be found — it just isn't shouted twice.
    expect(activeTipId(w)).toBe("edit-thrash");
  });

  test("once the window passes, the tip is due again", async () => {
    w = makeWorld({ REMY_STOP_NUDGE_THROTTLE_MS: "1" });
    const { stop, transcriptPath } = await driveSession(w, THRASH);
    expect(systemMessage(stop)).toBeTruthy();

    const second = await hook(w, "Stop", { transcript_path: transcriptPath });
    expect(systemMessage(second)).toBeTruthy();
  });
});

describe("the context alarm outranks and silences everything else", () => {
  beforeEach(() => {
    w = makeWorld();
  });

  test("an alarming session gets the alarm once, then silence", async () => {
    const { stop, transcriptPath } = await driveSession(w, CHAOS);
    expect(systemMessage(stop)).toContain("83%");

    // Second turn: the alarm is throttled, and the context tip must not slip
    // into the gap — that would be a second nag about the same problem.
    const second = await hook(w, "Stop", { transcript_path: transcriptPath });
    expect(second.stdout).toBe("");
    expect(activeTipId(w)).toBe("context-band");
  });

  test("with the alarm window elapsed it fires again, still without the tip", async () => {
    w = makeWorld({ REMY_CTX_ALARM_THROTTLE_MS: "1", REMY_STOP_NUDGE_THROTTLE_MS: "1" });
    const { transcriptPath } = await driveSession(w, CHAOS);

    const second = await hook(w, "Stop", { transcript_path: transcriptPath });
    // Still the live alarm ("act now"), never the habit tip ("you should have
    // compacted at 60%") — both are branded, so tell them apart by their text.
    expect(systemMessage(second)).toContain("83%");
    expect(systemMessage(second)).not.toContain("/compact at 60%");
  });
});

describe("dismissing a tip", () => {
  beforeEach(() => {
    w = makeWorld();
  });

  test("snoozing promotes the next-best tip and never re-files the old one", async () => {
    const { transcriptPath } = await driveSession(w, CHAOS);
    expect(activeTipId(w)).toBe("context-band");

    const dismissed = await remy(w, ["dismiss"]);
    expect(dismissed.code).toBe(0);
    expect(activeTipId(w)).toBe("edit-thrash");

    // The same toxic session, analysed again: the snoozed tip stays snoozed
    // rather than coming straight back as a "new" finding.
    await hook(w, "Stop", { transcript_path: transcriptPath });
    const contextBand = tips(w).filter((t) => t.tip_id === "context-band");
    expect(contextBand.length).toBe(1);
    expect(contextBand[0]!.status).toBe("dismissed");
    expect(activeTipId(w)).toBe("edit-thrash");
  });
});

describe("one voice per turn", () => {
  beforeEach(() => {
    w = makeWorld({ REMY_STOP_NUDGE_THROTTLE_MS: "1", REMY_CTX_ALARM_THROTTLE_MS: "1" });
  });

  test("no Stop ever emits two messages, across every scenario", async () => {
    for (const s of [CHAOS, THRASH, SCENARIOS.find((x) => x.name === "cache-idle")!]) {
      const world = makeWorld({ REMY_STOP_NUDGE_THROTTLE_MS: "1" });
      try {
        const { stop } = await driveSession(world, s);
        if (!stop.stdout.trim()) continue;
        // Exactly one JSON object, carrying exactly one systemMessage.
        expect(stop.stdout.trim().split("\n").length).toBe(1);
        const parsed = JSON.parse(stop.stdout);
        expect(Object.keys(parsed)).toEqual(["systemMessage"]);
      } finally {
        destroyWorld(world);
      }
    }
  });
});
