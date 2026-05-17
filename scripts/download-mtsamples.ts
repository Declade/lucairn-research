#!/usr/bin/env -S node --import tsx
/**
 * download-mtsamples.ts
 *
 * Acquires the MTSamples Kaggle dataset via the Kaggle CLI, verifies row count
 * and (if a previously recorded hash exists) SHA-256 integrity, and records
 * acquisition metadata to datasets/healthcare/raw/ACQUISITION.json.
 *
 * Prerequisites:
 *   - `kaggle` CLI on PATH (install via `pipx install kaggle`)
 *   - ~/.kaggle/kaggle.json present, mode 0600
 *
 * Idempotency:
 *   - If `datasets/healthcare/raw/mtsamples.csv` already exists, the download
 *     step is skipped; verification still runs.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = resolve(REPO_ROOT, 'datasets', 'healthcare', 'raw');
const CSV_PATH = resolve(RAW_DIR, 'mtsamples.csv');
const ACQUISITION_PATH = resolve(RAW_DIR, 'ACQUISITION.json');
const EXPECTED_HASH_PATH = resolve(RAW_DIR, 'EXPECTED-HASH.txt');

const KAGGLE_DATASET = 'tboyle10/medicaltranscriptions';
const MIN_ROW_COUNT = 4990;
const MAX_ROW_COUNT = 5050;

function findKaggleCli(): string {
  const home = process.env['HOME'] ?? '';
  const candidates = [
    `${home}/.local/bin/kaggle`,
    '/opt/homebrew/bin/kaggle',
    '/usr/local/bin/kaggle',
    'kaggle',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    'kaggle CLI not found on PATH. Install via: pipx install kaggle. ' +
      'Confirm ~/.kaggle/kaggle.json is present (mode 0600).',
  );
}

function sha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function countCsvRows(csvPath: string): number {
  // Robust row count: parse line-by-line, respecting quoted newlines.
  const text = readFileSync(csvPath, 'utf8');
  let rows = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Toggle, but handle escaped "" inside quoted fields.
      if (inQuotes && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (ch === '\n' && !inQuotes) {
      rows++;
    }
  }
  // If the last line lacks a trailing newline, count it.
  if (text.length > 0 && text[text.length - 1] !== '\n') {
    rows++;
  }
  // Subtract the header row.
  return Math.max(0, rows - 1);
}

function main(): void {
  mkdirSync(RAW_DIR, { recursive: true });

  if (!existsSync(CSV_PATH)) {
    const kaggle = findKaggleCli();
    process.stdout.write(`[download] kaggle CLI: ${kaggle}\n`);
    process.stdout.write(`[download] dataset: ${KAGGLE_DATASET}\n`);
    process.stdout.write(`[download] target dir: ${RAW_DIR}\n`);

    const dl = spawnSync(
      kaggle,
      ['datasets', 'download', '-d', KAGGLE_DATASET, '-p', RAW_DIR, '--unzip'],
      { stdio: 'inherit' },
    );
    if (dl.status !== 0) {
      throw new Error(`Kaggle download failed (exit ${dl.status}).`);
    }
    if (!existsSync(CSV_PATH)) {
      throw new Error(
        `Kaggle download succeeded but ${CSV_PATH} is missing — expected the unzipped CSV at that path.`,
      );
    }
  } else {
    process.stdout.write(`[download] CSV already present at ${CSV_PATH}; skipping download.\n`);
  }

  // ORDER MATTERS: hash first, then row-count.
  // Rationale: if EXPECTED-HASH.txt is present and the new download mismatches,
  // we must fail IMMEDIATELY — before any row processing — so the operator
  // sees the integrity violation rather than a derivative symptom.
  const csvHash = sha256(CSV_PATH);
  const csvBytes = statSync(CSV_PATH).size;

  process.stdout.write(`[verify] sha256:       ${csvHash}\n`);
  process.stdout.write(`[verify] size bytes:   ${csvBytes}\n`);

  // Step 1: hash check (immediate fail-closed on mismatch).
  const hashFileExists = existsSync(EXPECTED_HASH_PATH);
  if (hashFileExists) {
    const expected = readFileSync(EXPECTED_HASH_PATH, 'utf8').trim();
    if (expected !== csvHash) {
      throw new Error(
        `SHA-256 mismatch — refusing to process this CSV:\n` +
          `  expected ${expected}\n` +
          `  actual   ${csvHash}\n` +
          `If you have intentionally re-acquired the dataset, delete ${EXPECTED_HASH_PATH} and re-run.`,
      );
    }
    process.stdout.write(`[verify] sha256 matches EXPECTED-HASH.txt\n`);
  }

  // Step 2: row count check (only reached if hash check passed, or if this is
  // the first acquisition and EXPECTED-HASH.txt does not yet exist).
  const rowCount = countCsvRows(CSV_PATH);
  process.stdout.write(`[verify] row count:    ${rowCount}\n`);

  if (rowCount < MIN_ROW_COUNT || rowCount > MAX_ROW_COUNT) {
    throw new Error(
      `Row count ${rowCount} outside acceptable band [${MIN_ROW_COUNT}, ${MAX_ROW_COUNT}]. ` +
        `Dataset may have changed upstream; investigate before proceeding.`,
    );
  }

  // Step 3: only NOW — after both hash AND row-count checks pass — record the
  // hash on first acquisition. This avoids writing EXPECTED-HASH.txt for a
  // download whose row count is out-of-band.
  if (!hashFileExists) {
    writeFileSync(EXPECTED_HASH_PATH, `${csvHash}\n`, 'utf8');
    process.stdout.write(`[verify] recorded sha256 to EXPECTED-HASH.txt (first acquisition)\n`);
  }

  const kaggleVersion = (() => {
    const kaggle = findKaggleCli();
    const probe = spawnSync(kaggle, ['--version'], { encoding: 'utf8' });
    return (probe.stdout ?? '').trim() || 'unknown';
  })();

  const acquisition = {
    dataset: KAGGLE_DATASET,
    csv_path: 'datasets/healthcare/raw/mtsamples.csv',
    csv_sha256: csvHash,
    csv_bytes: csvBytes,
    row_count: rowCount,
    acquired_at_utc: new Date().toISOString(),
    kaggle_cli_version: kaggleVersion,
  };
  writeFileSync(ACQUISITION_PATH, `${JSON.stringify(acquisition, null, 2)}\n`, 'utf8');
  process.stdout.write(`[ok] wrote ${ACQUISITION_PATH}\n`);
}

main();
