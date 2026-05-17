/**
 * mocks/gateway-fixtures.ts
 *
 * Deterministic mock-response builders that mirror the real gateway's
 * proving-ground response shape exactly. Tests and the `--mock` smoke
 * scripts mount these via msw (see msw setup in test files).
 *
 * The shape MUST track the gateway sources cited in
 * `src/gateway-client.ts` — any divergence is a Slice 3 hazard.
 */

import type { InjectedEntity } from '../inject-pii-core.js';
import type {
  GatewayResponse,
  GroundTruthExtra,
  GroundTruthMatch,
  GroundTruthMiss,
  ProvingGroundAnnotation,
} from '../gateway-client.js';
import { mulberry32 } from '../inject-pii-core.js';

export interface MockBuilderOptions {
  readonly rowIndex: number;
  readonly entities: readonly InjectedEntity[];
  /** Fraction in [0, 1] of injected entities the mock should "miss". 0 = perfect recall, 1.0 = no detections. */
  readonly missRate?: number;
  /** Optional fixed seed for the per-row PRNG. Default: rowIndex. */
  readonly seed?: number;
  /** When provided, latency_ms field is set to this value. Default: deterministic-pseudo. */
  readonly latencyMsOverride?: number;
  /** Synthetic spurious-redaction count, simulating false positives. */
  readonly spuriousFpCount?: number;
}

/**
 * Map from HIPAA Safe Harbor category to the LIVE placeholder prefix the
 * Lucairn sanitizer would emit in production for that category. Source of
 * truth for these mappings:
 *   dual-sandbox-architecture/services/sanitizer/presidio_scan.py:31-58
 *   (PRESIDIO_TO_PLACEHOLDER dict).
 *
 * Locked decisions:
 *   - FAX uses the same PHONE prefix the sanitizer emits for phone numbers
 *     (the sanitizer does not natively distinguish FAX from PHONE — fax
 *     numbers match the PHONE recognizer).
 *   - MRN, HEALTH_PLAN_ID, LICENSE_NUMBER, VEHICLE_ID, DEVICE_ID,
 *     IP_ADDRESS, BIOMETRIC_ID, FACE_PHOTO_REF, OTHER_UNIQUE_ID all collapse
 *     to the sanitizer's ID bucket. The mock therefore emits [ID_N] for
 *     these — matching production behavior. Their FP attribution surfaces
 *     in the unmapped_extras accounting (recall.ts:142-167), NOT in the
 *     per-category HIPAA buckets, exactly as the live path behaves.
 *   - ACCOUNT_NUMBER picks IBAN deterministically (CC is the alternative).
 *     Both map back to ACCOUNT_NUMBER via LUCAIRN_TO_HIPAA, so the test
 *     bookkeeping is symmetric.
 */
const PLACEHOLDER_FOR_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  NAME: 'PERSON',
  GEO_SUBDIVISION: 'LOCATION',
  DATE: 'DOB',
  PHONE: 'PHONE',
  FAX: 'PHONE', // sanitizer doesn't natively distinguish fax from phone
  EMAIL: 'EMAIL',
  SSN: 'SSN',
  MRN: 'ID', // sanitizer collapses to ID bucket
  HEALTH_PLAN_ID: 'ID', // sanitizer collapses to ID bucket
  ACCOUNT_NUMBER: 'IBAN', // deterministic choice; CC is the alternative
  LICENSE_NUMBER: 'ID', // sanitizer collapses to ID bucket
  VEHICLE_ID: 'ID', // sanitizer collapses to ID bucket
  DEVICE_ID: 'ID', // sanitizer collapses to ID bucket
  URL: 'URL',
  IP_ADDRESS: 'ID', // sanitizer collapses IP_ADDRESS to ID (presidio_scan.py:51)
  BIOMETRIC_ID: 'ID', // sanitizer collapses to ID bucket
  FACE_PHOTO_REF: 'ID', // sanitizer collapses to ID bucket
  OTHER_UNIQUE_ID: 'ID', // sanitizer collapses to ID bucket
});

/**
 * Build a mock gateway response for a single row. Determinism: given the
 * same options the output is byte-identical across runs and platforms (the
 * miss-selection PRNG is mulberry32-seeded).
 */
