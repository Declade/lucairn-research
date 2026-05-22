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
 *     - dual-sandbox-architecture/services/gateway/internal/api/proxy.go:349-354
 *       (BYOK-per-request gate — returns 400 missing_upstream_key when the
 *       customer profile requires per-request upstream keys and the
 *       X-Upstream-Key header is absent).
 *
 * The retry policy is 2 retries with exponential backoff (base 500 ms, jitter
 * 0–200 ms) on 5xx, HTTP 429 (Too Many Requests), and connection errors only.
 * Other 4xx errors (400/401/403/404 etc.) are surfaced without retry. The
 * per-request timeout defaults to 30 s and is configurable via
 * LUCAIRN_REQUEST_TIMEOUT_MS.
 *
 * Optional client-side rate limiting via `rateLimitRpm` paces calls at no more
 * than N requests per minute by gating every `runRow` dispatch on a
 * `60_000 / rpm` minimum-interval since the previous dispatch. This is a
 * coarse Anthropic-API-rate-limit-tier RPM-cap safety belt — Slice 2.5 M2; see
 * `prd-2026-05-17-paper-1-autonomous-finish.md` (Slice 2.5 section).
 *
 * No real secret material is referenced at import time — env reads happen at
 * call time inside makeGatewayClient(). Tests run with msw active and use
 * synthetic URLs / keys.
 */

/**
 * Minimal shape any paper's injected-entity record must satisfy to be
 * submitted as ground truth to the gateway. Both
 *   - `InjectedEntity` (Paper 1 healthcare; `inject-pii-core.ts` —
 *     `category: HipaaCategory`)
 *   - `InjectedFinanceEntity` (Paper 2 finance; `inject-finance-pii-core.ts`
 *     — `category: GlbaCategory`)
 * are structurally assignable to this interface because HIPAA / GLBA category
 * string-literal unions are assignable to `string`. Future paper category
 * enumerations satisfy it the same way without code changes here.
 */
export interface AnnotationInput {
  readonly category: string;
  readonly value: string;
  readonly start_char: number;
  readonly end_char: number;
}

/**
 * The annotation we send to the gateway as ground truth. `type` carries the
 * paper's category verbatim (HIPAA Safe Harbor for Paper 1; GLBA NPI for
 * Paper 2; …), so the gateway echoes it back in `matches[].annotation_type`
 * and `missed[].type` and we can aggregate directly without a second
 * mapping pass.
 */
