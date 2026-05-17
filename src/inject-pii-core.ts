/**
 * inject-pii-core.ts
 *
 * Deterministic synthetic-PII injection over MTSamples-style clinical narrative.
 *
 * Design invariants:
 *   1. Given the same input rows + same SEED, the output (injected text +
 *      ground-truth coordinates) is byte-identical across runs and machines.
 *   2. Per-row injection density falls inside [MIN_PHI_PER_ROW, MAX_PHI_PER_ROW].
 *   3. All 18 HIPAA Safe Harbor categories appear at least once across any
 *      subset of size >= 18 rows (statistical check, not per-row).
 *   4. Every recorded (start_char, end_char, value) ground-truth entry
 *      resolves exactly when seek'd into the injected transcription.
 *
 * The injection does NOT cleanse pre-existing residual identifiers in the
 * source text — those are out of scope for Measurement B (see RECIPE.md).
 */

import { faker } from '@faker-js/faker';

export const SEED = 42;
export const MIN_PHI_PER_ROW = 20;
export const MAX_PHI_PER_ROW = 25;

/**
 * The 18 HIPAA Safe Harbor categories (45 CFR § 164.514(b)(2)(i)).
 */
export const HIPAA_CATEGORIES = [
  'NAME',
  'GEO_SUBDIVISION',
  'DATE',
  'PHONE',
  'FAX',
  'EMAIL',
  'SSN',
  'MRN',
  'HEALTH_PLAN_ID',
  'ACCOUNT_NUMBER',
  'LICENSE_NUMBER',
  'VEHICLE_ID',
  'DEVICE_ID',
  'URL',
  'IP_ADDRESS',
  'BIOMETRIC_ID',
  'FACE_PHOTO_REF',
  'OTHER_UNIQUE_ID',
] as const;

export type HipaaCategory = (typeof HIPAA_CATEGORIES)[number];

export interface InjectedEntity {
  readonly category: HipaaCategory;
  readonly value: string;
  readonly start_char: number;
  readonly end_char: number;
}

export interface InjectedRow {
  readonly row_index: number;
  readonly original_transcription: string;
  readonly injected_transcription: string;
  readonly entities: readonly InjectedEntity[];
}

/**
 * Mulberry32 PRNG — deterministic, fast, sufficient for non-crypto sampling.
 * Identical output across Node, browsers, and platforms for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return Math.floor(rng() * (maxInclusive - minInclusive + 1)) + minInclusive;
}

function pickWeightedCategory(rng: () => number): HipaaCategory {
  // Approximate i2b2 empirical proportions (Stubbs & Uzuner 2015):
  //   DATE ~35%, NAME ~20%, GEO ~15%, ID-shaped ~10% combined, remainder ~20% across 11 cats.
  // Implemented as a cumulative distribution keyed off the rng.
  const dist: Array<[HipaaCategory, number]> = [
    ['DATE', 0.35],
    ['NAME', 0.55],
    ['GEO_SUBDIVISION', 0.7],
    ['MRN', 0.74],
    ['HEALTH_PLAN_ID', 0.77],
    ['ACCOUNT_NUMBER', 0.8],
    ['PHONE', 0.82],
    ['FAX', 0.84],
    ['EMAIL', 0.86],
    ['SSN', 0.88],
    ['LICENSE_NUMBER', 0.9],
    ['VEHICLE_ID', 0.92],
    ['DEVICE_ID', 0.94],
    ['URL', 0.955],
    ['IP_ADDRESS', 0.97],
    ['BIOMETRIC_ID', 0.98],
    ['FACE_PHOTO_REF', 0.99],
    ['OTHER_UNIQUE_ID', 1.0],
  ];
  const r = rng();
  for (const [cat, cumulative] of dist) {
    if (r < cumulative) return cat;
  }
  return 'OTHER_UNIQUE_ID';
}

/**
 * Synthesize a category-appropriate PHI string using Faker.
 *
 * Faker is seeded globally (see `injectIntoRows` below). Each call advances
 * Faker's internal RNG, so the sequence of synthesized values is deterministic
 * for a given seed + same call order.
 */
