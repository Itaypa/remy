import { z } from "zod";
import { createHash } from "node:crypto";

export const HOST = "claude-code";

// Privacy invariant: this schema is a WHITELIST. Unknown keys are stripped at
// parse time, so free-text payloads (prompts, code, file contents, raw paths)
// physically cannot reach the store. Every string field is an enum, a 16-hex
// hash, or charset-constrained with no "/" — path-shaped strings cannot pass.
// Widening this schema is a design change — update
// packages/core/test/privacy.test.ts in the same PR.

export const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
export const IsoTs = z.string().max(40).regex(ISO_TS_RE);
export const IdStr = z.string().min(1).max(128).regex(/^[\w.:-]+$/);
export const ModelStr = z.string().min(1).max(80).regex(/^[\w.:-]+$/);
export const Hash16 = z.string().regex(/^[0-9a-f]{16}$/);
export const HostStr = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/);
export const HostVersionStr = z.string().min(1).max(32).regex(/^[\w.-]+$/);
export const ToolNameStr = z.string().min(1).max(64).regex(/^[\w.:-]+$/);

export const EventTypeSchema = z.enum([
  "session_start",
  "prompt",
  "tool_use",
  "compact",
  "stop",
  "session_end",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const TokenUsageSchema = z.object({
  in: z.number().int().nonnegative().default(0),
  out: z.number().int().nonnegative().default(0),
  cache_read: z.number().int().nonnegative().default(0),
  cache_write: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const SessionEventSchema = z.object({
  session_id: IdStr,
  ts: IsoTs,
  host: HostStr.default(HOST),
  host_version: HostVersionStr.optional(),
  type: EventTypeSchema,
  model: ModelStr.optional(),
  tokens: TokenUsageSchema.optional(),
  context_pct: z.number().min(0).max(100).optional(),
  tool: z
    .object({
      name: ToolNameStr,
      ok: z.boolean().default(true),
      target_hash: Hash16.optional(),
    })
    .optional(),
  compact_trigger: z.enum(["auto", "manual"]).optional(),
  // No repo_hash: it was whitelisted here but no caller ever set it (0 of
  // 2,372 local events). Narrowing the whitelist is always safe; see the
  // vestigial-column note in store.ts for why the DB columns stay.
  cwd_hash: Hash16.optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

/** Privacy gate: returns a whitelisted event or null. Never throws. */
export function sanitizeEvent(raw: unknown): SessionEvent | null {
  const res = SessionEventSchema.safeParse(raw);
  return res.success ? res.data : null;
}
