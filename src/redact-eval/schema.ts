/**
 * schema.ts (REDACT eval harness)
 *
 * Internal record + scoring-output shapes for the recall-first,
 * German-inclusive, GDPR-tier-bucketed sanitizer evaluation harness (PRD
 * Slice 10 — `Opus Advisor/specs/prd-2026-07-02-tech-trends-roadmap.md`).
 *
 * This harness is DELIBERATELY independent of the existing HIPAA-category
 * harness in `src/recall.ts` / `src/redaction-extractor.ts` /
 * `src/hipaa-category-mapping.ts`: those are US-HIPAA-Safe-Harbor-taxonomy
 * and gateway-proving-ground-verdict shaped (TP/FN/FP already tagged
 * server-side). This harness's ground truth is GDPR-tier + language shaped
 * and scores raw predicted spans against gold spans in-process — a
 * different taxonomy, a different scoring axis (language x GDPR tier
 * instead of HIPAA category), and a different consumer (a future REDACT-
 * ingested multilingual dataset, not the MTSamples/CFPB pipelines). Keeping
 * it in its own `src/redact-eval/` subtree avoids conflating two taxonomies
 * inside one module.
 *
 * GDPR tier definitions (locked by PRD Slice 10 brief):
 *   - HIGH: GDPR Art. 9 special-category data (health, biometric, genetic,
 *     racial/ethnic origin, political opinions, religious/philosophical
 *     beliefs, trade-union membership, sex life/orientation) OR GDPR Art. 10
 *     criminal-conviction/offence data OR any identifier that creates
 *     material linkage risk on its own (e.g. national ID / SSN-equivalent).
 *   - MED: standard identifying PII that is not Art. 9/10 and not a
 *     freestanding linkage-risk identifier (e.g. name, email, phone).
 *   - LOW: quasi-identifiers / low-sensitivity context (e.g. a city name,
 *     a generic date) that contribute to re-identification risk only in
 *     combination with other fields.
 *
 * RECALL is the headline / kill metric for this harness (PRD: "recall-first
 * evaluation harness"; the whole point of a GDPR-tiered sanitizer eval is
 * that a missed HIGH-tier entity is a materially worse failure than a
 * spurious LOW-tier flag). Every scoring function surfaces `recall` as the
 * first-listed rate and callers MUST treat recall regressions as the
 * kill-criteria signal — precision/F1 are supporting metrics, not the gate.
 */

/** The three GDPR sensitivity tiers this harness buckets entities into. */
export const GDPR_TIERS = ['HIGH', 'MED', 'LOW'] as const;

export type GdprTier = (typeof GDPR_TIERS)[number];

/**
 * A single gold-standard (ground-truth) entity span inside `EvalRecord.text`.
 * Half-open interval [start, end) over UTF-16 code units (JS string
 * indexing), consistent with `src/inject-pii-core.ts`'s `start_char`/
 * `end_char` convention elsewhere in this repo.
 */
export interface GoldEntity {
  readonly start: number;
  readonly end: number;
  /** Free-form entity type label (e.g. "PERSON", "HEALTH_CONDITION", "IBAN"). Not a closed enum — REDACT's real taxonomy is unknown pending ingestion (see adapters/redact.ts). */
  readonly type: string;
  readonly gdprTier: GdprTier;
}

/**
 * One evaluation record: an input text, its BCP-47-ish language tag (this
 * harness only requires "de" / "en" today; any string is accepted so a
 * future REDACT ingestion doesn't need a schema bump), and its gold spans.
 */
export interface EvalRecord {
  readonly text: string;
  readonly language: string;
  readonly goldEntities: readonly GoldEntity[];
}

/**
 * A single predicted span from a sanitizer/model under evaluation. Mirrors
 * `GoldEntity`'s span shape; `type`/`gdprTier` are optional because a
 * predictor may not always know or assert a GDPR tier for what it flagged
 * (unmatched predictions still count as FP either way).
 */
export interface PredictedEntity {
  readonly start: number;
  readonly end: number;
  readonly type?: string;
  readonly gdprTier?: GdprTier;
}

/** One record's predictions, keyed back to its position in the input array (see scorer.ts `scoreRecords`). */
export interface PredictedRecord {
  readonly recordIndex: number;
  readonly predictions: readonly PredictedEntity[];
}

/**
 * Span-overlap matching mode:
 *   - "exact": predicted span must match the gold span's [start, end)
 *     exactly to count as a TP.
 *   - "partial-overlap": predicted span counts as a TP if it overlaps the
 *     gold span at all (overlap > 0 chars). This is deliberately more
 *     permissive than `src/recall.ts`'s locked 50%-overlap threshold — that
 *     threshold is locked for the Paper 1/2 HIPAA harness specifically and
 *     is NOT reused here; REDACT's real overlap convention is unverified
 *     pending ingestion (see adapters/redact.ts TODO). Both modes are
 *     exposed so a future calibration pass can pick the REDACT-matching one
 *     without a scorer rewrite.
 */
export const MATCH_MODES = ['exact', 'partial-overlap'] as const;

export type MatchMode = (typeof MATCH_MODES)[number];
