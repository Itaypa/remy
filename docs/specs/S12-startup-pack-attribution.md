# S12 — Startup-pack attribution: let `context-tax` name its biggest cause

**Status: shipped 2026-08-06** (part 1 the probe + columns, part 2 the attribution).
Kept for the reasoning; the landmine section below is now the documentation of why
`TipDef.fallbacks` exists.

**What the build changed against this spec.** The adversarial review found four defects
in the drafted copy, all folded in:
- The drafted `fix` *replaced* the shipped sentence. It now **appends** — `claude-md-prune`
  is suppressed whenever `context-tax` fires, and the stated reason is that this fix
  already says "prune CLAUDE.md". Dropping either imperative would have left a user with
  a bloated CLAUDE.md told the number and never told to cut it, and made the suppression
  unearned. Locked by a test.
- The copy says "skill descriptions", not "plugin skills". The probe sums plugin,
  personal (`~/.claude`) and project skills, so naming plugins as *the* cause asserts
  something it never measured.
- Option 1 ("fill unconditionally at the rule") was **not sufficient on its own**: it
  cannot reach tip rows already sitting in a user's DB, which keep the evidence they were
  written with until the same rule fires again. Hence `TipDef.fallbacks`, merged under
  real evidence at both render sites.
- Attribution went in `fix` only, never `what`: the adaptive prompt slices this tip's
  catalog line at 220 chars and already cuts mid-way through `fix`, so anything added to
  `what` would push more of it out of the model's view.

**Not done, and why:** `packages/core/test/support/scenarios.ts` has no skill-pack knob,
so the coverage matrix cannot express "measured skills". That file was uncommitted work
belonging to the developer at build time and was left untouched; `skillBytes` is optional
on `SessionSnapshot` precisely so it compiles unchanged.

> **Correction, measured after the council (2026-08-06).** The council's headline —
> 81 skills / 26,357 B / "2.7× CLAUDE.md" — was inflated ~2.6×. It came from walking
> `~/.claude/plugins/`, which includes `marketplaces/` (a browsable catalog of plugins
> that are *not installed*) and a plugin that is installed but **disabled**. Resolving
> installs from `installed_plugins.json` and honouring `enabledPlugins` gives the real
> figure on this machine: **35 skills, 10,176 B ≈ 2.5k tokens every session start**,
> against this repo's CLAUDE.md at 9,659 B ≈ 2.4k. So skills are roughly *equal* to
> CLAUDE.md here, not triple it. The finding survives — it is still the largest
> component of the startup pack that `context-tax` can measure and does not name, and
> it is still inherited rather than chosen — but any copy quoting "2.7×" is wrong.

## The mistake

You enabled a handful of plugins. You inherited dozens of skills. Every one of their
descriptions is loaded before you type a word, on every session, whether you invoke them
or not — and unlike CLAUDE.md, you never wrote a line of it, which is exactly why nobody
notices. Measured on this machine: **35 distinct skills, 10,176 B of name+description
≈ 2.5k tokens at every session start**, against this repo's own CLAUDE.md at 9,659 B
≈ 2.4k. Against a measured `firstContextTokens` of p50 37k that is ~7% of the startup
pack — the same order as CLAUDE.md, which the product already coaches on. REMY already bills the user for this pack via `context-tax`, and
its fix line says "Disconnect MCP servers you rarely use and prune CLAUDE.md" — it names
the two smaller levers and stays silent about the largest one it can measure. That is the
product showing worse information than it already possesses.

## Trend evidence

