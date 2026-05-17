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
});
