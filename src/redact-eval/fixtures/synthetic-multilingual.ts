/**
 * synthetic-multilingual.ts (REDACT eval harness)
 *
 * Hand-authored synthetic fixture — NOT real data, NOT downloaded, NOT
 * derived from REDACT (PRD Slice 10: "NO model runs, NO real-dataset
 * download"). Every sentence below is invented for this fixture; any
 * resemblance to a real person is coincidental.
 *
 * Covers German (de) and English (en), with at least one record touching
 * each GDPR tier (HIGH / MED / LOW — see schema.ts doc-comment for tier
 * definitions). `start`/`end` offsets are exact UTF-16-code-unit slices of
 * the `text` string on that record (verified via `text.indexOf(needle)` at
 * fixture-authoring time, not eyeballed) and are re-verified at test time by
 * `test/redact-eval/scorer.spec.ts`'s "fixture self-consistency" case, which
 * slices `text.slice(start, end)` for every gold entity and asserts it
 * round-trips — a cheap regression guard against a future edit to `text`
 * silently invalidating the offsets.
 */

import type { EvalRecord } from '../schema.js';

export const SYNTHETIC_MULTILINGUAL_FIXTURE: readonly EvalRecord[] = [
  // --- German (de) ---
  {
    // HIGH tier: a health condition (Art. 9 special-category) + a national
    // ID number (freestanding linkage-risk identifier).
    text: 'Frau Müller wurde mit Depression diagnostiziert, ihre Sozialversicherungsnummer lautet 65 120176 M 052.',
    language: 'de',
    goldEntities: [
      { start: 5, end: 11, type: 'PERSON', gdprTier: 'MED' }, // "Müller"
      { start: 22, end: 32, type: 'HEALTH_CONDITION', gdprTier: 'HIGH' }, // "Depression"
      { start: 87, end: 102, type: 'NATIONAL_ID', gdprTier: 'HIGH' }, // "65 120176 M 052"
    ],
  },
  {
    // MED tier: ordinary identifying PII (name, phone), plus a LOW-tier
    // quasi-identifier (city).
    text: 'Herr Bauer aus München erreichen Sie unter 089 1234567.',
    language: 'de',
    goldEntities: [
      { start: 5, end: 10, type: 'PERSON', gdprTier: 'MED' }, // "Bauer"
      { start: 15, end: 22, type: 'LOCATION', gdprTier: 'LOW' }, // "München"
      { start: 43, end: 54, type: 'PHONE', gdprTier: 'MED' }, // "089 1234567"
    ],
  },
  {
    // LOW tier only: a generic date, no direct identifier in this sentence.
    text: 'Der Termin wurde auf den 14. März 2026 verschoben.',
    language: 'de',
    goldEntities: [{ start: 25, end: 38, type: 'DATE', gdprTier: 'LOW' }], // "14. März 2026"
  },
  // --- English (en) ---
  {
    // HIGH tier: criminal-offence data (Art. 10) + an email (MED).
    text: 'John Carter was convicted of tax fraud in 2019; contact john.carter@example.test for records.',
    language: 'en',
    goldEntities: [
      { start: 0, end: 11, type: 'PERSON', gdprTier: 'MED' }, // "John Carter"
      { start: 29, end: 38, type: 'CRIMINAL_OFFENCE', gdprTier: 'HIGH' }, // "tax fraud"
      { start: 56, end: 80, type: 'EMAIL', gdprTier: 'MED' }, // "john.carter@example.test"
    ],
  },
  {
    // MED tier: standard PII (name, IBAN-like account identifier).
    text: 'Please route the refund to Aisha Khan, account DE44 5001 0517 5407 3249 31.',
    language: 'en',
    goldEntities: [
      { start: 27, end: 37, type: 'PERSON', gdprTier: 'MED' }, // "Aisha Khan"
      { start: 47, end: 74, type: 'IBAN', gdprTier: 'MED' }, // "DE44 5001 0517 5407 3249 31"
    ],
  },
  {
    // LOW tier only: a quasi-identifying city + generic date.
    text: 'The Berlin office closed early on Friday, 3 July.',
    language: 'en',
    goldEntities: [
      { start: 4, end: 10, type: 'LOCATION', gdprTier: 'LOW' }, // "Berlin"
      { start: 34, end: 48, type: 'DATE', gdprTier: 'LOW' }, // "Friday, 3 July"
    ],
  },
];
