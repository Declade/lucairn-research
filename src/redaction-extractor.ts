/**
 * redaction-extractor.ts
 *
 * Pure function that converts a gateway proving-ground response into a
 * uniform per-entity record stream the recall computation can consume.
 *
 * Why this layer exists:
 *   The gateway's proving-ground response carries three structured arrays —
 *   `matches[]` (true positives), `missed[]` (false negatives), and
 *   `extras[]` (false positives unmatched by ground truth) — keyed off the
 *   caller-supplied annotation type. The harness needs a single flat record
 *   per gateway-emitted decision, tagged with its HIPAA Safe Harbor category
 *   and a verdict (TP / FN / FP), so the recall layer can aggregate
 *   per-category without re-parsing the response shape.
 *
 * Cite-back: gateway emits `matches`/`missed`/`extras` at
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:5-138.
 */

import type { HipaaCategory, HIPAA_CATEGORIES } from './inject-pii-core.js';
import type { GroundTruthEvaluation } from './gateway-client.js';
import { placeholderToHipaaCategory } from './hipaa-category-mapping.js';

// Imported only as the type-source for HipaaCategory; the runtime constant is
// imported via the values import below to satisfy isolated-modules + the
// noUnusedImports lint policy.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CategoryTypeAnchor = (typeof HIPAA_CATEGORIES)[number];

import { HIPAA_CATEGORIES as HIPAA_CATEGORIES_VALUES } from './inject-pii-core.js';

const HIPAA_SET = new Set<string>(HIPAA_CATEGORIES_VALUES as readonly string[]);

export type RedactionVerdict = 'tp' | 'fn' | 'fp';

export interface ExtractedRedaction {
  readonly row_index: number;
  readonly hipaa_category: HipaaCategory | null;
  readonly verdict: RedactionVerdict;
  /** Value the gateway compared against (ground-truth value for TP/FN; original PHI for FP). */
  readonly value: string;
  /** Sanitizer placeholder (e.g. `[PERSON_1]`) for TP/FP; null for FN. */
  readonly placeholder: string | null;
  /** When known, the field name the gateway saw (`transcription` for the harness). */
  readonly field: string | null;
}

/**
 * Convert a single proving-ground evaluation block into a list of flat
 * extracted redactions tagged with HIPAA category + verdict.
 *
 * - TP rows: category = annotation_type (HIPAA-tagged in our submission).
 * - FN rows: category = type (same source).
 * - FP rows: category derived from the sanitizer placeholder via
 *   `placeholderToHipaaCategory`; null when the placeholder type is
 *   unmapped (still emitted with verdict=fp so the FP count is preserved).
 */
export function extractFromEvaluation(
  rowIndex: number,
  evaluation: GroundTruthEvaluation,
): ExtractedRedaction[] {
  const out: ExtractedRedaction[] = [];
  for (const m of evaluation.matches ?? []) {
    out.push({
      row_index: rowIndex,
      hipaa_category: tagAsHipaa(m.annotation_type),
      verdict: 'tp',
      value: m.annotation_value,
      placeholder: m.redacted_as,
      field: null,
    });
  }
  for (const miss of evaluation.missed ?? []) {
    out.push({
      row_index: rowIndex,
      hipaa_category: tagAsHipaa(miss.type),
      verdict: 'fn',
      value: miss.value,
      placeholder: null,
      field: miss.field,
    });
  }
  for (const extra of evaluation.extras ?? []) {
    out.push({
      row_index: rowIndex,
      hipaa_category: placeholderToHipaaCategory(extra.placeholder),
      verdict: 'fp',
      value: extra.original,
      placeholder: extra.placeholder,
      field: null,
    });
  }
  return out;
}

/**
 * Narrow a free-form string to HipaaCategory when it matches one of the 18
 * canonical names exactly; otherwise null. This keeps malformed gateway
 * payloads from silently widening the type.
 */
function tagAsHipaa(s: string): HipaaCategory | null {
  return HIPAA_SET.has(s) ? (s as HipaaCategory) : null;
}

/**
 * Verify the mapping table covers every Lucairn internal type observed in a
 * supplied evaluation's `extras[]`. Returns the list of unmapped types found
 * (empty if the mapping is complete for this sample). Used by
 * `test/redaction-extractor.spec.ts` to detect taxonomy drift.
 */
export function unmappedExtraTypes(evaluation: GroundTruthEvaluation): string[] {
  const seen = new Set<string>();
  const unmapped: string[] = [];
  for (const e of evaluation.extras ?? []) {
    const mapped = placeholderToHipaaCategory(e.placeholder);
    if (mapped === null) {
      // Pull the inner type for the report.
      const stripped = e.placeholder.replace(/^\[|\]$/gu, '');
      const t = stripped.replace(/_\d+$/u, '');
      if (!seen.has(t)) {
        seen.add(t);
        unmapped.push(t);
      }
    }
  }
  return unmapped;
}
