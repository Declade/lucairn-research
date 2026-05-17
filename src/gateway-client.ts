/**
 * gateway-client.ts
 *
 * Typed wrapper around the Lucairn gateway's proving-ground proxy endpoint
 * (`POST /api/v1/proxy/messages` with `mode: "proving_ground"`).
 *
 * Why this endpoint:
 *   The proving-ground mode is the ONLY inline gateway surface that returns
 *   per-entity matching evidence (matches / missed / extras keyed by the
 *   caller-supplied annotation type) in the same HTTP response. The
 *   alternative inline surfaces — `/v1/messages` and the public-summary
 *   endpoint — emit only aggregate redaction counts and explicitly omit
 *   per-entity fields for privacy reasons. References:
 *     - dual-sandbox-architecture/services/gateway/internal/api/proxy.go:35-58
 *       (proxyPIIAnnotation + proxyRequest schemas)
 *     - dual-sandbox-architecture/services/gateway/internal/api/proxy.go:361-373
 *       (mode validation, ActivityID + GroundTruth requirements)
 *     - dual-sandbox-architecture/services/gateway/internal/api/proxy.go:1068-1080
 *       (ground_truth_evaluation field emission)
 *     - dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:5-138
 *       (groundTruthResult + per-item shapes)
 *
 * The retry policy is 2 retries with exponential backoff (base 500 ms, jitter
 * 0–200 ms) on 5xx and connection errors only. 4xx errors are surfaced
 * without retry. The per-request timeout defaults to 30 s and is configurable
 * via LUCAIRN_REQUEST_TIMEOUT_MS.
 *
 * No real secret material is referenced at import time — env reads happen at
 * call time inside makeGatewayClient(). Tests run with msw active and use
 * synthetic URLs / keys.
 */

import type { HipaaCategory, InjectedEntity } from './inject-pii-core.js';

/**
 * The annotation we send to the gateway as ground truth. `type` carries the
 * HIPAA Safe Harbor category verbatim, so the gateway echoes it back in
 * `matches[].annotation_type` and `missed[].type` and we can aggregate
 * directly without a second mapping pass.
 */
export interface ProvingGroundAnnotation {
  readonly type: HipaaCategory;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The per-row request body emitted to `POST /api/v1/proxy/messages`. The
 * prompt template + context fields are minimal because Paper 1's measurement
 * is upstream of inference — we are measuring sanitizer recall against
 * known-injected PHI, not LLM behaviour. The single context field
 * `transcription` carries the row text; the prompt template trivially echoes
 * it back so the inference call completes.
 */
export interface GatewayRequestBody {
  readonly prompt_template: string;
  readonly context: Readonly<Record<string, string>>;
  readonly mode: 'proving_ground';
  readonly activity_id: string;
  readonly ground_truth: Readonly<Record<string, readonly ProvingGroundAnnotation[]>>;
  readonly relink_response: false;
  readonly model?: string;
  readonly max_tokens?: number;
}

/**
 * Mirrors `groundTruthMatch` in
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:20-24
 */
export interface GroundTruthMatch {
  readonly annotation_type: string;
  readonly annotation_value: string;
  readonly redacted_as: string;
}

/**
 * Mirrors `groundTruthMiss` in
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:26-30
 */
export interface GroundTruthMiss {
  readonly field: string;
  readonly type: string;
  readonly value: string;
}

/**
 * Mirrors `groundTruthExtra` in
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:32-35
 */
export interface GroundTruthExtra {
  readonly placeholder: string;
  readonly original: string;
}

/**
 * Mirrors `groundTruthResult` in
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:7-18
 */
export interface GroundTruthEvaluation {
  readonly total_annotations: number;
  readonly true_positives: number;
  readonly false_negatives: number;
  readonly false_positives: number;
  readonly detection_rate: number;
  readonly matches?: readonly GroundTruthMatch[];
  readonly missed?: readonly GroundTruthMiss[];
  readonly extras?: readonly GroundTruthExtra[];
}

/**
 * Subset of the gateway proxy response that the harness reads. The full
 * response also includes `result`, `model_used`, `dlp_redacted`,
 * `compliance_trace`, etc. — those are surfaced verbatim in the raw NDJSON
 * for downstream auditability but the harness reads only what's needed for
 * cert collection + recall computation.
 *
 * `veil` is the Pro/Enterprise hint emitted at
 *   dual-sandbox-architecture/services/gateway/internal/api/proxy.go:1088-1094
 */
export interface VeilHint {
  readonly status: string;
  readonly certificate_url: string;
  readonly summary_url: string;
}

export interface GatewayResponse {
  readonly request_id: string;
  readonly status?: string;
  readonly latency_ms?: number;
  readonly redaction_count?: number;
  readonly ground_truth_evaluation?: GroundTruthEvaluation;
  readonly veil?: VeilHint;
  // Free-form passthrough for the raw NDJSON dump — typed loosely so the
  // harness never silently drops fields that the gateway adds later.
  readonly [extra: string]: unknown;
}

export interface GatewayRowInput {
  readonly row_index: number;
  readonly transcription: string;
  readonly entities: readonly InjectedEntity[];
}

export interface GatewayRowResult {
  readonly row_index: number;
  readonly request_id: string;
  readonly cert_url: string | null;
  readonly summary_url: string | null;
  readonly evaluation: GroundTruthEvaluation | null;
  readonly redaction_count: number | null;
  readonly latency_ms: number | null;
  readonly raw_response: GatewayResponse;
}

export interface GatewayClientOptions {
  readonly gatewayUrl: string;
  readonly apiKey: string;
  readonly activityIdPrefix?: string;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly backoffJitterMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly randomFn?: () => number;
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface GatewayClient {
  runRow(row: GatewayRowInput): Promise<GatewayRowResult>;
}

export class GatewayClientError extends Error {
  public readonly status: number | null;
  public readonly responseBody: string | null;

