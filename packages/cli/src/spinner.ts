import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { HINTS, envVar, getSyncState, logError, setSyncState, type TipRow } from "@ccpp/core";
import { tipLineLong } from "./ui";

// The spinner tip line — the text Claude Code prints under "Forging… (2m 30s)"
// while it works. The host picks it from `spinnerTipsOverride` in
// settings.json, so the remy can own the one surface a developer is
// guaranteed to be reading: the idle wait. Zero tokens, like every other
// coaching channel — this is a file write, not a message to the model.
//
// The host's own tip list (~50 entries: "Use /theme to change the color
// theme") is generic and never personalized; ours is the open finding queue,
// spoken with this session's own numbers, or the hint deck when there's
// nothing to remy. Rotation between entries is the host's job — it shows the
// least-recently-seen one and records the show — so a multi-entry deck moves
// on by itself between waits, no dismissing required.

const OWNED_KEY = "spinner_tips_written";

export function settingsPath(): string {
  return envVar("SETTINGS_PATH") || join(homedir(), ".claude", "settings.json");
}

export function spinnerEnabled(): boolean {
  return envVar("SPINNER") !== "0";
}

/** The deck the host rotates through: every open finding, best-value first,
 * in wide-surface form — so the queue moves on its own between waits instead
 * of parking on one line until it's dismissed. The host picks the
 * least-recently-shown entry and records the show, so entry N+1 comes up on
 * the next spinner. (Rotation is keyed by position, `custom-tip-N`, so a
 * re-ordered deck restarts that bookkeeping — harmless, it just re-shuffles.)
 * Nothing to remy → the hint deck, same rotation. */
export function desiredTips(tips: TipRow[]): string[] {
  return tips.length > 0 ? tips.map(tipLineLong) : [...HINTS];
}

export type SpinnerSync =
  | { status: "written" | "unchanged" | "cleared"; tips: string[] }
  | { status: "disabled" | "user-owned" | "unclaimed" | "unreadable" };

/** Refresh the line — but only while the remy owns it. Hooks call this on
 * every SessionStart and Stop, and it stays a no-op until the developer runs
 * `remy spinner` once: silently writing into someone's global settings is
 * exactly the kind of thing this product refuses to do elsewhere (org tool
 * recs are display-only, nothing auto-installs). Deleting the key by hand is
 * therefore a valid uninstall — the remy stops touching it. */
export function syncSpinnerTips(db: Database, tips: TipRow[]): SpinnerSync {
  if (!spinnerEnabled()) return { status: "disabled" };
  return writeOverride(db, desiredTips(tips), false);
}

/** Take the surface: `remy spinner`, the one explicitly-asked-for write. */
export function claimSpinnerTips(db: Database, tips: TipRow[]): SpinnerSync {
  if (!spinnerEnabled()) return { status: "disabled" };
  return writeOverride(db, desiredTips(tips), true);
}

/** Hand the surface back to the host: drop our key, keep everything else. */
export function clearSpinnerTips(db: Database): SpinnerSync {
  return writeOverride(db, null, true);
}

function writeOverride(db: Database, tips: string[] | null, claim: boolean): SpinnerSync {
  const path = settingsPath();
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings is not an object");
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      // Malformed settings are the user's to fix; writing over them would
      // destroy whatever they were mid-edit on.
      logError("spinner", err);
      return { status: "unreadable" };
    }
  }

  const current = settings.spinnerTipsOverride as { tips?: unknown } | undefined;
  const currentTips = Array.isArray(current?.tips) ? (current!.tips as unknown[]).map(String) : null;
  if (currentTips && !sameTips(currentTips, lastWritten(db))) return { status: "user-owned" };
  if (!currentTips && !claim) return { status: "unclaimed" };

  if (tips === null) {
    if (!current) return { status: "cleared", tips: [] };
    delete settings.spinnerTipsOverride;
  } else {
    if (currentTips && sameTips(currentTips, tips)) return { status: "unchanged", tips };
    // excludeDefault drops the host's generic deck — with it on, the line is
    // ours every time, which is the whole point of taking the surface.
    settings.spinnerTipsOverride = { excludeDefault: true, tips };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.remy-tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    logError("spinner", err);
    return { status: "unreadable" };
  }
  setSyncState(db, OWNED_KEY, tips === null ? "" : JSON.stringify(tips));
  return tips === null ? { status: "cleared", tips: [] } : { status: "written", tips };
}

function lastWritten(db: Database): string[] | null {
  const raw = getSyncState(db, OWNED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function sameTips(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((s, i) => s === b[i]);
}