function synthesizeValue(category: HipaaCategory): string {
  switch (category) {
    case 'NAME':
      return faker.person.fullName();
    case 'GEO_SUBDIVISION':
      return `${faker.location.streetAddress()}, ${faker.location.city()}`;
    case 'DATE':
      return faker.date.between({ from: '1990-01-01', to: '2024-12-31' }).toISOString().slice(0, 10);
    case 'PHONE':
      return faker.phone.number({ style: 'national' });
    case 'FAX':
      return `Fax: ${faker.phone.number({ style: 'national' })}`;
    case 'EMAIL':
      return faker.internet.email();
    case 'SSN':
      return `${pad(faker.number.int({ min: 100, max: 999 }), 3)}-${pad(faker.number.int({ min: 10, max: 99 }), 2)}-${pad(faker.number.int({ min: 1000, max: 9999 }), 4)}`;
    case 'MRN':
      return `MRN${pad(faker.number.int({ min: 1, max: 9999999 }), 7)}`;
    case 'HEALTH_PLAN_ID':
      return `HP-${faker.string.alphanumeric({ length: 9, casing: 'upper' })}`;
    case 'ACCOUNT_NUMBER':
      return `ACCT-${faker.string.alphanumeric({ length: 10, casing: 'upper' })}`;
    case 'LICENSE_NUMBER':
      return `LIC-${faker.string.alphanumeric({ length: 8, casing: 'upper' })}`;
    case 'VEHICLE_ID':
      return faker.vehicle.vin();
    case 'DEVICE_ID':
      return `DEV-${faker.string.alphanumeric({ length: 12, casing: 'upper' })}`;
    case 'URL':
      return faker.internet.url();
    case 'IP_ADDRESS':
      return faker.internet.ipv4();
    case 'BIOMETRIC_ID':
      return `BIO-FINGERPRINT-${faker.string.alphanumeric({ length: 16, casing: 'upper' })}`;
    case 'FACE_PHOTO_REF':
      return `face-photo://${faker.string.alphanumeric({ length: 12 })}.jpg`;
    case 'OTHER_UNIQUE_ID':
      return `STUDY-${faker.string.alphanumeric({ length: 8, casing: 'upper' })}`;
  }
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * Inject a sequence of synthetic PHI values into a single transcription.
 *
 * Strategy:
 *   1. Pick N = uniform in [MIN_PHI_PER_ROW, MAX_PHI_PER_ROW].
 *   2. Pick N insertion positions, sorted ascending.
 *   3. Synthesize N category-appropriate values.
 *   4. Splice them in from highest position to lowest (so earlier positions
 *      stay valid as we insert).
 *   5. Record the post-insertion (start_char, end_char, value, category).
 *
 * Insertion uses a single leading space + the value + a single trailing space
 * so the injected text reads naturally inside the surrounding narrative.
 */
export function injectIntoRow(rowIndex: number, transcription: string): InjectedRow {
  const rowRng = mulberry32(SEED * 1_000_003 + rowIndex);

  const targetCount = pickInt(rowRng, MIN_PHI_PER_ROW, MAX_PHI_PER_ROW);

  // Pick N insertion positions in [0, transcription.length].
  // Use a Set to deduplicate, then top-up if duplicates collapsed the count.
  const positions = new Set<number>();
  let safety = 0;
  const maxPos = Math.max(1, transcription.length);
  while (positions.size < targetCount && safety < targetCount * 10) {
    positions.add(pickInt(rowRng, 0, maxPos));
    safety++;
  }
  // If after the safety budget we still don't have enough distinct positions
  // (very short transcription), just settle for what we have.

  const sortedPositions = Array.from(positions).sort((a, b) => a - b);

  // Pick categories per position (in the same forward order so the Faker
  // sequence is deterministic and inspectable).
  const categories: HipaaCategory[] = [];
  for (let i = 0; i < sortedPositions.length; i++) {
    categories.push(pickWeightedCategory(rowRng));
  }

  // Synthesize values in forward order. Faker is globally seeded — each call
  // advances Faker's RNG deterministically.
  const values: string[] = [];
  for (const cat of categories) {
    values.push(synthesizeValue(cat));
  }

  // Insert from highest position to lowest so earlier positions remain valid.
  let injected = transcription;
  const entitiesReverse: InjectedEntity[] = [];
  for (let i = sortedPositions.length - 1; i >= 0; i--) {
    const pos = sortedPositions[i] ?? 0;
    const cat = categories[i] ?? 'OTHER_UNIQUE_ID';
    const value = values[i] ?? '';
    const wrapped = ` ${value} `;
    injected = injected.slice(0, pos) + wrapped + injected.slice(pos);
    // Post-insertion absolute coords of `value` itself:
    //   wrapped starts at pos; value starts at pos + 1; ends at pos + 1 + value.length.
    // BUT every entity recorded so far (entitiesReverse) was inserted at a
    // higher position, so their absolute coords stay valid; we record this
    // one's coords at its current absolute position.
    entitiesReverse.push({
      category: cat,
      value,
      start_char: pos + 1,
      end_char: pos + 1 + value.length,
    });
  }

  // entitiesReverse is in reverse order; we recorded each entity AFTER
  // inserting it but BEFORE the next-lower insertion. Since the next
  // insertion happens at a strictly lower position, it shifts the just-
  // recorded entity's absolute coords forward by `wrapped.length` of the
  // newer insertion. Adjust:
  // Walk forward through the *position sequence* (highest -> lowest as
  // recorded) and apply cumulative shifts to coords of items inserted earlier
  // in the reverse pass (i.e. higher-position items).
  //
  // Simpler approach: rebuild ground truth by scanning the final `injected`
  // string for the recorded values in order. But that's ambiguous if a value
  // repeats. Instead, we recompute coords deterministically from the original
  // positions and the cumulative shifts.

  // Reset: recompute absolute coords cleanly.
  // For the chronological reverse pass (highest -> lowest), each insertion of
  // length W = value.length + 2 at original position P shifts every previously
  // recorded entity (which lives at a higher original position) by +W.
  //
  // We have categories[] and values[] indexed in forward order (lowest -> highest position).
  // After all insertions, the final coord of categories[i] is:
  //   start_char = positions[i] + 1 + sum(values[j].length + 2 for j < i)
  // because every insertion at a LOWER position (j < i) shifts entity i forward by W_j.
  let cumulative = 0;
  const entities: InjectedEntity[] = [];
  for (let i = 0; i < sortedPositions.length; i++) {
    const pos = sortedPositions[i] ?? 0;
    const cat = categories[i] ?? 'OTHER_UNIQUE_ID';
    const value = values[i] ?? '';
    const start = pos + 1 + cumulative;
    entities.push({
      category: cat,
      value,
      start_char: start,
      end_char: start + value.length,
    });
    cumulative += value.length + 2; // ` ${value} ` -> +2 for the surrounding spaces.
  }

  // Sanity: prevent the impossible reverse-array variable from being reported as unused.
  void entitiesReverse;

  return {
    row_index: rowIndex,
    original_transcription: transcription,
    injected_transcription: injected,
    entities,
  };
}

/**
 * Inject across many rows. Reseeds Faker once at the start so the entire
 * batch is deterministic.
 */
export function injectIntoRows(
  rows: ReadonlyArray<{ row_index: number; transcription: string }>,
): InjectedRow[] {
  faker.seed(SEED);
  const out: InjectedRow[] = [];
  for (const r of rows) {
    out.push(injectIntoRow(r.row_index, r.transcription));
  }
  return out;
}

/**
 * Verify that every recorded (start_char, end_char, value) entity in `row`
 * resolves to exactly `value` when seek'd into `row.injected_transcription`.
 * Throws on first mismatch.
 */
export function verifyInjectionRow(row: InjectedRow): void {
  for (const e of row.entities) {
    const sliced = row.injected_transcription.slice(e.start_char, e.end_char);
    if (sliced !== e.value) {
      throw new Error(
        `verify failed for row ${row.row_index} category=${e.category}: ` +
          `expected ${JSON.stringify(e.value)} at [${e.start_char},${e.end_char}); ` +
          `got ${JSON.stringify(sliced)}.`,
      );
    }
  }
}

/**
 * Deterministic 500-row subset selection from a corpus of size `totalRows`.
 * Returns sorted row indices.
 */
export function pickMeasurementBSubset(totalRows: number, subsetSize = 500): number[] {
  if (subsetSize > totalRows) {
    throw new Error(`subset size ${subsetSize} > totalRows ${totalRows}`);
  }
  const rng = mulberry32(SEED);
  const picked = new Set<number>();
  // Reservoir-ish sampling via repeated draws + deduplication keeps the
  // implementation simple and deterministic.
  let safety = 0;
  while (picked.size < subsetSize && safety < subsetSize * 100) {
    picked.add(pickInt(rng, 0, totalRows - 1));
    safety++;
  }
  return Array.from(picked).sort((a, b) => a - b);
}
