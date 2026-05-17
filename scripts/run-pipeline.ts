/**
 * run-pipeline.ts
 *
 * Slice 2 harness — call the Lucairn gateway row-by-row over the
 * Measurement-B 500-row subset (or a smaller --rows slice), recording each
 * gateway response to an NDJSON file under `papers/paper-1-healthcare/raw-
 * results/`. Designed to run in two modes:
 *
 *   - LIVE (default): hits a real gateway at LUCAIRN_GATEWAY_URL with an
 *     LUCAIRN_API_KEY. Live runs are deferred to Slice 3 per the locked
 *     halt gate. Do not run live by accident — the script refuses to start
 *     without an explicit --live flag.
 *   - MOCK (--mock): mounts a deterministic msw fixture server in-process.
 *     The harness fetches the loopback `mock://` URL the msw handler
 *     intercepts. No network egress. The mock honours `--miss-rate` and
 *     `--spurious-fp-count` so smoke tests can drive recall paths against
 *     a known oracle.
 *
 * Usage:
 *   pnpm run pipeline -- --rows=5 --mock --output=/tmp/slice2-smoke.ndjson
 *   pnpm run pipeline -- --rows=500 --mock --output=papers/paper-1-healthcare/raw-results/mock-500.ndjson
 *   pnpm run pipeline -- --live --rows=20    # Slice 3 only
 */

import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream, existsSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import {
  GatewayClientError,
  type GatewayRowResult,
  makeGatewayClient,
  readGatewayEnv,
} from '../src/gateway-client.js';
import type { InjectedEntity } from '../src/inject-pii-core.js';
import { parseCsv } from '../src/csv.js';
import { buildMockResponse, entitiesFromRequestBody } from '../src/mocks/gateway-fixtures.js';

const DEFAULT_TRUTH_PATH =
  'datasets/healthcare/with-injected-pii/ground-truth.jsonl';
const DEFAULT_SUBSET_PATH =
  'datasets/healthcare/with-injected-pii/measurement-b-subset.csv';
const MOCK_GATEWAY_URL = 'http://mock.lucairn.local';
// Synthetic mock key. Uses an `lcr_mock_` prefix (NOT `lcr_live_`) so the
// real production key prefix never appears in committed code — secret
// scanners (truffleHog, gitleaks, GitHub secret scanning) would otherwise
// flag this file the moment the repo flips public. Length preserved so any
// length-based sanity checks elsewhere don't drift.
const MOCK_API_KEY = 'lcr_mock_0000000000000000000000000000';

interface CliArgs {
  rows: number | null;
  mock: boolean;
  live: boolean;
  truth: string;
  subset: string;
  output: string;
  gateway: string | null;
  apiKey: string | null;
  /**
   * Upstream LLM API key (Anthropic for Claude models, OpenAI for GPT
   * models, etc.) for BYOK-per-request customer profiles. Wired as
   * `X-Upstream-Key` header on every gateway call. Required when the
   * Lucairn customer profile has `ByokPerRequest: true` — the gateway
   * returns 400 `missing_upstream_key` otherwise. See
   * `dual-sandbox-architecture/services/gateway/internal/api/proxy.go:349-354`
   * for the gate. Falls back to `process.env.LUCAIRN_UPSTREAM_KEY` when the
   * flag is absent. Ignored under `--mock`.
   */
  upstreamKey: string | null;
  /**
   * Optional client-side rate-limit budget in requests-per-minute. Wired
   * through to `GatewayClientOptions.rateLimitRpm`. Default null disables
   * rate-limiting; the 500-row live-run dispatch should set this to the
   * Anthropic Tier-1 RPM cap (typically 50 for first-tier accounts; the
   * Slice 3 dispatch defaults to 10 for a conservative belt). Slice 2.5
   * M2; see `prd-2026-05-17-paper-1-autonomous-finish.md` (Slice 2.5).
   */
  rateLimitRpm: number | null;
  missRate: number;
  spuriousFpCount: number;
  activityIdPrefix: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    rows: null,
    mock: false,
    live: false,
    truth: DEFAULT_TRUTH_PATH,
    subset: DEFAULT_SUBSET_PATH,
    output: `papers/paper-1-healthcare/raw-results/run-${new Date()
      .toISOString()
      .replace(/[:.]/gu, '-')}.ndjson`,
    gateway: null,
    apiKey: null,
    upstreamKey: null,
    rateLimitRpm: null,
    missRate: 0,
    spuriousFpCount: 0,
    activityIdPrefix: 'paper-1-healthcare',
  };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const val = eq === -1 ? '' : raw.slice(eq + 1);
    switch (key) {
      case '--rows':
        args.rows = parseIntOrThrow(val, '--rows');
        break;
      case '--mock':
        args.mock = true;
        break;
      case '--live':
        args.live = true;
        break;
      case '--truth':
        args.truth = val;
        break;
      case '--subset':
        args.subset = val;
        break;
      case '--output':
        args.output = val;
        break;
      case '--gateway':
        args.gateway = val;
        break;
      case '--api-key':
        args.apiKey = val;
        break;
      case '--upstream-key':
        args.upstreamKey = val;
        break;
      case '--rate-limit-rpm':
        args.rateLimitRpm = parseIntOrThrow(val, '--rate-limit-rpm');
        if (args.rateLimitRpm === 0) {
          throw new Error('--rate-limit-rpm requires a positive integer (use omit-flag to disable)');
        }
        break;
      case '--miss-rate':
        args.missRate = parseFloatOrThrow(val, '--miss-rate');
        break;
      case '--spurious-fp-count':
        args.spuriousFpCount = parseIntOrThrow(val, '--spurious-fp-count');
        break;
      case '--activity-id-prefix':
        args.activityIdPrefix = val;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (raw.length > 0 && raw !== '--') {
          throw new Error(`unknown argument: ${raw}`);
        }
    }
  }
  return args;
}