export interface ProvingGroundAnnotation {
  readonly type: string;
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
  readonly entities: readonly AnnotationInput[];
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
  /**
   * Upstream LLM API key for BYOK-per-request customer profiles. When set,
   * emitted as the `X-Upstream-Key` HTTP header on every request. Required
   * for Slice 3 live runs when the Lucairn customer profile has
   * `ByokPerRequest: true` — the gateway returns a 400
   * `missing_upstream_key` otherwise (see
   *   dual-sandbox-architecture/services/gateway/internal/api/proxy.go:349-354
   * for the gate). May be supplied via the `LUCAIRN_UPSTREAM_KEY` env var as
   * a fallback when not set explicitly.
   */
  readonly upstreamKey?: string;
  readonly activityIdPrefix?: string;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly backoffJitterMs?: number;
  /**
   * Optional client-side rate-limit budget in requests-per-minute. When set
   * to a positive number, every `runRow` dispatch gates on a
   * `60_000 / rateLimitRpm` minimum interval since the previous dispatch
   * began. Values <= 0 (or undefined) disable rate-limiting. Slice 2.5 M2 —
   * see `prd-2026-05-17-paper-1-autonomous-finish.md` (Slice 2.5).
   */
  readonly rateLimitRpm?: number;
  /**
   * Injected clock for the rate-limiter. Returns a monotonic millisecond
   * value used to gate per-row dispatches. Defaults to `performance.now()`
   * (monotonic-since-process-start, immune to NTP step adjustments and
   * DST jumps; the correct primitive for per-row interval gating). The
   * contract is "any monotonic-non-decreasing number" — tests inject a
   * virtual clock; production code SHOULD NOT pass `Date.now` because
   * wall-clock adjustments can briefly reverse and cause the rate-limit
   * gate to undercount the elapsed interval. MEDIUM-1 fix-up (2026-05-17).
   */
  readonly nowFn?: () => number;
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
/**
 * Default Anthropic model for the live pipeline. Locked at Haiku 4.5 per
 * `Opus Advisor/specs/prd-2026-05-17-paper-1-autonomous-finish.md`
 * Implementation decisions — recall numbers come from server-side
 * `compareGroundTruth` at `dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:69-138`,
 * so LLM choice does not affect the recall verdict. Haiku 4.5 is ~5x cheaper
 * than Sonnet 4.6 for the ~1K-input / ~200-output token shape this harness
 * sends; the cost differential is the whole basis for the lock. Override via
 * `GatewayClientOptions.model` or `--model=<id>` CLI flag.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 64;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Minimum trimmed length of a ground-truth annotation value the harness will
 * submit to the gateway. Defensive guard against future Faker regressions —
 * the gateway's matcher (`compareGroundTruth` at
 *   dual-sandbox-architecture/services/gateway/internal/api/ground_truth.go:82-95
 * ) drops empty-after-trim values but NOT 1- or 2-char values. A 1-2 char
 * value used as a containment-match needle has a high prior on spurious
 * matches (e.g. annotation `value: "X"` matches every sanitizer redaction
 * whose Original contains the letter X). Faker outputs in
 * `inject-pii-core.ts:122-161` empirically always emit values ≥3 chars per
 * category, but pinning the floor here protects against silent regressions.
 */
const MIN_GROUND_TRUTH_VALUE_LENGTH = 3;

/**
 * Construct an annotation list suitable for the proving-ground ground_truth
 * field. The keying field name is fixed at `transcription` because that is
 * the single context field we route through the sanitizer.
 *
 * Filters out annotations whose `value.trim().length` is below
 * MIN_GROUND_TRUTH_VALUE_LENGTH and emits a single console.warn with the
 * dropped count (never the dropped values — those are PII even when
 * synthetic). The filter rationale + cite-back live on
 * MIN_GROUND_TRUTH_VALUE_LENGTH above.
 */
function buildGroundTruth(
  entities: readonly AnnotationInput[],
): Record<string, ProvingGroundAnnotation[]> {
  const kept: ProvingGroundAnnotation[] = [];
  let droppedCount = 0;
  for (const e of entities) {
    if (e.value.trim().length < MIN_GROUND_TRUTH_VALUE_LENGTH) {
      droppedCount += 1;
      continue;
    }
    kept.push({
      type: e.category,
      value: e.value,
      start: e.start_char,
      end: e.end_char,
    });
  }
  if (droppedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gateway-client] dropped ${droppedCount} ground-truth annotation(s) ` +
        `with value.trim().length < ${MIN_GROUND_TRUTH_VALUE_LENGTH} (containment-match safety; see ` +
        `ground_truth.go:82-95)`,
    );
  }
  return { transcription: kept };
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
  // MEDIUM-1 (2026-05-17): default to `performance.now()` (monotonic),
  // not `Date.now()` (wall-clock). Wall-clock is vulnerable to NTP step
  // adjustments and DST jumps that can briefly reverse — both would cause
  // the rate-limit gate to undercount the elapsed interval and burst.
  const nowFn = options.nowFn ?? (() => performance.now());
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffJitter = options.backoffJitterMs ?? DEFAULT_BACKOFF_JITTER_MS;
  const activityPrefix = options.activityIdPrefix ?? 'paper-1-healthcare';
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Empty-string upstreamKey is treated as "absent" so callers can pass
  // `process.env.LUCAIRN_UPSTREAM_KEY ?? ''` without accidentally emitting a
  // header with no value.
  const upstreamKey =
    typeof options.upstreamKey === 'string' && options.upstreamKey.length > 0
      ? options.upstreamKey
      : null;
  const endpoint = `${options.gatewayUrl.replace(/\/+$/u, '')}/api/v1/proxy/messages`;

  // Rate-limit gate state. `rateLimitRpm <= 0` (or undefined) disables the
  // gate entirely; otherwise the minimum spacing between two consecutive
  // dispatches is `60_000 / rpm` ms. `lastDispatchAt` is null until the
  // first row dispatches, so the first call is never delayed.
  const rateLimitRpm =
    typeof options.rateLimitRpm === 'number' && options.rateLimitRpm > 0
      ? options.rateLimitRpm
      : null;
  const minIntervalMs = rateLimitRpm === null ? 0 : 60_000 / rateLimitRpm;
  let lastDispatchAt: number | null = null;

  async function runRow(row: GatewayRowInput): Promise<GatewayRowResult> {
    // Rate-limit gate. Single-flight per client instance (Slice 2.5 M2 only
    // gates per-row sequential dispatches — the harness loop is sequential,
    // see `scripts/run-pipeline.ts` row-by-row for-loop). Concurrency
    // control across multiple in-flight clients is out of scope here.
    if (minIntervalMs > 0 && lastDispatchAt !== null) {
      const elapsed = nowFn() - lastDispatchAt;
      const wait = minIntervalMs - elapsed;
      if (wait > 0) {
        await sleepFn(wait);
      }
    }
    lastDispatchAt = nowFn();

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
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
        };
        if (upstreamKey !== null) {
          headers['x-upstream-key'] = upstreamKey;
        }
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
        // HTTP 429 (Too Many Requests) is retry-eligible alongside 5xx —
        // Slice 2.5 M2; Anthropic API rate-limit tier caps surface as 429
        // from the upstream and propagate through the gateway. Other 4xx
        // (400/401/403/404/etc.) remain terminal — those are client-side
        // errors that won't fix themselves on retry.
        //
        // Gateway 429 surface (grep 2026-05-17 against
        // `dual-sandbox-architecture/services/gateway/internal/middleware/ratelimit.go:101-114`
        // + `services/gateway/internal/api/handler.go:159/184/218`): the
        // gateway emits real HTTP 429 with `Retry-After: 60` header and a
        // JSON body `{"error":"rate_limit_exceeded","retry_after_seconds":60}`.
        // Upstream Anthropic 429s are mapped to HTTP 503 with
        // `Retry-After`-derived `ErrInferenceServiceUnavailable(retrySeconds)`
        // via the circuit-breaker path at
        // `services/gateway/internal/api/proxy.go:748-755`, so they hit
        // the 5xx branch here, not the 429 branch.
        if (response.status === 429 || response.status >= 500) {
          // Retry-eligible.
          const text = await safeReadText(response);
          if (attempt > maxRetries) {
            const klass = response.status === 429 ? '429' : '5xx';
            throw new GatewayClientError(
              `gateway ${klass} after ${attempt - 1} retries (status ${response.status})`,
              response.status,
              text,
            );
          }
          // HIGH-1 (2026-05-17): honor `Retry-After` header on 429
          // responses (RFC 6585 / RFC 7231 §7.1.3). Anthropic returns
          // `Retry-After: <seconds>` or `Retry-After: <HTTP-date>`; a real
          // `Retry-After: 60` blows past our fixed exponential backoff
          // (max ~1.9s across 2 retries) and chips into the 5% failure
          // budget for no good reason. We honor the server's hint AND
          // our own backoff floor via `Math.max(...)`, so we never sleep
          // LESS than computed backoff (jitter still applies).
          const computed = computeBackoffMs(attempt, backoffBase, backoffJitter, randomFn);
          const retryAfterMs =
            response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after'), nowFn) : null;
          const sleepMs = retryAfterMs !== null ? Math.max(retryAfterMs, computed) : computed;
          await sleepFn(sleepMs);
          continue;
        }
        if (response.status >= 400) {
          // 4xx-non-429 is terminal — surface immediately, no retry.
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

/**
 * Parse an RFC 7231 §7.1.3 `Retry-After` header value into milliseconds.
 * Two forms supported:
 *   - Delta-seconds (numeric, no decimal point): `Retry-After: 60` → 60_000 ms.
 *   - HTTP-date (IMF-fixdate / obs-date): e.g. `Retry-After: Wed, 21 Oct
 *     2026 07:28:00 GMT` → ms-until-that-timestamp, computed against
 *     `nowMonotonicMs` as a stand-in (we don't have a true wall-clock
 *     here — the rate-limit gate's `nowFn` is monotonic). For the
 *     HTTP-date form we delegate to `Date.parse` (which returns
 *     wall-clock-relative ms-since-epoch) and subtract `Date.now()` to
 *     get the delta, which works regardless of which monotonic clock
 *     the rate-limit gate uses.
 * Returns null if the header is absent, blank, or unparseable. Returns 0
 * if the parsed delay is non-positive (the server is asking us to retry
 * immediately; caller's backoff floor still applies).
 *
 * HIGH-1 fix-up (2026-05-17). Reference test cases:
 *   - `Retry-After: 5` → 5000
 *   - `Retry-After: <wall-clock date 30s in the future>` → ~30000
 *   - missing / `null` → null (caller falls back to computed backoff)
 *   - non-numeric garbage → null (treated as "no hint")
 */
export function parseRetryAfterMs(
  header: string | null,
  _nowMonotonicMs: () => number,
): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  // Delta-seconds form: pure digits (no decimal). RFC 7231 §7.1.3
  // permits only digit-only seconds; we also tolerate a leading +.
  if (/^[+-]?\d+$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, seconds * 1000);
  }
  // HTTP-date form: hand off to Date.parse. NaN if unparseable.
  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) return null;
  const delta = target - Date.now();
  return Math.max(0, delta);
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Read gateway URL + API key + optional upstream LLM API key from
 * process.env. Returns null fields if unset so callers can decide whether to
 * enter mock mode or fail. `upstreamKey` is sourced from
 * `LUCAIRN_UPSTREAM_KEY` and is required for BYOK-per-request customer
 * profiles in Slice 3 live runs (see `GatewayClientOptions.upstreamKey`
 * for the gate cite-back).
 */
export function readGatewayEnv(env: NodeJS.ProcessEnv = process.env): {
  gatewayUrl: string | null;
  apiKey: string | null;
  upstreamKey: string | null;
  requestTimeoutMs: number | null;
} {
  const url = env.LUCAIRN_GATEWAY_URL ?? null;
  const key = env.LUCAIRN_API_KEY ?? null;
  const upstreamKey = env.LUCAIRN_UPSTREAM_KEY ?? null;
  const timeoutStr = env.LUCAIRN_REQUEST_TIMEOUT_MS ?? null;
  let timeoutMs: number | null = null;
  if (timeoutStr !== null) {
    const parsed = Number.parseInt(timeoutStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      timeoutMs = parsed;
    }
  }
  return { gatewayUrl: url, apiKey: key, upstreamKey, requestTimeoutMs: timeoutMs };
}
