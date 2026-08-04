import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launcher (packages/plugin-claude-code/bin/remy) is what every hook
// actually invokes, so its failure modes matter more than its happy path: a
// missing binary, an unknown platform or a dead network must all end in a
// silent exit 0, never a broken session.

const LAUNCHER = join(import.meta.dir, "..", "..", "plugin-claude-code", "bin", "remy");
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "remy-launcher-"));
  mkdirSync(join(home, "bin"), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([LAUNCHER, "report", "--week"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, REMY_HOME: home, REMY_VERSION: "9.9.9", ...env },
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

function installFakeBinary(): string {
  const path = join(home, "bin", `remy-9.9.9-${TARGET}`);
  writeFileSync(path, '#!/bin/sh\necho "ran: $*"\n');
  chmodSync(path, 0o755);
  return path;
}

describe("plugin launcher", () => {
  test("execs the installed binary and forwards its arguments", async () => {
    installFakeBinary();
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out.trim()).toBe("ran: report --week");
  });

  test("points `current` at the binary that ran, so the statusline survives upgrades", async () => {
    const path = installFakeBinary();
    await run();
    expect(await Bun.file(join(home, "bin", "current")).text()).toBe(await Bun.file(path).text());
  });

  test("a missing binary exits 0 in silence instead of erroring into the session", async () => {
    const { code, out } = await run({ REMY_NO_DOWNLOAD: "1" });
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("is valid POSIX sh", async () => {
    const proc = Bun.spawn(["sh", "-n", LAUNCHER], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});
