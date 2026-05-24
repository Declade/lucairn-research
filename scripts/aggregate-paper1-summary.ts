/**
 * aggregate-paper1-summary.ts
 *
 * Aggregates per-row evaluation data from a Paper 1 NDJSON harness output
 * into a deterministic per-category SUMMARY-tuned.json file. The summary
 * mirrors the Paper 2 SUMMARY shape (see `papers/paper-2-finance/SUMMARY-tuned.json`)
 * so that `scripts/build-figures.ts` can consume both papers through one shared
 * JSON loader.
 *
 * WHY this exists:
 *   The raw Paper 1 NDJSON (about 5 MB, 500 rows) is gitignored under
 *   papers/<paper>/raw-results/ (the repo convention: only summaries are
 *   checked in). The SVG generator must NOT depend on a gitignored input file
 *   or it breaks reproducibility for anyone cloning fresh. This script lives
 *   between the harness output and build-figures.ts: harness produces NDJSON
 *   locally, aggregator writes the small JSON summary, that JSON is committed,
 *   SVG generator reads only committed inputs.
 *
 * Usage:
 *   pnpm aggregate:paper1
 *     defaults:
 *       --input=papers/paper-1-healthcare/raw-results/paper1-AFTER-500row-20260522T080037Z.ndjson
 *       --output=papers/paper-1-healthcare/SUMMARY-tuned.json
 *
 *   pnpm aggregate:paper1 -- \
 *     --input=papers/paper-1-healthcare/raw-results/other.ndjson \
 *     --output=papers/paper-1-healthcare/SUMMARY-baseline.json
 *
 * Determinism:
 *   The output JSON contains no timestamps, no PRNG output, no locale-dependent
 *   number formatting. Identical input NDJSON → byte-identical SUMMARY JSON.
 *
 * Failure modes:
 *   - Input file missing: throws with ENOENT-style message.
 *   - Any line fails JSON.parse (excluding blank lines): throws a descriptive
 *     error including the line number and the parse error. Published benchmark
 *     figures must NEVER be generated from a silently-truncated input — we fail
 *     loud rather than emit partial metrics.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT =
  'papers/paper-1-healthcare/raw-results/paper1-AFTER-500row-20260522T080037Z.ndjson';
const DEFAULT_OUTPUT = 'papers/paper-1-healthcare/SUMMARY-tuned.json';

const HIPAA_CATEGORIES = [
  'NAME',
  'GEO_SUBDIVISION',
  'DATE',
  'PHONE',
  'FAX',
  'EMAIL',
  'SSN',
  'MRN',
  'HEALTH_PLAN_ID',
  'ACCOUNT_NUMBER',
  'LICENSE_NUMBER',
  'VEHICLE_ID',
  'DEVICE_ID',
  'URL',
  'IP_ADDRESS',
  'BIOMETRIC_ID',
  'FACE_PHOTO_REF',
  'OTHER_UNIQUE_ID',
] as const;
type HipaaCategory = (typeof HIPAA_CATEGORIES)[number];

interface RawEvaluationMatch {
  annotation_type?: unknown;
}
interface RawEvaluationMissed {
  type?: unknown;
}
interface RawEvaluation {
  matches?: unknown;
  missed?: unknown;
  false_positives?: unknown;
}
interface RawRow {
  result?: { evaluation?: RawEvaluation | null } | null;
}

interface Paper1SummaryEntry {
  category: HipaaCategory;
  counts: { tp: number; fn: number };
  recall: number | null;
}

interface Paper1Summary {
  input_path: string;
  rows_total: number;
  rows_with_evaluation: number;
  aggregate: {
    tp_total: number;
    fn_total: number;
    fp_total: number;
    recall: number;
  };
  per_category: Paper1SummaryEntry[];
}

function parseArgs(argv: readonly string[]): { input: string; output: string } {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--input=')) input = a.slice('--input='.length);
    else if (a.startsWith('--output=')) output = a.slice('--output='.length);
  }
  return { input, output };
}

/**
 * @param inputAbs   Absolute path used for filesystem reads + error messages.
 * @param inputLabel Repo-relative path (or other stable label) embedded into
 *                   the summary's `input_path` field. We deliberately do NOT
 *                   store the absolute path — committed summaries must not
 *                   leak per-user filesystem paths (e.g. `/Users/<name>/...`),
 *                   which the personal-info-leak-detector flags as HIGH. This
 *                   matches the convention used by Paper 2's SUMMARY-tuned.json.
 */
