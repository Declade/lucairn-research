/**
 * hipaa-category-mapping.ts
 *
 * Maps Lucairn's LIVE placeholder prefixes (the `[PREFIX_N]` shape emitted by
 * the sanitizer in production) back to the 18 HIPAA Safe Harbor categories
 * defined in `src/inject-pii-core.ts:28-47` (45 CFR § 164.514(b)(2)(i)).
 *
 * Why this exists:
 *   The Lucairn sanitizer emits redactions whose `placeholder` field is of the
 *   form `[PREFIX_N]` where PREFIX comes from the `PRESIDIO_TO_PLACEHOLDER`
 *   dict in
 *     dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
 *   (i.e. one of the 11 LIVE values: PERSON, EMAIL, PHONE, LOCATION, IBAN, CC,
 *   SSN, ID, URL, DOB, SECRET — confirmed by the placeholder-emit format at
 *   `placeholders.py:52` `f"[{pii_type}_{count}]"`). The HIPAA Safe Harbor
 *   enumeration is the standard the research program reports recall against.
 *   This module is the documented bridge between the two taxonomies.
 *
 * Cite-back:
 *   - Live placeholder vocabulary (source-of-truth):
 *       dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
 *       (`PRESIDIO_TO_PLACEHOLDER` dict)
 *   - Placeholder emit format `[{pii_type}_{count}]`:
 *       dual-sandbox-architecture/services/sanitizer/placeholders.py:52
 *   - Gateway emits `placeholder` per redaction at:
 *       dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:48-56
 *   - Gateway's own parsing convention `[TYPE_N]`:
 *       dual-sandbox-architecture/services/gateway/internal/api/proxy.go:1361-1395
 *       (extractEntityTypes — accepts uppercase letters/underscores + digits suffix).
 *
 * IMPORTANT — what this table is used for:
 *   The harness's TP and FN attribution flow through the ground-truth
 *   annotation's HIPAA `annotation_type` (since the harness submits HIPAA
 *   categories as `ProvingGroundAnnotation.type`), NOT through this table.
 *   This table is consulted only for FALSE POSITIVES surfaced in
 *   `extras[].placeholder` — where the gateway returns the placeholder the
 *   sanitizer emitted, and the harness needs to attribute the FP to a HIPAA
 *   category bucket.
 *
 * Documented limitations:
 *   - `[ID_N]` is the sanitizer's COLLAPSE bucket for many distinct Presidio
 *     entity types (MRN-shaped, US_BANK_NUMBER, US_PASSPORT,
 *     US_DRIVER_LICENSE, UK_NHS, SG_NRIC_FIN, AU_ABN, AU_TFN, AU_MEDICARE,
 *     IN_PAN, IP_ADDRESS, the four custom German recognizers Fallnummer /
 *     Personalausweis / Steuer-ID / SVNR, AND the unknown-entity fallback).
 *     These map to at least six different HIPAA categories (MRN,
 *     HEALTH_PLAN_ID, ACCOUNT_NUMBER, LICENSE_NUMBER, IP_ADDRESS,
 *     OTHER_UNIQUE_ID). The placeholder shape alone cannot disambiguate them.
 *     `placeholderToHipaaCategory('[ID_N]')` therefore returns `null` by
 *     design.
 *   - `[SECRET_N]` is the W5+ Phase 1 (2026-05-09) detect-secrets +
 *     SaaS-API-key bucket. Secrets are not a HIPAA Safe Harbor category in
 *     the 18-enumeration sense (45 CFR § 164.514(b)(2)(i)).
 *     `placeholderToHipaaCategory('[SECRET_N]')` returns `null` by design.
 *
 * FP counts whose placeholder maps to null surface in the
 * `unmappedExtraTypes()` accounting in `src/redaction-extractor.ts:111-127`
 * and `src/recall.ts:142-167` so they remain visible in the SUMMARY notes
 * rather than being silently dropped.
 */

import type { HipaaCategory } from './inject-pii-core.js';

/**
 * The mapping from Lucairn LIVE placeholder prefixes (per
 * `presidio_scan.py:31-58`) to HIPAA Safe Harbor categories.
 *
 * The 11 live prefixes are: PERSON, EMAIL, PHONE, LOCATION, IBAN, CC, SSN,
 * ID, URL, DOB, SECRET. `ID` and `SECRET` are deliberately UNMAPPED (they
 * collapse multiple HIPAA categories / are not Safe Harbor categories
 * respectively; see file-level doc-comment for the full rationale).
 *
 * If `presidio_scan.py` adds a new placeholder value, the regression test in
 * `test/redaction-extractor.spec.ts` will fail until this table is updated
 * or the new prefix is added to that test's `KNOWN_UNMAPPED` set.
 */
export const LUCAIRN_TO_HIPAA: Readonly<Record<string, HipaaCategory>> = Object.freeze({
  PERSON: 'NAME',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  LOCATION: 'GEO_SUBDIVISION',
  IBAN: 'ACCOUNT_NUMBER', // SEPA bank account numbers
  CC: 'ACCOUNT_NUMBER', // credit card numbers
  SSN: 'SSN',
  URL: 'URL',
  DOB: 'DATE',
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
 * Returns null when the internal type is not in `LUCAIRN_TO_HIPAA`. The
 * documented null cases are `[ID_N]` (collapse-bucket — disambiguation
 * impossible from the placeholder alone) and `[SECRET_N]` (not a Safe
 * Harbor category). See the file-level doc-comment for the rationale.
 */
export function placeholderToHipaaCategory(placeholder: string): HipaaCategory | null {
  const t = parsePlaceholderType(placeholder);
  if (t === null) return null;
  return LUCAIRN_TO_HIPAA[t] ?? null;
}
