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
 * one prediction and vice versa) within a single record; candidates are
 * ranked by overlap fraction (overlap chars ÷ gold length) descending, then
 * earliest predicted start, then shortest predicted span — fully
 * deterministic, same tie-break convention as `src/recall.ts`.
 *
 * GDPR-tier bucketing takes the GOLD entity's tier for TP/FN (the tier we
 * know was actually present), and the PREDICTED entity's asserted tier for
 * FP when known; an FP with no asserted tier is counted in `overall` only
 * and surfaced via `notes`, mirroring the "unknown bucket" pattern in
 * `src/recall.ts::aggregateExtracted`. The same defensive handling applies
 * to a GOLD entity whose `gdprTier` falls outside HIGH/MED/LOW (the type is
 * closed at the TypeScript boundary, but data crossing a JSON/adapter
 * boundary is not guaranteed to respect it): it still counts in
 * `overall`/`perLanguage`, is excluded from `perGdprTier` (there is no
 * bucket to put it in), and is surfaced via `notes` — never silently
 * dropped.
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

/** A span is malformed (empty or inverted) if its half-open interval has zero or negative length. */
function isMalformedSpan(s: { start: number; end: number }): boolean {
  return s.end <= s.start;
}

interface RecordMatchResult {
  /** Keyed by INDEX into the `gold` array passed to `matchRecordSpans`, not by object identity — two `===`-equal (or reference-identical) gold/pred entries at different indices must be tracked independently. */
  goldIndexToPredIndex: Map<number, number>;
  matchedPredIndices: Set<number>;
}

/**
 * Greedy 1:1 span matcher for a single record. Candidate pairs are those
 * satisfying the selected `matchMode`; ties resolve by highest overlap
 * fraction (overlap chars ÷ gold length) descending, then earliest predicted
 * start, then shortest predicted span (deterministic, mirrors
 * `src/recall.ts::matchSpans`). In "exact" mode every candidate's overlap
 * fraction is 1.0 (the spans are equal), so the primary key is inert there
 * and ties fall through to the start/length secondary keys as before.
 *
 * Matching is tracked by ARRAY INDEX, not object identity: two array entries
 * that are the same object reference (or two distinct objects with equal
 * field values) are still two distinct entities, each consumable at most
 * once. Zero-length (malformed, `end <= start`) spans are excluded from
 * candidate generation entirely for both gold and predictions — they cannot
 * legitimately overlap anything and must never resolve to a TP.
 */
function matchRecordSpans(
  gold: readonly GoldEntity[],
  predictions: readonly PredictedEntity[],
  matchMode: MatchMode,
): RecordMatchResult {
  const candidates: Array<{
    goldIndex: number;
    predIndex: number;
    predStart: number;
    predLen: number;
    overlapFraction: number;
  }> = [];
  gold.forEach((g, goldIndex) => {
    if (isMalformedSpan(g)) return;
    const goldLen = g.end - g.start;
    predictions.forEach((p, predIndex) => {
      if (isMalformedSpan(p)) return;
      const isCandidate = matchMode === 'exact' ? spansEqual(g, p) : overlaps(g, p);
      if (isCandidate) {
        const overlap = Math.max(0, Math.min(g.end, p.end) - Math.max(g.start, p.start));
        const overlapFraction = goldLen === 0 ? 0 : overlap / goldLen;
        candidates.push({
          goldIndex,
          predIndex,
          predStart: p.start,
          predLen: Math.max(0, p.end - p.start),
          overlapFraction,
        });
      }
    });
  });
  candidates.sort((a, b) => {
    if (b.overlapFraction !== a.overlapFraction) return b.overlapFraction - a.overlapFraction;
    if (a.predStart !== b.predStart) return a.predStart - b.predStart;
    return a.predLen - b.predLen;
  });

  const matchedGoldIndices = new Set<number>();
  const matchedPredIndices = new Set<number>();
  const goldIndexToPredIndex = new Map<number, number>();
  for (const c of candidates) {
    if (matchedGoldIndices.has(c.goldIndex) || matchedPredIndices.has(c.predIndex)) continue;
    matchedGoldIndices.add(c.goldIndex);
    matchedPredIndices.add(c.predIndex);
    goldIndexToPredIndex.set(c.goldIndex, c.predIndex);
  }
  return { goldIndexToPredIndex, matchedPredIndices };
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
  let unknownTierGold = 0;
  let malformedSpanCount = 0;

  records.forEach((record, recordIndex) => {
    const predictions = predsByIndex.get(recordIndex) ?? [];
    const { goldIndexToPredIndex, matchedPredIndices } = matchRecordSpans(
      record.goldEntities,
      predictions,
      matchMode,
    );

    const langBucket = perLanguageCounts.get(record.language) ?? emptyCounts();
    perLanguageCounts.set(record.language, langBucket);

    record.goldEntities.forEach((g, goldIndex) => {
      if (isMalformedSpan(g)) {
        malformedSpanCount += 1;
        return;
      }
      const matched = goldIndexToPredIndex.has(goldIndex);
      const tierBucket = perTierCounts.get(g.gdprTier);
      if (!tierBucket) unknownTierGold += 1;
      if (matched) {
        overallCounts.tp += 1;
        langBucket.tp += 1;
        if (tierBucket) tierBucket.tp += 1;
      } else {
        overallCounts.fn += 1;
        langBucket.fn += 1;
        if (tierBucket) tierBucket.fn += 1;
      }
    });
    predictions.forEach((p, predIndex) => {
      if (isMalformedSpan(p)) {
        malformedSpanCount += 1;
        return;
      }
      if (matchedPredIndices.has(predIndex)) return;
      overallCounts.fp += 1;
      langBucket.fp += 1;
      if (p.gdprTier !== undefined) {
        const tierBucket = perTierCounts.get(p.gdprTier);
        if (tierBucket) tierBucket.fp += 1;
      } else {
        unknownTierFp += 1;
      }
    });
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
  if (unknownTierGold > 0) {
    notes.push(
      `${unknownTierGold} gold entity(ies) had a gdprTier outside HIGH/MED/LOW and are ` +
        'included in overall but not in any perGdprTier bucket.',
    );
  }
  if (malformedSpanCount > 0) {
    notes.push(`${malformedSpanCount} zero-length/malformed span(s) skipped.`);
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