async function aggregate(inputAbs: string, inputLabel: string): Promise<Paper1Summary> {
  let text: string;
  try {
    text = await readFile(inputAbs, 'utf8');
  } catch (err) {
    throw new Error(
      `aggregate-paper1-summary: failed to read input '${inputAbs}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const tp = Object.fromEntries(HIPAA_CATEGORIES.map((c) => [c, 0])) as Record<
    HipaaCategory,
    number
  >;
  const fn = Object.fromEntries(HIPAA_CATEGORIES.map((c) => [c, 0])) as Record<
    HipaaCategory,
    number
  >;
  let totalTp = 0;
  let totalFn = 0;
  let totalFp = 0;
  let rowsTotal = 0;
  let rowsWithEval = 0;

  let lineNo = 0;
  for (const ln of text.split('\n')) {
    lineNo += 1;
    const trimmed = ln.trim();
    if (trimmed === '') continue;
    rowsTotal += 1;
    let parsed: RawRow;
    try {
      parsed = JSON.parse(trimmed) as RawRow;
    } catch (err) {
      // Fail loud: published benchmark figures must not silently drop rows.
      throw new Error(
        `aggregate-paper1-summary: malformed JSON at ${inputAbs}:${lineNo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const ev = parsed.result?.evaluation;
    if (ev === null || ev === undefined) continue;
    rowsWithEval += 1;
    if (Array.isArray(ev.matches)) {
      for (const m of ev.matches as RawEvaluationMatch[]) {
        const t = m.annotation_type;
        if (typeof t === 'string' && HIPAA_CATEGORIES.includes(t as HipaaCategory)) {
          tp[t as HipaaCategory] += 1;
        }
        totalTp += 1;
      }
    }
    if (Array.isArray(ev.missed)) {
      for (const m of ev.missed as RawEvaluationMissed[]) {
        const t = m.type;
        if (typeof t === 'string' && HIPAA_CATEGORIES.includes(t as HipaaCategory)) {
          fn[t as HipaaCategory] += 1;
        }
        totalFn += 1;
      }
    }
    const fpVal = ev.false_positives;
    if (typeof fpVal === 'number' && Number.isFinite(fpVal)) {
      totalFp += fpVal;
    }
  }

  const perCategory: Paper1SummaryEntry[] = HIPAA_CATEGORIES.map((cat) => {
    const t = tp[cat];
    const f = fn[cat];
    const n = t + f;
    const recall = n === 0 ? null : Number(((t / n) * 100).toFixed(2));
    return { category: cat, counts: { tp: t, fn: f }, recall };
  });

  const overallRecall =
    totalTp + totalFn === 0 ? 0 : Number(((totalTp / (totalTp + totalFn)) * 100).toFixed(2));

  return {
    input_path: inputLabel,
    rows_total: rowsTotal,
    rows_with_evaluation: rowsWithEval,
    aggregate: {
      tp_total: totalTp,
      fn_total: totalFn,
      fp_total: totalFp,
      recall: overallRecall,
    },
    per_category: perCategory,
  };
}

async function main(): Promise<void> {
  const { input, output } = parseArgs(process.argv);
  const here = new URL('.', import.meta.url).pathname;
  const root = resolve(here, '..');
  const inputAbs = resolve(root, input);
  const outputAbs = resolve(root, output);

  process.stdout.write(`[aggregate-paper1] input=${input}\n`);
  // Pass the user-supplied (repo-relative-by-convention) `input` as the label
  // embedded into the summary, so the committed JSON contains a stable
  // repo-relative path rather than a per-user absolute path.
  const summary = await aggregate(inputAbs, input);
  process.stdout.write(
    `[aggregate-paper1] aggregated: rows=${summary.rows_total} with_eval=${summary.rows_with_evaluation} tp=${summary.aggregate.tp_total} fn=${summary.aggregate.fn_total} fp=${summary.aggregate.fp_total} recall=${summary.aggregate.recall}%\n`,
  );

  // Pretty-print with 2-space indent + trailing newline for git friendliness.
  await writeFile(outputAbs, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  process.stdout.write(`[aggregate-paper1] wrote ${output}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[aggregate-paper1] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
