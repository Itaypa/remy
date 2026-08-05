import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSubagentStats } from "../src/subagents";
import { openDb, upsertSession, setSubagentStats, getSession } from "../src/store";
import type { Database } from "bun:sqlite";

/** The host's layout: the main transcript, and the workers in a directory
 * named for the session beside it. */
function scratch(sessionId: string): { transcript: string; agentsDir: string; root: string } {
  const root = join(tmpdir(), `remy-sub-${Math.random().toString(36).slice(2)}`);
  const agentsDir = join(root, sessionId, "subagents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(root, `${sessionId}.jsonl`), "");
  return { transcript: join(root, `${sessionId}.jsonl`), agentsDir, root };
}

function agentLine(opts: { id: string; model?: string; out?: number; in?: number; cw?: number; tools?: number }): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: {
      id: opts.id,
      model: opts.model ?? "claude-opus-5",
      usage: {
        input_tokens: opts.in ?? 0,
        output_tokens: opts.out ?? 0,
        cache_creation_input_tokens: opts.cw ?? 0,
      },
      content: Array.from({ length: opts.tools ?? 0 }, () => ({ type: "tool_use", name: "Read" })),
    },
  });
}

describe("subagent spend", () => {
  test("sums every worker's usage and counts their tool calls", () => {
    const s = scratch("sess-1");
    try {
      writeFileSync(
        join(s.agentsDir, "agent-aaa.jsonl"),
        [agentLine({ id: "m1", out: 1_000, cw: 20_000, tools: 3 }), agentLine({ id: "m2", out: 500, tools: 1 })].join("\n"),
      );
      writeFileSync(join(s.agentsDir, "agent-bbb.jsonl"), agentLine({ id: "m3", out: 200, in: 7, cw: 5_000, tools: 2 }));
      const stats = readSubagentStats(s.transcript, "sess-1")!;
      expect(stats.agents).toBe(2);
      expect(stats.tokensOut).toBe(1_700);
      expect(stats.tokensIn).toBe(7);
      expect(stats.cacheWrite).toBe(25_000);
      expect(stats.tools).toBe(6);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("a repeated message id counts once — streaming rewrites the same turn", () => {
    // Same rule the main parser uses: a streamed message is written repeatedly
    // with growing usage, and summing every copy would multiply the spend.
    const s = scratch("sess-2");
    try {
      writeFileSync(
        join(s.agentsDir, "agent-aaa.jsonl"),
        [agentLine({ id: "same", out: 100 }), agentLine({ id: "same", out: 900 })].join("\n"),
      );
      expect(readSubagentStats(s.transcript, "sess-2")!.tokensOut).toBe(900);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("the worker tier is the one that produced the most output", () => {
    const s = scratch("sess-3");
    try {
      writeFileSync(join(s.agentsDir, "agent-aaa.jsonl"), agentLine({ id: "m1", model: "claude-haiku-4-5", out: 50 }));
      writeFileSync(join(s.agentsDir, "agent-bbb.jsonl"), agentLine({ id: "m2", model: "claude-opus-5", out: 9_000 }));
      expect(readSubagentStats(s.transcript, "sess-3")!.topModel).toBe("claude-opus-5");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("no subagents directory is null, an empty one is zero — they mean different things", () => {
    // Null is every pre-existing row and every older host. Reading it as zero
    // would assert the user delegated nothing, which we never established.
    expect(readSubagentStats(join(tmpdir(), "remy-nope", "x.jsonl"), "sess-4")).toBeNull();

    const s = scratch("sess-5");
    try {
      const stats = readSubagentStats(s.transcript, "sess-5")!;
      expect(stats).not.toBeNull();
      expect(stats.agents).toBe(0);
      expect(stats.topModel).toBeNull();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("ignores the .meta.json sidecar entirely — it carries the task prompt", () => {
    // The sidecar holds `description`, which is free text. The guarantee here
    // is that the file is never opened at all, so a prompt cannot leak through
    // a parsing mistake. Asserted by planting a marker in it.
    const s = scratch("sess-6");
    try {
      writeFileSync(join(s.agentsDir, "agent-aaa.jsonl"), agentLine({ id: "m1", out: 10 }));
      writeFileSync(
        join(s.agentsDir, "agent-aaa.meta.json"),
        JSON.stringify({ agentType: "Explore", description: "SECRET-PROMPT-TEXT", model: "claude-opus-5" }),
      );
      const stats = readSubagentStats(s.transcript, "sess-6")!;
      expect(stats.agents).toBe(1); // the sidecar is not counted as a worker
      expect(JSON.stringify(stats)).not.toContain("SECRET-PROMPT-TEXT");
      expect(JSON.stringify(stats)).not.toContain("Explore");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("survives garbage without throwing — it runs inside a hook", () => {
    const s = scratch("sess-7");
    try {
      writeFileSync(
        join(s.agentsDir, "agent-aaa.jsonl"),
        ["not json at all", agentLine({ id: "m1", out: 42 }), '{"type":"assistant"', ""].join("\n"),
      );
      // A half-written final line is normal on a live session.
      expect(readSubagentStats(s.transcript, "sess-7")!.tokensOut).toBe(42);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
    expect(readSubagentStats("", "")).toBeNull();
    // @ts-expect-error — hostile input from a payload that lied about its type
    expect(readSubagentStats(null, null)).toBeNull();
  });

  test("the columns keep NULL and 0 apart, and reject a hostile value", () => {
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s1", ts: "2026-08-06T00:00:00.000Z" });
    expect(getSession(db, "s1")!.sub_agents).toBeNull();

    setSubagentStats(db, "s1", { agents: 0, tokensIn: 0, tokensOut: 0, cacheWrite: 0, tools: 0, topModel: null });
    expect(getSession(db, "s1")!.sub_agents).toBe(0);

    // INTEGER affinity would store a path verbatim; the coercion is the guard.
    setSubagentStats(db, "s1", { agents: "/Users/x/secret", tokensIn: 1, tokensOut: 1, cacheWrite: 1, tools: 1 });
    const dump = JSON.stringify((db as Database).query("SELECT * FROM sessions").all());
    expect(dump).not.toContain("/Users");
    expect(getSession(db, "s1")!.sub_agents).toBeNull();
    expect(getSession(db, "s1")!.sub_tokens_in).toBeNull();

    // sub_model is the one string crossing the boundary, out of a file we do
    // not control — so it goes through the same charset gate as sessions.model.
    setSubagentStats(db, "s1", {
      agents: 2,
      tokensIn: 1,
      tokensOut: 2,
      cacheWrite: 3,
      tools: 4,
      topModel: "/Users/x/evil",
    });
    expect(getSession(db, "s1")!.sub_model).toBeNull();
    expect(getSession(db, "s1")!.sub_agents).toBe(2);

    setSubagentStats(db, "s1", { agents: 2, tokensIn: 1, tokensOut: 2, cacheWrite: 3, tools: 4, topModel: "claude-opus-5[1m]" });
    expect(getSession(db, "s1")!.sub_model).toBe("claude-opus-5[1m]");
  });
});
