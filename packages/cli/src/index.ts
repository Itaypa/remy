#!/usr/bin/env bun
import { $ } from "bun";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activeTip,
  analyzeHabits,
  analyzeSession,
  applyAdaptResponse,
  buildAdaptPayload,
  buildAdaptPrompt,
  claudeMdBytes,
  setClaudeMdBytes,
  skillPackBytes,
  setSkillPack,
  parseAdaptOutput,
  contextFromPayload,
  binDir,
  contextLimit,
  dataDir,
  dismissTip,
  dueForContextAlarm,
  dueForStopNudge,
  envVar,
  markContextAlarmShown,
  markStopNudgeShown,
  openTips,
  getSession,
  getSyncState,
  setSyncState,
  hashPath,
  HINTS,
  insertEvent,
  latestSessionForCwd,
  logError,
  markShown,
  openDb,
  parseTranscriptFile,
  recentSessions,
  recordFindings,
  sanitizeEvent,
  sessionTips,
  shouldSuppressPlanMode,
  tailContext,
  upsertSession,
  TIPS,
  type Finding,
  type SessionRow,
} from "@ccpp/core";
import {
  ansi,
  bar,
  contextAlarmLine,
  fmtTok,
  linkify,
  linksEnabled,
  modelEmoji,
  renderReport,
  renderWeek,
  rotatingHint,
  spendField,
  splash,
  tipLine,
  weekTotals,
} from "./ui";
import {
  claimSpinnerTips,
  clearSpinnerTips,
  desiredTips,
  settingsPath,
  spinnerEnabled,
  syncSpinnerTips,
} from "./spinner";

// Baked in by scripts/build-plugin.ts from the plugin manifest — one version
// number for the plugin, the binary, and the release asset names.
declare const REMY_VERSION: string | undefined;
const VERSION = typeof REMY_VERSION === "string" ? REMY_VERSION : "dev";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ADAPT_THROTTLE_MS = 24 * 60 * 60 * 1000; // one analyzer call per day, max

// Injected by scripts/build-plugin.ts via --define; absent when running from source.
declare const REMY_BUILD_ID: string | undefined;
const BUILD_ID = typeof REMY_BUILD_ID === "string" ? REMY_BUILD_ID : "src";
declare const REMY_CHANNEL: string | undefined;
const CHANNEL = typeof REMY_CHANNEL === "string" ? REMY_CHANNEL : "dev";

/** Dev install = this binary was not stamped by a release build.
 *
 * Decided by the baked-in channel, NOT by where the binary sits: since the
 * plugin ships a launcher and the real binary always lives in ~/.remy/bin,
 * an execPath test ("is it under .claude/plugins?") is false for every
 * install that has ever existed — which showed the dev badge to real users.
 * REMY_DEV=1/0 overrides. */
function isDevInstall(): boolean {
  if (envVar("DEV") === "1") return true;
  if (envVar("DEV") === "0") return false;
  return CHANNEL !== "release";
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";

try {
  switch (cmd) {
    case "ingest":
      await ingest();
      break;
    case "statusline":
      await statusline();
      break;
    case "report":
      report(argv.slice(1));
      break;
    case "dismiss":
      dismiss(argv.slice(1));
      break;
    case "init":
      init(argv.slice(1));
      break;
    case "adapt":
      await adapt(argv.slice(1));
      break;
    case "spinner":
      spinner(argv.slice(1));
      break;
    case "links":
      await installClickActions();
      break;
    case "version":
      console.log(`${VERSION}+${BUILD_ID}`);
      break;
    default:
      help();
  }
} catch (err) {
  // A coaching tool must never break the host: log, emit a safe fallback, exit 0.
  logError(cmd, err);
  if (cmd === "statusline") console.log("⚡ remy");
}
process.exit(0);

/** Hook stdin is untrusted and, for Stop, carries the raw assistant
 * response text. V8's JSON.parse SyntaxError embeds a fragment of its
 * input, and logError() persists error messages to remy.log — so a
 * malformed payload must never reach the generic catch. Logs a fixed
 * string only. */
function parseHookPayload(text: string, context: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    logError(context, new Error("unparseable hook payload"));
    return null;
  }
}

// ---------------------------------------------------------------- ingest