function parseIntOrThrow(s: string, flag: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} requires a non-negative integer`);
  return n;
}

function parseFloatOrThrow(s: string, flag: string): number {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${flag} requires a number in [0, 1]`);
  }
  return n;
}

function printHelp(): void {
  const lines = [
    'Usage: pnpm run pipeline -- [options]',
    '',
    'Options:',
    '  --rows=N             limit run to first N rows (sorted by row_index). Default: all rows in ground truth.',
    '  --mock               mount msw mock; no network egress. Mutually exclusive with --live.',
    '  --live               require LUCAIRN_GATEWAY_URL + LUCAIRN_API_KEY in env (Slice 3 use).',
    '  --truth=PATH         ground-truth JSONL path. Default: datasets/healthcare/with-injected-pii/ground-truth.jsonl',
    '  --subset=PATH        Measurement-B subset CSV path. Default: datasets/healthcare/with-injected-pii/measurement-b-subset.csv',
    '  --output=PATH        NDJSON output path. Default: papers/paper-1-healthcare/raw-results/run-<ISO>.ndjson',
    '  --gateway=URL        gateway URL override (also honoured under --live).',
    '  --api-key=KEY        API key override (--live only).',
    '  --upstream-key=KEY   Upstream LLM API key for BYOK-per-request customer profiles.',
    '                       Sent as X-Upstream-Key header. Falls back to LUCAIRN_UPSTREAM_KEY env.',
    '                       Required when the Lucairn profile has ByokPerRequest: true; otherwise',
    '                       the gateway returns HTTP 400 missing_upstream_key. Ignored under --mock.',
    '  --rate-limit-rpm=N   Pace gateway calls at no more than N requests per minute (positive int).',
    '                       Sets a `60_000/N` ms minimum interval between consecutive row dispatches.',
    '                       Default unset = no rate-limit. Recommended for Slice 3 live runs to stay',
    '                       under Anthropic Tier-1 RPM caps. Combines with the 429-retry policy.',
    '  --miss-rate=F        --mock only. Fraction of injected entities the mock misses. Default: 0.',
    '  --spurious-fp-count=N --mock only. Synthetic FP redactions per row. Default: 0.',
    '  --activity-id-prefix=S  per-row activity_id prefix. Default: paper-1-healthcare.',
    '',
    'Auth modes (3 supported by this harness; covers Slice 2 mock + Slice 3 live):',
    '  1. --mock                                          → no auth required; in-process msw mock; tests + dev.',
    '  2. --live + --api-key                              → non-BYOK customer profile (Lucairn-managed AI).',
    '  3. --live + --api-key + --upstream-key             → BYOK-per-request profile; gateway gate at',
    '                                                       dual-sandbox-architecture/services/gateway/internal/api/proxy.go:349-354.',
    'Slice 2 ships --mock support only. --live is reserved for Slice 3 and requires Marc-confirmation.',
  ];
  for (const ln of lines) {
    process.stdout.write(`${ln}\n`);
  }
}

