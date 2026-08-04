import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store";

// openDb has to survive opening a database somebody else is mid-write on.
// Under `refreshInterval` the statusline opens it roughly once a second while
// hooks write to it, so contention is the normal case, not the edge case.
//
// This is a regression test for an ordering bug: `PRAGMA journal_mode = WAL`
// takes an exclusive lock, and it used to run BEFORE `PRAGMA busy_timeout`.
// With no timeout configured yet SQLite's default is 0, so it failed instantly
// instead of waiting the 2 seconds configured on the very next line — which is
// why raising that timeout from 250ms to 2000ms hadn't helped. Rather than
// race the real thing, this holds a lock for a known interval and asserts
// openDb waits it out.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remy-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Hold an exclusive write lock on `dbPath` for `holdMs`, in another process
 * (bun:sqlite is synchronous, so a same-process holder would deadlock).
 *
 * It leaves the database in the default journal mode purely because that is a
 * convenient way to hold a lock a fresh connection will collide with. Do NOT
 * read that as "already-WAL databases are safe" — the 192 real failures came
 * from a database that was in WAL and fully migrated. The vulnerability is
 * having no busy_timeout on a fresh connection, not the journal mode. */
function holdLock(dbPath: string, holdMs: number) {
  const script = join(dir, "holder.ts");
  writeFileSync(
    script,
    `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)}, { create: true });
db.run("PRAGMA busy_timeout = 5000");
db.run("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)");
db.run("BEGIN EXCLUSIVE");
db.run("INSERT INTO lock_probe (id) VALUES (1)");
console.log("held");
await Bun.sleep(${holdMs});
db.run("COMMIT");
db.close();
`,
  );
  return Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
}

describe("openDb under contention", () => {
  test("waits for a competing writer instead of throwing", async () => {
    const dbPath = join(dir, "remy.db");
    const holder = holdLock(dbPath, 400);
    // Wait until the lock is actually held, so this isn't a timing guess.
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");

    const started = performance.now();
    let db: ReturnType<typeof openDb> | null = null;
    expect(() => {
      db = openDb(dbPath);
    }).not.toThrow();
    const waited = performance.now() - started;
    db!.close();

    await holder.exited;
    // It should have blocked for a meaningful slice of the hold rather than
    // returning instantly — proof it waited rather than got lucky.
    expect(waited).toBeGreaterThan(50);
    // ...and still well inside the 2s budget.
    expect(waited).toBeLessThan(2_000);
  }, 15_000);
});
