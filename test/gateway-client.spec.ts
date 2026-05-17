import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import {
  GatewayClientError,
  extractCertUrls,
  makeGatewayClient,
} from '../src/gateway-client.js';
import type { GatewayResponse } from '../src/gateway-client.js';

const BASE_URL = 'http://gateway.test.local';
const ENDPOINT = `${BASE_URL}/api/v1/proxy/messages`;
// Synthetic test key. Uses an `lcr_test_` prefix (NOT `lcr_live_`) so the
// real production key prefix never appears in committed test code — that
// avoids triggering downstream secret scanners (truffleHog, gitleaks,
// GitHub secret scanning) once this repo flips public.
const API_KEY = 'lcr_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function successResponse(overrides?: Partial<GatewayResponse>): GatewayResponse {
  return {
    request_id: 'req_test_0001',
    status: 'JOB_STATUS_COMPLETED',
    latency_ms: 120,
    redaction_count: 2,
    ground_truth_evaluation: {
      total_annotations: 2,
      true_positives: 2,
      false_negatives: 0,
      false_positives: 0,
      detection_rate: 1.0,
      matches: [
        { annotation_type: 'NAME', annotation_value: 'Jane Roe', redacted_as: '[PERSON_1]' },
        { annotation_type: 'EMAIL', annotation_value: 'jane@example.test', redacted_as: '[EMAIL_ADDRESS_1]' },
      ],
      missed: [],
      extras: [],
    },
    veil: {
      status: 'available',
      certificate_url: '/api/v1/veil/certificate/abc123',
      summary_url: '/api/v1/veil/certificate/abc123/summary',
    },
    ...overrides,
  };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('makeGatewayClient', () => {
  it('parses a successful proving-ground response into a GatewayRowResult', async () => {
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        // Confirm the harness emits the locked proving-ground request shape.
        expect(body['mode']).toBe('proving_ground');
        expect(body['relink_response']).toBe(false);
        expect(body['activity_id']).toBe('paper-1-healthcare-row-7');
        // ground_truth.transcription carries HIPAA-tagged annotations.
        const gt = body['ground_truth'] as { transcription: unknown[] };
        expect(Array.isArray(gt.transcription)).toBe(true);
        expect(gt.transcription.length).toBe(1);
        const ann = gt.transcription[0] as Record<string, unknown>;
        expect(ann['type']).toBe('NAME');
        expect(ann['value']).toBe('Jane Roe');
        expect(ann['start']).toBe(10);
        expect(ann['end']).toBe(18);
        // Verify auth header carries the API key.
        expect(request.headers.get('x-api-key')).toBe(API_KEY);
        return HttpResponse.json(successResponse());
      }),
    );

    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      sleepFn: async () => undefined,
    });
    const result = await client.runRow({
      row_index: 7,
      transcription: 'A note about Jane Roe at jane@example.test in ward 3.',
      entities: [
        { category: 'NAME', value: 'Jane Roe', start_char: 10, end_char: 18 },
      ],
    });
    expect(result.row_index).toBe(7);
    expect(result.cert_url).toBe('/api/v1/veil/certificate/abc123');
    expect(result.summary_url).toBe('/api/v1/veil/certificate/abc123/summary');
    expect(result.redaction_count).toBe(2);
    expect(result.evaluation?.true_positives).toBe(2);
    expect(result.evaluation?.matches?.[0]?.annotation_type).toBe('NAME');
  });

  it('retries on 5xx and recovers, respecting backoff', async () => {
    let calls = 0;
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1;
        if (calls < 3) {
          return HttpResponse.json({ error: 'transient' }, { status: 502 });
        }
        return HttpResponse.json(successResponse());
      }),
    );

    const sleeps: number[] = [];
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 3,
      backoffBaseMs: 10,
      backoffJitterMs: 5,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      randomFn: () => 0.5,
    });
    const result = await client.runRow({
      row_index: 0,
      transcription: 'short',
      entities: [],
    });
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2);
    // First retry backoff is base*2^0 + 0.5*jitter = 10 + 2.5 -> 12.
    expect(sleeps[0]).toBe(12);
    // Second retry backoff is base*2^1 + 0.5*jitter = 20 + 2.5 -> 22.
    expect(sleeps[1]).toBe(22);
    expect(result.request_id).toBe('req_test_0001');
  });

  it('does NOT retry on 4xx — surfaces a GatewayClientError with the status', async () => {
    let calls = 0;
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1;
        return HttpResponse.json({ error: { code: 'invalid_field' } }, { status: 400 });
      }),
    );
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      sleepFn: async () => undefined,
    });
    await expect(
      client.runRow({ row_index: 0, transcription: 'x', entities: [] }),
    ).rejects.toThrow(GatewayClientError);
    expect(calls).toBe(1);
  });

  it('fails after exhausting retries on persistent 5xx', async () => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ error: 'down' }, { status: 503 })),
    );
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 2,
      backoffBaseMs: 1,
      backoffJitterMs: 1,
      sleepFn: async () => undefined,
      randomFn: () => 0,
    });
    let thrown: GatewayClientError | null = null;
    try {
      await client.runRow({ row_index: 0, transcription: 'x', entities: [] });
    } catch (err) {
      if (err instanceof GatewayClientError) thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.status).toBe(503);
  });

  it('treats abort/timeout as a retry-eligible failure', async () => {
    let calls = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          // Wait long enough for the client's tiny timeout to abort.
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          if (request.signal.aborted) {
            return HttpResponse.error();
          }
        }
        return HttpResponse.json(successResponse());
      }),
    );
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 2,
      backoffBaseMs: 1,
      backoffJitterMs: 1,
      requestTimeoutMs: 10,
      sleepFn: async () => undefined,
      randomFn: () => 0,
    });
    const result = await client.runRow({ row_index: 0, transcription: 'x', entities: [] });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.request_id).toBe('req_test_0001');
  });

  it('extractCertUrls returns nulls when veil is absent', () => {
    const r = extractCertUrls({ request_id: 'r' } as GatewayResponse);
    expect(r.cert_url).toBeNull();
    expect(r.summary_url).toBeNull();
  });

  it('extractCertUrls round-trips veil hints unchanged', () => {
    const r = extractCertUrls(successResponse());
    expect(r.cert_url).toBe('/api/v1/veil/certificate/abc123');
    expect(r.summary_url).toBe('/api/v1/veil/certificate/abc123/summary');
  });

  it('rejects construction without gatewayUrl or apiKey', () => {
    expect(() => makeGatewayClient({ gatewayUrl: '', apiKey: API_KEY })).toThrow(
      /gatewayUrl is required/u,
    );
    expect(() => makeGatewayClient({ gatewayUrl: BASE_URL, apiKey: '' })).toThrow(
      /apiKey is required/u,
    );
  });

  it('emits X-Upstream-Key header when upstreamKey is set (Slice 3 BYOK gate)', async () => {
    // Locks the contract for `dual-sandbox-architecture/services/gateway/
    // internal/api/proxy.go:349-354` BYOK-per-request profile gate.
    let observedUpstreamHeader: string | null = null;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        observedUpstreamHeader = request.headers.get('x-upstream-key');
        return HttpResponse.json(successResponse());
      }),
    );
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      upstreamKey: 'sk-ant-api03-fake-upstream-test-value',
      sleepFn: async () => undefined,
    });
    await client.runRow({ row_index: 0, transcription: 'x', entities: [] });
    expect(observedUpstreamHeader).toBe('sk-ant-api03-fake-upstream-test-value');
  });

  it('omits X-Upstream-Key header when upstreamKey is absent or empty', async () => {
    let observedUpstreamHeader: string | null = 'sentinel';
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        observedUpstreamHeader = request.headers.get('x-upstream-key');
        return HttpResponse.json(successResponse());
      }),
    );
    const clientUnset = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      sleepFn: async () => undefined,
    });
    await clientUnset.runRow({ row_index: 0, transcription: 'x', entities: [] });
    // msw / fetch surface absent headers as null.
    expect(observedUpstreamHeader).toBeNull();

    observedUpstreamHeader = 'sentinel';
    const clientEmpty = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      upstreamKey: '', // explicitly empty must be treated as "absent"
      sleepFn: async () => undefined,
    });
    await clientEmpty.runRow({ row_index: 0, transcription: 'y', entities: [] });
    expect(observedUpstreamHeader).toBeNull();
  });

  it('filters ground-truth annotations with value.trim().length < 3 (H2 containment-match safety)', async () => {
    // Defensive guard against future Faker regression — see
    // src/gateway-client.ts::MIN_GROUND_TRUTH_VALUE_LENGTH and the
    // ground_truth.go:82-95 cite-back. The gateway's compareGroundTruth
    // drops empty-after-trim values but NOT 1-2 char values, so a 1-2 char
    // needle would containment-match into many redactions spuriously.
    let observedAnnotations: unknown[] = [];
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const gt = body['ground_truth'] as { transcription: unknown[] };
        observedAnnotations = gt.transcription;
        return HttpResponse.json(successResponse());
      }),
    );
    // Silence the expected console.warn so the test output stays clean
    // while still verifying the filter fired.
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((): void => undefined);
    const client = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      sleepFn: async () => undefined,
    });
    await client.runRow({
      row_index: 0,
      transcription: 'short note',
      entities: [
        // length-1 — must be dropped.
        { category: 'NAME', value: 'X', start_char: 0, end_char: 1 },
        // length-2 after trim — must be dropped.
        { category: 'NAME', value: ' AB ', start_char: 0, end_char: 4 },
        // length-3 — must survive.
        { category: 'EMAIL', value: 'a@b', start_char: 5, end_char: 8 },
      ],
    });
    expect(observedAnnotations).toHaveLength(1);
    const kept = observedAnnotations[0] as Record<string, unknown>;
    expect(kept['type']).toBe('EMAIL');
    expect(kept['value']).toBe('a@b');
    // Warning fired with the dropped count, NOT the dropped values.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg = warnSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('string');
    expect(firstArg as string).toMatch(/dropped 2 ground-truth annotation\(s\)/u);
    warnSpy.mockRestore();
  });

  // Slice 2.5 M2 — rate-limit (requests-per-minute). The client gates every
  // dispatch after the first on `60_000 / rateLimitRpm` ms minimum interval
  // since the previous dispatch began. We inject `nowFn` for a deterministic
  // virtual clock and capture `sleepFn(ms)` arguments to assert the spacing.
  // Also locks the disable contract: rateLimitRpm omitted OR <= 0 must NOT
  // call sleepFn. See `prd-2026-05-17-paper-1-autonomous-finish.md`
  // (Slice 2.5 section) and `src/gateway-client.ts::GatewayClientOptions.rateLimitRpm`.
  it('rate-limit gates dispatches to N rpm via sleepFn(60_000/N); disabled when omitted or <=0', async () => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json(successResponse())),
    );

    // Sub-case A: rpm=60 → expect 1000 ms sleep on each call after the first.
    // Virtual clock — `nowFn()` is frozen so every dispatch after the first
    // measures elapsed=0 against the `60_000/rpm = 1000` ms budget and asks
    // sleepFn for the full 1000 ms.
    const sleepsEnabled: number[] = [];
    const virtualNow = 1_000_000;
    const clientEnabled = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      rateLimitRpm: 60,
      nowFn: () => virtualNow,
      sleepFn: async (ms) => {
        sleepsEnabled.push(ms);
      },
    });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await clientEnabled.runRow({ row_index: i, transcription: 'x', entities: [] });
    }
    // First call never sleeps (lastDispatchAt=null). Calls 2-5 each sleep
    // for the full minIntervalMs because the virtual clock is frozen.
    expect(sleepsEnabled).toEqual([1000, 1000, 1000, 1000]);

    // Sub-case B: rpm omitted → no sleeps fire at all.
    const sleepsUnset: number[] = [];
    const clientUnset = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      sleepFn: async (ms) => {
        sleepsUnset.push(ms);
      },
    });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await clientUnset.runRow({ row_index: i, transcription: 'x', entities: [] });
    }
    expect(sleepsUnset).toEqual([]);

    // Sub-case C: rpm=0 → also no sleeps (non-positive disables).
    const sleepsZero: number[] = [];
    const clientZero = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      rateLimitRpm: 0,
      sleepFn: async (ms) => {
        sleepsZero.push(ms);
      },
    });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await clientZero.runRow({ row_index: i, transcription: 'x', entities: [] });
    }
    expect(sleepsZero).toEqual([]);
  });

  // Slice 2.5 M2 — HTTP 429 (Too Many Requests) is retry-eligible alongside
  // 5xx and connection errors. Other 4xx (400/401/403/404 etc.) remain
  // terminal. Anthropic Tier-1 RPM caps surface as 429 from the upstream
  // and propagate through the gateway. See
  // `prd-2026-05-17-paper-1-autonomous-finish.md` (Slice 2.5).
  it('retries on HTTP 429 and recovers; 4xx-non-429 does not retry', async () => {
    // First sub-case: 429 then 200 → exactly one retry, success.
    let calls = 0;
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: 'rate_limited' }, { status: 429 });
        }
        return HttpResponse.json(successResponse());
      }),
    );
    const sleeps429: number[] = [];
    const client429 = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 2,
      backoffBaseMs: 10,
      backoffJitterMs: 5,
      sleepFn: async (ms) => {
        sleeps429.push(ms);
      },
      randomFn: () => 0.5,
    });
    const result = await client429.runRow({ row_index: 0, transcription: 'x', entities: [] });
    expect(calls).toBe(2);
    expect(sleeps429.length).toBe(1);
    // First retry backoff = base*2^0 + 0.5*jitter = 10 + 2.5 → floor 12.
    expect(sleeps429[0]).toBe(12);
    expect(result.request_id).toBe('req_test_0001');

    // Second sub-case: persistent 429 → throws after retry budget with status 429.
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ error: 'rate_limited' }, { status: 429 })),
    );
    const clientPersist = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 1,
      backoffBaseMs: 1,
      backoffJitterMs: 1,
      sleepFn: async () => undefined,
      randomFn: () => 0,
    });
    let thrown: GatewayClientError | null = null;
    try {
      await clientPersist.runRow({ row_index: 0, transcription: 'x', entities: [] });
    } catch (err) {
      if (err instanceof GatewayClientError) thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.status).toBe(429);
    expect(thrown?.message).toMatch(/gateway 429 after 1 retries/u);

    // Third sub-case: 401 (4xx-non-429) → terminal, exactly one call, no retry.
    let calls401 = 0;
    server.use(
      http.post(ENDPOINT, () => {
        calls401 += 1;
        return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
      }),
    );
    const client401 = makeGatewayClient({
      gatewayUrl: BASE_URL,
      apiKey: API_KEY,
      maxRetries: 5,
      sleepFn: async () => undefined,
      randomFn: () => 0,
    });
    let thrown401: GatewayClientError | null = null;
    try {
      await client401.runRow({ row_index: 0, transcription: 'x', entities: [] });
    } catch (err) {
      if (err instanceof GatewayClientError) thrown401 = err;
    }
    expect(thrown401).not.toBeNull();
    expect(thrown401?.status).toBe(401);
    expect(calls401).toBe(1);
  });
});

