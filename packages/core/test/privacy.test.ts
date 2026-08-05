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
  claudeMdBytes,
  setClaudeMdBytes,
  getSession,
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

  test("repo_hash is no longer whitelisted — it is stripped like any unknown key", () => {
    // It was in the schema but no caller ever set it: NULL for all 2,372
    // events and all 59 sessions in the real local DB. A field that always
    // reads null is a trap (a rule built on it can never fire), and the
    // whitelist should not carry surface nothing writes. The DB columns stay
    // for shape compatibility; the parse gate does not.
    const ev = sanitizeEvent({
      session_id: "s1",
      ts: "2026-07-26T10:00:00Z",
      type: "session_start",
      repo_hash: hashPath("/Users/x/project"),
    });
    expect(ev).not.toBeNull();
    expect(ev).not.toHaveProperty("repo_hash");

    // And it stays stripped when the value is hostile rather than well-formed.
    const hostile = sanitizeEvent({
      session_id: "s1",
      ts: "2026-07-26T10:00:00Z",
      type: "session_start",
      repo_hash: `/Users/x/${MARKER}`,
    });
    expect(JSON.stringify(hostile)).not.toContain(MARKER);
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

  test("the CLAUDE.md probe yields a byte count and never the path it probed", () => {
    // claudemd.ts is the one place in core that touches the filesystem using
    // a raw path. Its whole output surface must be a number: the path goes in
    // and only a size comes out, so there is nothing path-shaped to store.
    const hostile = `/Users/x/${MARKER}`;
    const bytes = claudeMdBytes(hostile);
    expect(typeof bytes).toBe("number");
    expect(Number.isFinite(bytes)).toBe(true);
    expect(JSON.stringify(bytes)).not.toContain(MARKER);
  });

  test("a hostile value cannot reach the claude_md_bytes column — INTEGER affinity is not the guarantee", () => {
    // SQLite's INTEGER affinity does NOT reject a string: writing a path into
    // this column would store it verbatim. The coercion in setClaudeMdBytes
    // is what actually holds the invariant, so that is what's asserted here.
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:00:00.000Z" });
    setClaudeMdBytes(db, "s1", `/Users/x/${MARKER}/CLAUDE.md`);
    const dump = JSON.stringify((db as Database).query("SELECT * FROM sessions").all());
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain("/Users");
    expect(getSession(db, "s1")!.claude_md_bytes).toBeNull();

    // A real probe stores a plain number.
    setClaudeMdBytes(db, "s1", 8_920);
    expect(getSession(db, "s1")!.claude_md_bytes).toBe(8_920);
  });

  test("a hostile value cannot reach the sessions.model column — the statusline payload is host input", () => {
    // sessions rows are written from the statusline payload, which never goes
    // through sanitizeEvent. Before the gate in upsertSession, `model` was
    // passed straight to the INSERT, so this column was the one stored string
    // with no charset check anywhere in its path.
    const db = openDb(":memory:");
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:00:00.000Z", model: `/Users/x/${MARKER}` });
    expect(getSession(db, "s1")!.model).toBeNull();

    // A rejected value must not clobber a good one either: NULL means "leave
    // what we already knew", not "overwrite with nothing".
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:01:00.000Z", model: "claude-fable-5" });
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:02:00.000Z", model: `secret ${MARKER}` });
    expect(getSession(db, "s1")!.model).toBe("claude-fable-5");

    // cwd_hash is gated the same way — only a 16-hex hash lands.
    upsertSession(db, { session_id: "s2", ts: "2026-07-26T10:00:00.000Z", cwd_hash: `/Users/x/${MARKER}` });
    expect(getSession(db, "s2")!.cwd_hash).toBeNull();

    const dump = JSON.stringify((db as Database).query("SELECT * FROM sessions").all());
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain("/Users");
  });

  test("the model ids the host actually emits survive the gate", () => {
    // The charset admits these two deliberately (see ModelStr): dropping them
    // would trade a privacy hole for silently losing which model ran. Both are
    // bounded identifiers — the regression to guard is someone "tightening"
    // the regex back and blanking the column for every 1M-context user.
    const db = openDb(":memory:");
    for (const id of ["claude-opus-5[1m]", "claude-opus-4-8[1m]", "<synthetic>", "anthropic.claude-3-5-v2:0"]) {
      upsertSession(db, { session_id: id, ts: "2026-07-26T10:00:00.000Z", model: id });
      expect(getSession(db, id)!.model).toBe(id);
    }
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
