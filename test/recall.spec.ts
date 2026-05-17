import { describe, expect, it } from 'vitest';

import { HIPAA_CATEGORIES, type InjectedRow } from '../src/inject-pii-core.js';
import {
  SPAN_OVERLAP_THRESHOLD,
  aggregateExtracted,
  computeRecallFromSpans,
  type PredictedSpan,
} from '../src/recall.js';
import type { ExtractedRedaction } from '../src/redaction-extractor.js';

describe('aggregateExtracted', () => {
  it('computes per-category recall/precision/F1 from gateway-attested verdicts', () => {
    // 5 rows, 22 entities, hand-tagged TP/FN/FP. The per-category math is
    // checked exactly so a regression in the aggregation logic is caught.
    const extracted: ExtractedRedaction[] = [
      // NAME: 5 TP, 1 FN -> recall 5/6 ≈ 0.833, precision 5/5 = 1, F1 0.909
      ...times(5, (i) => mkTp(1, 'NAME', `name-${i}`)),
      mkFn(1, 'NAME', 'name-miss'),
      // EMAIL: 2 TP, 0 FN -> recall 1.0, precision 1.0
      mkTp(1, 'EMAIL', 'e1'),
      mkTp(2, 'EMAIL', 'e2'),
      // DATE: 3 TP, 1 FN, 1 FP -> recall 3/4 = 0.75, precision 3/4 = 0.75
      ...times(3, (i) => mkTp(2, 'DATE', `d${i}`)),
      mkFn(2, 'DATE', 'd-miss'),
      mkFp(2, 'DATE', 'd-extra'),
      // PHONE: 0 TP, 0 FN, 2 FP -> precision 0/2 = 0
      mkFp(3, 'PHONE', 'p1'),
      mkFp(3, 'PHONE', 'p2'),
      // SSN: 1 TP -> recall 1.0
      mkTp(4, 'SSN', 's1'),
      // GEO_SUBDIVISION: 4 TP, 1 FN -> recall 4/5 = 0.8
      ...times(4, (i) => mkTp(5, 'GEO_SUBDIVISION', `g${i}`)),
      mkFn(5, 'GEO_SUBDIVISION', 'g-miss'),
    ];

    const summary = aggregateExtracted(extracted);
    expect(summary.schema_version).toBe('1.0');
    expect(summary.generator).toBe('lucairn-research/recall.ts');

    // Per-category — locks specific TP/FN/FP counts and rates.
    const byCat = new Map(summary.per_category.map((p) => [p.category, p.counts]));
    expect(byCat.get('NAME')).toMatchObject({ tp: 5, fp: 0, fn: 1, precision: 1 });
    expect(byCat.get('NAME')?.recall).toBeCloseTo(5 / 6, 6);
    expect(byCat.get('EMAIL')).toMatchObject({ tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    expect(byCat.get('DATE')).toMatchObject({ tp: 3, fp: 1, fn: 1, precision: 0.75, recall: 0.75 });
    expect(byCat.get('PHONE')).toMatchObject({ tp: 0, fp: 2, fn: 0, precision: 0, recall: 0, f1: 0 });
    expect(byCat.get('SSN')).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    expect(byCat.get('GEO_SUBDIVISION')).toMatchObject({ tp: 4, fp: 0, fn: 1, precision: 1 });
    expect(byCat.get('GEO_SUBDIVISION')?.recall).toBeCloseTo(0.8, 6);

    // Categories with no records still appear with zeros (per_category covers
    // the full HIPAA enumeration in canonical order).
    expect(summary.per_category.map((p) => p.category)).toEqual([...HIPAA_CATEGORIES]);
    const mrn = byCat.get('MRN');
    expect(mrn).toEqual({ tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 });

    // Overall — TP=15, FP=3, FN=3 -> precision 15/18 = 0.833, recall 15/18 = 0.833.
    expect(summary.overall.tp).toBe(15);
    expect(summary.overall.fp).toBe(3);
    expect(summary.overall.fn).toBe(3);
    expect(summary.overall.total_annotations).toBe(18);
    expect(summary.overall.recall).toBeCloseTo(15 / 18, 6);
    expect(summary.overall.precision).toBeCloseTo(15 / 18, 6);

    // Per-row order is ascending by row_index. Row 1 holds the 5 NAME TPs
    // plus the single EMAIL TP `e1` (`e2` is on row 2) and the 1 NAME FN.
    expect(summary.per_row.map((r) => r.row_index)).toEqual([1, 2, 3, 4, 5]);
    expect(summary.per_row[0]).toMatchObject({ row_index: 1, tp: 6, fn: 1, fp: 0 });
  });

  it('handles unmapped categories without exploding (kept out of per_category but counted in overall)', () => {
    const extracted: ExtractedRedaction[] = [
      mkTp(1, 'NAME', 'a'),
      // hipaa_category null — happens when the gateway returns an unknown
      // annotation_type or an unmapped placeholder appears in extras.
      {
        row_index: 1,
        hipaa_category: null,
        verdict: 'fp',
        value: 'x',
        placeholder: '[UNKNOWN_1]',
        field: null,
      },
    ];
    const summary = aggregateExtracted(extracted);
    expect(summary.overall.fp).toBe(1);
    expect(summary.notes.some((n) => /no HIPAA category mapping/iu.test(n))).toBe(true);
    // NAME bucket still picks up its TP; UNKNOWN does not appear in per_category.
    const byCat = new Map(summary.per_category.map((p) => [p.category, p.counts]));
    expect(byCat.get('NAME')?.tp).toBe(1);
  });

  it('treats absent ground truth as recall=0 with total_annotations=0', () => {
    const summary = aggregateExtracted([]);
    expect(summary.overall.total_annotations).toBe(0);
    expect(summary.overall.recall).toBe(0);
    expect(summary.overall.f1).toBe(0);
  });
});

describe('computeRecallFromSpans (≥50% character-overlap)', () => {
  it('matches at the locked overlap threshold and counts TP/FN/FP correctly', () => {
    // Single-row, hand-built ground truth + predictions.
    const truth: InjectedRow = {
      row_index: 100,
      original_transcription: 'placeholder',
      injected_transcription: 'placeholder',
      entities: [
        { category: 'NAME', value: 'Jane Roe', start_char: 0, end_char: 8 }, // len 8
        { category: 'EMAIL', value: 'j@example.test', start_char: 20, end_char: 34 }, // len 14
        { category: 'DATE', value: '2024-01-02', start_char: 40, end_char: 50 }, // len 10 — missed
      ],
    };
    const predicted: PredictedSpan[] = [
      // 50%-overlap exactly with NAME -> matches (>=0.5 inclusive).
      { category: 'NAME', start_char: 4, end_char: 12, value: 'Jane Roe' },
      // EMAIL: prediction fully covers the truth -> 100% overlap, matches.
      { category: 'EMAIL', start_char: 18, end_char: 40, value: 'j@example.test' },
      // 40%-overlap with DATE -> below threshold, counts as FP.
      { category: 'DATE', start_char: 36, end_char: 44, value: '2024' },
    ];

    const summary = computeRecallFromSpans([truth], [{ row_index: 100, spans: predicted }]);
    const byCat = new Map(summary.per_category.map((p) => [p.category, p.counts]));
    expect(byCat.get('NAME')).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(byCat.get('EMAIL')).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(byCat.get('DATE')).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(summary.overall).toMatchObject({
      tp: 2,
      fp: 1,
      fn: 1,
      total_annotations: 3,
    });
    expect(summary.overall.recall).toBeCloseTo(2 / 3, 6);
  });

  it('exposes the SPAN_OVERLAP_THRESHOLD const as 0.5 (regression lock)', () => {
    expect(SPAN_OVERLAP_THRESHOLD).toBe(0.5);
  });
});

// ---- helpers ----

function mkTp(
  rowIndex: number,
  category: ExtractedRedaction['hipaa_category'],
  value: string,
): ExtractedRedaction {
  return {
    row_index: rowIndex,
    hipaa_category: category,
    verdict: 'tp',
    value,
    placeholder: `[${categoryToInternal(category)}_${value}]`,
    field: null,
  };
}

function mkFn(
  rowIndex: number,
  category: ExtractedRedaction['hipaa_category'],
  value: string,
): ExtractedRedaction {
  return {
    row_index: rowIndex,
    hipaa_category: category,
    verdict: 'fn',
    value,
    placeholder: null,
    field: 'transcription',
  };
}

function mkFp(
  rowIndex: number,
  category: ExtractedRedaction['hipaa_category'],
  value: string,
): ExtractedRedaction {
  return {
    row_index: rowIndex,
    hipaa_category: category,
    verdict: 'fp',
    value,
    placeholder: `[${categoryToInternal(category)}_${value}]`,
    field: null,
  };
}

function categoryToInternal(category: ExtractedRedaction['hipaa_category']): string {
  // Sufficient for synthetic test fixtures only — we are not exercising the
  // mapping table here, just generating plausible-looking placeholders.
  return category ?? 'UNKNOWN';
}

function times<T>(n: number, f: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(f(i));
  return out;
}