- [Anthropic, Manage costs effectively](https://code.claude.com/docs/en/costs) — "Your
  CLAUDE.md is loaded into context at session start… aim to keep it under 200 lines",
  and skills are recommended as the *fix* for CLAUDE.md bloat, which is what creates the
  inverse failure once a plugin ships dozens of them.
- [Team-adoption anti-patterns, 2026](https://www.digitalapplied.com/blog/claude-code-anti-patterns-team-adoption-failure-modes-2026) —
  "skill sprawl" named as one of eight; "fifty skills nobody remembers", top five are
  90%+ of invocations, long tail at zero; suggested cap ≈20.
- Local measurement (2026-08-06, host 2.1.220), from the shipped probe rather than a
  directory walk: **35 skills, 10,176 B**, of which 32 skills are plugin-inherited and 3
  are this repo's own. One installed plugin is disabled and correctly contributes 0.

## Detection

**Nothing new fires.** `context-tax` keeps its shipped trigger
(`firstContextTokens ≥ CONTEXT_TAX_MIN_TOKENS`, currently 45k) and its shipped estimate.
The only change is that its copy names the largest measured component of the pack.

Inputs, both now on the session row (part 1, shipped):

- `sessions.skill_bytes` — summed `name + description` frontmatter bytes of the skills
  the host would actually load. NULL = never probed, 0 = probed and none. **NULL ≠ 0**,
  the same discipline `claude_md_bytes` uses.
- `sessions.skill_count` — distinct skills behind that number.

## What it must NOT fire on

1. **`skill_bytes IS NULL`** — never probed. Every pre-existing row is NULL; treating it
   as 0 would claim "you have no skills" on the entire back catalogue.
2. **Disabled plugins.** `settings.json` → `enabledPlugins` can be `false` for a plugin
   whose skills are still on disk and never load. Billing a user for skills they already
   disabled is the single worst correctness trap here.
3. **Plugin-cache duplicates.** The same plugin appears on disk under both a version
   directory and a hash directory (`vercel/0.45.1` and `vercel/19606ac163fe`). The probe
   de-duplicates by skill name, since the host loads one copy of each.
4. **Skill bodies.** Only frontmatter loads at session start, and bodies are two orders
   of magnitude larger — measuring whole files overstates the tax ~46×.
6. **Oversized frontmatter.** A single small read is a trap: the `ai-sdk` skill runs
   15,705 B before its closing `---`, so a 4KB head silently drops the *heaviest*
   skills. The probe reads small, then re-reads big on a miss. This one bit during
   development and cost 30% of the measured weight.
5. **Marketplace-cached-but-uninstalled** plugins, and `.claude/skills/` belonging to
   repos other than this session's cwd.

## Storage

Two INTEGER columns on `sessions`, coerced at the write site exactly like
`setClaudeMdBytes` (SQLite's INTEGER affinity does not reject a string, so the column
type is not the guarantee — the coercion is). No change to `SessionEventSchema`; the
whitelist question never arises because nothing here goes through the event path.

## Surface

`context-tax`, unchanged in when it fires and which channel it uses. No new catalog entry.

### The render landmine — read this before touching the copy

`tipBody` in `packages/cli/src/ui.ts` falls back to `def.title` when **any** `{placeholder}`
in the template is unresolved (`UNRESOLVED_PLACEHOLDER` at ui.ts:134). It does that on
purpose: the adaptive analyzer files tips with no session numbers, and rendering
"Same file edited {edits}×" on the statusline is worse than rendering the title.

So naively adding `{skill_k}` to `context-tax`'s `short`/`live`/`what` would mean: every
session where the probe didn't run — which is **every existing row**, plus any session
where the probe failed — silently loses the `pct` number it shows today and collapses to
the bare title "Heavy pack before turn one". That is a regression to the shipped tip,
paid by exactly the users we have the least information about.

Whatever the next cycle builds must degrade safely. The options, in the order they should
be considered:

1. **Fill the placeholders unconditionally at the rule**, substituting a form that reads
   correctly when unmeasured — the evidence object is built in `detectContextTax`, so it
   can always emit every key the template asks for.
2. Keep the numbers out of the template and put the attribution only in the long-form
   `what`/`fix`, which render on wide surfaces where a fallback is less costly.
3. A second catalog id, chosen by the rule when a measurement exists — the codebase's own
   precedent for conditional copy (`claude-md-missing` vs `claude-md-prune`), but it costs
   a catalog entry and the council explicitly resolved on "no new tip".

Option 1 is the recommendation. Do not pick 3 without re-reading the Open objection below.

## Tip copy

No new tip. `context-tax`'s existing copy gains the attribution, keeping the shipped
`{pct}` lead and naming the levers with their own numbers rather than in the abstract —
largest first, so the sentence itself is the ranking:

- `fix` (draft): "Largest first: {skill_k}k is plugin skill descriptions (`/plugin` to
  disable packs you never invoke), {md_k}k is CLAUDE.md. `/context` shows the rest."

`short` stays as shipped — 55 chars has no room for attribution, and the statusline is
the wrong surface for a three-way breakdown.

## Tests

- Probe: enabled vs disabled plugin (the disabled one contributes 0); duplicate plugin
  directories counted once; frontmatter counted, body not; missing/malformed frontmatter
  contributes 0 rather than throwing; a nonexistent root returns 0.
- Store: a hostile value cannot reach `skill_bytes`/`skill_count` (INTEGER affinity is
  not the guarantee) — mirrors the existing `claude_md_bytes` privacy test.
- **Negative/regression (the one that matters):** a `context-tax` finding on a session
  with `skill_bytes = NULL` still renders its `pct` number and does **not** collapse to
  the bare title. Write this test first; it is the landmine above, in executable form.

## Open objection — the Fable seat, unresolved

The Fable seat argued for a **distinct `skill-sprawl` tip that replaces `context-tax`**
when skills dominate the measured pack, on the precedent that `claude-md-missing` fires
alongside `reread-churn` and replaces it (S4): "yielding means the session where we
finally *know* which lever is biggest is the session we show the tip that names the
smaller ones." Its draft copy: `short` = `{count} skills load before turn 1 → disable idle
plugins` (51 chars), on the session-start splash, because the tax is levied at that exact
moment.

I resolved for attribution over a new tip: it satisfies the same user need at zero cost
to the noise budget, and the noise budget is the harder constraint to buy back later. The
objection stands on one point that the attribution design does not answer — a tip's
*identity* is what makes it dismissible for 30 days, and a user who has decided that 81
skills is who they are can currently only silence the whole of `context-tax`. If that
turns out to matter in practice, the Fable seat's design is the fallback and this note is
the argument for it.
