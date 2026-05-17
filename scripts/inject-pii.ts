#!/usr/bin/env -S node --import tsx
/**
 * inject-pii.ts
 *
 * Driver for Measurement B PII re-injection.
 *
 * Reads:  datasets/healthcare/raw/mtsamples.csv
 * Writes: datasets/healthcare/with-injected-pii/measurement-b-subset.csv
 *         datasets/healthcare/with-injected-pii/ground-truth.jsonl
 *         datasets/healthcare/with-injected-pii/EXPECTED-HASHES.json (first run only)
 *
 * Determinism: identical inputs + same SEED -> byte-identical outputs.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitCsv, parseCsv } from '../src/csv.js';
import { injectIntoRows, pickMeasurementBSubset } from '../src/inject-pii-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_CSV = resolve(REPO_ROOT, 'datasets', 'healthcare', 'raw', 'mtsamples.csv');
const OUT_DIR = resolve(REPO_ROOT, 'datasets', 'healthcare', 'with-injected-pii');
const OUT_CSV = resolve(OUT_DIR, 'measurement-b-subset.csv');
const OUT_JSONL = resolve(OUT_DIR, 'ground-truth.jsonl');
const EXPECTED_HASHES = resolve(OUT_DIR, 'EXPECTED-HASHES.json');

const SUBSET_SIZE = 500;

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function main(): void {
  if (!existsSync(RAW_CSV)) {
    throw new Error(
      `Raw MTSamples CSV not found at ${RAW_CSV}. Run \`pnpm dataset:download\` first.`,
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const text = readFileSync(RAW_CSV, 'utf8');
  const { headers, rows } = parseCsv(text);

  if (!headers.includes('transcription')) {
    throw new Error(
      `Expected MTSamples CSV to have a 'transcription' column; got headers: ${JSON.stringify(headers)}`,
    );
  }

  // Filter out rows where transcription is empty — Faker injection requires
  // some carrier text to splice into.
  const nonEmpty: Array<{ row_index: number; transcription: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const t = (rows[i]?.['transcription'] ?? '').trim();
    if (t.length > 0) {
      nonEmpty.push({ row_index: i, transcription: rows[i]?.['transcription'] ?? '' });
    }
  }

  process.stdout.write(`[input] total rows:      ${rows.length}\n`);
  process.stdout.write(`[input] non-empty rows:  ${nonEmpty.length}\n`);

  const subsetIndices = pickMeasurementBSubset(nonEmpty.length, SUBSET_SIZE);
  const subsetCarriers = subsetIndices.map((idx) => {
    const item = nonEmpty[idx];
    if (!item) throw new Error(`subset index ${idx} out of range`);
    // We track the row's ORIGINAL row_index in the source CSV, not its index
    // within the non-empty filter, so cross-references to mtsamples.csv work.
    return item;
  });

  process.stdout.write(`[subset] selected ${subsetCarriers.length} rows for Measurement B\n`);

  const injected = injectIntoRows(subsetCarriers);

  // Output CSV: keep the original headers + add an `original_row_index` column
  // so reviewers can join back to mtsamples.csv if they want to spot-check.
  const outHeaders = ['original_row_index', ...headers];
  const outRows = injected.map((ir) => {
    const sourceRow = rows[ir.row_index] ?? {};
    return {
      original_row_index: String(ir.row_index),
      ...sourceRow,
      transcription: ir.injected_transcription,
    };
  });
  const csvOut = emitCsv(outHeaders, outRows);
  writeFileSync(OUT_CSV, csvOut, 'utf8');

  // Ground-truth JSONL: one line per row, capturing entities + row_index.
  const lines: string[] = [];
  let totalPhi = 0;
  for (const ir of injected) {
    totalPhi += ir.entities.length;
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
  const meanPhi = totalPhi / injected.length;
  const variance =
    injected.reduce((acc, r) => acc + (r.entities.length - meanPhi) ** 2, 0) / injected.length;
  const stddev = Math.sqrt(variance);

  process.stdout.write(`[output] csv path:    ${OUT_CSV}\n`);
  process.stdout.write(`[output] jsonl path:  ${OUT_JSONL}\n`);
  process.stdout.write(`[output] rows:        ${injected.length}\n`);
  process.stdout.write(`[output] total PHI:   ${totalPhi}\n`);
  process.stdout.write(`[output] mean PHI:    ${meanPhi.toFixed(2)} (stddev ${stddev.toFixed(2)})\n`);
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
      total_phi: totalPhi,
      mean_phi_per_row: meanPhi,
      stddev_phi_per_row: stddev,
    };
    writeFileSync(EXPECTED_HASHES, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    process.stdout.write(`[ok] recorded hashes to EXPECTED-HASHES.json (first generation)\n`);
  }
}

main();
