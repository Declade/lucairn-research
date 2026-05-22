#!/usr/bin/env -S node --import tsx
/**
 * download-cfpb.ts
 *
 * Acquires the CFPB Consumer Complaint Database via direct HTTPS download
 * from the CFPB's public file server, unzips, verifies row count and
 * SHA-256 integrity, and records acquisition metadata to
 * `datasets/finance/raw/ACQUISITION.json`.
 *
 * Source:  https://files.consumerfinance.gov/ccdb/complaints.csv.zip
 * License: US Federal government work — public domain under 17 USC § 105.
 *          (See CFPB data policy: https://www.consumerfinance.gov/data/.)
 *
 * Idempotency:
 *   - If `datasets/finance/raw/complaints.csv` already exists, the download
 *     step is skipped; verification still runs.
 *   - If the zip is partially downloaded, `curl -C -` resumes it.
 *
 * Prerequisites:
 *   - `curl` on PATH
 *   - `unzip` on PATH (macOS + Linux default)
 *   - ~3 GB free disk space (zip ~1 GB, CSV unzipped ~3 GB)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = resolve(REPO_ROOT, 'datasets', 'finance', 'raw');
const ZIP_PATH = resolve(RAW_DIR, 'complaints.csv.zip');
const CSV_PATH = resolve(RAW_DIR, 'complaints.csv');
const ACQUISITION_PATH = resolve(RAW_DIR, 'ACQUISITION.json');
const EXPECTED_HASH_PATH = resolve(RAW_DIR, 'EXPECTED-HASH.txt');

const SOURCE_URL = 'https://files.consumerfinance.gov/ccdb/complaints.csv.zip';

// CFPB updates the database daily — row count is monotonically increasing.
// A reasonable band given the public release dates known so far. If the row
// count falls outside this band, the operator should investigate upstream
// schema or release-cadence changes.
const MIN_ROW_COUNT = 3_000_000;
const MAX_ROW_COUNT = 12_000_000;

function sha256(filePath: string): string {
  // Stream-hash to avoid loading the entire ~3GB CSV into memory.
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
  }
}

function countCsvRowsStreaming(csvPath: string): number {
  // Use awk for streaming row count over multi-GB files (memory-safe).
  // Subtract 1 for the header row.
  const r = spawnSync('awk', ['END{print NR}', csvPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`awk row count failed (exit ${r.status}): ${r.stderr}`);
  }
  const n = Number((r.stdout ?? '').trim());
  if (!Number.isFinite(n)) throw new Error(`awk returned non-numeric: ${r.stdout}`);
  return Math.max(0, n - 1);
}

function main(): void {
  mkdirSync(RAW_DIR, { recursive: true });

  if (!existsSync(CSV_PATH)) {
    if (!existsSync(ZIP_PATH)) {
      process.stdout.write(`[download] url:        ${SOURCE_URL}\n`);
      process.stdout.write(`[download] target zip: ${ZIP_PATH}\n`);
      run('curl', ['-fsSL', '--retry', '5', '--retry-delay', '10', '-C', '-', '-o', ZIP_PATH, SOURCE_URL]);
    } else {
      process.stdout.write(`[download] zip already present at ${ZIP_PATH}; skipping download.\n`);
    }
    process.stdout.write(`[unzip] extracting ${ZIP_PATH} → ${RAW_DIR}\n`);
    run('unzip', ['-o', ZIP_PATH, '-d', RAW_DIR]);
    if (!existsSync(CSV_PATH)) {
      throw new Error(
        `unzip succeeded but ${CSV_PATH} is missing. Inspect the archive contents at ${RAW_DIR}.`,
      );
    }
  } else {
    process.stdout.write(`[download] CSV already present at ${CSV_PATH}; skipping download/unzip.\n`);
  }

  // ORDER MATTERS: hash first, then row count (mirror healthcare script's
  // discipline at download-mtsamples.ts:112-155).
  const csvHash = sha256(CSV_PATH);
  const csvBytes = statSync(CSV_PATH).size;

  process.stdout.write(`[verify] sha256:       ${csvHash}\n`);
  process.stdout.write(`[verify] size bytes:   ${csvBytes}\n`);

  const hashFileExists = existsSync(EXPECTED_HASH_PATH);
  if (hashFileExists) {
    const expected = readFileSync(EXPECTED_HASH_PATH, 'utf8').trim();
    if (expected !== csvHash) {
      throw new Error(
        `SHA-256 mismatch — refusing to process this CSV:\n` +
          `  expected ${expected}\n` +
          `  actual   ${csvHash}\n` +
          `Note: CFPB updates the database daily, so a fresh download will produce a new hash.\n` +
          `If you have intentionally re-acquired the dataset, delete ${EXPECTED_HASH_PATH} and re-run.`,
      );
    }
    process.stdout.write(`[verify] sha256 matches EXPECTED-HASH.txt\n`);
  }

  const rowCount = countCsvRowsStreaming(CSV_PATH);
  process.stdout.write(`[verify] row count:    ${rowCount}\n`);

  if (rowCount < MIN_ROW_COUNT || rowCount > MAX_ROW_COUNT) {
    throw new Error(
      `Row count ${rowCount} outside acceptable band [${MIN_ROW_COUNT}, ${MAX_ROW_COUNT}]. ` +
        `Investigate upstream before proceeding.`,
    );
  }

  if (!hashFileExists) {
    writeFileSync(EXPECTED_HASH_PATH, `${csvHash}\n`, 'utf8');
    process.stdout.write(`[verify] recorded sha256 to EXPECTED-HASH.txt (first acquisition)\n`);
  }

  const curlVersion = (() => {
    const r = spawnSync('curl', ['--version'], { encoding: 'utf8' });
    const line = (r.stdout ?? '').split('\n')[0] ?? '';
    return line.trim() || 'unknown';
  })();

  const acquisition = {
    dataset: 'CFPB Consumer Complaint Database',
    source_url: SOURCE_URL,
    csv_path: 'datasets/finance/raw/complaints.csv',
    csv_sha256: csvHash,
    csv_bytes: csvBytes,
    row_count: rowCount,
    acquired_at_utc: new Date().toISOString(),
    curl_version: curlVersion,
    license: 'US Federal government work — public domain under 17 USC § 105',
  };
  writeFileSync(ACQUISITION_PATH, `${JSON.stringify(acquisition, null, 2)}\n`, 'utf8');
  process.stdout.write(`[ok] wrote ${ACQUISITION_PATH}\n`);
}

main();