async function loadGroundTruth(path: string): Promise<Map<number, readonly InjectedEntity[]>> {
  const text = await readFile(path, 'utf8');
  const out = new Map<number, InjectedEntity[]>();
  let lineNo = 0;
  for (const ln of text.split('\n')) {
    lineNo += 1;
    const trimmed = ln.trim();
    if (trimmed === '') continue;
    let parsed: { row_index: unknown; entities: unknown };
    try {
      parsed = JSON.parse(trimmed) as { row_index: unknown; entities: unknown };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`ground truth line ${lineNo} is not valid JSON: ${reason}`);
    }
    if (typeof parsed.row_index !== 'number' || !Array.isArray(parsed.entities)) {
      throw new Error(`ground truth line ${lineNo} missing row_index or entities`);
    }
    const entities: InjectedEntity[] = [];
    for (const item of parsed.entities as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as {
        category?: unknown;
        value?: unknown;
        start_char?: unknown;
        end_char?: unknown;
      };
      if (
        typeof e.category === 'string' &&
        typeof e.value === 'string' &&
        typeof e.start_char === 'number' &&
        typeof e.end_char === 'number'
      ) {
        entities.push({
          // The injected categories are HipaaCategory by construction; we
          // intentionally avoid a runtime narrowing assertion so a malformed
          // ground-truth line surfaces in the recall computation rather than
          // at parse time.
          category: e.category as InjectedEntity['category'],
          value: e.value,
          start_char: e.start_char,
          end_char: e.end_char,
        });
      }
    }
    out.set(parsed.row_index, entities);
  }
  return out;
}

async function loadTranscriptions(path: string): Promise<Map<number, string>> {
  const text = await readFile(path, 'utf8');
  const { rows } = parseCsv(text);
  const out = new Map<number, string>();
  for (const row of rows) {
    const idxStr = row['original_row_index'] ?? '';
    const idx = Number.parseInt(idxStr, 10);
    if (!Number.isFinite(idx)) continue;
    const tr = row['transcription'] ?? '';
    out.set(idx, tr);
  }
  return out;
}

interface MockServerHandle {
  close(): void;
}

function mountMockServer(missRate: number, spuriousFpCount: number): MockServerHandle {
  const handlers = [
    http.post(
      `${MOCK_GATEWAY_URL}/api/v1/proxy/messages`,
      async ({ request }) => {
        const body = (await request.json()) as unknown;
        const { rowIndex, entities } = entitiesFromRequestBody(body);
        if (rowIndex === null) {
          return HttpResponse.json(
            { error: { code: 'invalid_body', message: 'mock could not parse activity_id row-N suffix' } },
            { status: 400 },
          );
        }
        const response = buildMockResponse({
          rowIndex,
          entities,
          missRate,
          spuriousFpCount,
        });
        return HttpResponse.json(response);
      },
    ),
  ];
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  return { close: () => server.close() };
}

