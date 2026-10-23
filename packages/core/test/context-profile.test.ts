import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hashPath, insertEvent, sanitizeContextProfile, sanitizeEvent } from "../src/index";
import { getSession, mcpServerProfile, mcpServerSegments, openDb, setContextProfile, upsertSession } from "../src/store";

// The sensor mod's report, from the gate to the rule's input: what the
// whitelist admits, what the store keeps, and how the configured half joins
// the usage half on a hash.

const TS = "2026-10-23T10:00:00.000Z";
const gmail = hashPath("claude_ai_Gmail");
const linear = hashPath("linear");

function seeded(): Database {
  const db = openDb(":memory:");
  upsertSession(db, { session_id: "s1", ts: TS });
  const profile = sanitizeContextProfile({
    session_id: "s1",
    ts: TS,
    window: 200_000,
    system_prompt_tokens: 3_000,
    system_tools_tokens: 12_000,
    memory_tokens: 18_000,
    skills_tokens: 4_000,
    agents_tokens: 500,
    messages_tokens: 9_000,
    mcp: [
      { server_hash: gmail, tools: 30, loaded_tools: 30, tokens: 24_000 },
      { server_hash: linear, tools: 8, loaded_tools: 2, tokens: 1_500 },
    ],
  });
  expect(profile).not.toBeNull();
  setContextProfile(db, profile!);
  return db;
}

describe("the context profile gate", () => {
  test("admits numbers and 16-hex server hashes, nothing else", () => {
    const ok = sanitizeContextProfile({ session_id: "s1", ts: TS, window: 1, mcp: [] });
    expect(ok).not.toBeNull();
    expect(ok!.system_prompt_tokens).toBe(0);
    // A raw server name, a path, free text — all refused, whole.
    for (const bad of [
      { session_id: "s1", ts: TS, window: 1, mcp: [{ server_hash: "claude_ai_Gmail", tools: 1, loaded_tools: 1, tokens: 1 }] },
      { session_id: "s1", ts: TS, window: 1, mcp: [{ server_hash: gmail, tools: 1, loaded_tools: 1, tokens: 1, name: "x" }] },
      { session_id: "s1", ts: TS, window: 1, prompt: "hello" },
      { session_id: "/Users/x", ts: TS, window: 1 },
      { session_id: "s1", ts: TS, window: -1 },
    ]) {
      expect(sanitizeContextProfile(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the store", () => {
  test("keeps the categories on the session and one row per server, replacing the last reading", () => {
    const db = seeded();
    const row = getSession(db, "s1")!;
    expect([row.ctx_system_tokens, row.ctx_tools_tokens, row.ctx_memory_tokens, row.ctx_skills_tokens, row.ctx_agents_tokens, row.ctx_mcp_tokens, row.ctx_messages_tokens])
      .toEqual([3_000, 12_000, 18_000, 4_000, 500, 25_500, 9_000]);
    // A later report replaces, never accumulates: schemas load on demand and
    // the newest picture is the true one.
    setContextProfile(db, sanitizeContextProfile({ session_id: "s1", ts: TS, window: 200_000, mcp: [{ server_hash: gmail, tools: 30, loaded_tools: 30, tokens: 26_000 }] })!);
    const servers = mcpServerProfile(db, "s1");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({ serverHash: gmail, tokens: 26_000, tools: 30, loadedTools: 30, calls: 0 });
  });

  test("joins the configured half to the usage half on the hash of the wire segment", () => {
    const db = seeded();
    for (const name of ["mcp__linear__create_issue", "mcp__linear__list_issues", "mcp__linear__create_issue", "Read"]) {
      insertEvent(db, sanitizeEvent({ session_id: "s1", ts: TS, type: "tool_use", tool: { name, ok: true } })!);
    }
    // Another session's calls do not count for this one.
    upsertSession(db, { session_id: "s2", ts: TS });
    insertEvent(db, sanitizeEvent({ session_id: "s2", ts: TS, type: "tool_use", tool: { name: "mcp__claude_ai_Gmail__search_threads", ok: true } })!);
    const byHash = new Map(mcpServerProfile(db, "s1").map((s) => [s.serverHash, s.calls]));
    expect(byHash.get(linear)).toBe(3);
    expect(byHash.get(gmail)).toBe(0);
    // ...but they do tell resolve.ts which segments this machine has seen.
    expect(mcpServerSegments(db).sort()).toEqual(["claude_ai_Gmail", "linear"]);
  });

  test("a session the mod never reported has no profile — not an empty one", () => {
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s9", ts: TS });
    expect(mcpServerProfile(db, "s9")).toEqual([]);
    expect(getSession(db, "s9")!.ctx_system_tokens).toBeNull();
  });
});
