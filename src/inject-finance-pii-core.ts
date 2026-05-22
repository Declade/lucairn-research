/**
 * inject-finance-pii-core.ts
 *
 * Deterministic synthetic-NPI injection over CFPB Consumer Complaint Database
 * narrative text. Mirrors `inject-pii-core.ts` (HIPAA) in structure and
 * determinism contract, swapping the category enumeration to GLBA NPI per the
 * Paper 2 RECIPE at `datasets/finance/RECIPE.md`.
 *
 * Design invariants (parity with healthcare):
 *   1. Given the same input rows + same SEED, output is byte-identical across
 *      runs and machines.
 *   2. Per-row injection density falls inside [MIN_NPI_PER_ROW, MAX_NPI_PER_ROW].
 *   3. All GLBA_CATEGORIES values appear at least once across any subset of
 *      size >= 17 rows (statistical check, not per-row).
 *   4. Every recorded (start_char, end_char, value) ground-truth entry resolves
 *      exactly when seek'd into the injected narrative.
 *
 * The injection does NOT cleanse pre-existing residual identifiers in the
 * source CFPB narrative — those are out of scope for Measurement B (see
 * `datasets/finance/RECIPE.md`).
 */

import { faker } from '@faker-js/faker';

import { SEED, MIN_PHI_PER_ROW, MAX_PHI_PER_ROW, mulberry32 } from './inject-pii-core.js';

// Re-export shared determinism primitives so callers can stay symmetrical with
// the healthcare pipeline.
export { SEED, mulberry32 } from './inject-pii-core.js';
export const MIN_NPI_PER_ROW = MIN_PHI_PER_ROW;
export const MAX_NPI_PER_ROW = MAX_PHI_PER_ROW;

/**
 * The GLBA NPI category enumeration used by Paper 2.
 *
 * Sources for the enumeration (cite-back in `datasets/finance/RECIPE.md`):
 *   - 16 CFR § 313.3(n) — GLBA Privacy Rule "nonpublic personal information"
 *     definition + examples.
 *   - 16 CFR Part 314 — FTC Safeguards Rule, "customer information"
 *     enumeration.
 *   - PCI-DSS v4.0 §3.2.1 — Account Data ("Cardholder Data") definition for
 *     PAN / CVV / expiration.
 *   - HIPAA Safe Harbor 18 categories at 45 CFR § 164.514(b)(2)(i) used as the
 *     enumeration model for cross-paper structural parity, NOT as the
 *     regulatory frame.
 */
export const GLBA_CATEGORIES = [
  'FULL_NAME',
  'RESIDENTIAL_ADDRESS',
  'SSN',
  'EMAIL',
  'PHONE',
  'DOB',
  'BANK_ACCOUNT_NUMBER',
  'BANK_ROUTING_NUMBER',
  'CREDIT_CARD_PAN',
  'CARD_CVV',
  'CARD_EXPIRATION',
  'IBAN',
  'TAX_ID',
  'DRIVER_LICENSE',
  'ACCOUNT_BALANCE',
  'CREDIT_SCORE',
  'LOAN_ACCOUNT_ID',
] as const;

export type GlbaCategory = (typeof GLBA_CATEGORIES)[number];

export interface InjectedFinanceEntity {
  readonly category: GlbaCategory;
  readonly value: string;
  readonly start_char: number;
  readonly end_char: number;
}

export interface InjectedFinanceRow {
  readonly row_index: number;
  readonly original_narrative: string;
  readonly injected_narrative: string;
  readonly entities: readonly InjectedFinanceEntity[];
}

function pickInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return Math.floor(rng() * (maxInclusive - minInclusive + 1)) + minInclusive;
}

/**
 * Cumulative-weight category sampler.
 *
 * No empirical "i2b2 equivalent" baseline exists for finance NPI density — this
 * distribution is documented in `datasets/finance/RECIPE.md` as a per-category
 * weighting calibrated to (a) realistic consumer-finance narrative content
 * (names + addresses + account/transaction references dominate) and (b)
 * preserving non-zero coverage for every GLBA category across a 500-row subset.
 *
 * Weights are CUMULATIVE in the array, monotone in [0, 1].
 */