export function buildMockResponse(options: MockBuilderOptions): GatewayResponse {
  const missRate = clampUnit(options.missRate ?? 0);
  const seed = options.seed ?? options.rowIndex;
  const rng = mulberry32(seed);
  const spuriousFpCount = Math.max(0, options.spuriousFpCount ?? 0);

  const matches: GroundTruthMatch[] = [];
  const missed: GroundTruthMiss[] = [];
  // Deterministic per-category sequence counters for placeholder N suffix.
  const seqByType = new Map<string, number>();

  for (const e of options.entities) {
    const draw = rng();
    if (draw < missRate) {
      missed.push({ field: 'transcription', type: e.category, value: e.value });
    } else {
      const internalType = PLACEHOLDER_FOR_CATEGORY[e.category] ?? 'OTHER';
      const nextN = (seqByType.get(internalType) ?? 0) + 1;
      seqByType.set(internalType, nextN);
      matches.push({
        annotation_type: e.category,
        annotation_value: e.value,
        redacted_as: `[${internalType}_${nextN}]`,
      });
    }
  }

  const extras: GroundTruthExtra[] = [];
  for (let i = 0; i < spuriousFpCount; i++) {
    // Synthesise plausible-looking spurious detections so FP-handling code
    // paths can be exercised. Use deterministic pseudo-text. The prefix
    // rotation includes `ID` so the unmapped_extras accounting path
    // (recall.ts:142-167) is exercised on at least one of every 4 synthetic
    // FPs — mirroring production where `[ID_N]` is a common collapse-bucket
    // placeholder for the sanitizer.
    const internalType = ['PERSON', 'LOCATION', 'PHONE', 'ID'][i % 4] ?? 'PERSON';
    const nextN = (seqByType.get(internalType) ?? 0) + 1;
    seqByType.set(internalType, nextN);
    extras.push({
      placeholder: `[${internalType}_${nextN}]`,
      original: `spurious_${seed}_${i}`,
    });
  }

  const totalAnnotations = options.entities.length;
  const truePositives = matches.length;
  const falseNegatives = missed.length;
  const falsePositives = extras.length;
  const detectionRate =
    totalAnnotations === 0 ? 1.0 : truePositives / totalAnnotations;

  const certId = pseudoCertId(seed);
  return {
    request_id: `req_${seed.toString(16).padStart(8, '0')}`,
    status: 'JOB_STATUS_COMPLETED',
    latency_ms: options.latencyMsOverride ?? 250,
    result: 'mock-result-omitted',
    redaction_count: truePositives + falsePositives,
    ground_truth_evaluation: {
      total_annotations: totalAnnotations,
      true_positives: truePositives,
      false_negatives: falseNegatives,
      false_positives: falsePositives,
      detection_rate: detectionRate,
      matches,
      missed,
      extras,
    },
    veil: {
      status: 'available',
      certificate_url: `/api/v1/veil/certificate/${certId}`,
      summary_url: `/api/v1/veil/certificate/${certId}/summary`,
    },
  };
}

/**
 * Stub helper used by test mocks to recover the per-row ground truth from a
 * request body. Mirrors the wire shape: ground_truth.transcription is an
 * array of ProvingGroundAnnotation.
 */
export function entitiesFromRequestBody(body: unknown): {
  rowIndex: number | null;
  entities: InjectedEntity[];
} {
  if (typeof body !== 'object' || body === null) {
    return { rowIndex: null, entities: [] };
  }
  const obj = body as Record<string, unknown>;
  const activity = obj['activity_id'];
  let rowIndex: number | null = null;
  if (typeof activity === 'string') {
    const match = /-row-(\d+)$/u.exec(activity);
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(parsed)) rowIndex = parsed;
    }
  }
  const gtRaw = obj['ground_truth'];
  if (typeof gtRaw !== 'object' || gtRaw === null) {
    return { rowIndex, entities: [] };
  }
  const transcription = (gtRaw as Record<string, unknown>)['transcription'];
  if (!Array.isArray(transcription)) {
    return { rowIndex, entities: [] };
  }
  const entities: InjectedEntity[] = [];
  for (const item of transcription) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Partial<ProvingGroundAnnotation>;
    if (
      typeof a.type === 'string' &&
      typeof a.value === 'string' &&
      typeof a.start === 'number' &&
      typeof a.end === 'number'
    ) {
      entities.push({
        category: a.type,
        value: a.value,
        start_char: a.start,
        end_char: a.end,
      });
    }
  }
  return { rowIndex, entities };
}

function clampUnit(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function pseudoCertId(seed: number): string {
  // 32 hex chars, deterministic per seed via two mulberry32 draws.
  const rng = mulberry32(seed);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += Math.floor(rng() * 0x1_0000_0000).toString(16).padStart(8, '0');
  }
  return out;
}
