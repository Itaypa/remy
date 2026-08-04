import { homedir } from "node:os";
import { join } from "node:path";

// Environment knobs are read through here so the rename from `coach` to
// `remy` never strands an existing install: REMY_* wins, COACH_* still
// answers. Legacy names are read-only compatibility — new knobs get a REMY_
// name and nothing else.

export function envVar(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[`REMY_${name}`] ?? env[`COACH_${name}`];
}

export function envFlag(name: string, env: Record<string, string | undefined> = process.env): boolean | undefined {
  const raw = envVar(name, env);
  if (raw === undefined) return undefined;
  return raw !== "0" && raw !== "false";
}

/** Where the compiled binaries live — always `~/.remy/bin`, matching the
 * plugin launcher's own resolution (REMY_HOME/COACH_HOME override both).
 * Deliberately NOT dataDir(): an install carried over from the coach era
 * keeps its database in `~/.coach`, and pointing binaries at the data
 * directory put the launcher somewhere no build ever writes. */
export function binDir(): string {
  const home = envVar("HOME") ?? join(homedir(), ".remy");
  return join(home, "bin");
}
