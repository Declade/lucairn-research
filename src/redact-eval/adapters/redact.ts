/**
 * redact.ts (REDACT eval harness — adapter STUB)
 *
 * Typed conversion boundary between REDACT's real on-disk record shape and
 * this harness's internal `EvalRecord` schema (`../schema.ts`).
 *
 * INTENTIONALLY UNIMPLEMENTED. Per PRD Slice 10
 * (`Opus Advisor/specs/prd-2026-07-02-tech-trends-roadmap.md`) hard
 * constraints: "DO NOT guess REDACT's on-disk JSON schema — leaving it a
 * typed stub is the requirement." This is a NEVER-GUESS boundary
 * (CLAUDE.md: "NEVER GUESS, if Marc asks you for an information you are
 * never allowed to GUESS. This is a kill criteria and cannot happen
 * again.") — REDACT's real per-record JSON shape (field names, span
 * convention, language-tag format, sensitivity-label taxonomy) has not been
 * inspected against the actual dataset artifact, so no shape is asserted
 * here beyond `unknown`.
 *
 * Sources to consult before filling this in:
 *   - Paper: arXiv:2606.19881 — "REDACT" (June 2026). Read the dataset
 *     section for the documented on-disk record schema, span-offset
 *     convention (byte vs. char vs. codepoint — this repo's own convention
 *     is UTF-16 code units per `src/inject-pii-core.ts`; REDACT's may
 *     differ and MUST be reconciled explicitly, not assumed to match), and
 *     its sensitivity/category taxonomy (its label set is NOT assumed to
 *     line up 1:1 with the HIGH/MED/LOW GDPR-tier bucketing in
 *     `../schema.ts` — that mapping is exactly what this adapter must
 *     define once the real schema is known).
 *   - REDACT GitHub repository (dataset release + any provided loader/
 *     schema code, e.g. a `datasets` card, JSON Schema, or Python loader
 *     whose field names are authoritative over anything inferred from the
 *     paper prose alone).
 *
 * When implementing:
 *   1. Read the actual downloaded artifact (or the repo's schema/loader
 *      code) — do not infer the shape from the paper's prose examples
 *      alone; papers routinely elide field names/edge cases.
 *   2. Replace the `raw: unknown` parameter with a precise interface (or a
 *      runtime-validated parse, given this is untrusted external data).
 *   3. Define the REDACT-label -> GdprTier mapping explicitly and test it
 *      exhaustively (every REDACT label must map to exactly one of
 *      HIGH/MED/LOW, with an explicit decision recorded per label — no
 *      silent defaults).
 *   4. Decide the span-offset reconciliation (REDACT's convention vs. this
 *      repo's UTF-16-code-unit convention) and document it here.
 *   5. Delete this doc-comment's "STUB" framing and this file's `throw`.
 *
 * This file ships with NO network access, NO dataset download, and NO
 * assumed schema, per the Slice 10 scaffold-only scope (see PRD § Out of
 * scope: "NO live model eval runs / HF downloads / GPU bench").
 */

import type { EvalRecord } from '../schema.js';

/**
 * Convert one raw REDACT record (shape TBD — see module doc-comment) into
 * this harness's internal `EvalRecord`.
 *
 * @param raw - A single record from the REDACT dataset, in whatever shape
 *   the real on-disk artifact uses. Typed `unknown` deliberately: no field
 *   name or structure is asserted until the real schema has been read.
 * @throws Always. This is an intentional stub — see module doc-comment.
 */
export function redactRecordToInternal(raw: unknown): EvalRecord {
  void raw;
  throw new Error(
    'redactRecordToInternal: not implemented. REDACT on-disk schema has not been ' +
      'verified against the real dataset artifact (NEVER-GUESS boundary — see ' +
      'redact-eval/adapters/redact.ts doc-comment). Read arXiv:2606.19881 § dataset ' +
      'and the REDACT GitHub repository/loader before implementing this function.',
  );
}
