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
  it('maps Lucairn internal types to HIPAA Safe Harbor categories', () => {
    expect(placeholderToHipaaCategory('[PERSON_1]')).toBe('NAME');
    expect(placeholderToHipaaCategory('[LOCATION_2]')).toBe('GEO_SUBDIVISION');
    expect(placeholderToHipaaCategory('[PHONE_NUMBER_3]')).toBe('PHONE');
    expect(placeholderToHipaaCategory('[EMAIL_ADDRESS_4]')).toBe('EMAIL');
    expect(placeholderToHipaaCategory('[US_SSN_5]')).toBe('SSN');
    expect(placeholderToHipaaCategory('[IBAN_6]')).toBe('ACCOUNT_NUMBER');
    expect(placeholderToHipaaCategory('[URL_7]')).toBe('URL');
    expect(placeholderToHipaaCategory('[IP_ADDRESS_8]')).toBe('IP_ADDRESS');
  });

  it('returns null for placeholders whose internal type is not in the map', () => {
    expect(placeholderToHipaaCategory('[UNKNOWN_TYPE_1]')).toBeNull();
    expect(placeholderToHipaaCategory('[FOO_BAR_9]')).toBeNull();
  });
});

describe('LUCAIRN_TO_HIPAA mapping', () => {
  it('every right-hand side is a valid HipaaCategory', () => {
    const valid = new Set<string>(HIPAA_CATEGORIES);
    for (const [internalType, hipaa] of Object.entries(LUCAIRN_TO_HIPAA)) {
      expect(valid.has(hipaa), `entry ${internalType} -> ${hipaa}`).toBe(true);
    }
  });

  it('covers the standard Presidio/Lucairn vocabulary the gateway emits', () => {
    // Smoke list of internal types observed in proxy.go::extractEntityTypes
    // and the Presidio recognizer catalogue. Any future regression where one
    // of these disappears from the mapping is a Slice 3 hazard.
    const required = [
      'PERSON',
      'LOCATION',
      'DATE',
      'PHONE_NUMBER',
      'EMAIL_ADDRESS',
      'US_SSN',
      'IBAN',
      'URL',
      'IP_ADDRESS',
      'CREDIT_CARD',
    ];
    for (const t of required) {
      expect(LUCAIRN_TO_HIPAA[t], `mapping missing for ${t}`).toBeTruthy();
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
