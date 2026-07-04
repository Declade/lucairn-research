/**
 * run-itsm-baseline.ts
 *
 * S5-BASELINE (PRD prd-2026-07-04-redaction-quality-overhaul, Slice 5):
 * scores the current L1+L2 sanitizer's predicted redactions (produced by the
 * standalone Python probe kept in lucairn-research/../scratchpad, invoked
 * per the results README) against the ITSM gold fixture set
 * (papers/itsm-fp-baseline/fixtures/itsm-gold.json) using the REDACT eval
 * harness's own scorer (src/redact-eval/scorer.ts, shipped PR #8 / merge
 * 20be12c, 2026-07-02).
 *
 * This is a genuine reuse of the shipped harness, not a parallel
 * reimplementation: scoreRecords() plus the EvalRecord / PredictedRecord
 * schema are imported unchanged from src/redact-eval/. The only new code
 * here is the file-loading glue and the ITSM-specific fixture set.
 *
 * Usage:
 *   node --import tsx scripts/run-itsm-baseline.ts \
 *     --gold=papers/itsm-fp-baseline/fixtures/itsm-gold.json \
 *     --predictions=papers/itsm-fp-baseline/raw-results/RUN-predictions.json \
 *     --output=papers/itsm-fp-baseline/raw-results/RUN-SUMMARY.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { scoreRecords } from '../src/redact-eval/scorer.js';
import type { EvalRecord, PredictedRecord } from '../src/redact-eval/schema.js';

interface CliArgs {
  gold: string;
  predictions: string;
  output: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'gold' || key === 'predictions' || key === 'output') out[key] = value;
  }
  if (!out.gold || !out.predictions || !out.output) {
    console.error(
      'Usage: run-itsm-baseline.ts --gold=<path> --predictions=<path> --output=<path>',
    );
    process.exit(1);
  }
  return out as CliArgs;
}

interface GoldFixture {
  id: string;
  language: string;
  text: string;
  goldEntities: EvalRecord['goldEntities'];
}

interface ProbeOutput {
  predictedByRecord: PredictedRecord[];
  unresolvedSpans: unknown[];
  meta: Record<string, unknown>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const goldFixtures: GoldFixture[] = JSON.parse(readFileSync(args.gold, 'utf-8'));
  const probeOutput: ProbeOutput = JSON.parse(readFileSync(args.predictions, 'utf-8'));

  const records: EvalRecord[] = goldFixtures.map((f) => ({
    text: f.text,
    language: f.language,
    goldEntities: f.goldEntities,
  }));

  const summary = scoreRecords(records, probeOutput.predictedByRecord, 'partial-overlap');

  // Per-fixture breakdown (which record ids reproduce which FP classes) --
  // not part of scorer.ts's ScoreSummary shape, so computed here as a
  // companion diagnostic, not a scorer.ts modification.
  const perFixture = goldFixtures.map((f, i) => {
    const preds = probeOutput.predictedByRecord.find((p) => p.recordIndex === i)?.predictions ?? [];
    const goldSpans = f.goldEntities.map((g) => ({ ...g, text: f.text.slice(g.start, g.end) }));
    const predSpans = preds.map((p) => ({ ...p, text: f.text.slice(p.start, p.end) }));
    return { id: f.id, gold: goldSpans, predicted: predSpans };
  });

  const output = {
    schema_version: '1.0' as const,
    generator: 'lucairn-research/scripts/run-itsm-baseline.ts',
    bracket: 'S5-BASELINE (pre-Slice-3, current L1+L2 sanitizer code)',
    prd: 'Opus Advisor/specs/prd-2026-07-04-redaction-quality-overhaul.md',
    probe_meta: probeOutput.meta,
    unresolved_spans: probeOutput.unresolvedSpans,
    score_summary: summary,
    per_fixture: perFixture,
  };

  writeFileSync(args.output, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote baseline SUMMARY to ${args.output}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
