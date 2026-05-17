/**
 * compute-recall.ts
 *
 * Reads the harness's NDJSON output, extracts per-row gateway-attested
 * ground_truth_evaluation blocks, and emits a `SUMMARY.json` aggregate
 * recall / precision / F1 file. Validates the emitted JSON against
 * `papers/_template/SUMMARY.schema.json`.
 *
 * Two input modes:
 *
 *   --redactions-source=ndjson  (default): reads --input NDJSON, uses the
 *     gateway-attested evaluation blocks. This is the live path.
 *   --redactions-source=mock: re-runs the in-process mock against the
 *     ground-truth file, useful for math-only smoke without spinning up the
 *     full run-pipeline harness. Configurable via --miss-rate and
 *     --spurious-fp-count.
 *
 * Determinism: identical inputs produce byte-identical output (sort orders
 * fixed: per_category in HIPAA_CATEGORIES order, per_row by row_index asc).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  type GroundTruthEvaluation,
  extractFromEvaluation,
} from '../src/index.js';
import { aggregateExtracted } from '../src/recall.js';
import type { ExtractedRedaction } from '../src/redaction-extractor.js';
import { buildMockResponse } from '../src/mocks/gateway-fixtures.js';
import type { InjectedEntity } from '../src/inject-pii-core.js';

interface CliArgs {
  truth: string;
  input: string | null;
  redactionsSource: 'ndjson' | 'mock';
  output: string;
  rows: number | null;
  missRate: number;
  spuriousFpCount: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    truth: 'datasets/healthcare/with-injected-pii/ground-truth.jsonl',
    input: null,
    redactionsSource: 'ndjson',
    output: 'papers/paper-1-healthcare/SUMMARY.json',
    rows: null,
    missRate: 0,
    spuriousFpCount: 0,
  };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const val = eq === -1 ? '' : raw.slice(eq + 1);
    switch (key) {
      case '--truth':
        args.truth = val;
        break;
      case '--input':
        args.input = val;
        break;
      case '--redactions-source':
        if (val !== 'ndjson' && val !== 'mock') {
          throw new Error('--redactions-source must be "ndjson" or "mock"');
        }
        args.redactionsSource = val;
        break;
      case '--output':
        args.output = val;
        break;
      case '--rows': {
        const n = Number.parseInt(val, 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error('--rows must be a non-negative integer');
        }
        args.rows = n;
        break;
      }
      case '--miss-rate': {
        const f = Number.parseFloat(val);
        if (!Number.isFinite(f) || f < 0 || f > 1) {
          throw new Error('--miss-rate must be in [0, 1]');
        }
        args.missRate = f;
        break;
      }
      case '--spurious-fp-count': {
        const n = Number.parseInt(val, 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error('--spurious-fp-count must be a non-negative integer');
        }
        args.spuriousFpCount = n;
        break;
      }
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: pnpm run compute-recall -- --truth=<ground-truth.jsonl> ' +
            '[--input=<run.ndjson> | --redactions-source=mock] [--rows=N] --output=<SUMMARY.json>\n',
        );
        process.exit(0);
        break;
      default:
        if (raw.length > 0 && raw !== '--') {
          throw new Error(`unknown argument: ${raw}`);
        }
    }
  }
  if (args.redactionsSource === 'ndjson' && args.input === null) {
    throw new Error('--input is required when --redactions-source=ndjson');
  }
  return args;
}

async function loadGroundTruth(
  path: string,
): Promise<Array<{ row_index: number; entities: InjectedEntity[] }>> {
  const text = await readFile(path, 'utf8');
  const out: Array<{ row_index: number; entities: InjectedEntity[] }> = [];
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
      throw new Error(`${path}: line ${lineNo} not JSON: ${reason}`);
    }
    if (typeof parsed.row_index !== 'number' || !Array.isArray(parsed.entities)) continue;
    const entities: InjectedEntity[] = [];
    for (const item of parsed.entities as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Partial<InjectedEntity>;
      if (
        typeof e.category === 'string' &&
        typeof e.value === 'string' &&
        typeof e.start_char === 'number' &&
        typeof e.end_char === 'number'
      ) {
        entities.push({
          category: e.category,
          value: e.value,
          start_char: e.start_char,
          end_char: e.end_char,
        });
      }
    }
    out.push({ row_index: parsed.row_index, entities });
  }
  return out;
}

async function loadEvaluationsFromNdjson(
  path: string,
): Promise<Map<number, GroundTruthEvaluation>> {
  const text = await readFile(path, 'utf8');
  const out = new Map<number, GroundTruthEvaluation>();
  let lineNo = 0;
  for (const ln of text.split('\n')) {
    lineNo += 1;
    const trimmed = ln.trim();
    if (trimmed === '') continue;
    // BLOCKER-2 (2026-05-17): tolerate partial-line tails left by a
    // SIGKILL between `writeStream.write` and `fsyncSync` in
    // scripts/run-pipeline.ts. Previous behaviour threw, which blocked the
    // entire next pipeline step on a single trailing partial line —
    // contradicting the run-pipeline doc-comment's "downstream consumers
    // gracefully skip malformed lines" recovery contract. We skip-with-warn
    // (NOT silent-skip) so operators retain visibility when a SIGKILL left
    // partial output.
    let parsed: { row_index?: unknown; result?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { row_index?: unknown; result?: unknown };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[compute-recall] skipping malformed line ${lineNo} in ${path}: ${reason}\n`,
      );
      continue;
    }
    if (typeof parsed.row_index !== 'number') continue;
    const result = parsed.result;
    if (typeof result !== 'object' || result === null) continue;
    const evaluation = (result as { evaluation?: GroundTruthEvaluation | null }).evaluation;
    if (evaluation !== null && evaluation !== undefined) {
      out.set(parsed.row_index, evaluation);
    }
  }
  return out;
}

/**
 * Minimal in-process JSON-Schema validator covering the subset of Draft
 * 2020-12 used by SUMMARY.schema.json. Avoids a runtime dep on ajv for a
 * single schema. Throws on the first failure with a JSON-pointer-ish path.
 */
