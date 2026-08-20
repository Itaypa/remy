import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { CHAOS, SCENARIOS } from "../../../core/test/support/scenarios";
import {
  activeTipId,
  destroyWorld,
  driveSession,
  hook,
  makeWorld,
  privacyLeaks,
  remy,
  stripAnsi,
  systemMessage,
  tips,
  type World,
} from "./harness";

// Catching waste is only half the job — the tip has to reach the developer.
// This drives one genuinely bad session and then checks every channel REMY
// speaks through, because each is wired differently: the statusline is a
// separate process reading a host payload, the nudge is a hook's stdout, the
// splash is SessionStart's, the spinner is a file the host reads later.

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => destroyWorld(w));

const statusPayload = (w: World, extra: Record<string, unknown> = {}) => ({
  session_id: "toxic-session",
  cwd: w.cwd,
  workspace: { current_dir: w.cwd },
  model: { id: "claude-fable-5", display_name: "Fable 5" },
  cost: { total_cost_usd: 1.23 },
  context_window: {
    total_input_tokens: 90_000,
    total_output_tokens: 5_000,
    context_window_size: 200_000,
  },
  ...extra,
});

describe("the surfaces a coached developer actually sees", () => {
  test("the statusline is a pure HUD — no tip, no version, however bad the session", async () => {
    await driveSession(w, CHAOS);
    expect(tips(w).length).toBe(5);

    const out = stripAnsi((await remy(w, ["statusline"], statusPayload(w))).stdout);
    expect(out).toContain("Fable 5");
    expect(out).toContain("ctx");
    expect(out).toContain("$1.23");
    // Tips live on the splash, the Stop nudge, and /remy — never here. The
    // version lives in `remy version` and the splash. Both were dropped from
    // the statusline as noise: it repaints every second, so anything static
    // on it is a permanent banner, not information.
    expect(out).not.toContain("tip");
    expect(out).not.toContain("v0.");
    // The cache clock is the one field that earns its second: it changes on its
    // own while nothing else does. It stays absent here because these fixture
    // transcripts carry no `cache_creation` breakdown, so no TTL was ever
    // observed — "we never show a number we can't derive", and a guessed hour
    // would tell the developer to keep a fat session open. Its full pipeline
    // (Stop parses the TTL → statusline renders it) is driven in
    // packages/cli/test/statusline.test.ts.
    expect(out).not.toContain("cache");
  });

  test("the Stop nudge is the active tip, verbatim", async () => {
    const thrash = SCENARIOS.find((s) => s.name === "edit-thrash")!;
    const { stop } = await driveSession(w, thrash);
    const active = tips(w).find((t) => t.status === "active")!;

    const { tipLine } = await import("../../src/ui");
    expect(systemMessage(stop)).toBe(tipLine(active as never));
  });

  test("an overflowing context outranks the coaching tip", async () => {
    // The chaos session ends at 83% full. A tip about last hour's habits can
    // wait; a window about to overflow cannot — and the developer must not
    // get both in one turn.
    const { stop } = await driveSession(w, CHAOS);
    const message = systemMessage(stop);

    expect(message).toContain("83%");
    expect(activeTipId(w)).toBe("context-band");
    // ...and the context tip does not then arrive as a second nag about the
    // same problem.
    expect(message).not.toContain("/compact at 60%");
  });

  test("the session report lists every finding, with the active one on top", async () => {
    await driveSession(w, CHAOS);

    const raw = JSON.parse((await remy(w, ["report", "--raw"])).stdout);
    expect(raw.tips.map((t: { tip_id: string }) => t.tip_id).sort()).toEqual(
      [...CHAOS.expect].sort(),
    );
    expect(raw.active.tip_id).toBe(activeTipId(w));

    const rendered = stripAnsi((await remy(w, ["report"])).stdout);
    expect(rendered).toContain("REMY · session report");
    expect(rendered).toContain("🪙");
  });

  test("the splash greets a returning session with its worst habit", async () => {
    await driveSession(w, CHAOS);
    // A second session start is where the splash reports the standing tip.
    const start = await hook(w, "SessionStart", { source: "startup" }, "next-session");
    const message = stripAnsi(systemMessage(start) ?? "");

    expect(message).toContain("REMY");
    expect(message).toContain("/remy");
  });

  test("the spinner line carries the queue once the user opts in", async () => {
    await driveSession(w, CHAOS);
    writeFileSync(w.settingsPath, JSON.stringify({}));

    await remy(w, ["spinner"]);
    const settings = JSON.parse(readFileSync(w.settingsPath, "utf8"));
    expect(settings.spinnerTipsOverride.excludeDefault).toBe(true);
    expect(settings.spinnerTipsOverride.tips.length).toBeGreaterThan(0);

    await remy(w, ["spinner", "--off"]);
    const after = JSON.parse(readFileSync(w.settingsPath, "utf8"));
    expect(after.spinnerTipsOverride).toBeUndefined();
  });

  test("nothing rendered anywhere leaks a path or a command", async () => {
    const { outputs } = await driveSession(w, CHAOS);
    const rendered = [
      await remy(w, ["statusline"], statusPayload(w)),
      await remy(w, ["report"]),
      await remy(w, ["report", "--raw"]),
      await remy(w, ["report", "--week"]),
    ];
    expect(privacyLeaks(w, [...outputs, ...rendered])).toEqual([]);
  });
});

describe("the privacy scan itself", () => {
  test("a planted secret is caught — the scan is not vacuously green", async () => {
    // Without this, a broken scanner would report "no leaks" on every test
    // above and nobody would know.
    await driveSession(w, CHAOS);
    expect(privacyLeaks(w)).toEqual([]);

    const { MARKER } = await import("../../../core/test/support/transcript-builder");
    writeFileSync(`${w.dataDir}/remy.log`, `pretend a stack trace leaked ${MARKER}\n`);
    expect(privacyLeaks(w)).toContain(`remy.log contains ${JSON.stringify(MARKER)}`);
  });
});
