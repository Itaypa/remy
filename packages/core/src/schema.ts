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
// The host emits two shapes this charset originally excluded, both bounded
// identifiers rather than free text: `claude-opus-5[1m]` for the 1M-context
// variants, and `<synthetic>` for placeholder turns that carry no usage. They
// were reaching sessions.model anyway (see upsertSession — the write site had
// no gate), so the honest fix is to admit them here and then enforce it, not
// to keep a regex that production data already violates. Still no "/", no
// whitespace, still capped: path-shaped values remain structurally impossible.
export const ModelStr = z.string().min(1).max(80).regex(/^[\w.:<>\[\]-]+$/);
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

/** What the sensor mod reports about the context window, once the CLI has
 * hashed the server names: `/context` as numbers. Same whitelist discipline
 * as the event — a server is a 16-hex hash of its wire segment, every other
 * field is a count, and anything else is stripped. The mod itself never
 * touches the store; this is the only door its report comes through. */
const Count = z.number().int().nonnegative();
export const ContextProfileSchema = z
  .object({
    session_id: IdStr,
    ts: IsoTs,
    window: Count,
    system_prompt_tokens: Count.default(0),
    system_tools_tokens: Count.default(0),
    memory_tokens: Count.default(0),
    skills_tokens: Count.default(0),
    agents_tokens: Count.default(0),
    messages_tokens: Count.default(0),
    mcp: z
      .array(
        z
          .object({
            server_hash: Hash16,
            tools: Count,
            loaded_tools: Count,
            tokens: Count,
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

/** Privacy gate for the mod's report: a whitelisted profile or null. Strict,
 * unlike the event schema — the sender is our own code, so an unknown key is
 * a bug to surface, not host noise to strip. Never throws. */
export function sanitizeContextProfile(raw: unknown): ContextProfile | null {
  const res = ContextProfileSchema.safeParse(raw);
  return res.success ? res.data : null;
}

export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

/** Privacy gate: returns a whitelisted event or null. Never throws. */
export function sanitizeEvent(raw: unknown): SessionEvent | null {
  const res = SessionEventSchema.safeParse(raw);
  return res.success ? res.data : null;
}
