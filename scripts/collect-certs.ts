/**
 * collect-certs.ts
 *
 * Walks the NDJSON output of `run-pipeline.ts`, extracts each row's cert URL
 * + summary URL + recall metadata, and emits a `CERTIFICATES.csv` appendix
 * suitable for the paper.
 *
 * Columns:
 *   row_index, cert_url, cert_id, summary_url, overall_verdict,
 *   redaction_count, latency_ms, timestamp_utc, error_code
 *
 * `overall_verdict` is a per-row tag derived from the gateway-attested
 * ground_truth_evaluation:
 *   - "verified" when total_annotations > 0 and detection_rate == 1.0
 *   - "partial" when total_annotations > 0 and 0 < detection_rate < 1.0
 *   - "miss" when total_annotations > 0 and detection_rate == 0
 *   - "n/a" when total_annotations == 0 (no ground truth submitted)
 *   - "error" when the row carried an error block
 *
 * Cert ID is parsed from the certificate_url's final path segment to keep
 * the CSV readable without re-parsing URLs.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { emitCsv } from '../src/csv.js';
import type { GroundTruthEvaluation } from '../src/gateway-client.js';

interface PipelineNdjsonRecord {
  row_index: number;
  timestamp_utc: string;
  entities_submitted?: number;
  transcription_length?: number;
  gateway?: string;
  mode?: 'mock' | 'live';
  result: {
    row_index: number;
    request_id: string;
    cert_url: string | null;
    summary_url: string | null;
    evaluation: GroundTruthEvaluation | null;
    redaction_count: number | null;
    latency_ms: number | null;
  } | null;
  error: { code: string; message: string } | null;
}

interface CliArgs {
  input: string;
  output: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { input: '', output: '' };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const val = eq === -1 ? '' : raw.slice(eq + 1);
    switch (key) {
      case '--input':
        args.input = val;
        break;
      case '--output':
        args.output = val;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: pnpm run collect-certs -- --input=<run.ndjson> --output=<CERTIFICATES.csv>\n',
        );
        process.exit(0);
        break;
      default:
        if (raw.length > 0 && raw !== '--') {
          throw new Error(`unknown argument: ${raw}`);
        }
    }
  }
  if (args.input === '' || args.output === '') {
    throw new Error('--input and --output are required');
  }
  return args;
}

function classifyVerdict(
  evaluation: GroundTruthEvaluation | null,
  error: { code: string } | null,
): string {
  if (error !== null) return 'error';
  if (evaluation === null) return 'n/a';
  if (evaluation.total_annotations === 0) return 'n/a';
  if (evaluation.detection_rate >= 1) return 'verified';
  if (evaluation.detection_rate <= 0) return 'miss';
  return 'partial';
}

function extractCertIdFromUrl(certUrl: string | null): string {
  if (certUrl === null) return '';
  const trimmed = certUrl.replace(/\/+$/u, '');
  const last = trimmed.lastIndexOf('/');
  return last === -1 ? trimmed : trimmed.slice(last + 1);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const text = await readFile(cli.input, 'utf8');
  const records: PipelineNdjsonRecord[] = [];
  let lineNo = 0;
  for (const ln of text.split('\n')) {
    lineNo += 1;
    const trimmed = ln.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as PipelineNdjsonRecord);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${cli.input}: line ${lineNo} is not valid JSON: ${reason}`);
    }
  }

  const headers = [
    'row_index',
    'cert_url',
    'cert_id',
    'summary_url',
    'overall_verdict',
    'redaction_count',
    'latency_ms',
    'timestamp_utc',
    'error_code',
  ];
  const rows = records.map((r) => {
    const certUrl = r.result?.cert_url ?? '';
    const summaryUrl = r.result?.summary_url ?? '';
    const evaluation = r.result?.evaluation ?? null;
    const verdict = classifyVerdict(evaluation, r.error);
    return {
      row_index: String(r.row_index),
      cert_url: certUrl,
      cert_id: extractCertIdFromUrl(r.result?.cert_url ?? null),
      summary_url: summaryUrl,
      overall_verdict: verdict,
      redaction_count: r.result?.redaction_count === null || r.result?.redaction_count === undefined
        ? ''
        : String(r.result.redaction_count),
      latency_ms:
        r.result?.latency_ms === null || r.result?.latency_ms === undefined
          ? ''
          : String(r.result.latency_ms),
      timestamp_utc: r.timestamp_utc,
      error_code: r.error?.code ?? '',
    };
  });

  await writeFile(cli.output, emitCsv(headers, rows), 'utf8');
  process.stdout.write(`wrote ${rows.length} cert row(s) to ${cli.output}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`collect-certs: ${msg}\n`);
  process.exit(1);
});