// Slice 2.5 M1 — streaming NDJSON writer in `scripts/run-pipeline.ts` must
// preserve rows 1..N-1 in the output file when the harness is killed
// mid-run. This is the load-bearing acceptance test: the previous
// buffered-in-memory pattern (atomic-write at EOF) lost ALL rows on any
// process-death event. The replacement is per-row `createWriteStream`
// append + fsync. See `prd-2026-05-17-paper-1-autonomous-finish.md`
// (Slice 2.5) and `scripts/run-pipeline.ts` `writeStream` block.
describe('run-pipeline streaming NDJSON writer (M1)', () => {
  it('preserves rows 1..N-1 on SIGTERM mid-run', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slice25-sigterm-'));
    const outputPath = join(tmpDir, 'run.ndjson');
    try {
      const proc = spawn(
        'node',
        [
          '--import',
          'tsx',
          'scripts/run-pipeline.ts',
          '--rows=20',
          '--mock',
          // 30 rpm = 2000 ms spacing → predictable timing for the
          // mid-run kill at ~2.5 s elapsed. With 30 rpm spacing, rows
          // 1+2 dispatch at t=0 + t=2s, then SIGTERM at t=2.5s drops
          // the harness before row 3 lands.
          '--rate-limit-rpm=30',
          `--output=${outputPath}`,
        ],
        { cwd: process.cwd(), stdio: 'ignore' },
      );
      // Give the harness time to dispatch at least 1 row (rate-limit
      // 30 rpm = 2000 ms per row gap), then SIGTERM.
      await new Promise<void>((res) => setTimeout(res, 2500));
      proc.kill('SIGTERM');
      await new Promise<void>((res) => {
        proc.once('exit', () => res());
      });
      expect(existsSync(outputPath)).toBe(true);
      const fileText = readFileSync(outputPath, 'utf8');
      const lines = fileText.split('\n').filter((l) => l.trim().length > 0);
      // Must have at least 1 valid NDJSON record; must have STRICTLY
      // FEWER than 20 (proves the harness was actually killed mid-run,
      // not allowed to complete all 20 rows).
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThan(20);
      // Every surviving line MUST parse as JSON (no half-written
      // record at the tail). The fsync after each write guarantees
      // the partial line we'd see in a pure-buffered-stream scenario
      // is not visible here.
      for (const ln of lines) {
        expect(() => JSON.parse(ln)).not.toThrow();
        const obj = JSON.parse(ln) as Record<string, unknown>;
        expect(typeof obj['row_index']).toBe('number');
        expect(obj['mode']).toBe('mock');
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
