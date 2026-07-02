/**
 * scorer.ts (REDACT eval harness)
 *
 * Recall-first scoring for the German-inclusive, GDPR-tier-bucketed
 * sanitizer eval harness (PRD Slice 10). Given a set of `EvalRecord`s (gold
 * spans) and matching predicted spans, computes recall / precision / F1
 * bucketed BOTH per-language and per-GDPR-tier, plus an overall summary.
 *
 * RECALL IS THE HEADLINE METRIC. `ScoreSummary.overall.recall` and every
 * per-language / per-tier bucket's `.recall` are the numbers this harness
 * exists to produce; precision/F1 are reported for context but a recall
 * regression is the kill signal (see schema.ts doc-comment). Call sites
 * that only look at `f1` or `precision` are using this module wrong.
 *
 * Matching: two modes, selectable per call —
 *   - "exact": predicted [start, end) must equal a gold [start, end) exactly.
 *   - "partial-overlap": any character overlap (> 0) counts as a candidate
 *     match.
 * In both modes, matching is greedy 1:1 (each gold entity matches at most
 * one prediction and vice versa) within a single record; ties break by
 * earliest predicted start, then shortest predicted span — fully
 * deterministic, same tie-break convention as `src/recall.ts`.
 *
 * GDPR-tier bucketing takes the GOLD entity's tier for TP/FN (the tier we
 * know was actually present), and the PREDICTED entity's asserted tier for
 * FP when known; an FP with no asserted tier is counted in `overall` only
 * and surfaced via `notes`, mirroring the "unknown bucket" pattern in
 * `src/recall.ts::aggregateExtracted`.
 */

import type {
  EvalRecord,
  GdprTier,
  GoldEntity,
  MatchMode,
  PredictedEntity,
  PredictedRecord,
} from './schema.js';
import { GDPR_TIERS } from './schema.js';

export interface RateTriple {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Headline metric — see module doc-comment. Listed first by convention. */
  readonly recall: number;
  readonly precision: number;
  readonly f1: number;
}

export interface ScoreSummary {
  readonly schema_version: '1.0';
  readonly generator: 'lucairn-research/redact-eval/scorer.ts';
  readonly matchMode: MatchMode;
  readonly overall: RateTriple;
  /** One entry per distinct language seen in the input records, sorted alphabetically. */
  readonly perLanguage: ReadonlyArray<{ language: string; counts: RateTriple }>;
  /** One entry per GDPR tier in HIGH/MED/LOW canonical order (always all three, even if zero-count). */
  readonly perGdprTier: ReadonlyArray<{ gdprTier: GdprTier; counts: RateTriple }>;
  readonly notes: readonly string[];
}

interface MutableCounts {
  tp: number;
  fp: number;
  fn: number;
}

function emptyCounts(): MutableCounts {
  return { tp: 0, fp: 0, fn: 0 };
}

function deriveRates(c: MutableCounts): RateTriple {
  const recall = c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
  const precision = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { tp: c.tp, fp: c.fp, fn: c.fn, recall, precision, f1 };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

function spansEqual(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start === b.start && a.end === b.end;
}

interface RecordMatchResult {
  goldToPred: Map<GoldEntity, PredictedEntity>;
  predMatched: Set<PredictedEntity>;
}

/**
 * Greedy 1:1 span matcher for a single record. Candidate pairs are those
 * satisfying the selected `matchMode`; ties resolve by earliest predicted
 * start then shortest predicted span (deterministic, mirrors
 * `src/recall.ts::matchSpans`).
 */
function matchRecordSpans(
  gold: readonly GoldEntity[],
  predictions: readonly PredictedEntity[],
  matchMode: MatchMode,
): RecordMatchResult {
  const candidates: Array<{ gold: GoldEntity; pred: PredictedEntity; predLen: number }> = [];
  for (const g of gold) {
    for (const p of predictions) {
      const isCandidate = matchMode === 'exact' ? spansEqual(g, p) : overlaps(g, p);
      if (isCandidate) {
        candidates.push({ gold: g, pred: p, predLen: Math.max(0, p.end - p.start) });
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.pred.start !== b.pred.start) return a.pred.start - b.pred.start;
    return a.predLen - b.predLen;
  });

  const goldMatched = new Set<GoldEntity>();
  const predMatched = new Set<PredictedEntity>();
  const goldToPred = new Map<GoldEntity, PredictedEntity>();
  for (const c of candidates) {
    if (goldMatched.has(c.gold) || predMatched.has(c.pred)) continue;
    goldMatched.add(c.gold);
    predMatched.add(c.pred);
    goldToPred.set(c.gold, c.pred);
  }
  return { goldToPred, predMatched };
}

/**
 * Score a set of `EvalRecord`s against predicted spans, bucketed per-
 * language and per-GDPR-tier. `predictedByRecord` maps a record's index in
 * `records` (0-based) to its predictions; a record with no entry is treated
 * as zero predictions (every gold entity becomes an FN for that record).
 */
export function scoreRecords(
  records: readonly EvalRecord[],
  predictedByRecord: readonly PredictedRecord[],
  matchMode: MatchMode = 'partial-overlap',
): ScoreSummary {
  const predsByIndex = new Map<number, readonly PredictedEntity[]>();
  for (const p of predictedByRecord) {
    predsByIndex.set(p.recordIndex, p.predictions);
  }

  const overallCounts = emptyCounts();
  const perLanguageCounts = new Map<string, MutableCounts>();
  const perTierCounts = new Map<GdprTier, MutableCounts>();
  for (const tier of GDPR_TIERS) perTierCounts.set(tier, emptyCounts());

  let unknownTierFp = 0;

  records.forEach((record, recordIndex) => {
    const predictions = predsByIndex.get(recordIndex) ?? [];
    const { goldToPred, predMatched } = matchRecordSpans(record.goldEntities, predictions, matchMode);

    const langBucket = perLanguageCounts.get(record.language) ?? emptyCounts();
    perLanguageCounts.set(record.language, langBucket);

    for (const g of record.goldEntities) {
      const matched = goldToPred.has(g);
      const tierBucket = perTierCounts.get(g.gdprTier);
      if (matched) {
        overallCounts.tp += 1;
        langBucket.tp += 1;
        if (tierBucket) tierBucket.tp += 1;
      } else {
        overallCounts.fn += 1;
        langBucket.fn += 1;
        if (tierBucket) tierBucket.fn += 1;
      }
    }
    for (const p of predictions) {
      if (predMatched.has(p)) continue;
      overallCounts.fp += 1;
      langBucket.fp += 1;
      if (p.gdprTier !== undefined) {
        const tierBucket = perTierCounts.get(p.gdprTier);
        if (tierBucket) tierBucket.fp += 1;
      } else {
        unknownTierFp += 1;
      }
    }
  });

  const perLanguage = Array.from(perLanguageCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([language, counts]) => ({ language, counts: deriveRates(counts) }));

  const perGdprTier = GDPR_TIERS.map((tier) => ({
    gdprTier: tier,
    counts: deriveRates(perTierCounts.get(tier) ?? emptyCounts()),
  }));

  const notes: string[] = [];
  if (unknownTierFp > 0) {
    notes.push(
      `${unknownTierFp} false-positive prediction(s) had no asserted gdprTier and are ` +
        'included in overall.fp but not in any perGdprTier bucket.',
    );
  }

  return {
    schema_version: '1.0',
    generator: 'lucairn-research/redact-eval/scorer.ts',
    matchMode,
    overall: deriveRates(overallCounts),
    perLanguage,
    perGdprTier,
    notes,
  };
}
