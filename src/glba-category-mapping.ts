/**
 * glba-category-mapping.ts
 *
 * Maps Lucairn's LIVE placeholder prefixes (the `[PREFIX_N]` shape emitted by
 * the sanitizer in production) back to the GLBA NPI categories defined in
 * `src/inject-finance-pii-core.ts:GLBA_CATEGORIES`.
 *
 * Why this exists:
 *   The Lucairn sanitizer emits redactions whose `placeholder` field is of the
 *   form `[PREFIX_N]` where PREFIX comes from the `PRESIDIO_TO_PLACEHOLDER`
 *   dict in
 *     dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
 *   (i.e. one of the 11 LIVE values: PERSON, EMAIL, PHONE, LOCATION, IBAN, CC,
 *   SSN, ID, URL, DOB, SECRET — same vocabulary as Paper 1; cite-back below).
 *   The GLBA enumeration is the standard Paper 2 reports recall against; this
 *   module is the documented bridge.
 *
 * Cite-back:
 *   - Live placeholder vocabulary (source-of-truth):
 *       dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
 *   - Placeholder emit format `[{pii_type}_{count}]`:
 *       dual-sandbox-architecture/services/sanitizer/placeholders.py:52
 *   - Gateway emits `placeholder` per redaction at:
 *       dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:48-56
 *
 * IMPORTANT — what this table is used for:
 *   The harness's TP and FN attribution flow through the ground-truth
 *   annotation's GLBA `annotation_type` (since the harness submits GLBA
 *   categories as `ProvingGroundAnnotation.type`), NOT through this table.
 *   This table is consulted only for FALSE POSITIVES surfaced in
 *   `extras[].placeholder` — where the gateway returns the placeholder the
 *   sanitizer emitted, and the harness needs to attribute the FP to a GLBA
 *   category bucket.
 *
 * Documented limitations:
 *   - `[ID_N]` is the sanitizer's COLLAPSE bucket for many distinct Presidio
 *     entity types including US_BANK_NUMBER, US_PASSPORT, US_DRIVER_LICENSE,
 *     etc. These overlap multiple GLBA categories
 *     (BANK_ACCOUNT_NUMBER, BANK_ROUTING_NUMBER, DRIVER_LICENSE,
 *     LOAN_ACCOUNT_ID, TAX_ID). `placeholderToGlbaCategory('[ID_N]')`
 *     therefore returns `null` by design.
 *   - `[SECRET_N]` is the detect-secrets / SaaS-API-key bucket — not a GLBA
 *     NPI category. Returns `null` by design.
 *   - `[CC_N]` covers credit-card numbers but not card CVV or expiration; the
 *     mapping is to `CREDIT_CARD_PAN` only.
 *   - `[IBAN_N]` covers SEPA IBAN values; mapped to `IBAN`. Generic US ACH
 *     account numbers do NOT match the IBAN recognizer — they end up in
 *     `[ID_N]` if the US_BANK_NUMBER recognizer fires, otherwise undetected.
 *
 * FP counts whose placeholder maps to null surface in the
 * `unmappedExtraTypes()` accounting in `src/redaction-extractor.ts` and the
 * recall summary so they remain visible rather than silently dropped.
 */

import type { GlbaCategory } from './inject-finance-pii-core.js';
import { parsePlaceholderType } from './hipaa-category-mapping.js';

/**
 * The mapping from Lucairn LIVE placeholder prefixes (per
 * `presidio_scan.py:31-58`) to GLBA NPI categories.
 *
 * The 11 live prefixes are: PERSON, EMAIL, PHONE, LOCATION, IBAN, CC, SSN,
 * ID, URL, DOB, SECRET. `ID`, `SECRET`, and `URL` are deliberately UNMAPPED
 * (collapse / not-a-NPI-category / no GLBA equivalent respectively).
 */
export const LUCAIRN_TO_GLBA: Readonly<Record<string, GlbaCategory>> = Object.freeze({
  PERSON: 'FULL_NAME',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  LOCATION: 'RESIDENTIAL_ADDRESS',
  IBAN: 'IBAN',
  CC: 'CREDIT_CARD_PAN',
  SSN: 'SSN',
  DOB: 'DOB',
});

/**
 * Map a Lucairn `[TYPE_N]` placeholder to its GLBA NPI category.
 * Returns null when the internal type is not in `LUCAIRN_TO_GLBA`.
 *
 * Documented null cases (placeholders the sanitizer DOES emit but which we
 * intentionally do not bucket to a single GLBA category):
 *   - `[ID_N]` — collapse bucket; spans BANK_ACCOUNT, ROUTING, DL, LOAN, TAX
 *   - `[SECRET_N]` — secrets bucket; not GLBA NPI
 *   - `[URL_N]` — URLs are not a GLBA NPI category in the enumeration
 */
export function placeholderToGlbaCategory(placeholder: string): GlbaCategory | null {
  const t = parsePlaceholderType(placeholder);
  if (t === null) return null;
  return LUCAIRN_TO_GLBA[t] ?? null;
}
