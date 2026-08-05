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
  setSkillPack,
  setSubagentStats,
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

  /** Every way a process can reach the network that this codebase could
   * plausibly acquire. Kept as one exported-by-test constant so the scanner
   * below can be checked against planted samples — a scanner that finds
   * nothing is indistinguishable from a scanner that is broken. */
  const EGRESS =
    /\bfetch\s*\(|new WebSocket|new EventSource|XMLHttpRequest|sendBeacon|Bun\.(connect|listen|serve)\b|node:(https?|net|dgram|tls)\b|(from|require\s*\()\s*["'](https?|net|dgram|tls)["']/;

  /** Every .ts under a directory, recursively — the old scan was one level
   * deep, so `core/src/net/client.ts` would not have been looked at. */
  function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFilesUnder(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  test("the egress scanner actually detects egress", () => {
    // The test below asserts an empty list. That assertion is worthless unless
    // the pattern it uses can be shown to catch something, so these are the
    // shapes it must never start missing.
    for (const sample of [
      'const r = await fetch("https://x")',
      'new WebSocket("wss://x")',
      'import { request } from "node:http"',
      'import { connect } from "node:net"',
      'const dns = require("dgram")',
      'import tls from "tls"',
      "Bun.connect({ hostname: 'x', port: 1 })",
      "Bun.serve({ port: 3000 })",
      "new EventSource('/x')",
      "navigator.sendBeacon('/x')",
    ]) {
      expect(EGRESS.test(sample), `scanner missed: ${sample}`).toBe(true);
    }
    // And it must not fire on the things this codebase legitimately contains.
    for (const innocent of [
      'const rows = db.query("SELECT * FROM sessions").all()',
      "const text = await Bun.stdin.text()",
      'import { join } from "node:path"',
      'import { readFileSync } from "node:fs"',
      "// the adaptive analyzer spawns a local claude -p",
    ]) {
      expect(EGRESS.test(innocent), `scanner false-positived on: ${innocent}`).toBe(false);
    }
  });

  test("the adaptive analyzer is the ONLY outbound path in the codebase", () => {
    // Everything REMY knows stays in its local DB. The one thing that ever
    // leaves the process is the adaptive analyzer's prompt (a local `claude -p`
    // call, disableable), and its payload is whitelisted below. If a second
    // egress path ever appears, this test is where it must be justified.
    //
    // Scans the CLI as well as core: the claim in this test's name is about the
    // codebase, and a fetch() in the hook path would break the promise exactly
    // as badly as one in core. The local-binary spawn is a shell exec, not a
    // socket, so it is not matched.
    const roots = [
      join(import.meta.dir, "..", "src"),
      join(import.meta.dir, "..", "..", "cli", "src"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        if (EGRESS.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
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

  test("nothing body-like survives a full write to the SESSIONS row either", () => {
    // The test above covers `events` and one writer. Every probe result and
    // every host-supplied field lands in `sessions` instead, through writers
    // that do NOT go through sanitizeEvent — which is how the model column
    // came to hold values the schema forbade. This drives all of them at once
    // with a hostile value and looks at the whole row.
    const db = openDb(":memory:");
    const hostile = `/Users/x/${MARKER}`;
    upsertSession(db, { session_id: "s1", ts: "2026-07-26T10:00:00.000Z", model: hostile, cwd_hash: hostile });
    setClaudeMdBytes(db, "s1", hostile);
    setSkillPack(db, "s1", { bytes: hostile, count: hostile });
    setSubagentStats(db, "s1", { agents: hostile, tokensIn: hostile, tokensOut: hostile, cacheWrite: hostile, tools: hostile, topModel: hostile });

    const dump = JSON.stringify((db as Database).query("SELECT * FROM sessions").all());
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain("/Users");
  });

  test("no table grows a free-text column without this test being updated", () => {
    // "Widening this schema is a design change" is the rule; this is what makes
    // it one. Every TEXT column is listed with what constrains it, so adding a
    // column that could hold a prompt, a path or a file body fails here rather
    // than shipping quietly. INTEGER/REAL columns are covered by the coercion
    // tests above — SQLite affinity would happily store a string in them, so
    // the write-site coercion is the guarantee, not the declared type.
    const REVIEWED: Record<string, Record<string, string>> = {
      sessions: {
        session_id: "IdStr — charset-gated, no slash",
        started_at: "ISO timestamp",
        ended_at: "ISO timestamp",
        model: "ModelStr — charset-gated at the write site",
        cwd_hash: "Hash16 — one-way, gated at the write site",
        repo_hash: "vestigial; no writer, kept for shape compatibility",
        sub_model: "ModelStr — charset-gated at the write site",
      },
      events: {
        session_id: "IdStr", ts: "ISO timestamp", host: "HostStr enum-shaped",
        host_version: "HostVersionStr", type: "EventType enum", model: "ModelStr",
        tool_name: "ToolNameStr", target_hash: "Hash16",
        compact_trigger: "auto|manual enum", repo_hash: "vestigial", cwd_hash: "Hash16",
      },
      tips: {
        tip_id: "catalog id", session_id: "IdStr", created_at: "ISO timestamp",
        status: "queued|active|dismissed enum",
        evidence: "rule-authored JSON of numbers and closed-set strings",
        why: "the adaptive analyzer's own sentence, length-capped and sanitized (adapt.ts)",
      },
      sync_state: { key: "local kv key", value: "local kv value" },
    };

    const db = openDb(":memory:");
    for (const [table, reviewed] of Object.entries(REVIEWED)) {
      const cols = (db as Database).query(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      const text = cols.filter((c) => c.type === "TEXT").map((c) => c.name);
      expect(text.sort(), `${table} gained or lost a TEXT column — justify it here`).toEqual(
        Object.keys(reviewed).sort(),
      );
    }
  });
});
