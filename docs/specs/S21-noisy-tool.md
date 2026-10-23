# S21 — One tool keeps flooding the window

**Status: shipped 2026-10-23** (v0.4.0), tip `noisy-tool`.

## The mistake

A tool whose *typical* result is enormous: a web fetch that returns the whole page, an MCP
query with no filter, a browser snapshot on every step. Each result lands in the window
whole and is carried for every turn after — the same waste S17 named for `Read`, for every
other tool. S17 deliberately excluded them because the browser MCP's results looked like
100k-token monsters; they were base64 images, and the API prices an image by its pixels
(~1.6k at the 1568px cap), not by the string that encodes it.

## Detection

- `transcript.ts` now weighs every `tool_result`: text at chars/4, image blocks at a flat
  1,600, into a per-tool `toolResultProfile` (calls, total, worst, median). Nothing new is
  stored; the profile is computed at analysis time like the fat-read stats.
- `detectNoisyTool`: a tool with ≥3 results whose **median** is ≥6k tokens. `Read` is left
  to `read-in-slices` (it can name the file). The heaviest offender is named as
  `server/tool` for MCP names, bounded to 28 characters.
- Estimate: `(total − calls × 6k) × 0.9`, input class — the same shape as S17.

## Must NOT fire

- One oversized result among small ones (the median decides).
- A browser session of screenshots (five images ≈ 8k, not 500k).
- `Read` floods — those are `read-in-slices`.

## Copy

`{tool} returned ~{avg_k}k tokens per call, {calls} times — {total_k}k parked in the
window → ask for less: a filter, a range, a page`
