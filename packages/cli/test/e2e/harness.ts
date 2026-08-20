import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../core/src/store";
import {
  claudeMdBytesFor,
  seedSession,
  transcriptFor,
  type Scenario,
} from "../../../core/test/support/scenarios";
import { MARKER } from "../../../core/test/support/transcript-builder";

// The e2e tier: a throwaway machine per test, and the real `remy` CLI driven
// exactly the way Claude Code drives it — one process per hook, payload on
// stdin, everything it knows afterwards read back out of SQLite.
//
// index.ts runs its dispatch at import time, so spawning is not a workaround
// here; it is the contract under test. What a hook may print to stdout, that
// it always exits 0, and that a raw path never reaches disk are properties of
// the process, not of any function inside it.

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

export interface World {
  /** Where the fake $HOME, data dir and project live. */
  root: string;
  home: string;
  dataDir: string;
  /** The "project" the session runs in — outside any real CLAUDE.md tree. */
  cwd: string;
  settingsPath: string;
  env: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function makeWorld(extraEnv: Record<string, string> = {}): World {
  const root = mkdtempSync(join(tmpdir(), "remy-e2e-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const cwd = join(root, "project");
  for (const d of [home, dataDir, cwd]) mkdirSync(d, { recursive: true });
  const settingsPath = join(home, "settings.json");
  return {
    root,
    home,
    dataDir,
    cwd,
    settingsPath,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      REMY_HOME: home,
      REMY_DATA_DIR: dataDir,
      REMY_SETTINGS_PATH: settingsPath,
      // The analyzer forks a detached child on SessionEnd; suites that are not
      // about the analyzer must not race one.
      REMY_ADAPT: "0",
      REMY_NO_DOWNLOAD: "1",
      ...extraEnv,
    },
  };
}

export function destroyWorld(w: World): void {
  rmSync(w.root, { recursive: true, force: true });
}

export async function remy(w: World, args: string[], stdin?: unknown): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    env: w.env,
    cwd: w.cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

/** Fire one hook, the way the host does. */
export async function hook(
  w: World,
  event: string,
  extra: Record<string, unknown> = {},
  sessionId = "toxic-session",
): Promise<RunResult> {
  return remy(w, ["ingest"], {
    hook_event_name: event,
    session_id: sessionId,
    cwd: w.cwd,
    ...extra,
  });
}

/** The systemMessage a hook emitted, or null when it stayed quiet. */
export function systemMessage(r: RunResult): string | null {
  if (!r.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return typeof parsed?.systemMessage === "string" ? parsed.systemMessage : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ world setup

/** Write the scenario's project memory and transcript into the world. */
export function stage(w: World, s: Scenario, sessionId = "toxic-session"): string {
  const bytes = claudeMdBytesFor(s);
  if (bytes > 0) {
    // Content is irrelevant to the rules — only the byte count is ever read.
    writeFileSync(join(w.cwd, "CLAUDE.md"), "#".repeat(bytes));
  }
  const transcriptPath = join(w.root, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, transcriptFor(s));

  if (s.seed?.length) {
    const db = openDb(dbFile(w));
    s.seed.forEach((seed, i) => seedSession(db, `seed${i}`, seed));
    db.close();
  }
  return transcriptPath;
}

/** Drive a whole toxic session through the hooks, in order. Returns every
 * stdout the host would have seen. */
export async function driveSession(
  w: World,
  s: Scenario,
  sessionId = "toxic-session",
): Promise<{ outputs: RunResult[]; stop: RunResult; transcriptPath: string }> {
  const transcriptPath = stage(w, s, sessionId);
  const outputs: RunResult[] = [];

  outputs.push(await hook(w, "SessionStart", { source: "startup" }, sessionId));
  for (const h of s.hooks ?? []) {
    for (let i = 0; i < (h.repeat ?? 1); i++) {
      outputs.push(
        await hook(
          w,
          h.event,
          {
            ...(h.trigger ? { trigger: h.trigger } : {}),
            ...(h.toolName ? { tool_name: h.toolName, tool_input: { command: `x # ${MARKER}` } } : {}),
          },
          sessionId,
        ),
      );
    }
  }
  const stop = await hook(w, "Stop", { transcript_path: transcriptPath }, sessionId);
  outputs.push(stop);
  return { outputs, stop, transcriptPath };
}

// ------------------------------------------------------------- inspection

export function dbFile(w: World): string {
  return join(w.dataDir, "remy.db");
}

function read<T>(w: World, sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbFile(w), { readonly: true });
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

export interface TipRowLite {
  tip_id: string;
  status: string;
  est_savings_tokens: number;
  est_class: string | null;
  session_id: string | null;
  why: string | null;
  evidence: string;
}

export function tips(w: World): TipRowLite[] {
  // Ordered by WORTH, mirroring tips.ts — the raw count is not comparable
  // across price classes, and a harness that ranked differently from
  // production would quietly disagree with every assertion made through it.
  return read<TipRowLite>(
    w,
    `SELECT tip_id, status, est_savings_tokens, est_class, session_id, why, evidence
       FROM tips
      ORDER BY est_savings_tokens * (CASE est_class
                 WHEN 'cache-read' THEN 0.1
                 WHEN 'cold-write' THEN 1.9
                 ELSE 1 END) DESC, id ASC`,
  );
}

/** Tip ids REMY filed, dismissed ones excluded — what the session was told. */
export function tipIds(w: World): string[] {
  return tips(w)
    .filter((t) => t.status !== "dismissed")
    .map((t) => t.tip_id);
}

export function activeTipId(w: World): string | null {
  return tips(w).find((t) => t.status === "active")?.tip_id ?? null;
}

export function session(w: World, sessionId = "toxic-session"): Record<string, number> {
  return (
    read<Record<string, number>>(w, `SELECT * FROM sessions WHERE session_id = ?`, sessionId)[0] ?? {}
  );
}

export function logContents(w: World): string {
  try {
    return readFileSync(join(w.dataDir, "remy.log"), "utf8");
  } catch {
    return "";
  }
}

// --------------------------------------------------------------- privacy

/** Nothing REMY writes or prints may contain a path, a command, or any other
 * raw string from the session. Every fixture embeds MARKER precisely so this
 * one scan covers all of them at once.
 *
 * The -wal file is scanned too: pages live there before a checkpoint, so a
 * leak could sit on disk while the main database file looks clean. */
export function privacyLeaks(w: World, outputs: RunResult[] = []): string[] {
  const leaks: string[] = [];
  const forbidden = [MARKER, "/toxic/"];
  const blobs: Array<[string, string]> = [
    ["remy.log", logContents(w)],
    ["settings.json", tryRead(w.settingsPath)],
  ];
  for (const suffix of ["", "-wal", "-shm"]) {
    blobs.push([`remy.db${suffix}`, tryReadBinary(dbFile(w) + suffix)]);
  }
  outputs.forEach((o, i) => {
    blobs.push([`stdout[${i}]`, o.stdout]);
    blobs.push([`stderr[${i}]`, o.stderr]);
  });

  for (const [where, blob] of blobs) {
    for (const needle of forbidden) {
      if (blob.includes(needle)) leaks.push(`${where} contains ${JSON.stringify(needle)}`);
    }
  }
  return leaks;
}

function tryRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function tryReadBinary(path: string): string {
  try {
    return readFileSync(path).toString("latin1");
  } catch {
    return "";
  }
}

// --------------------------------------------------------- adaptive coach

export interface AdaptStub {
  /** Everything the backend was handed on stdin, one entry per invocation. */
  prompts(): string[];
  calls(): number;
}

/** Stand in for `claude -p`: capture the prompt, answer with `reply`. */
export function adaptStub(w: World, reply: string): AdaptStub {
  const script = join(w.root, "adapt-stub.sh");
  const promptDir = join(w.root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `n=$(ls ${JSON.stringify(promptDir)} | wc -l | tr -d ' ')`,
      `cat > ${JSON.stringify(promptDir)}/prompt-$n.txt`,
      `cat <<'REMY_STUB_EOF'`,
      reply,
      "REMY_STUB_EOF",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  w.env.REMY_ADAPT_CMD = `sh ${script}`;
  w.env.REMY_ADAPT = "1";

  const list = (): string[] => {
    const out: string[] = [];
    for (let i = 0; ; i++) {
      const body = tryRead(join(promptDir, `prompt-${i}.txt`));
      if (!body) break;
      out.push(body);
    }
    return out;
  };
  return { prompts: list, calls: () => list().length };
}

/** Strip ANSI colour and OSC-8 hyperlinks so rendered surfaces can be matched
 * as plain text. */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "");
}