async function ensureOutputDir(outputPath: string): Promise<void> {
  const dir = dirname(resolve(outputPath));
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.mock && cli.live) {
    throw new Error('--mock and --live are mutually exclusive');
  }
  if (!cli.mock && !cli.live) {
    process.stderr.write(
      'run-pipeline: neither --mock nor --live specified. Slice 2 supports --mock only.\n' +
        'Add --mock for the in-process smoke flow, or --live (Slice 3 + Marc-confirmation).\n',
    );
    process.exit(2);
  }

  const truthByRow = await loadGroundTruth(cli.truth);
  const transcriptByRow = await loadTranscriptions(cli.subset);
  const indices = Array.from(truthByRow.keys()).sort((a, b) => a - b);
  const limit = cli.rows ?? indices.length;
  const target = indices.slice(0, limit);

  let mock: MockServerHandle | null = null;
  let gatewayUrl: string;
  let apiKey: string;
  // Upstream LLM API key for BYOK-per-request flows; null when --mock or
  // when the customer profile doesn't require BYOK. See the auth-modes
  // table in printHelp() for the four valid combinations.
  let upstreamKey: string | null = null;
  if (cli.mock) {
    mock = mountMockServer(cli.missRate, cli.spuriousFpCount);
    gatewayUrl = MOCK_GATEWAY_URL;
    apiKey = MOCK_API_KEY;
  } else {
    const env = readGatewayEnv();
    gatewayUrl = cli.gateway ?? env.gatewayUrl ?? '';
    apiKey = cli.apiKey ?? env.apiKey ?? '';
    upstreamKey = cli.upstreamKey ?? env.upstreamKey ?? null;
    if (gatewayUrl === '' || apiKey === '') {
      throw new Error(
        '--live requires LUCAIRN_GATEWAY_URL + LUCAIRN_API_KEY in env or --gateway / --api-key flags',
      );
    }
  }

  await ensureOutputDir(cli.output);

  const client = makeGatewayClient({
    gatewayUrl,
    apiKey,
    ...(upstreamKey !== null ? { upstreamKey } : {}),
    ...(cli.rateLimitRpm !== null ? { rateLimitRpm: cli.rateLimitRpm } : {}),
    activityIdPrefix: cli.activityIdPrefix,
  });

  // Streaming NDJSON writer — Slice 2.5 M1; see
  // `prd-2026-05-17-paper-1-autonomous-finish.md` (Slice 2.5).
  //
  // We write one full NDJSON record per row directly to disk (append mode)
  // and fsync after each write. If the harness is killed mid-run (SIGTERM,
  // OOM, lost SSH session, etc.), the output file always contains exactly
  // the records that completed BEFORE the killing event. The previous
  // buffered-in-memory pattern atomic-wrote at EOF, which meant a 500-row
  // run that died at row 470 lost ALL 470 successful gateway calls + their
  // ~$3 of upstream LLM spend.
  //
  // Downstream NDJSON readers in `scripts/collect-certs.ts:109` +
  // `scripts/compute-recall.ts:166` already gracefully skip empty/malformed
  // lines via `trimmed === ''` guards, so a partial line written
  // mid-process-death is also safely consumed.
  const writeStream = createWriteStream(cli.output, { flags: 'w', encoding: 'utf8' });
  let written = 0;
  const startedAt = Date.now();
  try {
    for (const rowIndex of target) {
      const entities = truthByRow.get(rowIndex) ?? [];
      const transcription = transcriptByRow.get(rowIndex) ?? '';
      let result: GatewayRowResult | null = null;
      let error: { code: string; message: string } | null = null;
      try {
        result = await client.runRow({
          row_index: rowIndex,
          transcription,
          entities,
        });
      } catch (err) {
        if (err instanceof GatewayClientError) {
          error = {
            code: 'gateway_error',
            message: `${err.message} (status=${err.status ?? 'null'})`,
          };
        } else if (err instanceof Error) {
          error = { code: 'unknown_error', message: err.message };
        } else {
          error = { code: 'unknown_error', message: String(err) };
        }
      }
      const ndjsonLine = JSON.stringify({
        row_index: rowIndex,
        timestamp_utc: new Date().toISOString(),
        entities_submitted: entities.length,
        transcription_length: transcription.length,
        gateway: gatewayUrl,
        mode: cli.mock ? 'mock' : 'live',
        mock_miss_rate: cli.mock ? cli.missRate : null,
        mock_spurious_fp_count: cli.mock ? cli.spuriousFpCount : null,
        result,
        error,
      });
      // Await the write back-pressure so flushing is deterministic per row.
      await writeLine(writeStream, `${ndjsonLine}\n`);
      // fsync(2) every row — durability guarantee for the SIGTERM-mid-run
      // recovery story. Cost is ~ms per row, negligible vs gateway RTT.
      const fd = (writeStream as unknown as { fd: number | null }).fd;
      if (typeof fd === 'number') {
        try {
          fsyncSync(fd);
        } catch {
          // fsync may fail on some filesystems (tmpfs, certain network
          // mounts) — swallow; the write itself already succeeded.
        }
      }
      written += 1;
    }
  } finally {
    await new Promise<void>((res) => writeStream.end(res));
    mock?.close();
  }

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(
    `wrote ${written} record(s) to ${cli.output} in ${elapsedMs} ms (mode=${
      cli.mock ? 'mock' : 'live'
    })\n`,
  );
}

/**
 * Promise-wrap a writeStream.write call so back-pressure is observed
 * deterministically and the row-to-row event-loop ordering doesn't
 * silently fall behind during high-throughput live runs.
 */
function writeLine(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
): Promise<void> {
  return new Promise((res, rej) => {
    const ok = stream.write(chunk, (err) => {
      if (err) rej(err);
    });
    if (ok) {
      res();
    } else {
      stream.once('drain', () => res());
    }
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`run-pipeline: ${msg}\n`);
  process.exit(1);
});
