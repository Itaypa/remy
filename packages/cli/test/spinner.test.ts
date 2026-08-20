import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, HINTS, openDb, setSyncState, type TipRow } from "@ccpp/core";
import { claimSpinnerTips, clearSpinnerTips, desiredTips, syncSpinnerTips } from "../src/spinner";

// The spinner tip line is written into the user's real settings.json, so
// these tests care as much about what remy REFUSES to touch as about
// what it writes.

let dir: string;
let settings: string;
let db: Database;

const TIP: TipRow = {
  id: 1,
  tip_id: "no-verify",
  session_id: "s1",
  created_at: "2026-08-04T10:00:00.000Z",
  status: "active",
  evidence: JSON.stringify({
    edits: 9,
    files: 3,
    bash_calls: 4,
    scope: "3 files",
    shell: "4 shell runs",
    bash_mix: "3 git, 1 file read",
  }),
  // Genuinely zero: skipping a verify pass ships bugs, it does not spend
  // tokens. The fixture used to carry a flat 10,000 that matched the rule's
  // old hardcoded constant, so the deck rendered a price for a finding that
  // has none — which is what the `worth` assertion below now pins.
  est_savings_tokens: 0,
  est_class: "input",
  why: null,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remy-spinner-"));
  settings = join(dir, "settings.json");
  process.env.REMY_SETTINGS_PATH = settings;
  // REMY_DATA_DIR matters even though these tests pass an explicit DB path:
  // writeOverride() calls logError() on malformed settings, and logError
  // resolves dataDir() itself — so without this the suite appends its own
  // stack traces to the developer's REAL ~/.remy/remy.log. It did, for a
  // while: dozens of "[spinner] SyntaxError" lines from the deliberately
  // malformed fixture below, sitting in a live log next to genuine errors.
  process.env.REMY_DATA_DIR = dir;
  process.env.REMY_HOME = dir;
  delete process.env.REMY_SPINNER;
  db = openDb(join(dir, "remy.db"));
});

