import { describe, expect, it } from 'vitest';

import { HIPAA_CATEGORIES } from '../src/inject-pii-core.js';
import {
  extractFromEvaluation,
  unmappedExtraTypes,
} from '../src/redaction-extractor.js';
import {
  LUCAIRN_TO_HIPAA,
  parsePlaceholderType,
  placeholderToHipaaCategory,
} from '../src/hipaa-category-mapping.js';

describe('parsePlaceholderType', () => {
  it('parses well-formed `[TYPE_N]` placeholders', () => {
    expect(parsePlaceholderType('[PERSON_1]')).toBe('PERSON');
    expect(parsePlaceholderType('[PHONE_NUMBER_12]')).toBe('PHONE_NUMBER');
    expect(parsePlaceholderType('[EMAIL_ADDRESS_42]')).toBe('EMAIL_ADDRESS');
  });

  it('returns null for malformed placeholders', () => {
    expect(parsePlaceholderType('PERSON_1')).toBeNull(); // no brackets
    expect(parsePlaceholderType('[]')).toBeNull(); // empty
    expect(parsePlaceholderType('[PERSON]')).toBeNull(); // no _N suffix
    expect(parsePlaceholderType('[PERSON_]')).toBeNull(); // trailing underscore, no digits
    expect(parsePlaceholderType('[PERSON_abc]')).toBeNull(); // non-digit suffix
    expect(parsePlaceholderType('[_1]')).toBeNull(); // missing type prefix
  });
});

describe('placeholderToHipaaCategory', () => {
  it('maps Lucairn LIVE placeholder prefixes to HIPAA Safe Harbor categories', () => {
    // Live placeholder prefixes from presidio_scan.py:31-58
    // PRESIDIO_TO_PLACEHOLDER right-hand-side values.
    expect(placeholderToHipaaCategory('[PERSON_1]')).toBe('NAME');
    expect(placeholderToHipaaCategory('[LOCATION_2]')).toBe('GEO_SUBDIVISION');
    expect(placeholderToHipaaCategory('[PHONE_3]')).toBe('PHONE');
    expect(placeholderToHipaaCategory('[EMAIL_4]')).toBe('EMAIL');
    expect(placeholderToHipaaCategory('[SSN_5]')).toBe('SSN');
    expect(placeholderToHipaaCategory('[IBAN_6]')).toBe('ACCOUNT_NUMBER');
    expect(placeholderToHipaaCategory('[CC_7]')).toBe('ACCOUNT_NUMBER');
    expect(placeholderToHipaaCategory('[URL_8]')).toBe('URL');
    expect(placeholderToHipaaCategory('[DOB_9]')).toBe('DATE');
  });

  it('null-maps [ID_N] and [SECRET_N] by design (documented limitation)', () => {
    // [ID_N] is the sanitizer's collapse-bucket for MRN, US_BANK_NUMBER,
    // US_PASSPORT, US_DRIVER_LICENSE, UK_NHS, SG_NRIC_FIN, AU_ABN, AU_TFN,
    // AU_MEDICARE, IN_PAN, IP_ADDRESS + 4 German custom recognizers, AND the
    // unknown-entity fallback (cite-back: presidio_scan.py:31-58). The
    // placeholder shape cannot disambiguate the underlying HIPAA category, so
    // null-mapping is the correct behavior — the FP count surfaces in the
    // unmapped_extras accounting (recall.ts:142-167) instead of being
    // silently misattributed.
    expect(placeholderToHipaaCategory('[ID_1]')).toBeNull();
    // [SECRET_N] (W5+ Phase 1, 2026-05-09) is detect-secrets + SaaS-API-key
    // matches; secrets are not a HIPAA Safe Harbor category in the
    // 18-enumeration sense (45 CFR § 164.514(b)(2)(i)).
    expect(placeholderToHipaaCategory('[SECRET_1]')).toBeNull();
  });

  it('returns null for placeholders whose internal type is not in the map', () => {
    expect(placeholderToHipaaCategory('[UNKNOWN_TYPE_1]')).toBeNull();
    expect(placeholderToHipaaCategory('[FOO_BAR_9]')).toBeNull();
  });
});

