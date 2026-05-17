/**
 * hipaa-category-mapping.ts
 *
 * Maps Lucairn's internal sanitizer placeholder types (the `[TYPE_N]` shape)
 * back to the 18 HIPAA Safe Harbor categories defined in
 * `src/inject-pii-core.ts:28-47` (45 CFR § 164.514(b)(2)(i)).
 *
 * Why this exists:
 *   The Lucairn sanitizer emits redactions whose `placeholder` field is of the
 *   form `[TYPE_N]` where TYPE is an internal taxonomy term (PERSON, LOCATION,
 *   PHONE_NUMBER, etc.). The HIPAA Safe Harbor enumeration is the standard the
 *   research program reports recall against. This module is the documented
 *   bridge between the two taxonomies.
 *
 * Cite-back: gateway emits `placeholder` per redaction at
 *   `dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:48-56`
 * and the placeholder parsing convention at
 *   `dual-sandbox-architecture/services/gateway/internal/api/proxy.go:1361-1395`
 * (extractEntityTypes — accepts `[TYPE_N]` where TYPE is one or more
 * uppercase letters/underscores).
 *
 * The mapping is intentionally explicit and one-way (internal → HIPAA). If
 * Lucairn introduces a new sanitizer type, this table MUST be extended before
 * Paper 1 numbers are re-published — an unmapped placeholder is a recall
 * accounting gap, not a silent passthrough.
 */

import type { HipaaCategory } from './inject-pii-core.js';

/**
 * The exhaustive mapping from Lucairn internal sanitizer types to HIPAA Safe
 * Harbor categories.
 *
 * Sources for the right-hand-side category assignments:
 *  - 45 CFR § 164.514(b)(2)(i) Safe Harbor enumeration (the 18 categories
 *    listed in `src/inject-pii-core.ts:28-47`).
 *  - Lucairn sanitizer's internal type vocabulary as observed in the gateway
 *    `extractEntityTypes` logic (`proxy.go:1361-1395`) and the Presidio +
 *    custom recognizer catalogue.
 *
 * Categories not currently emitted by the sanitizer (e.g. FACE_PHOTO_REF,
 * BIOMETRIC_ID) are absent from this map; they appear in injected ground
 * truth only and will show as false-negatives if the sanitizer never detects
 * them, which is correct accounting.
 */
export const LUCAIRN_TO_HIPAA: Readonly<Record<string, HipaaCategory>> = Object.freeze({
  // Name-bearing types
  PERSON: 'NAME',
  PERSON_NAME: 'NAME',
  NAME: 'NAME',

  // Geographic subdivisions
  LOCATION: 'GEO_SUBDIVISION',
  ADDRESS: 'GEO_SUBDIVISION',
  STREET_ADDRESS: 'GEO_SUBDIVISION',
  ZIP_CODE: 'GEO_SUBDIVISION',
  GERMAN_ZIP_CODE: 'GEO_SUBDIVISION',
  CITY: 'GEO_SUBDIVISION',

  // Dates
  DATE: 'DATE',
  DATE_TIME: 'DATE',

  // Telephone / fax — sanitizer does not natively distinguish PHONE from FAX.
  // We map both PHONE_NUMBER and PHONE to PHONE; FAX is only recognised when
  // a custom recognizer surfaces FAX explicitly.
  PHONE_NUMBER: 'PHONE',
  PHONE: 'PHONE',
  FAX: 'FAX',
  FAX_NUMBER: 'FAX',

  // Email
  EMAIL: 'EMAIL',
  EMAIL_ADDRESS: 'EMAIL',

  // US identifier-shaped categories
  US_SSN: 'SSN',
  SSN: 'SSN',

  // Medical record / health-plan / account / license / vehicle / device
  MRN: 'MRN',
  MEDICAL_RECORD_NUMBER: 'MRN',
  HEALTH_PLAN_ID: 'HEALTH_PLAN_ID',
  HEALTH_PLAN_BENEFICIARY_NUMBER: 'HEALTH_PLAN_ID',
  ACCOUNT_NUMBER: 'ACCOUNT_NUMBER',
  US_BANK_NUMBER: 'ACCOUNT_NUMBER',
  IBAN: 'ACCOUNT_NUMBER',
  IBAN_CODE: 'ACCOUNT_NUMBER',
  CREDIT_CARD: 'ACCOUNT_NUMBER',
  CREDIT_CARD_NUMBER: 'ACCOUNT_NUMBER',
  LICENSE_NUMBER: 'LICENSE_NUMBER',
  US_DRIVER_LICENSE: 'LICENSE_NUMBER',
  PROFESSIONAL_LICENSE: 'LICENSE_NUMBER',
  VEHICLE_ID: 'VEHICLE_ID',
  VIN: 'VEHICLE_ID',
  US_VEHICLE_VIN: 'VEHICLE_ID',
  LICENSE_PLATE: 'VEHICLE_ID',
  DEVICE_ID: 'DEVICE_ID',
  DEVICE_SERIAL: 'DEVICE_ID',
  IMEI: 'DEVICE_ID',

  // Web identifiers
  URL: 'URL',
  IP_ADDRESS: 'IP_ADDRESS',

  // Biometric / face photo / other unique ID
  BIOMETRIC_ID: 'BIOMETRIC_ID',
  FACE_PHOTO_REF: 'FACE_PHOTO_REF',
  STUDY_ID: 'OTHER_UNIQUE_ID',
  OTHER_UNIQUE_ID: 'OTHER_UNIQUE_ID',
  PASSPORT: 'OTHER_UNIQUE_ID',
  US_PASSPORT: 'OTHER_UNIQUE_ID',
  US_ITIN: 'OTHER_UNIQUE_ID',
});

/**
 * Parse the internal type prefix out of a `[TYPE_N]` placeholder. Returns
 * null for malformed placeholders.
 *
 * Mirrors the gateway's own parsing in `extractEntityTypes`
 * (`proxy.go:1361-1395`): require leading `[`, trailing `]`, at least one
 * underscore, and an all-digit suffix.
 */
export function parsePlaceholderType(placeholder: string): string | null {
  if (placeholder.length < 4) return null;
  if (placeholder[0] !== '[' || placeholder[placeholder.length - 1] !== ']') return null;
  const inner = placeholder.slice(1, -1);
  const lastUnderscore = inner.lastIndexOf('_');
  if (lastUnderscore < 1) return null;
  const suffix = inner.slice(lastUnderscore + 1);
  if (suffix.length === 0) return null;
  for (const c of suffix) {
    if (c < '0' || c > '9') return null;
  }
  return inner.slice(0, lastUnderscore);
}

/**
 * Map a Lucairn `[TYPE_N]` placeholder to its HIPAA Safe Harbor category.
 * Returns null when the internal type is not in `LUCAIRN_TO_HIPAA`.
 */
export function placeholderToHipaaCategory(placeholder: string): HipaaCategory | null {
  const t = parsePlaceholderType(placeholder);
  if (t === null) return null;
  return LUCAIRN_TO_HIPAA[t] ?? null;
}
