#!/usr/bin/env -S node --import tsx
/**
 * verify-finance-injection.ts
 *
 * Round-trip verification of the Paper 2 Measurement B injected corpus.
 * Mirrors `verify-injection.ts` (healthcare) one-for-one.
 *
 * Checks:
 *   1. CSV + JSONL parse cleanly.
 *   2. For every JSONL row, every (start_char, end_char, value) entity
 *      resolves to exactly `value` when seek'd into the row's injected
 *      narrative.
 *   3. SHA-256 of CSV + JSONL match EXPECTED-HASHES.json (determinism gate).
 *
 * Exits 0 on full pass, non-zero on any failure.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../src/csv.js';
import type { GlbaCategory } from '../src/inject-finance-pii-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'datasets', 'finance', 'with-injected-pii');
const OUT_CSV = resolve(OUT_DIR, 'measurement-b-subset.csv');
const OUT_JSONL = resolve(OUT_DIR, 'ground-truth.jsonl');
const EXPECTED_HASHES = resolve(OUT_DIR, 'EXPECTED-HASHES.json');

const NARRATIVE_COLUMN = 'Consumer complaint narrative';

interface GroundTruthRow {
  row_index: number;
  entities: Array<{
    category: GlbaCategory;
    value: string;
    start_char: number;
    end_char: number;
  }>;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function main(): void {
  for (const p of [OUT_CSV, OUT_JSONL]) {
    if (!existsSync(p)) {
      throw new Error(`missing ${p}. Run \`pnpm dataset:inject-finance-pii\` first.`);
    }
  }

  const csvText = readFileSync(OUT_CSV, 'utf8');
  const jsonlText = readFileSync(OUT_JSONL, 'utf8');

  const { headers, rows } = parseCsv(csvText);
  if (!headers.includes('original_row_index') || !headers.includes(NARRATIVE_COLUMN)) {
    throw new Error(
      `Expected output CSV to have 'original_row_index' and '${NARRATIVE_COLUMN}' columns; got: ${JSON.stringify(headers)}`,
    );
  }
  process.stdout.write(`[verify] csv rows: ${rows.length}\n`);

  const csvByRowIndex = new Map<number, string>();
  for (const r of rows) {
    const idx = Number(r['original_row_index']);
    if (Number.isNaN(idx)) continue;
    csvByRowIndex.set(idx, r[NARRATIVE_COLUMN] ?? '');
  }

  const jsonlLines = jsonlText.split('\n').filter((l) => l.length > 0);
  process.stdout.write(`[verify] jsonl rows: ${jsonlLines.length}\n`);

  if (jsonlLines.length !== rows.length) {
    throw new Error(`row-count mismatch: csv=${rows.length}, jsonl=${jsonlLines.length}`);
  }

  let totalEntities = 0;
  let totalMismatches = 0;
  for (const line of jsonlLines) {
    const gt = JSON.parse(line) as GroundTruthRow;
    const injectedText = csvByRowIndex.get(gt.row_index);
    if (injectedText === undefined) {
      throw new Error(`jsonl row_index ${gt.row_index} not present in csv`);
    }
    for (const e of gt.entities) {
      totalEntities++;
      const sliced = injectedText.slice(e.start_char, e.end_char);
      if (sliced !== e.value) {
        totalMismatches++;
        if (totalMismatches <= 5) {
          process.stderr.write(
            `[MISMATCH] row=${gt.row_index} cat=${e.category} [${e.start_char},${e.end_char}) ` +
              `expected=${JSON.stringify(e.value)} got=${JSON.stringify(sliced)}\n`,
          );
        }
      }
    }
  }

  process.stdout.write(`[verify] total entities checked: ${totalEntities}\n`);
  if (totalMismatches > 0) {
    throw new Error(`${totalMismatches} ground-truth coordinate mismatch(es). See above.`);
  }
  process.stdout.write(`[ok] all entities round-trip cleanly\n`);

  if (existsSync(EXPECTED_HASHES)) {
    const expected = JSON.parse(readFileSync(EXPECTED_HASHES, 'utf8')) as {
      csv_sha256?: string;
      jsonl_sha256?: string;
    };
    const csvHash = sha256(csvText);
    const jsonlHash = sha256(jsonlText);
    const mismatches: string[] = [];
    if (expected.csv_sha256 && expected.csv_sha256 !== csvHash) {
      mismatches.push(`csv: expected ${expected.csv_sha256}, got ${csvHash}`);
    }
    if (expected.jsonl_sha256 && expected.jsonl_sha256 !== jsonlHash) {
      mismatches.push(`jsonl: expected ${expected.jsonl_sha256}, got ${jsonlHash}`);
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Hash check FAILED:\n  ${mismatches.join('\n  ')}\n` +
          `Determinism regression — investigate before proceeding.`,
      );
    }
    process.stdout.write(`[ok] csv + jsonl sha256 match EXPECTED-HASHES.json\n`);
  } else {
    process.stdout.write(
      `[note] no EXPECTED-HASHES.json present — skipping hash gate. Run \`pnpm dataset:inject-finance-pii\` once to populate.\n`,
    );
  }
}

main();
