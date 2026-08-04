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

  // Windows and anything exotic land here. The launcher must decline quietly:
  // a hook that errors on an unsupported platform turns "no coaching" into
  // "broken session", which is the thing this file exists to prevent.
  //
  // Two cases, one per axis, and that split is the point. Reporting BOTH the
  // OS and the arch as unsupported tests neither arm: whichever check runs
  // first exits, masking a broken second one. Each case below leaves the other
  // axis valid so exactly one guard is under test.
  //
  // Exit code and silence alone also don't discriminate — a launcher that
  // ignored the platform and carried on would exit 0 silently too, since no
  // binary exists for the bogus target. So each case plants a binary at the
  // target it WOULD fall through to. Correct behaviour never computes that
  // name; the failure announces itself.
  function shimUname(osOut: string, archOut: string): string {
    const shimDir = join(home, "shim");
    mkdirSync(shimDir, { recursive: true });
    const uname = join(shimDir, "uname");
    writeFileSync(uname, `#!/bin/sh\ncase "$1" in\n  -s) echo ${osOut} ;;\n  -m) echo ${archOut} ;;\n  *) echo ${osOut} ;;\nesac\n`);
    chmodSync(uname, 0o755);
    return `${shimDir}:${process.env.PATH ?? ""}`;
  }

  function plantTrap(target: string): void {
    const trap = join(home, "bin", `remy-9.9.9-${target}`);
    writeFileSync(trap, '#!/bin/sh\necho "SHOULD NOT HAVE RUN"\n');
    chmodSync(trap, 0o755);
  }

  test("an unsupported OS exits 0 without running anything", async () => {
    const PATH = shimUname("Windows_NT", "arm64"); // arch is fine; only the OS is not
    plantTrap("linux-arm64");
    const { code, out } = await run({ PATH });
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(await Bun.file(join(home, "bin", "current")).exists()).toBe(false);
  });

  test("an unsupported architecture exits 0 without running anything", async () => {
    const PATH = shimUname("Darwin", "ia64"); // OS is fine; only the arch is not
    plantTrap("darwin-x64");
    const { code, out } = await run({ PATH });
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(await Bun.file(join(home, "bin", "current")).exists()).toBe(false);
  });

  test("is valid POSIX sh", async () => {
    const proc = Bun.spawn(["sh", "-n", LAUNCHER], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});

// The dev-build badge is decided by the baked-in channel, not by where the
// binary sits on disk. An earlier version tested `process.execPath` against
// ".claude/plugins" — but the plugin ships a launcher and the real binary
// always lives in ~/.remy/bin, so that test was false for EVERY install and
// every real user saw a dev badge. Compile both channels and check the
// rendered statusline, since that is the only place the badge appears.
describe("dev-build badge — channel decides, not the binary's location", () => {
  const PAYLOAD = JSON.stringify({
    session_id: "badge",
    workspace: { current_dir: "/tmp" },
    model: { id: "claude-opus-5", display_name: "Opus 5" },
  });

  async function statuslineFor(channel: string): Promise<string> {
    const out = join(home, `remy-${channel}`);
    const build = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "..", "..", "scripts", "build-plugin.ts"),
        "--target",
        TARGET,
        "--channel",
        channel,
        "--out",
        out,
      ],
      { stdout: "ignore", stderr: "pipe", env: { ...process.env, REMY_HOME: home } },
    );
    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
    const proc = Bun.spawn([out, "statusline"], {
      stdin: Buffer.from(PAYLOAD),
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", HOME: home, REMY_HOME: home, REMY_DATA_DIR: home },
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  }

  test("a release build shows no ⚙ badge; a dev build does", async () => {
    expect(await statuslineFor("release")).not.toContain("⚙");
    expect(await statuslineFor("dev")).toContain("⚙");
  }, 120_000);
});
