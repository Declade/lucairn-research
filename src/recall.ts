/**
 * recall.ts
 *
 * Per-HIPAA-category recall / precision / F1 aggregation.
 *
 * Two consumer paths:
 *
 *   1. `aggregateExtracted(extracted)` — the path the harness uses live.
 *      Consumes redactions already tagged TP/FN/FP by the gateway's
 *      proving-ground evaluator (value-containment matching, server-side).
 *      Per-category counts are derived from `hipaa_category` on each
 *      `ExtractedRedaction`. This path is the source of truth for any number
 *      published in Paper 1 because the matching is performed inside the
 *      gateway, not by code that the publisher (Lucairn) also wrote — the
 *      arm's-length property compliance buyers care about.
 *
 *   2. `computeRecallFromSpans(groundTruth, predictedSpans)` — pure math
 *      layer with span-overlap matching at the ≥50%-character-overlap
 *      threshold locked in the Slice 2 dispatch brief. Useful when a future
 *      gateway surface exposes raw per-entity spans inline (none does today;
 *      see slice-2 brief lines 47-67 for the citation chain). Lets the
 *      research repo evolve its recall semantics without re-implementing
 *      aggregation downstream.
 *
 * Both paths produce the same `RecallSummary` shape.
 */

import { HIPAA_CATEGORIES, type HipaaCategory, type InjectedRow } from './inject-pii-core.js';
import type { ExtractedRedaction } from './redaction-extractor.js';

/** Overlap threshold for `computeRecallFromSpans`. Locked at 50% per Slice 2 brief. */
export const SPAN_OVERLAP_THRESHOLD = 0.5;

export interface CategoryCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface OverallCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** Total annotations in the ground truth (TP + FN). */
  readonly total_annotations: number;
}

export interface RowBreakdown {
  readonly row_index: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly recall: number;
}

export interface RecallSummary {
  readonly schema_version: '1.0';
  readonly generator: 'lucairn-research/recall.ts';
  readonly overall: OverallCounts;
  /** Sorted by HipaaCategory canonical order from `HIPAA_CATEGORIES`. */
  readonly per_category: ReadonlyArray<{ category: HipaaCategory; counts: CategoryCounts }>;
  /** Sorted by row_index ascending. */
  readonly per_row: readonly RowBreakdown[];
  readonly notes: readonly string[];
}

/** Spans with start ≤ end. Treated as half-open intervals [start, end). */
export interface SpanEntity {
  readonly category: HipaaCategory;
  readonly value: string;
  readonly start_char: number;
  readonly end_char: number;
}

export interface PredictedSpan {
  /** Optional Lucairn-internal type for diagnostics; not required for matching. */
  readonly category?: HipaaCategory | null;
  readonly start_char: number;
  readonly end_char: number;
  /** Original PHI text the sanitizer matched, when known. */
  readonly value?: string;
}

interface MutableCategoryCounts {
  tp: number;
  fp: number;
  fn: number;
}

function emptyCategoryCounts(): MutableCategoryCounts {
  return { tp: 0, fp: 0, fn: 0 };
}

/**
 * Derive precision, recall, F1 from raw TP/FP/FN. When (TP+FP)==0 or
 * (TP+FN)==0 we report 0 rather than NaN; that is the more useful behaviour
 * for aggregating summaries across rows where one category may be absent.
 */
