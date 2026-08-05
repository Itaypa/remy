# S17 — Whole files read when a slice was asked for

**Status: shipped 2026-08-06.** One deviation from this spec, found by running the rule
against the real corpus: the yield to `reread-churn` is **per-target**, not blanket. A
blanket yield (my first implementation) suppressed the single largest whole-file waste in
the corpus — 914k tokens across 17 reads — because that same session also tripped
`reread-churn` for 2k. It now yields only when *every* oversized read was of a file
`reread-churn` is already billing, which is what "on the same target hash" meant.

## The mistake

You ask about one function; the agent reads the whole 4,000-line file. That result lands
in the context window intact and stays there, and every turn afterwards re-reads it at
cache-read prices. Locally this is the single largest tool-shaped waste in the corpus:
`Read` results total **7.78M characters ≈ 1.95M tokens**, with a p95 of 117,944 characters
and a worst single result of 471,536 — about **118k tokens in one tool result**, more than
half of a 200k window from a single call. Bash, which the reported writeups blame, is by
comparison the best-behaved tool here (p95 2,222 chars).

## Trend evidence

- Practitioner writeups on token efficiency all name unfiltered tool output as a top cost,
  though they consistently frame it as shell logs (["a 12k-token shell trace"](https://buildtolaunch.substack.com/p/claude-code-token-optimization)).
  **The local data says that framing is backwards** — the shell is fine; unbounded `Read`
  is where the tokens go. The finding survives, the blame moves.
- Anthropic's own cost guidance recommends [code-intelligence plugins](https://code.claude.com/docs/en/costs)
  precisely to avoid "a grep followed by reading multiple candidate files", and PreToolUse
  truncation hooks exist as a documented mitigation for oversized results.
- `Read` takes `offset`/`limit`, so the bounded form is a first-class feature, not a
  workaround.

## Detection

`Read` tool results are already resolved in `transcript.ts` (the `type:"user"` tool_result
branch resolves `tool_use_id` → `ToolCall`). Measure the **length of the result** — a
number — and never the content.

```
FAT_READ_TOKENS = 8_000   // one result this big is a whole-file read, not a slice
FAT_READ_MIN    = 3       // one big file is a legitimate need; three is a habit
```

- `8_000` tokens ≈ 32k characters: comfortably above the p50 (2,179 chars) so ordinary
  reads never count, and well below the fat tail (p95 117,944) so the real offenders all
  do. It is ~2.5× the p50 of the fat tail itself.
- `3` follows the house pattern (`REREAD_MIN`, the read-command floor): a single large
  file is often exactly what was needed; three in one session is a habit with a lever.

Estimate: the tokens **above** what a bounded read would have cost, charged once —
`(fatReadTokens - fatReads × FAT_READ_TOKENS) × 0.9`. The 0.9 is because the excess is
paid at write price once and at cache-read price thereafter.

## What it must NOT fire on

1. **A single large read.** Sometimes you do need the whole file.
2. **Non-`Read` tools.** Scope strictly to `call.name === "Read"`. The browser MCP's p95 is
   166,100 characters of base64 image — enormous, and not a user choice.
3. **`reread-churn` on the same target.** That rule already bills repeated reads of one
   file; stacking would charge the same file twice under two tip ids, exactly the failure
   `applyClaudeMd` was written to avoid.
4. **Pre-turn-one reads.** Yield to `context-tax`, which already bills the startup pack.
5. **Sessions with no result-length data** — older transcripts, or a host that stops
   inlining results. Absent means silent.

## Storage

**Nothing new stored.** The counts live on `TranscriptStats` → `SessionSnapshot`, the same
path `redZoneTurns` and `cacheExpiries` take. Result *content* is never read into a
variable that outlives the length computation, never hashed, never persisted.

## Surface

A new rule-backed tip. It does not collide with `tools-over-bash` (that fires on Bash
read-commands; this fires on the `Read` tool doing exactly what it was told) and yields to
`context-tax` and `reread-churn` per the negatives above.

## Tip copy

- `short` (≤55): `{count} whole files read → ask for the slice you need`
- `live`: `{count} reads pulled whole files into context (worst ~{worst_k}k 🪙) — name the
  function or a line range next time`
- `what`: `{count} Read results landed whole files in the window, the largest ~{worst_k}k
  tokens — the window then carries them for every turn that follows.`
- `fix`: `Ask for the part you need: a symbol name, or Read with offset/limit. Grep first
  when you're hunting — it returns matches, not files.`

## Tests

- Fires at 3 oversized results; silent at 2; silent when the same bytes arrive as many
  small reads.
- **Negative:** a session with one 400k-character read and nothing else stays silent.
- **Negative:** oversized results from a non-`Read` tool (a browser MCP image) never count.
- Does not stack with `reread-churn` on the same target hash.
- The result content never reaches the finding: assert the evidence carries only numbers.

## Open objection — Seat B, unresolved

Seat B argued this should **extend `tools-over-bash` rather than become a new tip**: the
behavioural fix is the same ("ask for filtered output; pin it in CLAUDE.md"), the shipped
tip's `what` already says "output lands in the context whole", and a second tip for one
habit is a second nag against a one-slot noise budget. It wanted the fat result cited as
*evidence* on the existing tip, per the S12 precedent.

I ruled for a separate tip: the trigger populations are disjoint — `tools-over-bash`
requires Bash read-commands and stays silent for a user who correctly uses `Read`, which
is precisely the user this fires on. Calling them one habit would leave the correct-tool
user uncoached. Seat B's underlying constraint is kept, though: this must yield to
`context-tax` and must never stack with `reread-churn`, so no session is ever billed twice
for the same bytes. If the two tips are observed firing in the same week on real data,
revisit the merge.