function validateAgainstSchema(json: unknown, schemaPath: string): Promise<void> {
  return (async () => {
    const schemaText = await readFile(schemaPath, 'utf8');
    const schema = JSON.parse(schemaText) as unknown;
    validateNode(json, schema, '#');
  })();
}

interface Schema {
  type?: string;
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Readonly<Record<string, Schema>>;
  $ref?: string;
  $defs?: Readonly<Record<string, Schema>>;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
}

function getDefs(schema: Schema, root: Schema | null): Schema['$defs'] | undefined {
  return root?.$defs ?? schema.$defs;
}

let SCHEMA_ROOT: Schema | null = null;

function validateNode(node: unknown, schema: unknown, ptr: string): void {
  if (typeof schema !== 'object' || schema === null) return;
  const s = schema as Schema;
  if (SCHEMA_ROOT === null) SCHEMA_ROOT = s;
  if (s.$ref !== undefined) {
    const defs = getDefs(s, SCHEMA_ROOT);
    const refName = s.$ref.replace(/^#\/\$defs\//u, '');
    const target = defs?.[refName];
    if (target === undefined) {
      throw new Error(`schema: unresolved $ref ${s.$ref} at ${ptr}`);
    }
    validateNode(node, target, ptr);
    return;
  }
  if (s.type === 'object') {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`schema: expected object at ${ptr}, got ${typeof node}`);
    }
    const obj = node as Record<string, unknown>;
    for (const req of s.required ?? []) {
      if (!(req in obj)) {
        throw new Error(`schema: missing required property "${req}" at ${ptr}`);
      }
    }
    const props = s.properties ?? {};
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          throw new Error(`schema: unexpected property "${k}" at ${ptr}`);
        }
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) validateNode(obj[k], sub, `${ptr}/${k}`);
    }
    return;
  }
  if (s.type === 'array') {
    if (!Array.isArray(node)) {
      throw new Error(`schema: expected array at ${ptr}`);
    }
    if (s.minItems !== undefined && node.length < s.minItems) {
      throw new Error(`schema: array at ${ptr} has ${node.length} items, min ${s.minItems}`);
    }
    if (s.maxItems !== undefined && node.length > s.maxItems) {
      throw new Error(`schema: array at ${ptr} has ${node.length} items, max ${s.maxItems}`);
    }
    if (s.items) {
      for (let i = 0; i < node.length; i++) {
        validateNode(node[i], s.items, `${ptr}/${i}`);
      }
    }
    return;
  }
  if (s.type === 'integer') {
    if (typeof node !== 'number' || !Number.isInteger(node)) {
      throw new Error(`schema: expected integer at ${ptr}`);
    }
  }
  if (s.type === 'number') {
    if (typeof node !== 'number' || !Number.isFinite(node)) {
      throw new Error(`schema: expected number at ${ptr}`);
    }
  }
  if (s.type === 'string') {
    if (typeof node !== 'string') {
      throw new Error(`schema: expected string at ${ptr}`);
    }
  }
  if (s.minimum !== undefined && typeof node === 'number' && node < s.minimum) {
    throw new Error(`schema: ${ptr} below minimum ${s.minimum} (got ${node})`);
  }
  if (s.maximum !== undefined && typeof node === 'number' && node > s.maximum) {
    throw new Error(`schema: ${ptr} above maximum ${s.maximum} (got ${node})`);
  }
  if (s.const !== undefined && node !== s.const) {
    throw new Error(`schema: ${ptr} expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(node)}`);
  }
  if (s.enum !== undefined && !s.enum.includes(node)) {
    throw new Error(`schema: ${ptr} value ${JSON.stringify(node)} not in enum`);
  }
}

function defaultSchemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'papers', '_template', 'SUMMARY.schema.json');
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const groundTruth = await loadGroundTruth(cli.truth);
  const limit = cli.rows ?? groundTruth.length;
  const targetRows = groundTruth.slice(0, limit);

  const extracted: ExtractedRedaction[] = [];
  if (cli.redactionsSource === 'mock') {
    for (const row of targetRows) {
      const mockResponse = buildMockResponse({
        rowIndex: row.row_index,
        entities: row.entities,
        missRate: cli.missRate,
        spuriousFpCount: cli.spuriousFpCount,
      });
      const evaluation = mockResponse.ground_truth_evaluation;
      if (evaluation === undefined) continue;
      extracted.push(...extractFromEvaluation(row.row_index, evaluation));
    }
  } else {
    if (cli.input === null) {
      throw new Error('--input is required when --redactions-source=ndjson');
    }
    const evals = await loadEvaluationsFromNdjson(cli.input);
    for (const row of targetRows) {
      const evaluation = evals.get(row.row_index);
      if (evaluation === undefined) continue;
      extracted.push(...extractFromEvaluation(row.row_index, evaluation));
    }
  }

  const summary = aggregateExtracted(extracted, [
    `Source: ${cli.redactionsSource}; rows processed: ${targetRows.length}.`,
  ]);
  // Validate BEFORE writing. If validation throws, a bogus SUMMARY.json
  // never lands on disk for downstream consumers to consume.
  await validateAgainstSchema(summary, defaultSchemaPath());
  await writeFile(cli.output, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  process.stdout.write(
    `wrote SUMMARY.json (${targetRows.length} rows, ` +
      `overall recall=${summary.overall.recall.toFixed(4)}, ` +
      `f1=${summary.overall.f1.toFixed(4)}) to ${cli.output}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`compute-recall: ${msg}\n`);
  process.exit(1);
});
