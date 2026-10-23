import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `remy analytics` is the user's switch for the launcher's daily ping. The
// ping itself is tested with the launcher (launcher.test.ts); what matters
// here is that the switch lands exactly where the launcher looks —
// $REMY_HOME/analytics-off — and that status tells the truth about both the
// marker and the env kill switch.
//
// Full-process tests: index.ts runs its CLI dispatch at import time.

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "remy-analytics-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function remy(args: string[], extra: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      REMY_HOME: home,
      REMY_DATA_DIR: home,
      REMY_SETTINGS_PATH: join(home, "settings.json"),
      ...extra,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe("remy analytics", () => {
  const marker = () => join(home, "analytics-off");

  test("--off writes the marker the launcher checks; --on removes it", async () => {
    expect(await remy(["analytics"])).toMatch(/daily ping: on\b/);
    expect(await remy(["analytics", "--off"])).toContain("OFF");
    expect(existsSync(marker())).toBe(true);
    expect(await remy(["analytics"])).toMatch(/daily ping: off\b/);
    expect(await remy(["analytics", "--on"])).toContain("ON");
    expect(existsSync(marker())).toBe(false);
    expect(await remy(["analytics"])).toMatch(/daily ping: on\b/);
  });

  test("the env kill switch reads as off without touching the disk", async () => {
    expect(await remy(["analytics"], { REMY_ANALYTICS: "0" })).toMatch(/daily ping: off\b/);
    expect(await remy(["analytics"], { REMY_ANALYTICS: "false" })).toMatch(/daily ping: off\b/);
    expect(existsSync(marker())).toBe(false);
  });

  test("the command is listed in help, next to the other switches", async () => {
    const help = await remy(["help"]);
    expect(help).toContain("analytics");
    expect(help).toContain("--off");
  });
});
