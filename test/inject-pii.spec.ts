import { describe, expect, it } from 'vitest';

import {
  HIPAA_CATEGORIES,
  MAX_PHI_PER_ROW,
  MIN_PHI_PER_ROW,
  injectIntoRows,
  pickMeasurementBSubset,
  verifyInjectionRow,
} from '../src/inject-pii-core.js';

/**
 * Build a deterministic fixture of N carrier rows. Each row's text is long
 * enough to host MAX_PHI_PER_ROW insertions without exhausting distinct
 * positions. We use lorem-ipsum-style filler so test invariants don't depend
 * on the MTSamples corpus being downloaded.
 */
function buildFixture(n: number): Array<{ row_index: number; transcription: string }> {
  const filler =
    'The patient presents with chest discomfort. Vital signs are stable. Auscultation reveals mild wheeze. ' +
    'Past medical history is significant for hypertension and well-controlled diabetes. ' +
    'No acute distress noted. Medications were reviewed and reconciled at the bedside. ' +
    'A follow-up appointment is recommended in two weeks. Discharge instructions were provided. ';
  const carrier = filler.repeat(8); // ~3.5 KB of text — plenty of headroom for ~25 insertions.
  const rows: Array<{ row_index: number; transcription: string }> = [];
  for (let i = 0; i < n; i++) {
    rows.push({ row_index: i, transcription: carrier });
  }
  return rows;
}

describe('inject-pii determinism', () => {
  it('produces byte-identical output across two runs with the same seed', () => {
    const fixture = buildFixture(5);
    const a = injectIntoRows(fixture);
    const b = injectIntoRows(fixture);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('inject-pii density', () => {
  it('injects between MIN_PHI_PER_ROW and MAX_PHI_PER_ROW entities per row', () => {
    const fixture = buildFixture(20);
    const injected = injectIntoRows(fixture);
    for (const row of injected) {
      expect(row.entities.length).toBeGreaterThanOrEqual(MIN_PHI_PER_ROW);
      expect(row.entities.length).toBeLessThanOrEqual(MAX_PHI_PER_ROW);
    }
  });
});

describe('inject-pii category coverage', () => {
  it('covers all 18 HIPAA Safe Harbor categories at least once across a 500-row subset', () => {
    // Use the same fixture shape as the real subset to make this a
    // statistical-coverage check rather than a tiny-N flake.
    const fixture = buildFixture(500);
    const injected = injectIntoRows(fixture);

    const seen = new Set<string>();
    for (const row of injected) {
      for (const e of row.entities) {
        seen.add(e.category);
      }
    }

    for (const cat of HIPAA_CATEGORIES) {
      expect(seen.has(cat), `category ${cat} should appear at least once across 500 rows`).toBe(
        true,
      );
    }
  });
});

describe('inject-pii ground-truth coordinates', () => {
  it('resolves every recorded (start, end, value) entity to its exact value in the injected text', () => {
    const fixture = buildFixture(25);
    const injected = injectIntoRows(fixture);

    for (const row of injected) {
      // The core helper throws on first mismatch; this test passes iff it returns.
      verifyInjectionRow(row);

      // Belt-and-braces: also verify each recorded value resolves exactly
      // when seek'd into the injected text (note: some Faker values may
      // collide, so we don't insist on strict distinctness — we insist on
      // round-trip exact equality, which is what matters for recall
      // computation).
      for (const e of row.entities) {
        expect(row.injected_transcription.slice(e.start_char, e.end_char)).toBe(e.value);
      }
    }
  });
});

describe('pickMeasurementBSubset', () => {
  it('returns a sorted distinct subset of the requested size', () => {
    const subset = pickMeasurementBSubset(2000, 500);
    expect(subset.length).toBe(500);
    expect(new Set(subset).size).toBe(500);
    for (let i = 1; i < subset.length; i++) {
      expect((subset[i] ?? 0) > (subset[i - 1] ?? 0)).toBe(true);
    }
    for (const idx of subset) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(2000);
    }
  });

  it('is deterministic across calls', () => {
    const a = pickMeasurementBSubset(2000, 500);
    const b = pickMeasurementBSubset(2000, 500);
    expect(b).toEqual(a);
  });
});
