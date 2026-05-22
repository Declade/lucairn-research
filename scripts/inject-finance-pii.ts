#!/usr/bin/env -S node --import tsx
/**
 * inject-finance-pii.ts
 *
 * Driver for Paper 2 Measurement B NPI re-injection.
 *
 * Reads:  datasets/finance/raw/complaints.csv
 *           (CFPB Consumer Complaint Database; carrier-text column is
 *           `Consumer complaint narrative`. The file is ~8GB unzipped — we
 *           use the streaming reader at `src/streaming-csv.ts` because the
 *           full string exceeds V8's max string length.)
 * Writes: datasets/finance/with-injected-pii/measurement-b-subset.csv
 *         datasets/finance/with-injected-pii/ground-truth.jsonl
 *         datasets/finance/with-injected-pii/EXPECTED-HASHES.json (first run)
 *
 * Two-pass design:
 *   Pass 1: stream CSV, collect data-row indices of rows whose narrative is
 *           non-empty. Records ~1.5M ints in memory (≈12MB).
 *   Pass 2: deterministically sample 500 of those indices (Mulberry32, seed=42),
 *           re-stream the CSV, capture only the rows at the chosen indices.
 *           Inject synthetic GLBA NPI. Emit CSV + ground-truth JSONL.
 *
 * Determinism: identical inputs + same SEED -> byte-identical outputs.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitCsv } from '../src/csv.js';
import { injectIntoRows, pickMeasurementBSubset } from '../src/inject-finance-pii-core.js';
import { streamRows } from '../src/streaming-csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_CSV = resolve(REPO_ROOT, 'datasets', 'finance', 'raw', 'complaints.csv');
const OUT_DIR = resolve(REPO_ROOT, 'datasets', 'finance', 'with-injected-pii');
const OUT_CSV = resolve(OUT_DIR, 'measurement-b-subset.csv');
const OUT_JSONL = resolve(OUT_DIR, 'ground-truth.jsonl');
const EXPECTED_HASHES = resolve(OUT_DIR, 'EXPECTED-HASHES.json');

const SUBSET_SIZE = 500;
const NARRATIVE_COLUMN = 'Consumer complaint narrative';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function main(): void {
  if (!existsSync(RAW_CSV)) {
    throw new Error(
      `Raw CFPB CSV not found at ${RAW_CSV}. Run \`pnpm dataset:download:finance\` first.`,
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // --- Pass 1: scan for non-empty-narrative row indices. ---
  process.stdout.write(`[pass-1] streaming ${RAW_CSV} to collect non-empty narrative indices...\n`);
  const nonEmptyIndices: number[] = [];
  let headers: string[] = [];
  let totalRows = 0;
  let lastProgress = 0;
  const t0 = Date.now();
  const pass1 = streamRows(RAW_CSV, (row, dataRowIndex) => {
    totalRows = dataRowIndex + 1;
    const t = (row[NARRATIVE_COLUMN] ?? '').trim();
    if (t.length > 0) {
      nonEmptyIndices.push(dataRowIndex);
    }
    if (totalRows - lastProgress >= 500_000) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(
        `[pass-1] ${totalRows} rows scanned, ${nonEmptyIndices.length} non-empty (${elapsed}s)\n`,
      );
      lastProgress = totalRows;
    }
  });
  headers = pass1.headers;
  process.stdout.write(`[pass-1] done. total=${totalRows}, non-empty=${nonEmptyIndices.length}\n`);

  if (!headers.includes(NARRATIVE_COLUMN)) {
    throw new Error(
      `Expected CFPB CSV to have a '${NARRATIVE_COLUMN}' column; got headers: ${JSON.stringify(headers)}`,
    );
  }

  // --- Sample subset. ---
  // pickMeasurementBSubset returns sorted positions WITHIN the non-empty list.
  const positionsInNonEmpty = pickMeasurementBSubset(nonEmptyIndices.length, SUBSET_SIZE);
  const chosenDataRowIndices = new Set<number>();
  for (const p of positionsInNonEmpty) {
    const idx = nonEmptyIndices[p];
    if (idx === undefined) throw new Error(`subset position ${p} out of range`);
    chosenDataRowIndices.add(idx);
  }
  process.stdout.write(`[subset] sampled ${chosenDataRowIndices.size} row indices\n`);

  // --- Pass 2: re-stream, capture only the chosen rows. ---
  process.stdout.write(`[pass-2] re-streaming to capture chosen rows...\n`);
  const capturedByIndex = new Map<number, Record<string, string>>();
  streamRows(RAW_CSV, (row, dataRowIndex) => {
    if (chosenDataRowIndices.has(dataRowIndex)) {
      capturedByIndex.set(dataRowIndex, row);
    }
  });
  process.stdout.write(`[pass-2] captured ${capturedByIndex.size} rows\n`);

  if (capturedByIndex.size !== chosenDataRowIndices.size) {
    throw new Error(
      `Pass-2 captured ${capturedByIndex.size} rows but expected ${chosenDataRowIndices.size}. ` +
        `CFPB CSV may have changed between passes — re-run \`pnpm dataset:download:finance\` and retry.`,
    );
  }

  // Build carrier list in row-index ascending order (matches Paper 1's
  // post-subset processing order).
  const orderedIndices = Array.from(capturedByIndex.keys()).sort((a, b) => a - b);
  const subsetCarriers = orderedIndices.map((idx) => {
    const row = capturedByIndex.get(idx);
    if (!row) throw new Error(`internal: no row for index ${idx}`);
    return {
      row_index: idx,
      narrative: row[NARRATIVE_COLUMN] ?? '',
    };
  });

  process.stdout.write(`[inject] injecting GLBA NPI into ${subsetCarriers.length} rows...\n`);
  const injected = injectIntoRows(subsetCarriers);

  // Re-emit the FULL CFPB schema for the captured rows (so spot-checkers can
  // join back via original_row_index), swapping the narrative for the
  // injected text.
  const outHeaders = ['original_row_index', ...headers];
  const outRows = injected.map((ir) => {
    const sourceRow = capturedByIndex.get(ir.row_index) ?? {};
    return {
      original_row_index: String(ir.row_index),
      ...sourceRow,
      [NARRATIVE_COLUMN]: ir.injected_narrative,
    };
  });
  const csvOut = emitCsv(outHeaders, outRows);
  writeFileSync(OUT_CSV, csvOut, 'utf8');

  const lines: string[] = [];
  let totalNpi = 0;
  for (const ir of injected) {
    totalNpi += ir.entities.length;
    lines.push(
      JSON.stringify({
        row_index: ir.row_index,
        entities: ir.entities,
      }),
    );
  }
  const jsonlOut = lines.join('\n') + '\n';
  writeFileSync(OUT_JSONL, jsonlOut, 'utf8');

  const csvHash = sha256(csvOut);
  const jsonlHash = sha256(jsonlOut);
  const meanNpi = totalNpi / injected.length;
  const variance =
    injected.reduce((acc, r) => acc + (r.entities.length - meanNpi) ** 2, 0) / injected.length;
  const stddev = Math.sqrt(variance);

  process.stdout.write(`[output] csv path:     ${OUT_CSV}\n`);
  process.stdout.write(`[output] jsonl path:   ${OUT_JSONL}\n`);
  process.stdout.write(`[output] rows:         ${injected.length}\n`);
  process.stdout.write(`[output] total NPI:    ${totalNpi}\n`);
  process.stdout.write(`[output] mean NPI:     ${meanNpi.toFixed(2)} (stddev ${stddev.toFixed(2)})\n`);
  process.stdout.write(`[output] csv sha256:   ${csvHash}\n`);
  process.stdout.write(`[output] jsonl sha256: ${jsonlHash}\n`);

  if (existsSync(EXPECTED_HASHES)) {
    const expected = JSON.parse(readFileSync(EXPECTED_HASHES, 'utf8')) as {
      csv_sha256?: string;
      jsonl_sha256?: string;
    };
    const mismatches: string[] = [];
    if (expected.csv_sha256 && expected.csv_sha256 !== csvHash) {
      mismatches.push(`csv: expected ${expected.csv_sha256}, got ${csvHash}`);
    }
    if (expected.jsonl_sha256 && expected.jsonl_sha256 !== jsonlHash) {
      mismatches.push(`jsonl: expected ${expected.jsonl_sha256}, got ${jsonlHash}`);
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Determinism check FAILED — output hashes do not match EXPECTED-HASHES.json:\n  ${mismatches.join('\n  ')}\n` +
          `If you have intentionally regenerated, delete ${EXPECTED_HASHES} and re-run.`,
      );
    }
    process.stdout.write(`[ok] hashes match EXPECTED-HASHES.json\n`);
  } else {
    const record = {
      csv_sha256: csvHash,
      jsonl_sha256: jsonlHash,
      generated_at_utc: new Date().toISOString(),
      subset_size: injected.length,
      total_npi: totalNpi,
      mean_npi_per_row: meanNpi,
      stddev_npi_per_row: stddev,
    };
    writeFileSync(EXPECTED_HASHES, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`[ok] recorded hashes to EXPECTED-HASHES.json (first generation)\n`);
  }
}

main();