function deriveRates(tp: number, fp: number, fn: number): {
  precision: number;
  recall: number;
  f1: number;
} {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function finaliseCategory(c: MutableCategoryCounts): CategoryCounts {
  const r = deriveRates(c.tp, c.fp, c.fn);
  return { tp: c.tp, fp: c.fp, fn: c.fn, ...r };
}

/**
 * Aggregate gateway-attested TP/FP/FN verdicts into a RecallSummary.
 */
export function aggregateExtracted(
  extracted: readonly ExtractedRedaction[],
  notes: readonly string[] = [],
): RecallSummary {
  const perCat: Map<HipaaCategory, MutableCategoryCounts> = new Map();
  for (const cat of HIPAA_CATEGORIES) {
    perCat.set(cat, emptyCategoryCounts());
  }
  // "unknown" bucket for verdicts the harness could not tag with a HIPAA
  // category (e.g. an unmapped Lucairn placeholder appearing in extras). We
  // track it separately so it does not contaminate per-category numbers but
  // is still surfaced in `overall` + a note.
  let unknownTp = 0;
  let unknownFp = 0;
  let unknownFn = 0;

  const perRow: Map<number, MutableCategoryCounts> = new Map();

  for (const r of extracted) {
    let bucket: MutableCategoryCounts | undefined;
    if (r.hipaa_category !== null) {
      bucket = perCat.get(r.hipaa_category);
    }
    if (bucket === undefined) {
      // Bump the unknown tallies; still tally per-row.
      if (r.verdict === 'tp') unknownTp += 1;
      else if (r.verdict === 'fp') unknownFp += 1;
      else unknownFn += 1;
    } else {
      if (r.verdict === 'tp') bucket.tp += 1;
      else if (r.verdict === 'fp') bucket.fp += 1;
      else bucket.fn += 1;
    }

    const rowKey = r.row_index;
    let rowBucket = perRow.get(rowKey);
    if (rowBucket === undefined) {
      rowBucket = emptyCategoryCounts();
      perRow.set(rowKey, rowBucket);
    }
    if (r.verdict === 'tp') rowBucket.tp += 1;
    else if (r.verdict === 'fp') rowBucket.fp += 1;
    else rowBucket.fn += 1;
  }

  let totTp = unknownTp;
  let totFp = unknownFp;
  let totFn = unknownFn;
  const perCategory: Array<{ category: HipaaCategory; counts: CategoryCounts }> = [];
  for (const cat of HIPAA_CATEGORIES) {
    const c = perCat.get(cat) ?? emptyCategoryCounts();
    totTp += c.tp;
    totFp += c.fp;
    totFn += c.fn;
    perCategory.push({ category: cat, counts: finaliseCategory(c) });
  }

  const overallRates = deriveRates(totTp, totFp, totFn);
  const perRowOut: RowBreakdown[] = Array.from(perRow.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rowIndex, c]) => {
      const r = deriveRates(c.tp, c.fp, c.fn);
      return { row_index: rowIndex, tp: c.tp, fp: c.fp, fn: c.fn, recall: r.recall };
    });

  const allNotes: string[] = [...notes];
  if (unknownTp + unknownFp + unknownFn > 0) {
    allNotes.push(
      `Encountered ${unknownTp + unknownFp + unknownFn} verdict(s) with no HIPAA category mapping ` +
        `(tp=${unknownTp} fp=${unknownFp} fn=${unknownFn}). These are included in overall counts ` +
        'but not in per_category. Extend src/hipaa-category-mapping.ts if these are recurring.',
    );
  }

  return {
    schema_version: '1.0',
    generator: 'lucairn-research/recall.ts',
    overall: {
      tp: totTp,
      fp: totFp,
      fn: totFn,
      total_annotations: totTp + totFn,
      ...overallRates,
    },
    per_category: perCategory,
    per_row: perRowOut,
    notes: allNotes,
  };
}

/**
 * ≥50%-character-overlap span matcher. A prediction `p` matches a ground-
 * truth entity `g` when `(overlap_chars(p, g) / length(g)) >= 0.5`. Ties
 * (same overlap fraction for two predictions against the same ground-truth)
 * resolve to the earlier predicted span (lower start_char), then the
 * smaller predicted-span length — fully deterministic.
 *
 * Each ground-truth entity matches at most one prediction; each prediction
 * matches at most one ground-truth entity. Unmatched ground truth → FN.
 * Unmatched prediction → FP.
 *
 * Per-category tally: when matched, the ground-truth entity's category is
 * the one credited (since that is the category we knew was injected).
 */
