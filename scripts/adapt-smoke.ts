#!/usr/bin/env bun
// Does the adaptive coach's PROMPT actually work?
//
// Everything else about the analyzer is tested against a shell stub, which
// proves REMY handles whatever comes back — not that a real model, handed a
// real profile, picks a sensible tip. That needs one live call, so this is not
// in `bun test` and not in CI. Run it by hand after editing buildAdaptPrompt
// or the tip catalog:
//
//   bun run adapt:smoke
//
// It spends one cheap Haiku call, touches no real database (a throwaway
// REMY_DATA_DIR), and exits non-zero with the raw reply when the answer is
// unusable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdaptResponseSchema,
  buildAdaptPayload,
  buildAdaptPrompt,
  parseAdaptOutput,
} from "../packages/core/src/adapt";
import { TIPS } from "../packages/core/src/catalog";
import { openDb } from "../packages/core/src/store";
import { recordFindings } from "../packages/core/src/tips";

const MODEL = "haiku";

/** A developer who plans nothing, rides the context, and never verifies —
 * strong enough signal that a sensible answer is recognisable. */
function seedToxicProfile(db: ReturnType<typeof openDb>): void {
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    db.query(
      `INSERT OR REPLACE INTO sessions
         (session_id, started_at, model, tokens_in, tokens_out, cache_read,
          tool_calls, tool_fails, compacts_auto, used_plan_mode, max_context_pct)
       VALUES (?, ?, 'claude-opus-5', ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(`smoke-${i}`, new Date(now - i * 86_400_000).toISOString(), 120_000, 9_000, 20_000, 40, 6, i % 2, 88);
  }
  recordFindings(
    db,
    "smoke-0",
    [
      { tipId: "no-verify", evidence: { edits: 9, bash_calls: 4 }, estSavingsTokens: 10_000 },
      { tipId: "context-band", evidence: { turns: 6 }, estSavingsTokens: 90_000 },
    ],
    new Date(now).toISOString(),
  );
}

const dir = mkdtempSync(join(tmpdir(), "remy-adapt-smoke-"));
let failed = false;
const fail = (msg: string, detail?: string): void => {
  failed = true;
  console.log(`✗ ${msg}`);
  if (detail) console.log(`  ${detail.replace(/\n/g, "\n  ")}`);
};

try {
  process.env.REMY_DATA_DIR = dir;
  const db = openDb(join(dir, "remy.db"));
  seedToxicProfile(db);

  const payload = buildAdaptPayload(db, new Date().toISOString());
  const prompt = buildAdaptPrompt(payload);
  console.log(`🐭 asking ${MODEL} to coach a developer with ${payload.sessions} bad sessions…\n`);

  const proc = Bun.spawn(["claude", "-p", "--model", MODEL], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    fail(`the claude CLI exited ${code}`, err.trim() || "(no stderr)");
    throw new Error("backend unavailable");
  }

  console.log(`raw reply: ${out.trim()}\n`);
  const parsed = AdaptResponseSchema.safeParse(parseAdaptOutput(out));
  if (!parsed.success) {
    fail("the reply did not parse into {tip_id, why, confidence}", out.trim());
  } else {
    const { tip_id, why } = parsed.data;
    console.log(`✓ parsed a valid response`);

    if (tip_id in TIPS) console.log(`✓ picked a real catalog tip: ${tip_id} — ${TIPS[tip_id]!.title}`);
    else fail(`invented a tip id that is not in the catalog: ${tip_id}`);

    if (payload.pending_tips.includes(tip_id)) {
      fail(`picked ${tip_id}, which the prompt lists as already queued`);
    } else {
      console.log("✓ avoided the tips already in the queue");
    }

    if (/\d/.test(why)) console.log(`✓ cited a concrete number: "${why}"`);
    else fail("the explanation cites no number from the profile", why);

    if (why.length <= 200) console.log(`✓ the explanation fits the surface (${why.length} chars)`);
    else fail(`the explanation is ${why.length} chars — too long for the statusline`);
  }
  db.close();
} catch (e) {
  if (!failed) fail("smoke run threw", e instanceof Error ? e.message : String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? "\n✗ the adaptive prompt needs work" : "\n✔ the adaptive prompt holds up against a real model");
process.exit(failed ? 1 : 0);
