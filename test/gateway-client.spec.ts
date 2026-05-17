import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const API_KEY = 'lcr_live_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
});