export function computeRecallFromSpans(
  groundTruth: readonly InjectedRow[],
  predictedSpans: readonly { row_index: number; spans: readonly PredictedSpan[] }[],
  notes: readonly string[] = [],
): RecallSummary {
  const predictedByRow = new Map<number, readonly PredictedSpan[]>();
  for (const p of predictedSpans) {
    predictedByRow.set(p.row_index, p.spans);
  }

  const perCat: Map<HipaaCategory, MutableCategoryCounts> = new Map();
  for (const cat of HIPAA_CATEGORIES) {
    perCat.set(cat, emptyCategoryCounts());
  }
  const perRow: Map<number, MutableCategoryCounts> = new Map();

  for (const row of groundTruth) {
    const truth = row.entities;
    const preds = predictedByRow.get(row.row_index) ?? [];
    const matched = matchSpans(truth, preds);

    const rowBucket: MutableCategoryCounts = emptyCategoryCounts();
    for (const t of truth) {
      const m = matched.truthToPred.get(t);
      const catBucket = perCat.get(t.category);
      if (m === undefined) {
        if (catBucket !== undefined) catBucket.fn += 1;
        rowBucket.fn += 1;
      } else {
        if (catBucket !== undefined) catBucket.tp += 1;
        rowBucket.tp += 1;
      }
    }
    for (const p of preds) {
      if (!matched.predMatched.has(p)) {
        // Tag FP to the predicted span's own category if known; otherwise
        // bump the unknown bucket.
        const catBucket = p.category != null ? perCat.get(p.category) : undefined;
        if (catBucket !== undefined) catBucket.fp += 1;
        rowBucket.fp += 1;
      }
    }
    perRow.set(row.row_index, rowBucket);
  }

  let totTp = 0;
  let totFp = 0;
  let totFn = 0;
  const perCategory: Array<{ category: HipaaCategory; counts: CategoryCounts }> = [];
  for (const cat of HIPAA_CATEGORIES) {
    const c = perCat.get(cat) ?? emptyCategoryCounts();
    totTp += c.tp;
    totFp += c.fp;
    totFn += c.fn;
    perCategory.push({ category: cat, counts: finaliseCategory(c) });
  }
  const overallRates = deriveRates(totTp, totFp, totFn);
  const perRowOut: RowBreakdown[] = Array.from(perRow.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rowIndex, c]) => {
      const r = deriveRates(c.tp, c.fp, c.fn);
      return { row_index: rowIndex, tp: c.tp, fp: c.fp, fn: c.fn, recall: r.recall };
    });

  return {
    schema_version: '1.0',
    generator: 'lucairn-research/recall.ts',
    overall: {
      tp: totTp,
      fp: totFp,
      fn: totFn,
      total_annotations: totTp + totFn,
      ...overallRates,
    },
    per_category: perCategory,
    per_row: perRowOut,
    notes,
  };
}

interface MatchResult {
  truthToPred: Map<SpanEntity, PredictedSpan>;
  predMatched: Set<PredictedSpan>;
}

function matchSpans(
  truth: readonly SpanEntity[],
  preds: readonly PredictedSpan[],
): MatchResult {
  // Build candidate pairs sorted by (overlap_fraction desc, pred.start_char
  // asc, pred-length asc). Greedy assign — first pair wins, each truth and
  // each prediction can match at most once.
  const candidates: Array<{
    truth: SpanEntity;
    pred: PredictedSpan;
    overlapFraction: number;
  }> = [];
  for (const t of truth) {
    const truthLen = Math.max(0, t.end_char - t.start_char);
    if (truthLen === 0) continue;
    for (const p of preds) {
      const overlap = Math.max(
        0,
        Math.min(t.end_char, p.end_char) - Math.max(t.start_char, p.start_char),
      );
      if (overlap <= 0) continue;
      const frac = overlap / truthLen;
      if (frac >= SPAN_OVERLAP_THRESHOLD) {
        candidates.push({ truth: t, pred: p, overlapFraction: frac });
      }
    }
  }
  candidates.sort((a, b) => {
    if (b.overlapFraction !== a.overlapFraction) {
      return b.overlapFraction - a.overlapFraction;
    }
    if (a.pred.start_char !== b.pred.start_char) {
      return a.pred.start_char - b.pred.start_char;
    }
    return a.pred.end_char - a.pred.start_char - (b.pred.end_char - b.pred.start_char);
  });
  const truthMatched = new Set<SpanEntity>();
  const predMatched = new Set<PredictedSpan>();
  const truthToPred = new Map<SpanEntity, PredictedSpan>();
  for (const c of candidates) {
    if (truthMatched.has(c.truth) || predMatched.has(c.pred)) continue;
    truthMatched.add(c.truth);
    predMatched.add(c.pred);
    truthToPred.set(c.truth, c.pred);
  }
  return { truthToPred, predMatched };
}