describe('LUCAIRN_TO_HIPAA mapping', () => {
  // Live placeholder prefix vocabulary from
  //   dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
  // (PRESIDIO_TO_PLACEHOLDER dict right-hand-side values). Hard-coded here so
  // any future addition to that dict that this repo hasn't accounted for
  // surfaces as a test failure, not as silent FP miscategorization.
  const LIVE_PLACEHOLDER_PREFIXES = [
    'PERSON',
    'EMAIL',
    'PHONE',
    'LOCATION',
    'IBAN',
    'CC',
    'SSN',
    'ID',
    'URL',
    'DOB',
    'SECRET',
  ] as const;

  // Prefixes intentionally NOT mapped — see hipaa-category-mapping.ts
  // file-level doc-comment for the rationale.
  const KNOWN_UNMAPPED: ReadonlySet<string> = new Set([
    'ID', // collapse-bucket for many distinct HIPAA categories; disambiguation impossible from placeholder alone
    'SECRET', // not a HIPAA Safe Harbor category in the 18-enumeration sense
  ]);

  it('every right-hand side is a valid HipaaCategory', () => {
    const valid = new Set<string>(HIPAA_CATEGORIES);
    for (const [internalType, hipaa] of Object.entries(LUCAIRN_TO_HIPAA)) {
      expect(valid.has(hipaa), `entry ${internalType} -> ${hipaa}`).toBe(true);
    }
  });

  it('every live placeholder prefix is either mapped or explicitly null-mapped', () => {
    // Walk the live vocabulary; each prefix must either appear in
    // LUCAIRN_TO_HIPAA OR be listed in KNOWN_UNMAPPED. This is the regression
    // lock against `presidio_scan.py:31-58` drift.
    for (const prefix of LIVE_PLACEHOLDER_PREFIXES) {
      const mapped = LUCAIRN_TO_HIPAA[prefix] !== undefined;
      const unmappedIntentionally = KNOWN_UNMAPPED.has(prefix);
      expect(
        mapped || unmappedIntentionally,
        `prefix ${prefix} (from presidio_scan.py:31-58) must be in LUCAIRN_TO_HIPAA or KNOWN_UNMAPPED`,
      ).toBe(true);
    }
  });

  it('no prefix in LUCAIRN_TO_HIPAA is outside the live placeholder vocabulary', () => {
    // Inverse guard — if someone adds a stale alias (e.g. PHONE_NUMBER or
    // EMAIL_ADDRESS) to the mapping table, it must correspond to something
    // the sanitizer actually emits. Otherwise the entry is dead code masking
    // real drift.
    const liveSet = new Set<string>(LIVE_PLACEHOLDER_PREFIXES);
    for (const internalType of Object.keys(LUCAIRN_TO_HIPAA)) {
      expect(
        liveSet.has(internalType),
        `LUCAIRN_TO_HIPAA[${internalType}] is not in the live placeholder vocabulary (presidio_scan.py:31-58)`,
      ).toBe(true);
    }
  });
});

describe('extractFromEvaluation', () => {
  it('flattens matches/missed/extras into ExtractedRedaction[] with verdicts', () => {
    const extracted = extractFromEvaluation(42, {
      total_annotations: 3,
      true_positives: 1,
      false_negatives: 1,
      false_positives: 1,
      detection_rate: 1 / 3,
      matches: [
        { annotation_type: 'NAME', annotation_value: 'Alex Doe', redacted_as: '[PERSON_1]' },
      ],
      missed: [{ field: 'transcription', type: 'EMAIL', value: 'a@b.com' }],
      extras: [{ placeholder: '[PERSON_99]', original: 'Riverside Hospital' }],
    });
    expect(extracted).toHaveLength(3);
    const byVerdict = new Map(extracted.map((r) => [r.verdict, r]));
    expect(byVerdict.get('tp')?.hipaa_category).toBe('NAME');
    expect(byVerdict.get('tp')?.placeholder).toBe('[PERSON_1]');
    expect(byVerdict.get('fn')?.hipaa_category).toBe('EMAIL');
    expect(byVerdict.get('fn')?.placeholder).toBeNull();
    expect(byVerdict.get('fp')?.hipaa_category).toBe('NAME');
    expect(byVerdict.get('fp')?.placeholder).toBe('[PERSON_99]');
  });

  it('tags unknown annotation_type strings as null (does not silently widen)', () => {
    const extracted = extractFromEvaluation(0, {
      total_annotations: 1,
      true_positives: 1,
      false_negatives: 0,
      false_positives: 0,
      detection_rate: 1.0,
      matches: [
        {
          annotation_type: 'SOME_NEW_HIPAA_VARIANT',
          annotation_value: 'x',
          redacted_as: '[PERSON_1]',
        },
      ],
    });
    expect(extracted[0]?.hipaa_category).toBeNull();
    expect(extracted[0]?.verdict).toBe('tp');
  });

  it('surfaces unmapped Lucairn placeholder types via unmappedExtraTypes', () => {
    const unmapped = unmappedExtraTypes({
      total_annotations: 0,
      true_positives: 0,
      false_negatives: 0,
      false_positives: 2,
      detection_rate: 1.0,
      extras: [
        { placeholder: '[PERSON_1]', original: 'Alex' }, // mapped → NAME
        { placeholder: '[FUTURE_TYPE_X_1]', original: 'X' }, // unmapped
      ],
    });
    expect(unmapped).toEqual(['FUTURE_TYPE_X']);
  });
});
