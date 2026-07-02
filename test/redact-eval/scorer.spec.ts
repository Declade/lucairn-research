import { describe, expect, it } from 'vitest';

import { GDPR_TIERS } from '../../src/redact-eval/schema.js';
import type { EvalRecord, GdprTier, PredictedEntity, PredictedRecord } from '../../src/redact-eval/schema.js';
import { scoreRecords } from '../../src/redact-eval/scorer.js';
import { SYNTHETIC_MULTILINGUAL_FIXTURE } from '../../src/redact-eval/fixtures/synthetic-multilingual.js';
import { redactRecordToInternal } from '../../src/redact-eval/adapters/redact.js';

describe('synthetic multilingual fixture self-consistency', () => {
  it('every gold entity span round-trips against its own record text', () => {
    for (const record of SYNTHETIC_MULTILINGUAL_FIXTURE) {
      for (const entity of record.goldEntities) {
        expect(entity.start).toBeGreaterThanOrEqual(0);
        expect(entity.end).toBeGreaterThan(entity.start);
        expect(entity.end).toBeLessThanOrEqual(record.text.length);
        const slice = record.text.slice(entity.start, entity.end);
        expect(slice.length).toBeGreaterThan(0);
      }
    }
  });

  it('covers both German and English', () => {
    const languages = new Set(SYNTHETIC_MULTILINGUAL_FIXTURE.map((r) => r.language));
    expect(languages.has('de')).toBe(true);
    expect(languages.has('en')).toBe(true);
  });

  it('includes at least one gold entity per GDPR tier', () => {
    const tiersSeen = new Set(
      SYNTHETIC_MULTILINGUAL_FIXTURE.flatMap((r) => r.goldEntities.map((e) => e.gdprTier)),
    );
    for (const tier of GDPR_TIERS) {
      expect(tiersSeen.has(tier)).toBe(true);
    }
  });
});

