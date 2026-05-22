#!/usr/bin/env -S node --import tsx
/**
 * analyze-finance-ndjson.ts
 *
 * Paper 2 (finance) NDJSON analysis driver. Streams a benchmark NDJSON
 * line-by-line and computes:
 *   - rows OK / rows errored
 *   - aggregate matches / missed / extras across all rows
 *   - per-GLBA-category counts (TP / FN / FP attribution)
 *   - top-N most-frequent extras (false-positive vocabulary)
 *   - wall-clock from first-to-last timestamp
 *   - mean / p50 / p95 latency_ms (per-row gateway latency from
 *     `result.latency_ms`)
 *
 * Mirrors `compute-recall.ts` (HIPAA) in output shape but is fully
 * standalone — no recall.ts / redaction-extractor.ts dependency, so it
 * cannot regress Paper 1. Reads the harness's NDJSON format from
 * `scripts/run-pipeline.ts` directly.
 *
 * Usage:
 *   pnpm analyze:finance -- --input=papers/paper-2-finance/raw-results/baseline-500row-<ts>.ndjson
 *   pnpm analyze:finance -- --input=...ndjson --output=papers/paper-2-finance/SUMMARY-baseline.json
 *   pnpm analyze:finance -- --input=...ndjson --compare=baseline-summary.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLBA_CATEGORIES, type GlbaCategory } from '../src/inject-finance-pii-core.js';
import { placeholderToGlbaCategory } from '../src/glba-category-mapping.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface CliArgs {
  input: string;
  output: string | null;
  compare: string | null;
  topFps: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const a: CliArgs = { input: '', output: null, compare: null, topFps: 25 };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const k = eq === -1 ? raw : raw.slice(0, eq);
    const v = eq === -1 ? '' : raw.slice(eq + 1);
    if (k === '--input') a.input = v;
    else if (k === '--output') a.output = v;
    else if (k === '--compare') a.compare = v;
    else if (k === '--top-fps') a.topFps = Number.parseInt(v, 10) || 25;
    else if (k.length > 0 && k !== '--') throw new Error(`unknown arg: ${raw}`);
  }
  if (!a.input) throw new Error('--input=<NDJSON path> required');
  return a;
}

interface NdjsonRecord {
  row_index: number;
  timestamp_utc: string;
  entities_submitted: number;
  gateway?: string;
  mode?: string;
  result: null | {
    cert_url?: string | null;
    summary_url?: string | null;
    latency_ms?: number | null;
    evaluation?: null | {
      matches?: Array<{ annotation_type?: string; annotation_value?: string; redacted_as?: string }>;
      missed?: Array<{ type?: string; value?: string; field?: string }>;
      extras?: Array<{ placeholder?: string; original_value?: string; original?: string }>;
    };
  };
  error: null | { code: string; message: string };
}

interface CategoryCounts {
  tp: number;
  fn: number;
  fp_attributed: number;
}

interface Summary {
  input_path: string;
  rows_total: number;
  rows_ok: number;
  rows_errored: number;
  aggregate: {
    tp_total: number;
    fn_total: number;
    fp_total: number;
    fp_attributed: number;
    fp_unmapped: number;
    recall: number;
    precision: number;
    f1: number;
  };
  per_category: Array<{
    category: GlbaCategory | 'UNMAPPED';
    counts: CategoryCounts;
    recall: number | null;
    precision: number | null;
  }>;
  top_extras: Array<{ value: string; count: number; placeholder: string | null }>;
  latency: {
    count: number;
    mean_ms: number;
    p50_ms: number;
    p95_ms: number;
    max_ms: number;
  };
  wall_clock: {
    first_utc: string | null;
    last_utc: string | null;
    duration_ms: number | null;
  };
}

function pct(num: number, den: number): number {
  if (den === 0) return 0;
  return Math.round((num / den) * 10000) / 100;
}

function safeF1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return Math.round(((2 * precision * recall) / (precision + recall)) * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx] ?? 0;
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const absInput = resolve(REPO_ROOT, cli.input);
  if (!existsSync(absInput)) throw new Error(`input file not found: ${absInput}`);

  const text = readFileSync(absInput, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);

  let rowsOk = 0;
  let rowsErrored = 0;
  let tpTotal = 0;
  let fnTotal = 0;
  let fpTotal = 0;
  let fpAttributed = 0;
  let fpUnmapped = 0;
  const perCat = new Map<string, CategoryCounts>();
  for (const c of GLBA_CATEGORIES) perCat.set(c, { tp: 0, fn: 0, fp_attributed: 0 });
  perCat.set('UNMAPPED', { tp: 0, fn: 0, fp_attributed: 0 });

  const extrasByValue = new Map<string, { count: number; placeholder: string | null }>();
  const latencies: number[] = [];
  let firstUtc: string | null = null;
  let lastUtc: string | null = null;

  for (const ln of lines) {
    let rec: NdjsonRecord;
    try {
      rec = JSON.parse(ln) as NdjsonRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[warn] skipping malformed line: ${msg}\n`);
      continue;
    }
    if (firstUtc === null) firstUtc = rec.timestamp_utc;
    lastUtc = rec.timestamp_utc;
    if (rec.error || !rec.result) {
      rowsErrored++;
      continue;
    }
    rowsOk++;
    if (typeof rec.result.latency_ms === 'number' && rec.result.latency_ms > 0) {
      latencies.push(rec.result.latency_ms);
    }
    const ev = rec.result.evaluation;
    if (!ev) continue;

    for (const m of ev.matches ?? []) {
      tpTotal++;
      const t = m.annotation_type ?? '';
      const cat = perCat.get(t);
      if (cat) cat.tp++;
    }
    for (const miss of ev.missed ?? []) {
      fnTotal++;
      const t = miss.type ?? '';
      const cat = perCat.get(t);
      if (cat) cat.fn++;
    }
    for (const extra of ev.extras ?? []) {
      fpTotal++;
      const placeholder = extra.placeholder ?? null;
      const value = (extra.original_value ?? extra.original ?? '').trim();
      if (value) {
        const existing = extrasByValue.get(value);
        if (existing) existing.count++;
        else extrasByValue.set(value, { count: 1, placeholder });
      }
      const mapped = placeholder ? placeholderToGlbaCategory(placeholder) : null;
      if (mapped) {
        fpAttributed++;
        const cat = perCat.get(mapped);
        if (cat) cat.fp_attributed++;
      } else {
        fpUnmapped++;
        const cat = perCat.get('UNMAPPED');
        if (cat) cat.fp_attributed++;
      }
    }
  }

  const recall = pct(tpTotal, tpTotal + fnTotal);
  const precision = pct(tpTotal, tpTotal + fpTotal);
  const f1 = safeF1(precision, recall);

  const perCategoryRows: Summary['per_category'] = [];
  for (const cat of [...GLBA_CATEGORIES, 'UNMAPPED' as const]) {
    const counts = perCat.get(cat) ?? { tp: 0, fn: 0, fp_attributed: 0 };
    perCategoryRows.push({
      category: cat,
      counts,
      recall: counts.tp + counts.fn === 0 ? null : pct(counts.tp, counts.tp + counts.fn),
      precision:
        counts.tp + counts.fp_attributed === 0
          ? null
          : pct(counts.tp, counts.tp + counts.fp_attributed),
    });
  }

  const topExtras = Array.from(extrasByValue.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, cli.topFps)
    .map(([value, info]) => ({ value, count: info.count, placeholder: info.placeholder }));

  latencies.sort((a, b) => a - b);
  const meanMs = latencies.length === 0
    ? 0
    : Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length);

  const summary: Summary = {
    input_path: cli.input,
    rows_total: rowsOk + rowsErrored,
    rows_ok: rowsOk,
    rows_errored: rowsErrored,
    aggregate: {
      tp_total: tpTotal,
      fn_total: fnTotal,
      fp_total: fpTotal,
      fp_attributed: fpAttributed,
      fp_unmapped: fpUnmapped,
      recall,
      precision,
      f1,
    },
    per_category: perCategoryRows,
    top_extras: topExtras,
    latency: {
      count: latencies.length,
      mean_ms: meanMs,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      max_ms: latencies[latencies.length - 1] ?? 0,
    },
    wall_clock: {
      first_utc: firstUtc,
      last_utc: lastUtc,
      duration_ms:
        firstUtc && lastUtc
          ? new Date(lastUtc).getTime() - new Date(firstUtc).getTime()
          : null,
    },
  };

  // Pretty stdout summary.
  process.stdout.write(`\n========== Paper 2 (finance) NDJSON analysis ==========\n`);
  process.stdout.write(`input: ${cli.input}\n`);
  process.stdout.write(
    `rows: ${rowsOk} OK / ${rowsErrored} errored / ${rowsOk + rowsErrored} total\n`,
  );
  process.stdout.write(
    `wall_clock: ${summary.wall_clock.duration_ms ?? 'n/a'} ms ` +
      `(${summary.wall_clock.first_utc} → ${summary.wall_clock.last_utc})\n`,
  );
  process.stdout.write(
    `latency: count=${summary.latency.count} mean=${summary.latency.mean_ms} ms ` +
      `p50=${summary.latency.p50_ms} p95=${summary.latency.p95_ms} max=${summary.latency.max_ms}\n`,
  );
  process.stdout.write(`\n--- AGGREGATE ---\n`);
  process.stdout.write(`TP: ${tpTotal}\nFN: ${fnTotal}\nFP: ${fpTotal} (attributed=${fpAttributed}, unmapped=${fpUnmapped})\n`);
  process.stdout.write(`recall:    ${recall} %\nprecision: ${precision} %\nF1:        ${f1}\n`);
  process.stdout.write(`\n--- PER GLBA CATEGORY ---\n`);
  for (const row of perCategoryRows) {
    const r = row.recall === null ? '  n/a' : `${row.recall}`.padStart(6, ' ');
    const p = row.precision === null ? '  n/a' : `${row.precision}`.padStart(6, ' ');
    process.stdout.write(
      `  ${row.category.padEnd(22, ' ')} recall=${r} % precision=${p} % ` +
        `(tp=${row.counts.tp} fn=${row.counts.fn} fp=${row.counts.fp_attributed})\n`,
    );
  }
  process.stdout.write(`\n--- TOP ${topExtras.length} EXTRAS (false positives by frequency) ---\n`);
  for (const e of topExtras) {
    process.stdout.write(
      `  ${String(e.count).padStart(5, ' ')}×  ${e.value.slice(0, 60).padEnd(60, ' ')}  (${e.placeholder ?? 'no-placeholder'})\n`,
    );
  }
  process.stdout.write(`\n`);

  if (cli.output) {
    const absOut = resolve(REPO_ROOT, cli.output);
    writeFileSync(absOut, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    process.stdout.write(`wrote ${absOut}\n`);
  }
}

main();