async function ingest(): Promise<void> {
  const payload = parseHookPayload(await Bun.stdin.text(), "ingest");
  if (!payload) return;
  const hook: string = payload.hook_event_name ?? "";
  const sessionId: string = payload.session_id ?? "unknown";
  const now = new Date().toISOString();
  const cwdHash = typeof payload.cwd === "string" ? hashPath(payload.cwd) : undefined;
  const db = openDb();

  switch (hook) {
    case "SessionStart": {
      upsertSession(db, { session_id: sessionId, ts: now, cwd_hash: cwdHash });
      insertEvent(db, sanitizeEvent({ session_id: sessionId, ts: now, type: "session_start", cwd_hash: cwdHash })!);
      // How much project memory this session starts with (stat only, never a
      // read — see claudemd.ts). Every source counts, not just "startup": a
      // resumed session loads the same files. claudeMdBytes() cannot throw,
      // so this can't cost the splash below.
      if (typeof payload.cwd === "string") {
        setClaudeMdBytes(db, sessionId, claudeMdBytes(payload.cwd));
        // The other half of the startup pack, and the bigger one: skill
        // frontmatter from every enabled plugin. Measured here because it is
        // not recoverable later — plugins get toggled, and a session that
        // wasn't measured at its start can never be. Cannot throw (skills.ts).
        setSkillPack(db, sessionId, skillPackBytes(payload.cwd));
      }
      if (payload.source === "startup") {
        const week = weekTotals(recentSessions(db, new Date(Date.now() - WEEK_MS).toISOString()));
        const tip = activeTip(db);
        if (tip) markShown(db, tip.tip_id, now);
        // The full rat greets you once per version — first session after an
        // install or an upgrade. Keyed by version, not by a "seen" flag, so
        // an upgrade re-introduces him and nothing else does.
        const welcome = getSyncState(db, "welcome_version") !== VERSION;
        if (welcome) setSyncState(db, "welcome_version", VERSION);
        const message = splash({ version: VERSION, week, tip, welcome });
        // Claim the spinner tip line for this session while we're here — the
        // host reads settings.json at startup, so SessionStart is the moment
        // the line is set for every wait that follows.
        syncSpinnerTips(db, openTips(db));
        console.log(JSON.stringify({ systemMessage: message }));
      }
      break;
    }
    // PostToolUse fires ONLY after a tool call succeeds — failures arrive as a
    // separate PostToolUseFailure event. Sniffing tool_response for an error
    // flag therefore never once returned true: across 2.1k recorded calls on
    // this developer's machine, tool_fails sat at 0 while the same sessions'
    // transcripts held 81 is_error results. That made "N failed" in /remy a
    // constant zero and told the adaptive coach nobody ever fails a tool.
    // The event name is the signal — no payload shape to guess at, and the
    // old sniff stays as a fallback for hosts predating the split.
    case "PostToolUseFailure":
    case "PostToolUse": {
      const input = payload.tool_input;
      const resp = payload.tool_response ?? payload.tool_output;
      const failed =
        hook === "PostToolUseFailure" ||
        (!!resp && typeof resp === "object" && ((resp as any).is_error === true || (resp as any).isError === true || (resp as any).success === false));
      const rawTarget =
        input && typeof input === "object"
          ? ((input as any).file_path ?? (input as any).notebook_path ?? (input as any).path ?? (input as any).command ?? (input as any).url)
          : undefined;
      const ev = sanitizeEvent({
        session_id: sessionId,
        ts: now,
        type: "tool_use",
        cwd_hash: cwdHash,
        tool: {
          name: String(payload.tool_name ?? "unknown").slice(0, 64),
          ok: !failed,
          target_hash: typeof rawTarget === "string" && rawTarget ? hashPath(rawTarget) : undefined,
        },
      });
      if (ev) {
        upsertSession(db, { session_id: sessionId, ts: now, cwd_hash: cwdHash });
        insertEvent(db, ev);
        db.query(
          `UPDATE sessions SET tool_calls = tool_calls + 1, tool_fails = tool_fails + ? WHERE session_id = ?`,
        ).run(failed ? 1 : 0, sessionId);
      }
      break;
    }
    // A tool call the host's auto-mode classifier refused. Counted, nothing
    // else: the payload carries tool_input and a free-text `reason`, none of
    // which is read here. This branch must never write to stdout — on
    // PermissionDenied the host reads stdout for a `retry` directive, so a
    // coaching tool printing here would be steering the permission flow.
    // (PermissionRequest, where stdout IS an allow/deny decision, is
    // deliberately not registered at all.)
    case "PermissionDenied": {
      upsertSession(db, { session_id: sessionId, ts: now, cwd_hash: cwdHash });
      db.query(`UPDATE sessions SET perm_denials = perm_denials + 1 WHERE session_id = ?`).run(sessionId);
      break;
    }
    case "PreCompact": {
      const trigger = payload.trigger === "auto" ? "auto" : "manual";
      upsertSession(db, { session_id: sessionId, ts: now, cwd_hash: cwdHash });
      insertEvent(db, sanitizeEvent({ session_id: sessionId, ts: now, type: "compact", compact_trigger: trigger, cwd_hash: cwdHash })!);
      db.query(
        trigger === "auto"
          ? `UPDATE sessions SET compacts_auto = compacts_auto + 1 WHERE session_id = ?`
          : `UPDATE sessions SET compacts_manual = compacts_manual + 1 WHERE session_id = ?`,
      ).run(sessionId);
      if (trigger === "auto") {
        const finding: Finding = {
          tipId: "auto-compact",
          evidence: { count: 1 },
          estSavingsTokens: Math.round(contextLimit() * 0.3),
        };
        recordFindings(db, sessionId, [finding], now);
      }
      break;
    }
    case "Stop":
    case "SessionEnd": {
      upsertSession(db, { session_id: sessionId, ts: now, cwd_hash: cwdHash });
      if (typeof payload.transcript_path === "string") {
        await analyzeTranscript(db, sessionId, payload.transcript_path, now, hook === "SessionEnd");
      }
      insertEvent(db, sanitizeEvent({ session_id: sessionId, ts: now, type: hook === "Stop" ? "stop" : "session_end", cwd_hash: cwdHash })!);
      if (hook === "Stop") {
        // Two transient nudges, mutually exclusive per Stop so a turn never
        // gets two systemMessages: an overflowing context is the more
        // urgent problem, so it takes priority over the coaching tip.
        const session = getSession(db, sessionId);
        const inAlarmZone = !!session && session.max_context_pct >= 80;
        if (inAlarmZone && dueForContextAlarm(db, sessionId, now)) {
          markContextAlarmShown(db, sessionId, now);
          const window = session.context_window ?? contextLimit();
          const tokens = Math.round((session.max_context_pct / 100) * window);
          console.log(JSON.stringify({ systemMessage: contextAlarmLine(session.max_context_pct, tokens) }));
        } else {
          const tip = activeTip(db);
          // One voice about context at a time: while the session is in alarm
          // territory, the live alarm owns the context story — a context tip
          // taking the very next slot ("you should have compacted at 60%")
          // would be a second nag about the same problem within minutes.
          // Context tips still reach the splash and /remy.
          const contextTip = tip?.tip_id === "context-band" || tip?.tip_id === "auto-compact";
          if (tip && !(inAlarmZone && contextTip) && dueForStopNudge(db, tip.tip_id, now)) {
            markStopNudgeShown(db, tip.tip_id, now);
            console.log(JSON.stringify({ systemMessage: tipLine(tip) }));
          }
        }
        // Findings that landed this turn belong on the spinner for the next
        // wait, not the next session. Writes only when the line changed.
        syncSpinnerTips(db, openTips(db));
      }
      if (hook === "SessionEnd") {
        db.query(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`).run(now, sessionId);
        // Cross-session habit rules run once per session, at its end.
        const week = recentSessions(db, new Date(Date.now() - WEEK_MS).toISOString());
        recordFindings(db, sessionId, analyzeHabits(week), now);
        maybeAutoAdapt(db);
      }
      break;
    }
    default:
      break;
  }
}

async function analyzeTranscript(
  db: ReturnType<typeof openDb>,
  sessionId: string,
  transcriptPath: string,
  now: string,
  sessionEnd: boolean,
): Promise<void> {
  // The host-reported window (persisted by the statusline) beats the
  // assumed/env default — a 170k-context turn is red-zone on a 200k window
  // but healthy on a 1M one.
  const limit = getSession(db, sessionId)?.context_window ?? contextLimit();
  const stats = await parseTranscriptFile(transcriptPath, limit);
  if (!stats) return;
  db.query(
    `UPDATE sessions SET
       tokens_in = ?, tokens_out = ?, cache_read = ?, cache_write = ?,
       model = COALESCE(?, model),
       used_plan_mode = MAX(used_plan_mode, ?),
       max_context_pct = MAX(max_context_pct, ?)
     WHERE session_id = ?`,
  ).run(
    stats.totals.in,
    stats.totals.out,
    stats.totals.cache_read,
    stats.totals.cache_write,
    stats.model,
    stats.usedPlanMode ? 1 : 0,
    stats.contextPct,
    sessionId,
  );
  const row = getSession(db, sessionId);
  let findings = analyzeSession({
    sessionId,
    spendTokens: stats.totals.in + stats.totals.out,
    toolCalls: stats.toolCalls,
    editCalls: stats.editCalls,
    usedPlanMode: stats.usedPlanMode || !!row?.used_plan_mode,
    autoCompacts: row?.compacts_auto ?? 0,
    contextLimit: limit,
    contextPct: stats.contextPct,
    firstContextTokens: stats.firstContextTokens,
    cacheExpiries: stats.cacheExpiries,
    cacheExpiryTokens: stats.cacheExpiryTokens,
    cacheExpiryWorstGapMinutes: stats.cacheExpiryWorstGapMinutes,
    redZoneTurns: stats.redZoneTurns,
    redZoneExcessTokens: stats.redZoneExcessTokens,
    // NULL when SessionStart never ran for this id (plugin installed
    // mid-session, or a --continue into an older session) — the rules read
    // that as "unknown" and stay quiet.
    claudeMdBytes: row?.claude_md_bytes ?? null,
    skillBytes: row?.skill_bytes ?? null,
  });
  // Anti-nag: a user whose recent habit is already plan-first doesn't need
  // the plan-mode tip re-filed for the occasional direct session.
  if (findings.some((f) => f.tipId === "plan-mode")) {
    const week = recentSessions(db, new Date(Date.now() - WEEK_MS).toISOString());
    if (shouldSuppressPlanMode(week)) {
      findings = findings.filter((f) => f.tipId !== "plan-mode");
    }
  }
  recordFindings(db, sessionId, findings, now);
}

// ------------------------------------------------------- adaptive analyzer

function adaptEnabled(db: ReturnType<typeof openDb>): boolean {
  if (envVar("ADAPT") === "0") return false;
  return getSyncState(db, "adapt_enabled") !== "0";
}

/**
 * Fire-and-forget adaptive analysis from the SessionEnd hook — same contract
 * as maybeAutoSync: the hook process exits before any model call happens; a
 * detached child does the work. The throttle is claimed HERE (parent) so
 * concurrent session ends can't stampede; the --auto child skips its own
 * throttle check.
 */
function maybeAutoAdapt(db: ReturnType<typeof openDb>): void {
  try {
    if (!adaptEnabled(db)) return;
    const last = getSyncState(db, "last_adapt_at");
    if (last && Date.now() - Date.parse(last) < ADAPT_THROTTLE_MS) return;
    // Only run when there's fresh signal to analyze.
    const fresh = (
      db.query(`SELECT COUNT(*) AS c FROM sessions WHERE started_at >= ?`).get(last ?? "1970-01-01T00:00:00.000Z") as { c: number }
    ).c;
    if (fresh < 3) return;
    setSyncState(db, "last_adapt_at", new Date().toISOString());
    const entry = process.argv[1] ?? "";
    const cmd = entry.endsWith(".ts")
      ? [process.execPath, entry, "adapt", "--auto", "--quiet"]
      : [process.execPath, "adapt", "--auto", "--quiet"];
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch (err) {
    logError("auto-adapt", err);
  }
}

async function adapt(args: string[]): Promise<void> {
  const quiet = args.includes("--quiet");
  const db = openDb();
  if (args.includes("--on")) {
    setSyncState(db, "adapt_enabled", "1");
    console.log("🤖 adaptive coaching: ON — one metadata-only claude call per day, tips land in /remy");
    return;
  }
  if (args.includes("--off")) {
    setSyncState(db, "adapt_enabled", "0");
    console.log("🤖 adaptive coaching: OFF — deterministic coaching continues as usual");
    return;
  }
  const last = getSyncState(db, "last_adapt_at");
  if (args.includes("--status")) {
    console.log(
      `🤖 adaptive coaching: ${adaptEnabled(db) ? "on" : "off"}` +
        (last ? ` · last analyzed ${hoursAgo(last)}h ago` : " · never run") +
        " · toggle: remy adapt --on/--off",
    );
    return;
  }
  if (!adaptEnabled(db)) {
    if (!quiet) console.log("🤖 adaptive coaching is off — enable with: remy adapt --on");
    return;
  }
  const auto = args.includes("--auto");
  const now = new Date().toISOString();
  if (!auto) {
    if (!args.includes("--force") && last && Date.now() - Date.parse(last) < ADAPT_THROTTLE_MS) {
      if (!quiet) console.log(`🤖 analyzed ${hoursAgo(last)}h ago — one call a day is the budget; --force to rerun`);
      return;
    }
    setSyncState(db, "last_adapt_at", now);
  }
  const payload = buildAdaptPayload(db, now);
  if (payload.sessions === 0) {
    if (!quiet) console.log("🤖 no sessions in the last 14 days — nothing to analyze yet");
    return;
  }
  const stdout = await runAdaptBackend(buildAdaptPrompt(payload));
  if (stdout == null) {
    if (!quiet) console.log("🤖 claude CLI unavailable — skipped (silence for good with: remy adapt --off)");
    return;
  }
  const tipId = applyAdaptResponse(db, parseAdaptOutput(stdout), now);
  if (!quiet) {
    console.log(
      tipId
        ? `🤖 tip queued: ${TIPS[tipId]?.emoji} ${TIPS[tipId]?.title} — see /remy for the why`
        : "🤖 no new tip this round (queue full, cooldown, or unclear response)",
    );
  }
}

/** Headless claude CLI call — prompt on stdin, JSON out. COACH_ADAPT_CMD
 * overrides the command (test/e2e stub). Returns null on any failure: the
 * adaptive layer degrades to plain deterministic coaching. */
async function runAdaptBackend(prompt: string): Promise<string | null> {
  const override = envVar("ADAPT_CMD");
  const cmd = override
    ? override.split(" ").filter(Boolean)
    : ["claude", "-p", "--output-format", "json", "--model", "haiku", "--max-turns", "1"];
  try {
    const proc = Bun.spawn(cmd, { stdin: Buffer.from(prompt), stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => proc.kill(), 90_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(killer);
    return proc.exitCode === 0 ? out : null;
  } catch (err) {
    logError("adapt-backend", err);
    return null;
  }
}

function hoursAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
}

// ------------------------------------------------------------ statusline

/** With refreshInterval on, this runs ~1/s per session for as long as the
 * session lives — so the steady state (nothing changed since the last tick)
 * must be read-only. Written and model are effectively constant per session;
 * cost/context only move forward. Wrapped in its own try/catch so a
 * SQLITE_BUSY skips the write instead of falling through to the global
 * fallback and flickering "⚡ remy". */
function syncSessionStats(
  db: ReturnType<typeof openDb>,
  sessionId: string,
  cwdHash: string,
  model: string | undefined,
  cost: number | undefined,
  pct: number,
  windowSize: number | null,
): void {
  try {
    const row = db
      .query(`SELECT cost_usd, max_context_pct, model, cwd_hash, context_window FROM sessions WHERE session_id = ?`)
      .get(sessionId) as {
      cost_usd: number | null;
      max_context_pct: number;
      model: string | null;
      cwd_hash: string | null;
      context_window: number | null;
    } | null;
    if (!row) {
      upsertSession(db, { session_id: sessionId, ts: new Date().toISOString(), model, cwd_hash: cwdHash });
      db.query(
        `UPDATE sessions SET cost_usd = COALESCE(?, cost_usd), max_context_pct = MAX(max_context_pct, ?), context_window = COALESCE(?, context_window) WHERE session_id = ?`,
      ).run(cost ?? null, pct, windowSize, sessionId);
      return;
    }
    const costChanged = cost !== undefined && cost !== row.cost_usd;
    const pctChanged = pct > row.max_context_pct;
    const windowChanged = windowSize != null && windowSize !== row.context_window;
    // The statusline sees the model in the chair right now; the analysis pass
    // sees which one did the session's work and writes that (transcript.ts).
    // Only seed it here — once analysis has spoken, a live "opus" over a
    // dominant "sonnet" would flip the column back on the very next tick, and
    // this runs ~1/s, so it would also mean a write per second for the whole
    // session. Seeding keeps a never-analyzed session from having no model.
    const seedModel = row.model === null ? model : undefined;
    const identityChanged = (seedModel !== undefined && seedModel !== row.model) || cwdHash !== row.cwd_hash;
    if (!costChanged && !pctChanged && !windowChanged && !identityChanged) return;
    if (identityChanged) {
      upsertSession(db, { session_id: sessionId, ts: new Date().toISOString(), model: seedModel, cwd_hash: cwdHash });
    }
    if (costChanged || pctChanged || windowChanged) {
      db.query(
        `UPDATE sessions SET cost_usd = COALESCE(?, cost_usd), max_context_pct = MAX(max_context_pct, ?), context_window = COALESCE(?, context_window) WHERE session_id = ?`,
      ).run(cost ?? null, pct, windowSize, sessionId);
    }
  } catch (err) {
    logError("statusline-write", err);
  }
}

interface GitStatus {
  branch: string | null;
  dirty: boolean;
}

/** One git subprocess (not two) — `--branch` folds the current branch into
 * the same `status --porcelain` call that reports the dirty state, so a
 * fresh statusline process (spawned every ~1s under refreshInterval) pays
 * for exactly one git invocation, not one per field. */
async function gitStatus(cwd: string): Promise<GitStatus> {
  try {
    const out = await $`git -C ${cwd} status --porcelain=v1 --branch`.quiet().text();
    const lines = out.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0 || !lines[0]!.startsWith("## ")) return { branch: null, dirty: false };
    const head = lines[0]!.slice(3);
    const branch = head.includes("(no branch)") ? "detached" : (head.split("...")[0]?.split(" ")[0] ?? null);
    return { branch, dirty: lines.length > 1 };
  } catch {
    return { branch: null, dirty: false }; // not a git repo, or git unavailable — statusline must never break on this
  }
}

/** One constant layout, always — no alarm view, no tip/loading view. Both
 * used to hijack the whole line (see contextAlarmLine/tipLine in ui.ts for
 * where that moved); the statusline's only remaining job is a steady HUD
 * that colors in place instead of restructuring. */
async function statusline(): Promise<void> {
  const payload = JSON.parse(await Bun.stdin.text());
  const sessionId: string = payload.session_id ?? "unknown";
  const cwd: string = payload.workspace?.current_dir ?? payload.cwd ?? process.cwd();
  const cwdHash = hashPath(cwd);
  const db = openDb();

  // Fast path: the host already computed context size for us in the
  // statusLine payload (context_window) — falls back to tailing the
  // transcript file only on hosts that don't send it yet. The
  // host-reported window size is persisted (local-only) so the rules
  // engine measures red-zone against the REAL window, not an assumed 200k.
  const hostCtx = contextFromPayload(payload);
  const ctx =
    hostCtx ?? (typeof payload.transcript_path === "string" ? await tailContext(payload.transcript_path) : null);
  const pct = ctx?.contextPct ?? 0;
  const cost: number | undefined = payload.cost?.total_cost_usd;
  syncSessionStats(db, sessionId, cwdHash, payload.model?.id, cost, pct, hostCtx?.limit ?? null);

  const tip = activeTip(db);
  const git = await gitStatus(cwd);

  const pctStr = pct >= 80 ? ansi("red", `${pct}%`) : pct >= 60 ? ansi("yellow", `${pct}%`) : `${pct}%`;
  // The dirty dot is a state marker, not part of the name. Glued on in the
  // default weight it renders as `main●` and reads as a branch literally
  // called that; the space plus yellow puts it in the same "attention, not
  // alarm" register the context percentage already uses.
  const branch = git.branch ? `🌿 ${git.branch}${git.dirty ? ` ${ansi("yellow", "●")}` : ""}` : null;
  const parts = [
    `${modelEmoji(payload.model?.id)} ${payload.model?.display_name ?? "Claude"}`,
    `⚡ ${pctStr} ctx ${bar(pct, 5)}`,
    branch,
    spendField(cost, payload.rate_limits),
    tip ? linkify("💡 1 tip", actionUrl("remy") ?? TIPS[tip.tip_id]?.docs) : null,
    isDevInstall() ? ansi("dim", `⚙ v${VERSION}+${BUILD_ID}`) : null,
  ].filter(Boolean);
  console.log(parts.join(ansi("dim", " · ")));
}

// --------------------------------------------------- click-to-run actions

// A statusline hyperlink can only open a URI — it cannot type into Claude
// Code. `remy links` installs a tiny macOS URL-scheme handler (remy://)
// that turns clicks into keystrokes in the frontmost terminal. Security: the
// handler maps a FIXED whitelist of URIs to commands and ignores everything
// else — arbitrary text can never ride in on a URL.
// Function, not module const: the CLI switch runs at module top level, before
// later const declarations initialize.
function clicksAppPath(): string {
  return join(dataDir(), "RemyClicks.app");
}

function clickActionsInstalled(): boolean {
  return process.platform === "darwin" && existsSync(clicksAppPath());
}

/** remy://<cmd> when the click handler is installed, else undefined (plain text). */
function actionUrl(cmd: string): string | undefined {
  return clickActionsInstalled() ? `remy://${cmd}` : undefined;
}

async function installClickActions(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("remy links: click-to-run actions are macOS-only for now.");
    return;
  }
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const srcPath = join(dir, "remy-clicks.applescript");
  writeFileSync(
    srcPath,
    [
      "on open location theURL",
      '\tset cmd to ""',
      '\tif theURL is "remy://compact" then set cmd to "/compact"',
      '\tif theURL is "remy://remy" then set cmd to "/remy"',
      '\tif theURL is "remy://dismiss" then set cmd to "/remy-dismiss"',
      '\tif cmd is "" then return',
      "\ttry",
      '\t\ttell application "System Events"',
      "\t\t\tkeystroke cmd",
      "\t\t\tdelay 0.2",
      "\t\t\tkey code 36",
      "\t\tend tell",
      "\ton error",
      '\t\tdisplay notification "Grant Accessibility to RemyClicks: System Settings → Privacy & Security → Accessibility" with title "remy"',
      "\tend try",
      "end open location",
      "",
    ].join("\n"),
  );
  const app = clicksAppPath();
  await $`rm -rf ${app}`.quiet();
  await $`osacompile -o ${app} ${srcPath}`.quiet();
  const plist = join(app, "Contents", "Info.plist");
  await $`plutil -replace CFBundleURLTypes -json ${'[{"CFBundleURLName":"remy actions","CFBundleURLSchemes":["remy"]}]'} ${plist}`.quiet();
  await $`plutil -replace LSUIElement -bool true ${plist}`.quiet();
  await $`/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f ${app}`.quiet();
  console.log(
    [
      `🐭 click-to-run installed → ${app}`,
      "statusline actions like /compact are now clickable (cmd+click).",
      "first click: macOS asks to open RemyClicks, then to grant it",
      "Accessibility (System Settings → Privacy & Security → Accessibility).",
      "uninstall: rm -rf ~/.remy/RemyClicks.app",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- report

function report(args: string[]): void {
  const db = openDb();
  const week = args.includes("--week");
  const raw = args.includes("--raw");
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const rows = recentSessions(db, since);
  const totals = weekTotals(rows);

  if (week) {
    const tipsWeek = db
      .query(`SELECT COUNT(*) AS n, COALESCE(SUM(est_savings_tokens), 0) AS tok FROM tips WHERE created_at >= ?`)
      .get(since) as { n: number; tok: number };
    console.log(
      renderWeek({
        rows,
        totals,
        wasteTips: tipsWeek.n,
        wasteTokens: tipsWeek.tok,
      }),
    );
    return;
  }

  const session =
    latestSessionForCwd(db, hashPath(process.cwd())) ??
    (db.query(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as SessionRow | null);
  if (!session) {
    console.log("🐭 REMY: no sessions recorded yet. Hooks capture data as you work — check back soon.");
    return;
  }
  const tips = sessionTips(db, session.session_id);
  const active = activeTip(db);
  if (raw) {
    console.log(JSON.stringify({ session, tips, active, totals }, null, 2));
    return;
  }
  const adaptLast = getSyncState(db, "last_adapt_at");
  console.log(
    renderReport({
      session,
      tips,
      active,
      adaptive: { enabled: adaptEnabled(db), lastRunHours: adaptLast ? hoursAgo(adaptLast) : null },
    }),
  );
}

// --------------------------------------------------------------- dismiss

function dismiss(args: string[]): void {
  const db = openDb();
  const requested = args.find((a) => !a.startsWith("-"));
  const now = new Date().toISOString();
  const current = activeTip(db);
  if (!current && !requested) {
    console.log("🐭 REMY: no active tip to dismiss. You're all caught up ✨");
    return;
  }
  const dismissedId = requested ?? current!.tip_id;
  const next = dismissTip(db, requested, now);
  const def = TIPS[dismissedId];
  console.log(`🐭 snoozed ${def ? `${def.emoji} ${def.title}` : dismissedId} for 30 days.`);
  if (next) console.log(`💡 up next: ${tipLine(next)}`);
  // A snoozed tip must leave the spinner too, or dismissing it changes nothing
  // where the user actually reads it.
  syncSpinnerTips(db, openTips(db));
}

// --------------------------------------------------------------- spinner

function spinner(args: string[]): void {
  const db = openDb();
  const path = settingsPath();
  if (args.includes("--off")) {
    const out = clearSpinnerTips(db);
    console.log(
      out.status === "user-owned"
        ? `🐭 spinnerTipsOverride in ${path} wasn't written by REMY — left untouched.`
        : `🐭 spinner tips handed back to Claude Code → ${path}`,
    );
    return;
  }
  if (args.includes("--status")) {
    const open = openTips(db);
    const owned = syncSpinnerTips(db, open);
    const state = !spinnerEnabled()
      ? "off (COACH_SPINNER=0)"
      : owned.status === "unclaimed"
        ? "not claimed — run `remy spinner` to take the line"
        : owned.status === "user-owned"
          ? "held by a spinnerTipsOverride remy didn't write"
          : "on";
    console.log(`🐭 spinner tips: ${state} → ${path}`);
    const deck = desiredTips(open);
    console.log(`   rotating ${deck.length} line(s):`);
    for (const line of deck.slice(0, 5)) console.log(`   · ${line}`);
    if (deck.length > 5) console.log(`   · …and ${deck.length - 5} more`);
    return;
  }
  const out = claimSpinnerTips(db, openTips(db));
  switch (out.status) {
    case "user-owned":
      console.log(`⚠️  ${path} already has a spinnerTipsOverride remy didn't write — leaving it alone.`);
      console.log("   remove it by hand to let remy take the line.");
      return;
    case "unreadable":
      console.log(`✖ couldn't update ${path} — details in ~/.remy/remy.log`);
      return;
    case "disabled":
    case "unclaimed":
      console.log("🐭 spinner tips are off (REMY_SPINNER=0) — unset it to take the line.");
      return;
    default:
      console.log(`🐭 REMY owns the spinner tip line → ${path}`);
      for (const line of out.tips.slice(0, 5)) console.log(`   · ${line}`);
      console.log("\nRestart Claude Code to see it under the spinner.");
  }
}

// ------------------------------------------------------------------ init

function init(args: string[]): void {
  const global = args.includes("--global");
  const refreshArg = argValue(args, "--refresh");
  const refreshInterval = refreshArg ? Math.max(1, Math.round(Number(refreshArg)) || 1) : 1;
  const dir = global ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      logError("init", err);
      console.log(`⚠️  ${settingsPath} is not valid JSON — fix it and re-run \`remy init\`.`);
      return;
    }
  }
  // Merge, not replace: the statusLine block can carry host settings we
  // don't own (padding, hideVimModeIndicator) — clobbering it loses them.
  const existing = (settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : {}) as Record<
    string,
    unknown
  >;
  const launcher = launcherPath();
  settings.statusLine = {
    ...existing,
    type: "command",
    command: `"${launcher}" statusline`,
    // Event-driven repaints alone leave the statusline frozen for the
    // length of a tool run or a quiet thinking block — this is what makes
    // the loading-screen tip actually redraw while Claude is generating.
    refreshInterval,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(
    [
      "  ,__,",
      " (o,o)       REMY statusline installed",
      ` (")_(")~~~  → ${settingsPath} (refresh every ${refreshInterval}s)`,
      "",
      '     ⚙ also: "remy spinner" puts your tip under Claude Code\'s spinner',
      "",
      "Restart Claude Code (or /statusline) to see it.",
    ].join("\n"),
  );
  // The written command is an absolute path baked into a real project's
  // settings. If REMY_HOME was redirected — which is exactly what the dogfood
  // and driver workflows do — that path points inside a temp directory that
  // gets cleaned up, and from then on the statusline renders NOTHING: the
  // launcher exits 0 on every failure by design, so there is no error to see.
  // This has cost a developer their statusline once already.
  if (isTemporary(launcher)) {
    console.log(
      [
        "",
        `⚠️  that path is inside the system temp directory, so it will be cleaned up.`,
        `   When it goes, the statusline renders nothing and says nothing — the`,
        `   launcher exits 0 on every failure path.`,
        `   REMY_HOME is probably redirected; re-run \`remy init\` without it.`,
      ].join("\n"),
    );
  }
}

/** Is this path inside the OS temp directory? Compared through realpath so
 * macOS's /var → /private/var symlink doesn't hide the answer. */
function isTemporary(path: string): boolean {
  try {
    const tmp = realpathSync(tmpdir());
    return realpathSync(dirname(path)).startsWith(tmp);
  } catch {
    return false;
  }
}

/** A stable path for anything that outlives a single version — the
 * statusline command, mostly. Writing process.execPath there would pin
 * settings.json to `remy-0.2.0-darwin-arm64`, which stops existing the moment
 * the plugin upgrades. This launcher resolves `current` at run time instead,
 * and stays quiet when no binary is installed yet. */
function launcherPath(): string {
  const dir = binDir();
  const path = join(dir, "remy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    ['#!/bin/sh', '# remy launcher — resolves whichever binary version is current.', 'BIN="$(dirname "$0")/current"', '[ -x "$BIN" ] || exit 0', 'exec "$BIN" "$@"', ''].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

// ------------------------------------------------------------------ help

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function help(): void {
  console.log(
    [
      `REMY v${VERSION} — the coaching layer for AI coding agents 🐭`,
      "",
      "everything stays on this machine — nothing is ever uploaded.",
      "",
      "usage: remy <command>",
      "  ingest       (internal) consume a Claude Code hook event from stdin",
      "  statusline   (internal) render the statusline from stdin payload",
      "  report       session report · --week for 7-day rollup · --raw for JSON",
      "  dismiss [id] snooze the active tip (or a specific tip id) for 30 days",
      "  init         install the statusline into .claude/settings.json (--global for user-wide · --refresh <seconds>, default 1)",
      "  spinner      put your coaching line under Claude Code's spinner (--off to hand it back · --status)",
      "  links        make statusline actions clickable — installs the remy:// click handler (macOS)",
      "  adapt        run the adaptive analyzer now (--on/--off/--status · --force to bypass the daily budget)",
    ].join("\n"),
  );
}
