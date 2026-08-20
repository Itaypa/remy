// Builds Claude Code transcript JSONL for tests: the exact wire shape the
// parser reads, with none of the content it deliberately ignores.
//
// This is the input half of the "toxic driver" suite — every wasteful pattern
// REMY detects starts as a sequence of turns in a file like this. It lives in
// core/test/support so both tiers can share it: the fast tier feeds the string
// straight to parseTranscript, the e2e tier writes it to disk and hands the
// path to a real `remy ingest` Stop hook.
//
// Every synthetic path and command embeds MARKER, so any test can assert the
// privacy invariant for free: if a raw path ever reaches the DB, the log, or
// stdout, a scan for this one string finds it.

export const MARKER = "TOXIC_MARKER_should_never_be_stored";

/** Session clock origin. Fixed so gap-sensitive fixtures are reproducible. */
const EPOCH = Date.UTC(2026, 7, 1, 9, 0);

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TurnOpts {
  usage?: Usage;
  model?: string;
  sidechain?: boolean;
}

export interface CallOpts extends TurnOpts {
  /** false emits a matching tool_result with is_error — the only thing that
   * marks a call failed to the parser (PostToolUseFailure hooks do not). */
  ok?: boolean;
}

/** A turn that costs almost nothing: keeps context far below every band so a
 * fixture only trips the rule it is aiming at. */
const LIGHT: Usage = { input_tokens: 1_200, output_tokens: 300 };

/** A path that is unmistakably a path, and unmistakably ours. */
export const file = (name: string): string => `/toxic/${MARKER}/src/${name}`;

export class TranscriptBuilder {
  private readonly lines: string[] = [];
  private msgSeq = 0;
  private toolSeq = 0;
  private minutes = 0;
  private model = "claude-fable-5";

  /** Advance the session clock without emitting anything — the idle gap that
   * expires a prompt cache. */
  idle(mins: number): this {
    this.minutes += mins;
    return this;
  }

  useModel(model: string): this {
    this.model = model;
    return this;
  }

  /** A bare assistant turn. Shapes context without adding a tool call. */
  turn(opts: TurnOpts = {}): this {
    this.emitTurn([], opts);
    return this;
  }

  /** One assistant turn carrying one tool call. */
  call(name: string, input: Record<string, unknown>, opts: CallOpts = {}): this {
    const id = `tool${++this.toolSeq}`;
    this.emitTurn([{ type: "tool_use", id, name, input }], opts);
    if (opts.ok === false) {
      this.lines.push(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] },
        }),
      );
    }
    return this;
  }

  read(name: string, opts: CallOpts = {}): this {
    return this.call("Read", { file_path: file(name) }, opts);
  }

  edit(name: string, opts: CallOpts = {}): this {
    return this.call("Edit", { file_path: file(name) }, opts);
  }

  write(name: string, opts: CallOpts = {}): this {
    return this.call("Write", { file_path: file(name) }, opts);
  }

  bash(command: string, opts: CallOpts = {}): this {
    return this.call("Bash", { command: `${command} # ${MARKER}` }, opts);
  }

  planTool(): this {
    return this.call("ExitPlanMode", { plan: MARKER });
  }

  taskTool(): this {
    return this.call("Task", { description: MARKER });
  }

  /** A retry run: n consecutive identical calls, every one of them failing.
   * ≥3 is what `retry-loop` looks for. */
  failedRun(name: string, input: Record<string, unknown>, n: number): this {
    for (let i = 0; i < n; i++) this.call(name, input, { ok: false });
    return this;
  }

  /** Repeat any builder step n times — `t.times(6, (b) => b.edit("api.ts"))`. */
  times(n: number, fn: (b: this, i: number) => void): this {
    for (let i = 0; i < n; i++) fn(this, i);
    return this;
  }

  /** What /compact writes: the post-compact context size, and a marker that
   * the next turn's cache re-write is legitimate rather than an expiry. */
  compactBoundary(postTokens: number): this {
    this.lines.push(
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        isSidechain: false,
        compactMetadata: { trigger: "manual", preTokens: 160_252, postTokens },
      }),
    );
    return this;
  }

  jsonl(): string {
    return this.lines.join("\n");
  }

  private emitTurn(content: unknown[], opts: TurnOpts): void {
    const at = new Date(EPOCH + this.minutes * 60_000).toISOString();
    this.minutes += 1;
    this.lines.push(
      JSON.stringify({
        type: "assistant",
        isSidechain: opts.sidechain ?? false,
        timestamp: at,
        message: {
          id: `msg${++this.msgSeq}`,
          model: opts.model ?? this.model,
          usage: opts.usage ?? LIGHT,
          content,
        },
      }),
    );
  }
}

export function transcript(build: (t: TranscriptBuilder) => void): string {
  const t = new TranscriptBuilder();
  build(t);
  return t.jsonl();
}
