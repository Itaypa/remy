import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeEvent,
  hashPath,
  insertEvent,
  openDb,
  classifyCommand,
  buildAdaptPayload,
  contextFromPayload,
  upsertSession,
} from "../src/index";

const MARKER = "SUPER_SECRET_PROMPT_BODY_should_never_be_stored";

describe("privacy gate", () => {
  test("unknown free-text fields are stripped by the whitelist", () => {
    const ev = sanitizeEvent({
      session_id: "s1",
      ts: "2026-07-26T10:00:00Z",
      type: "prompt",
      prompt: MARKER,
      prompt_text: MARKER,
      last_assistant_message: MARKER,
      tool_input: { file_path: "/Users/x/secret.ts", content: MARKER },
      transcript: MARKER,
    });
    expect(ev).not.toBeNull();
    expect(JSON.stringify(ev)).not.toContain(MARKER);
    expect(JSON.stringify(ev)).not.toContain("secret.ts");
  });

  test("raw paths cannot pass as hashes", () => {
    const ev = sanitizeEvent({
      session_id: "s1",
      ts: "2026-07-26T10:00:00Z",
      type: "tool_use",
      tool: { name: "Read", ok: true, target_hash: "/Users/x/secret.ts" },
    });
    expect(ev).toBeNull();
  });

  test("path-shaped and free-text values are rejected by charset gates", () => {
    const base = { session_id: "s1", ts: "2026-07-26T10:00:00Z", type: "prompt" as const };
    // "/" is not in any charset — path-shaped strings cannot pass anywhere.
    expect(sanitizeEvent({ ...base, model: "/Users/x/secret.ts" })).toBeNull();
    expect(sanitizeEvent({ ...base, session_id: "/Users/x/proj" })).toBeNull();
    expect(sanitizeEvent({ ...base, ts: "yesterday at noon" })).toBeNull();
    expect(sanitizeEvent({ ...base, host: `run ${MARKER}` })).toBeNull();
    expect(
      sanitizeEvent({ ...base, type: "tool_use", tool: { name: "rm -rf /Users/x", ok: true } }),
    ).toBeNull();
    // Legitimate ids still pass.
    expect(sanitizeEvent({ ...base, model: "claude-fable-5" })).not.toBeNull();
    expect(sanitizeEvent({ ...base, model: "anthropic.claude-3-5-v2:0" })).not.toBeNull();
    expect(sanitizeEvent({ ...base, ts: "2026-07-26T10:00:00.123Z" })).not.toBeNull();
  });

  test("hashPath is 16 lowercase hex chars and one-way", () => {
    const h = hashPath("/Users/x/secret.ts");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain("secret");
  });

  test("classifyCommand is a closed enum — no input content can come out", () => {
    // The classifier runs on raw command text before hashing; its output type
    // IS the metadata boundary. Lock that contract before batch-2a ever
    // persists it.
    const CLASSES = new Set(["test", "build", "lint", "git", "pkg", "run", "read-cmd", "other"]);
    const hostile = [
      `bun test ${MARKER}`,
      `curl -H "Authorization: Bearer sk-${MARKER}"`,
      "/Users/x/secret-script.sh --token=abc123",
      `PASSWORD=${MARKER} npm run deploy`,
      `echo '${MARKER}' > /tmp/x`,
      "rm -rf / --no-preserve-root",
      `cat /Users/x/.env.${MARKER}`,
      `grep -rn "${MARKER}" /Users/x/private`,
    ];
    for (const cmd of hostile) {
      const out = classifyCommand(cmd);
      expect(CLASSES.has(out)).toBe(true);
      expect(out).not.toContain(MARKER);
    }
  });

  test("the adaptive analyzer is the ONLY outbound path in the codebase", () => {
    // Everything REMY knows stays in ~/.remy/remy.db. The one thing that ever
    // leaves the process is the adaptive analyzer's prompt (a local `claude -p`
    // call, off by default-able), and its payload is whitelisted below. If a
    // second egress path ever appears, this test is where it must be justified.
    const src = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(src)) {
      if (!file.endsWith(".ts")) continue;
      const body = readFileSync(join(src, file), "utf8");
      // `adapt.ts` builds the prompt but does not send it; the CLI spawns the
      // local claude binary. Neither may reach the network directly.
      if (/\bfetch\s*\(|new WebSocket|node:https?\b/.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("adapt payload carries no content — numbers and whitelisted ids only", () => {
    const db = openDb(":memory:");
    // Seed metadata that LOOKS hostile; the payload must still be content-free.
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:00:00.000Z" });
    (db as Database).query(`UPDATE sessions SET model = ? WHERE session_id = 's1'`).run(`/Users/x/${MARKER}`);
    const wire = JSON.stringify(buildAdaptPayload(db, "2026-07-27T10:00:00.000Z"));
    expect(wire).not.toContain(MARKER);
    expect(wire).not.toContain("/Users");
    expect(wire).not.toContain("s1"); // not even session ids leave in the profile
  });

  test("nothing body-like survives a full write to the store", () => {
    const db = openDb(":memory:");
    const ev = sanitizeEvent({
      session_id: "s1",
      ts: "2026-07-26T10:00:00Z",
      type: "tool_use",
      cwd_hash: hashPath("/Users/x/project"),
      tool: { name: "Bash", ok: false, target_hash: hashPath(`run ${MARKER}`) },
      sneaky_body: MARKER,
    });
    insertEvent(db, ev!);
    const dump = JSON.stringify(
      (db as Database).query("SELECT * FROM events").all(),
    );
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain("/Users/x");
  });

  test("contextFromPayload carries no content — numbers and a model id only", () => {
    const ctx = contextFromPayload({
      cwd: `/Users/x/${MARKER}`,
      transcript_path: `/Users/x/${MARKER}.jsonl`,
      model: { id: "claude-fable-5" },
      context_window: { total_input_tokens: 1, total_output_tokens: 1, context_window_size: 200_000 },
    });
    expect(JSON.stringify(ctx)).not.toContain(MARKER);
    expect(JSON.stringify(ctx)).not.toContain("/Users");
  });
});