afterEach(() => {
  db.close();
  delete process.env.REMY_SETTINGS_PATH;
  delete process.env.REMY_DATA_DIR;
  delete process.env.REMY_HOME;
  delete process.env.REMY_SPINNER;
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(settings, "utf8"));

describe("spinner tip override", () => {
  test("hooks never claim the line on their own — `remy spinner` does", () => {
    // Silently editing a user's global settings is the one thing this
    // surface must not do; until it's claimed, every hook is a no-op.
    expect(syncSpinnerTips(db, [TIP]).status).toBe("unclaimed");
    expect(() => readFileSync(settings, "utf8")).toThrow();
    expect(claimSpinnerTips(db, [TIP]).status).toBe("written");
    // Once claimed, hooks keep it current.
    expect(syncSpinnerTips(db, []).status).toBe("written");
    expect(read().spinnerTipsOverride.tips).toEqual(HINTS);
  });

  test("a hand-deleted key is a valid uninstall — remy doesn't re-take it", () => {
    claimSpinnerTips(db, [TIP]);
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "x" } }));
    expect(syncSpinnerTips(db, [TIP]).status).toBe("unclaimed");
    expect(read().spinnerTipsOverride).toBeUndefined();
  });

  test("the whole open queue rides the deck, so it moves on without a dismiss", () => {
    const second: TipRow = {
      ...TIP,
      id: 2,
      tip_id: "reread-churn",
      evidence: JSON.stringify({
        files: 8,
        worst: 12,
        more: "and 7 other files went the same way",
        file_hash: "0123456789abcdef",
      }),
      est_savings_tokens: 18_000,
    };
    claimSpinnerTips(db, [TIP, second]);
    const tips = read().spinnerTipsOverride.tips;
    // Two entries → the host rotates between them across waits; one entry
    // would have parked on the first finding until it was dismissed.
    expect(tips).toHaveLength(2);
    expect(tips[1]).toContain("got read 12× this session");
  });

  test("an unresolvable file hash degrades to the catalog's wording, never a placeholder", () => {
    // The whole filename mechanism is best-effort by design: a hash only
    // resolves for someone with that file on disk. Every other case — another
    // project, a deleted file, a repo too big to walk — must land on the
    // fallback rather than printing "{file}" at a developer.
    const orphan: TipRow = {
      ...TIP,
      id: 3,
      tip_id: "edit-thrash",
      evidence: JSON.stringify({ files: 1, edits: 14, rereads: 19, next: 15, file_hash: "deadbeefdeadbeef" }),
      est_savings_tokens: 55_000,
    };
    claimSpinnerTips(db, [orphan]);
    const line = read().spinnerTipsOverride.tips[0];
    expect(line).not.toMatch(/\{\w+\}/);
    expect(line).toContain("one file took 14 edits with 19 re-reads between them");

    // …and resolves to the real name when the map has it.
    expect(
      desiredTips([orphan], { files: new Map([["deadbeefdeadbeef", "packages/cli/src/index.ts"]]) })[0],
    ).toContain("packages/cli/src/index.ts took 14 edits with 19 re-reads between them");
  });

  test("the line speaks the session's own evidence, not the statusline shorthand", () => {
    claimSpinnerTips(db, [TIP]);
    const line = read().spinnerTipsOverride.tips[0];
    // The three parts: evidence the developer recognizes, the thing to do,
    // and what it is worth — which here is not tokens, and says so.
    expect(line).toContain("9 edits across 3 files; of 4 shell runs (3 git, 1 file read), not one was a test or build");
    expect(line).toContain("→ end with a check it can run");
    expect(line).toContain("→ worth: fewer bugs, not fewer tokens");
    expect(line).not.toContain("🪙");
    expect(line).toContain(BRAND);
  });

  test("an active tip takes the whole line — one entry, defaults excluded", () => {
    const out = claimSpinnerTips(db, [TIP]);
    expect(out.status).toBe("written");
    const written = read().spinnerTipsOverride;
    // One entry is the point: the host shows the least-recently-seen tip, so
    // a single-element deck means our line every single wait.
    expect(written.tips).toHaveLength(1);
    expect(written.excludeDefault).toBe(true);
    expect(written.tips[0]).toContain(BRAND);
    expect(written.tips[0]).toContain("9 edits");
  });

  test("no active tip → the hint deck, and the host rotates it", () => {
    claimSpinnerTips(db, []);
    expect(read().spinnerTipsOverride.tips).toEqual(HINTS);
    expect(desiredTips([])).toHaveLength(HINTS.length);
  });

  test("other settings survive the write, and the file stays valid JSON", () => {
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "remy statusline" } }));
    claimSpinnerTips(db, [TIP]);
    expect(read().statusLine.command).toBe("remy statusline");
  });

  test("re-running with the same tip doesn't rewrite the file", () => {
    claimSpinnerTips(db, [TIP]);
    const before = readFileSync(settings, "utf8");
    expect(syncSpinnerTips(db, [TIP]).status).toBe("unchanged");
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  test("an override remy didn't write is the user's — left untouched", () => {
    writeFileSync(settings, JSON.stringify({ spinnerTipsOverride: { tips: ["mine, not yours"] } }));
    expect(claimSpinnerTips(db, [TIP]).status).toBe("user-owned");
    expect(read().spinnerTipsOverride.tips).toEqual(["mine, not yours"]);
  });

  test("a user edit AFTER remy wrote is still the user's", () => {
    claimSpinnerTips(db, [TIP]);
    const edited = { ...read(), spinnerTipsOverride: { excludeDefault: true, tips: ["hand-edited"] } };
    writeFileSync(settings, JSON.stringify(edited));
    expect(syncSpinnerTips(db, []).status).toBe("user-owned");
    expect(read().spinnerTipsOverride.tips).toEqual(["hand-edited"]);
  });

  test("a corrupt ownership record makes it back off, not overwrite", () => {
    // The ownership check compares what's in settings.json against what we
    // recorded writing. If that record is unreadable we cannot prove the line
    // is ours — and the safe reading of "cannot prove" is "it's theirs".
    // Guessing the other way overwrites something a user typed by hand.
    claimSpinnerTips(db, [TIP]);
    setSyncState(db, "spinner_tips_written", "{ not json");
    expect(syncSpinnerTips(db, []).status).toBe("user-owned");
    expect(read().spinnerTipsOverride.tips.length).toBeGreaterThan(0);
  });

  test("an ownership record of the wrong shape is treated the same way", () => {
    claimSpinnerTips(db, [TIP]);
    setSyncState(db, "spinner_tips_written", '"a string, not an array"');
    expect(syncSpinnerTips(db, []).status).toBe("user-owned");
  });

  test("malformed settings are never clobbered", () => {
    writeFileSync(settings, "{ not json ");
    expect(claimSpinnerTips(db, [TIP]).status).toBe("unreadable");
    expect(readFileSync(settings, "utf8")).toBe("{ not json ");
  });

  test("the error it logs goes to the test's data dir, not the developer's real one", () => {
    // The test above deliberately triggers logError(). logError resolves
    // dataDir() on its own rather than taking a path, so an unset
    // REMY_DATA_DIR sends these stack traces into the live ~/.remy/remy.log —
    // polluting real diagnostics with test noise, which is exactly how a real
    // failure gets missed in the scroll.
    writeFileSync(settings, "{ still not json ");
    expect(claimSpinnerTips(db, [TIP]).status).toBe("unreadable");
    const log = join(dir, "remy.log");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("[spinner]");
  });

  test("REMY_SPINNER=0 writes nothing at all", () => {
    process.env.REMY_SPINNER = "0";
    expect(claimSpinnerTips(db, [TIP]).status).toBe("disabled");
    expect(() => readFileSync(settings, "utf8")).toThrow();
  });

  test("--off drops only our key, and only when it's ours", () => {
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "x" } }));
    claimSpinnerTips(db, [TIP]);
    expect(clearSpinnerTips(db).status).toBe("cleared");
    const after = read();
    expect(after.spinnerTipsOverride).toBeUndefined();
    expect(after.statusLine.command).toBe("x");

    writeFileSync(settings, JSON.stringify({ spinnerTipsOverride: { tips: ["theirs"] } }));
    expect(clearSpinnerTips(db).status).toBe("user-owned");
    expect(read().spinnerTipsOverride.tips).toEqual(["theirs"]);
  });
});