  constructor(message: string, status: number | null, responseBody: string | null) {
    super(message);
    this.name = 'GatewayClientError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_JITTER_MS = 200;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 64;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Construct an annotation list suitable for the proving-ground ground_truth
 * field. The keying field name is fixed at `transcription` because that is
 * the single context field we route through the sanitizer.
 */
function buildGroundTruth(
  entities: readonly InjectedEntity[],
): Record<string, ProvingGroundAnnotation[]> {
  return {
    transcription: entities.map((e) => ({
      type: e.category,
      value: e.value,
      start: e.start_char,
      end: e.end_char,
    })),
  };
}

/**
 * Pure helper: extract the cert URL + summary URL from a gateway response.
 * Exposed for the collect-certs script + unit testing without mounting a
 * full client.
 */
export function extractCertUrls(response: GatewayResponse): {
  cert_url: string | null;
  summary_url: string | null;
} {
  const veil = response.veil;
  if (!veil) return { cert_url: null, summary_url: null };
  return {
    cert_url: veil.certificate_url ?? null,
    summary_url: veil.summary_url ?? null,
  };
}

export function makeGatewayClient(options: GatewayClientOptions): GatewayClient {
  if (options.gatewayUrl === '') {
    throw new GatewayClientError(
      'gatewayUrl is required (or set LUCAIRN_GATEWAY_URL)',
      null,
      null,
    );
  }
  if (options.apiKey === '') {
    throw new GatewayClientError('apiKey is required (or set LUCAIRN_API_KEY)', null, null);
  }
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const randomFn = options.randomFn ?? Math.random;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffJitter = options.backoffJitterMs ?? DEFAULT_BACKOFF_JITTER_MS;
  const activityPrefix = options.activityIdPrefix ?? 'paper-1-healthcare';
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const endpoint = `${options.gatewayUrl.replace(/\/+$/u, '')}/api/v1/proxy/messages`;

  async function runRow(row: GatewayRowInput): Promise<GatewayRowResult> {
    const body: GatewayRequestBody = {
      prompt_template:
        'Echo the transcription back verbatim. Make no inferences. Transcription: {transcription}',
      context: { transcription: row.transcription },
      mode: 'proving_ground',
      activity_id: `${activityPrefix}-row-${row.row_index}`,
      ground_truth: buildGroundTruth(row.entities),
      relink_response: false,
      model,
      max_tokens: maxTokens,
    };

    let attempt = 0;
    // The retry budget is maxRetries + 1 (the initial attempt + retries).
    while (true) {
      attempt += 1;
      let controller: AbortController | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        controller = new AbortController();
        timeoutHandle = setTimeout(() => {
          controller?.abort();
        }, timeoutMs);
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
        if (response.status >= 500) {
          // Retry-eligible.
          const text = await safeReadText(response);
          if (attempt > maxRetries) {
            throw new GatewayClientError(
              `gateway 5xx after ${attempt - 1} retries (status ${response.status})`,
              response.status,
              text,
            );
          }
          await sleepFn(computeBackoffMs(attempt, backoffBase, backoffJitter, randomFn));
          continue;
        }
        if (response.status >= 400) {
          // 4xx is terminal — surface immediately, no retry.
          const text = await safeReadText(response);
          throw new GatewayClientError(
            `gateway 4xx (status ${response.status})`,
            response.status,
            text,
          );
        }
        const raw = (await response.json()) as GatewayResponse;
        const urls = extractCertUrls(raw);
        return {
          row_index: row.row_index,
          request_id: raw.request_id ?? '',
          cert_url: urls.cert_url,
          summary_url: urls.summary_url,
          evaluation: raw.ground_truth_evaluation ?? null,
          redaction_count: typeof raw.redaction_count === 'number' ? raw.redaction_count : null,
          latency_ms: typeof raw.latency_ms === 'number' ? raw.latency_ms : null,
          raw_response: raw,
        };
      } catch (err) {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        if (err instanceof GatewayClientError) {
          // Terminal — already classified.
          throw err;
        }
        // Connection / abort / unknown error → retry budget applies.
        if (attempt > maxRetries) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new GatewayClientError(
            `gateway connection error after ${attempt - 1} retries: ${reason}`,
            null,
            null,
          );
        }
        await sleepFn(computeBackoffMs(attempt, backoffBase, backoffJitter, randomFn));
      }
    }
  }

  return { runRow };
}

function computeBackoffMs(
  attempt: number,
  baseMs: number,
  jitterMs: number,
  randomFn: () => number,
): number {
  const expo = baseMs * 2 ** (attempt - 1);
  const jitter = randomFn() * jitterMs;
  return Math.floor(expo + jitter);
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Read gateway URL + API key from process.env. Returns null fields if unset
 * so callers can decide whether to enter mock mode or fail.
 */
export function readGatewayEnv(env: NodeJS.ProcessEnv = process.env): {
  gatewayUrl: string | null;
  apiKey: string | null;
  requestTimeoutMs: number | null;
} {
  const url = env.LUCAIRN_GATEWAY_URL ?? null;
  const key = env.LUCAIRN_API_KEY ?? null;
  const timeoutStr = env.LUCAIRN_REQUEST_TIMEOUT_MS ?? null;
  let timeoutMs: number | null = null;
  if (timeoutStr !== null) {
    const parsed = Number.parseInt(timeoutStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      timeoutMs = parsed;
    }
  }
  return { gatewayUrl: url, apiKey: key, requestTimeoutMs: timeoutMs };
}