function pickWeightedFinanceCategory(rng: () => number): GlbaCategory {
  const dist: Array<[GlbaCategory, number]> = [
    ['FULL_NAME', 0.18],
    ['RESIDENTIAL_ADDRESS', 0.33],
    ['BANK_ACCOUNT_NUMBER', 0.45],
    ['CREDIT_CARD_PAN', 0.55],
    ['SSN', 0.62],
    ['EMAIL', 0.68],
    ['PHONE', 0.74],
    ['DOB', 0.79],
    ['BANK_ROUTING_NUMBER', 0.83],
    ['ACCOUNT_BALANCE', 0.87],
    ['LOAN_ACCOUNT_ID', 0.9],
    ['TAX_ID', 0.93],
    ['DRIVER_LICENSE', 0.95],
    ['CREDIT_SCORE', 0.97],
    ['CARD_EXPIRATION', 0.985],
    ['CARD_CVV', 0.995],
    ['IBAN', 1.0],
  ];
  const r = rng();
  for (const [cat, cumulative] of dist) {
    if (r < cumulative) return cat;
  }
  return 'LOAN_ACCOUNT_ID';
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * Luhn-valid 16-digit PAN. Faker's `finance.creditCardNumber()` honors Luhn
 * by default; we wrap to keep the shape deterministic (no provider suffixes).
 */
function synthesizeCreditCardPan(): string {
  // Faker's creditCardNumber returns a Luhn-valid number. Strip separators for
  // a clean tokenisable shape.
  return faker.finance.creditCardNumber({ issuer: 'visa' }).replace(/[ -]/g, '');
}

function synthesizeIban(): string {
  // Faker's iban() returns DE/IE/GB/etc. Use a country code to make the shape
  // predictable for downstream pattern matching.
  return faker.finance.iban({ countryCode: 'DE', formatted: false });
}

function synthesizeValue(category: GlbaCategory): string {
  switch (category) {
    case 'FULL_NAME':
      return faker.person.fullName();
    case 'RESIDENTIAL_ADDRESS':
      return `${faker.location.streetAddress()}, ${faker.location.city()}, ${faker.location.state({ abbreviated: true })} ${faker.location.zipCode()}`;
    case 'SSN':
      return `${pad(faker.number.int({ min: 100, max: 999 }), 3)}-${pad(faker.number.int({ min: 10, max: 99 }), 2)}-${pad(faker.number.int({ min: 1000, max: 9999 }), 4)}`;
    case 'EMAIL':
      return faker.internet.email();
    case 'PHONE':
      return faker.phone.number({ style: 'national' });
    case 'DOB':
      return faker.date
        .between({ from: '1940-01-01', to: '2005-12-31' })
        .toISOString()
        .slice(0, 10);
    case 'BANK_ACCOUNT_NUMBER':
      // US-style ACH account number — 8-12 digits.
      return pad(faker.number.int({ min: 0, max: 999_999_999_999 }), faker.number.int({ min: 8, max: 12 }));
    case 'BANK_ROUTING_NUMBER':
      // ABA routing — exactly 9 digits. Faker has aba(); not all versions
      // expose it, so fall back to a deterministic 9-digit string.
      return pad(faker.number.int({ min: 10_000_000, max: 999_999_999 }), 9);
    case 'CREDIT_CARD_PAN':
      return synthesizeCreditCardPan();
    case 'CARD_CVV':
      return pad(faker.number.int({ min: 100, max: 9999 }), faker.number.int({ min: 3, max: 4 }));
    case 'CARD_EXPIRATION':
      // MM/YY shape.
      return `${pad(faker.number.int({ min: 1, max: 12 }), 2)}/${pad(faker.number.int({ min: 26, max: 32 }), 2)}`;
    case 'IBAN':
      return synthesizeIban();
    case 'TAX_ID':
      // EIN (XX-XXXXXXX) and ITIN (9XX-XX-XXXX) shapes — pick one.
      if (faker.datatype.boolean()) {
        return `${pad(faker.number.int({ min: 10, max: 99 }), 2)}-${pad(faker.number.int({ min: 1_000_000, max: 9_999_999 }), 7)}`;
      }
      return `9${pad(faker.number.int({ min: 0, max: 99 }), 2)}-${pad(faker.number.int({ min: 70, max: 88 }), 2)}-${pad(faker.number.int({ min: 1000, max: 9999 }), 4)}`;
    case 'DRIVER_LICENSE':
      return `DL-${faker.string.alphanumeric({ length: 9, casing: 'upper' })}`;
    case 'ACCOUNT_BALANCE':
      // Plain dollar amount with 2 decimal places.
      return `$${faker.number.int({ min: 100, max: 999_999 }).toLocaleString('en-US')}.${pad(faker.number.int({ min: 0, max: 99 }), 2)}`;
    case 'CREDIT_SCORE':
      return String(faker.number.int({ min: 300, max: 850 }));
    case 'LOAN_ACCOUNT_ID':
      return `LN-${faker.string.alphanumeric({ length: 10, casing: 'upper' })}`;
  }
}

/**
 * Inject NPI into a single CFPB narrative row.
 *
 * Mirrors `inject-pii-core.ts:injectIntoRow` exactly in algorithm; the only
 * differences are the category set and the synthesizer dispatch table.
 */
export function injectIntoRow(rowIndex: number, narrative: string): InjectedFinanceRow {
  const rowRng = mulberry32(SEED * 1_000_003 + rowIndex);

  const targetCount = pickInt(rowRng, MIN_NPI_PER_ROW, MAX_NPI_PER_ROW);

  const positions = new Set<number>();
  let safety = 0;
  const maxPos = Math.max(1, narrative.length);
  while (positions.size < targetCount && safety < targetCount * 10) {
    positions.add(pickInt(rowRng, 0, maxPos));
    safety++;
  }

  const sortedPositions = Array.from(positions).sort((a, b) => a - b);

  const categories: GlbaCategory[] = [];
  for (let i = 0; i < sortedPositions.length; i++) {
    categories.push(pickWeightedFinanceCategory(rowRng));
  }

  const values: string[] = [];
  for (const cat of categories) {
    values.push(synthesizeValue(cat));
  }

  let injected = narrative;
  for (let i = sortedPositions.length - 1; i >= 0; i--) {
    const pos = sortedPositions[i] ?? 0;
    const value = values[i] ?? '';
    const wrapped = ` ${value} `;
    injected = injected.slice(0, pos) + wrapped + injected.slice(pos);
  }

  // Recompute final absolute coords from the original positions + cumulative
  // shifts (same algebra as the healthcare core, see comment block there).
  let cumulative = 0;
  const entities: InjectedFinanceEntity[] = [];
  for (let i = 0; i < sortedPositions.length; i++) {
    const pos = sortedPositions[i] ?? 0;
    const cat = categories[i] ?? 'LOAN_ACCOUNT_ID';
    const value = values[i] ?? '';
    const start = pos + 1 + cumulative;
    entities.push({
      category: cat,
      value,
      start_char: start,
      end_char: start + value.length,
    });
    cumulative += value.length + 2;
  }

  return {
    row_index: rowIndex,
    original_narrative: narrative,
    injected_narrative: injected,
    entities,
  };
}

export function injectIntoRows(
  rows: ReadonlyArray<{ row_index: number; narrative: string }>,
): InjectedFinanceRow[] {
  faker.seed(SEED);
  const out: InjectedFinanceRow[] = [];
  for (const r of rows) {
    out.push(injectIntoRow(r.row_index, r.narrative));
  }
  return out;
}

export function verifyInjectionRow(row: InjectedFinanceRow): void {
  for (const e of row.entities) {
    const sliced = row.injected_narrative.slice(e.start_char, e.end_char);
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
 * Deterministic 500-row subset selection from the CFPB non-empty-narrative
 * row set. Re-uses the same SEED and Mulberry32 PRNG as healthcare so the
 * sampling pattern is identical across papers.
 */
export function pickMeasurementBSubset(totalRows: number, subsetSize = 500): number[] {
  if (subsetSize > totalRows) {
    throw new Error(`subset size ${subsetSize} > totalRows ${totalRows}`);
  }
  const rng = mulberry32(SEED);
  const picked = new Set<number>();
  let safety = 0;
  while (picked.size < subsetSize && safety < subsetSize * 100) {
    picked.add(pickInt(rng, 0, totalRows - 1));
    safety++;
  }
  return Array.from(picked).sort((a, b) => a - b);
}