describe('scoreRecords — output SHAPE (not model numbers)', () => {
  // A perfect predictor: emit exactly the gold spans for every record. This
  // is a shape/plumbing smoke test, not a model-accuracy assertion — the
  // harness is unrun against any real predictor per PRD Slice 10 scope.
  function perfectPredictions(): PredictedRecord[] {
    return SYNTHETIC_MULTILINGUAL_FIXTURE.map((record, recordIndex) => ({
      recordIndex,
      predictions: record.goldEntities.map(
        (g): PredictedEntity => ({ start: g.start, end: g.end, type: g.type, gdprTier: g.gdprTier }),
      ),
    }));
  }

  it('emits the documented summary shape with recall as a first-class field at every level', () => {
    const summary = scoreRecords(SYNTHETIC_MULTILINGUAL_FIXTURE, perfectPredictions(), 'exact');

    expect(summary.schema_version).toBe('1.0');
    expect(summary.generator).toBe('lucairn-research/redact-eval/scorer.ts');
    expect(summary.matchMode).toBe('exact');

    // Overall shape.
    expect(summary.overall).toEqual(
      expect.objectContaining({
        tp: expect.any(Number),
        fp: expect.any(Number),
        fn: expect.any(Number),
        recall: expect.any(Number),
        precision: expect.any(Number),
        f1: expect.any(Number),
      }),
    );

    // Perfect predictor against exact matching -> recall 1, precision 1, no FP/FN.
    expect(summary.overall.recall).toBe(1);
    expect(summary.overall.precision).toBe(1);
    expect(summary.overall.fp).toBe(0);
    expect(summary.overall.fn).toBe(0);

    // per-language SHAPE: both languages present, each with the full rate triple.
    const languages = summary.perLanguage.map((l) => l.language);
    expect(languages).toEqual([...languages].sort((a, b) => a.localeCompare(b)));
    expect(languages).toContain('de');
    expect(languages).toContain('en');
    for (const entry of summary.perLanguage) {
      expect(entry.counts).toEqual(
        expect.objectContaining({
          tp: expect.any(Number),
          fp: expect.any(Number),
          fn: expect.any(Number),
          recall: expect.any(Number),
          precision: expect.any(Number),
          f1: expect.any(Number),
        }),
      );
      // Perfect predictor: every language bucket has recall 1.
      expect(entry.counts.recall).toBe(1);
    }

    // per-GDPR-tier SHAPE: always all three tiers, canonical HIGH/MED/LOW order.
    expect(summary.perGdprTier.map((t) => t.gdprTier)).toEqual(['HIGH', 'MED', 'LOW']);
    for (const entry of summary.perGdprTier) {
      expect(entry.counts).toEqual(
        expect.objectContaining({
          tp: expect.any(Number),
          fp: expect.any(Number),
          fn: expect.any(Number),
          recall: expect.any(Number),
          precision: expect.any(Number),
          f1: expect.any(Number),
        }),
      );
      // Every tier has at least one gold entity in the fixture (locked by
      // the fixture self-consistency test above), so a perfect predictor
      // yields recall 1 in every bucket — also exercises that HIGH-tier
      // recall is computed and surfaced distinctly, since that's the
      // harness's actual kill metric.
      expect(entry.counts.recall).toBe(1);
    }

    expect(Array.isArray(summary.notes)).toBe(true);
  });

  it('a missed HIGH-tier entity drags down the HIGH bucket recall specifically (recall is the headline metric)', () => {
    // Drop every HIGH-tier gold entity from the predictions; keep everything
    // else perfect. Only the HIGH bucket's recall should suffer.
    const predictions: PredictedRecord[] = SYNTHETIC_MULTILINGUAL_FIXTURE.map((record, recordIndex) => ({
      recordIndex,
      predictions: record.goldEntities
        .filter((g) => g.gdprTier !== 'HIGH')
        .map((g): PredictedEntity => ({ start: g.start, end: g.end, type: g.type, gdprTier: g.gdprTier })),
    }));

    const summary = scoreRecords(SYNTHETIC_MULTILINGUAL_FIXTURE, predictions, 'exact');
    const byTier = new Map(summary.perGdprTier.map((t) => [t.gdprTier, t.counts]));

    expect(byTier.get('HIGH')?.recall).toBeLessThan(1);
    expect(byTier.get('HIGH')?.fn).toBeGreaterThan(0);
    expect(byTier.get('MED')?.recall).toBe(1);
    expect(byTier.get('LOW')?.recall).toBe(1);
    expect(summary.overall.recall).toBeLessThan(1);
  });

  it('a record with no predictions counts every gold entity as FN (empty-input shape)', () => {
    const summary = scoreRecords(SYNTHETIC_MULTILINGUAL_FIXTURE, [], 'exact');
    expect(summary.overall.tp).toBe(0);
    expect(summary.overall.recall).toBe(0);
    const totalGold = SYNTHETIC_MULTILINGUAL_FIXTURE.reduce((n, r) => n + r.goldEntities.length, 0);
    expect(summary.overall.fn).toBe(totalGold);
  });

  it('partial-overlap mode matches spans that exact mode would reject', () => {
    // Predict a span that overlaps the German "Depression" gold entity but
    // is not identical to it.
    const record = SYNTHETIC_MULTILINGUAL_FIXTURE[0];
    if (record === undefined) throw new Error('fixture missing record 0');
    const predictions: PredictedRecord[] = [
      { recordIndex: 0, predictions: [{ start: 20, end: 30, type: 'HEALTH_CONDITION', gdprTier: 'HIGH' }] },
    ];

    const exactSummary = scoreRecords([record], predictions, 'exact');
    expect(exactSummary.overall.tp).toBe(0);

    const overlapSummary = scoreRecords([record], predictions, 'partial-overlap');
    expect(overlapSummary.overall.tp).toBeGreaterThan(0);
  });

  it('an FP prediction with no asserted gdprTier is counted in overall but noted, not bucketed', () => {
    const record = SYNTHETIC_MULTILINGUAL_FIXTURE[2]; // German date-only, LOW tier record
    if (record === undefined) throw new Error('fixture missing record 2');
    // Predict a spurious span (no overlap with the gold DATE entity) with no gdprTier.
    const predictions: PredictedRecord[] = [{ recordIndex: 0, predictions: [{ start: 0, end: 3 }] }];

    const summary = scoreRecords([record], predictions, 'exact');
    expect(summary.overall.fp).toBe(1);
    for (const tier of summary.perGdprTier) {
      expect(tier.counts.fp).toBe(0);
    }
    expect(summary.notes.some((n) => /no asserted gdprTier/iu.test(n))).toBe(true);
  });

  it('matcher ranks candidates by overlap fraction first, mirroring src/recall.ts::matchSpans (regression: was pred.start/predLen only)', () => {
    // One record, two gold entities: Gc=[8,12) listed FIRST, Go=[2,6) listed
    // second — the ordering matters because a buggy start-first sort would
    // process Pa=[0,10) before Pb=[8,12) regardless of overlap quality.
    // Two predictions: Pa=[0,10) overlaps BOTH golds (partially: 2 chars of
    // Go, 2 chars of Gc) and Pb=[8,12) overlaps ONLY Gc, but EXACTLY (100%
    // overlap fraction vs Gc's 4-char length).
    //
    // Correct (overlap-fraction-primary) greedy assignment:
    //   Pb vs Gc has overlapFraction 1.0 (highest) -> assigned first: Gc<->Pb.
    //   Pa vs Go has overlapFraction 0.5 (2 of 4 chars) -> assigned next: Go<->Pa.
    //   Result: tp=2, fp=0, fn=0, recall=1.0.
    //
    // Buggy (pred.start-primary) greedy assignment sorts candidate pairs by
    // pred.start then predLen only, ignoring overlap quality: both
    // gold/pred candidate pairs involving Pa (start=0) sort ahead of the
    // Gc/Pb pair (start=8), so Pa is greedily assigned to whichever gold is
    // iterated first (Gc), leaving Go unmatched and Pb unused. Net effect:
    // tp=1, fn=1, recall=0.5.
    const record: EvalRecord = {
      text: 'xx go xx gc xx',
      language: 'en',
      goldEntities: [
        { start: 8, end: 12, type: 'ID', gdprTier: 'HIGH' }, // Gc
        { start: 2, end: 6, type: 'ID', gdprTier: 'HIGH' }, // Go
      ],
    };
    const predictions: PredictedRecord[] = [
      {
        recordIndex: 0,
        predictions: [
          { start: 0, end: 10, type: 'ID' }, // Pa
          { start: 8, end: 12, type: 'ID' }, // Pb
        ],
      },
    ];

    const summary = scoreRecords([record], predictions, 'partial-overlap');
    expect(summary.overall).toEqual(
      expect.objectContaining({ tp: 2, fp: 0, fn: 0, recall: 1 }),
    );
  });

  it('a gold entity with an out-of-set gdprTier is counted in overall but noted, not silently dropped (regression: was silently skipped)', () => {
    // Cast through unknown: the TS type is closed to HIGH/MED/LOW, but data
    // crossing a JSON/adapter boundary is not guaranteed to respect it —
    // this is exactly the runtime case the fix defends against.
    const badTier = 'CRIMINAL' as unknown as GdprTier;
    const record: EvalRecord = {
      text: 'gold entity text',
      language: 'en',
      goldEntities: [{ start: 0, end: 4, type: 'OFFENCE', gdprTier: badTier }],
    };
    const predictions: PredictedRecord[] = [
      { recordIndex: 0, predictions: [{ start: 0, end: 4, type: 'OFFENCE', gdprTier: badTier }] },
    ];

    const summary = scoreRecords([record], predictions, 'exact');

    // Still counted in overall (and perLanguage) — not dropped.
    expect(summary.overall.tp).toBe(1);
    expect(summary.overall.fn).toBe(0);
    const enBucket = summary.perLanguage.find((l) => l.language === 'en');
    expect(enBucket?.counts.tp).toBe(1);

    // No perGdprTier bucket exists for it (bucket-total invariant: this gold
    // entity is intentionally absent from HIGH/MED/LOW).
    for (const tier of summary.perGdprTier) {
      expect(tier.counts.tp).toBe(0);
    }

    // Surfaced via notes, mirroring the FP-side unknown-tier note.
    expect(summary.notes.some((n) => /gdprTier outside HIGH\/MED\/LOW/iu.test(n))).toBe(true);
  });
});

describe('redactRecordToInternal — intentional stub (NEVER-GUESS boundary)', () => {
  it('throws rather than guessing REDACT on-disk schema', () => {
    expect(() => redactRecordToInternal({ anything: 'goes' })).toThrow(/not implemented/iu);
  });
});
