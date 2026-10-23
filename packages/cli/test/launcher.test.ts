import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// The daily ping is the only thing REMY ever sends anywhere, and it is sent
// from the launcher, not the binary: a GET for a one-byte asset on this
// version's release, once per machine per UTC day, carrying nothing. These pin
// the properties that make it defensible — at most once a day, off when asked,
// never for a dev build, and a request that names only the release URL.
describe("the daily ping", () => {
  const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const PING_URL = `https://github.com/Itaypa/remy/releases/download/v9.9.9/ping-${TARGET}`;
  const RAN = "ran: report --week";

  /** A `curl` on PATH that records its argv instead of touching the network. */
  function shimCurl(): string {
    const shimDir = join(home, "shim");
    mkdirSync(shimDir, { recursive: true });
    const curl = join(shimDir, "curl");
    writeFileSync(curl, `#!/bin/sh\necho "$*" >> "${join(home, "curl.log")}"\n`);
    chmodSync(curl, 0o755);
    return `${shimDir}:${process.env.PATH ?? ""}`;
  }

  /** The request is detached from the hook, so give it a moment to land. */
  async function curlCalls(): Promise<string[]> {
    const log = join(home, "curl.log");
    for (let i = 0; i < 40 && !existsSync(log); i++) await Bun.sleep(50);
    try {
      return (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  test("pings this version's release once, then never again that day", async () => {
    installFakeBinary();
    const PATH = shimCurl();
    const first = await run({ PATH });
    expect(first.out.trim()).toBe(RAN); // the hook itself still ran, unhindered
    await run({ PATH });
    await run({ PATH });
    const calls = await curlCalls();
    expect(calls).toEqual([`-fsSL --max-time 20 -o /dev/null ${PING_URL}`]);
    expect(existsSync(join(home, "bin", `.ping-${DAY}`))).toBe(true);
  });

  test("a new day replaces yesterday's stamp instead of piling them up", async () => {
    installFakeBinary();
    mkdirSync(join(home, "bin", ".ping-20200101"));
    await run({ PATH: shimCurl() });
    await curlCalls();
    expect(existsSync(join(home, "bin", ".ping-20200101"))).toBe(false);
    expect(existsSync(join(home, "bin", `.ping-${DAY}`))).toBe(true);
  });

  const silent: Array<[string, Record<string, string>, () => void]> = [
    ["REMY_ANALYTICS=0", { REMY_ANALYTICS: "0" }, () => {}],
    ["REMY_ANALYTICS=false", { REMY_ANALYTICS: "false" }, () => {}],
    ["the `remy analytics --off` marker", {}, () => writeFileSync(join(home, "analytics-off"), "")],
  ];
  for (const [why, env, setup] of silent) {
    test(`stays silent with ${why} — and still runs the binary`, async () => {
      installFakeBinary();
      setup();
      const { out } = await run({ PATH: shimCurl(), ...env });
      expect(out.trim()).toBe(RAN);
      await Bun.sleep(200);
      expect(existsSync(join(home, "curl.log"))).toBe(false);
      expect(existsSync(join(home, "bin", `.ping-${DAY}`))).toBe(false);
    });
  }

  test("a dev build never pings — there is no release to count it against", async () => {
    const path = join(home, "bin", `remy-dev-${TARGET}`);
    writeFileSync(path, '#!/bin/sh\necho "ran: $*"\n');
    chmodSync(path, 0o755);
    const { out } = await run({ PATH: shimCurl(), REMY_VERSION: "dev" });
    expect(out.trim()).toBe(RAN);
    await Bun.sleep(200);
    expect(existsSync(join(home, "curl.log"))).toBe(false);
  });

  test("no binary, no ping — a half-installed plugin counts nobody", async () => {
    const { code } = await run({ PATH: shimCurl(), REMY_NO_DOWNLOAD: "1" });
    expect(code).toBe(0);
    await Bun.sleep(200);
    expect(existsSync(join(home, "curl.log"))).toBe(false);
  });
});

// The ⚙ dev-build badge is gone: the statusline is a pure HUD, and the
// version lives in `remy version` and the splash instead. This compiles both
// channels and checks the rendered statusline anyway, because the badge has
// come back once before (via an execPath test that was wrong for every real
// install) — a compiled-binary check is the only thing that would notice.
describe("no build badge — the statusline is channel-blind", () => {
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

  test("neither a release build nor a dev build shows a ⚙ badge", async () => {
    expect(await statuslineFor("release")).not.toContain("⚙");
    expect(await statuslineFor("dev")).not.toContain("⚙");
  }, 120_000);
});
