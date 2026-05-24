/**
 * build-figures.ts
 *
 * Generates the SVG bar charts + pipeline diagram referenced by the README:
 *
 *   docs/figures/paper1-recall-per-category.svg
 *   docs/figures/paper2-recall-per-category.svg
 *   docs/figures/paper1-vs-paper2-precision-recall.svg
 *   docs/figures/methodology-pipeline.svg
 *
 * Data sources (input):
 *   - Paper 1: `papers/paper-1-healthcare/raw-results/paper1-AFTER-500row-20260522T080037Z.ndjson`
 *     The harness-emitted per-row NDJSON. Each row carries the gateway's
 *     `evaluation` block (per-category `matches[]` + `missed[]` with HIPAA
 *     `annotation_type` values). We tally TP / FN by `annotation_type` ==
 *     HIPAA Safe Harbor category. No ground-truth.jsonl is needed because
 *     the gateway already performed the value-containment match server-side
 *     (the same arm's-length property documented in `src/recall.ts:13-15`).
 *   - Paper 2: `papers/paper-2-finance/SUMMARY-tuned.json`
 *     Already aggregated by `pnpm run analyze:finance`.
 *
 * Determinism:
 *   Identical inputs produce byte-identical outputs. There are NO timestamps,
 *   PRNGs, locale-dependent number formats, or file-mtime reads in the
 *   rendered SVG. The "Source: …" footnote uses a fixed `SOURCE_LABEL`
 *   constant per figure.
 *
 * Re-run:
 *   pnpm run build-figures
 *
 * Adding a new figure: add a `renderFooN()` returning an SVG string, then
 * push a new entry into the `figures` array at the bottom of `main()`. Keep
 * the output ≤50KB per file so git diffs stay readable.
 *
 * No new package dependencies: the SVGs are built from typed template
 * literals.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

const PAPER1_NDJSON =
  'papers/paper-1-healthcare/raw-results/paper1-AFTER-500row-20260522T080037Z.ndjson';
const PAPER2_SUMMARY = 'papers/paper-2-finance/SUMMARY-tuned.json';

const OUT_DIR = 'docs/figures';

/** Recall threshold (%) above which a category is rendered green; below = orange.
 *  Documented in each figure footnote so it is not a magic number. */
const RECALL_THRESHOLD_PCT = 90;

/** Fixed source label, baked into figures. Used for the "Source: …" footnote. */
const SOURCE_LABEL_P1 =
  'Source: paper-1-healthcare/raw-results/paper1-AFTER-500row-20260522T080037Z.ndjson';
const SOURCE_LABEL_P2 = 'Source: paper-2-finance/SUMMARY-tuned.json (tuned run)';
const SOURCE_LABEL_PIPELINE = 'Architecture diagram — Lucairn dual-sandbox pipeline';

// --------------------------------------------------------------------------
// HIPAA + GLBA enumerations (locked taxonomies — see src/*-category-mapping.ts)
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Per-row evaluation aggregation (Paper 1)
// --------------------------------------------------------------------------

interface PerCategory {
  readonly category: string;
  readonly tp: number;
  readonly fn: number;
  /** Recall as a percentage 0–100, or null if (tp+fn) == 0 (category absent). */
  readonly recallPct: number | null;
  /** Optional precision percentage 0–100, when the source exposes FP attribution. */
  readonly precisionPct?: number | null;
}

interface PaperAggregate {
  readonly perCategory: readonly PerCategory[];
  readonly overall: {
    readonly tp: number;
    readonly fn: number;
    readonly fp: number;
    readonly recallPct: number;
  };
}

interface RawEvaluationMatch {
  annotation_type?: unknown;
}
interface RawEvaluationMissed {
  type?: unknown;
}
interface RawEvaluation {
  true_positives?: unknown;
  false_negatives?: unknown;
  false_positives?: unknown;
  matches?: unknown;
  missed?: unknown;
}
interface RawRow {
  row_index?: unknown;
  result?: { evaluation?: RawEvaluation | null } | null;
}

async function aggregatePaper1(path: string): Promise<PaperAggregate> {
  const text = await readFile(path, 'utf8');
  const tp: Record<HipaaCategory, number> = Object.fromEntries(
    HIPAA_CATEGORIES.map((c) => [c, 0]),
  ) as Record<HipaaCategory, number>;
  const fn: Record<HipaaCategory, number> = Object.fromEntries(
    HIPAA_CATEGORIES.map((c) => [c, 0]),
  ) as Record<HipaaCategory, number>;
  let totalTp = 0;
  let totalFn = 0;
  let totalFp = 0;

  let lineNo = 0;
  for (const ln of text.split('\n')) {
    lineNo += 1;
    const trimmed = ln.trim();
    if (trimmed === '') continue;
    let parsed: RawRow;
    try {
      parsed = JSON.parse(trimmed) as RawRow;
    } catch (err) {
      process.stderr.write(
        `[build-figures] paper-1 line ${lineNo} skipped (not JSON): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      continue;
    }
    const ev = parsed.result?.evaluation;
    if (ev === null || ev === undefined) continue;
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

  const perCategory: PerCategory[] = HIPAA_CATEGORIES.map((cat) => {
    const t = tp[cat];
    const f = fn[cat];
    const n = t + f;
    const recallPct = n === 0 ? null : (t / n) * 100;
    return { category: cat, tp: t, fn: f, recallPct };
  });

  const overallRecallPct = totalTp + totalFn === 0 ? 0 : (totalTp / (totalTp + totalFn)) * 100;

  return {
    perCategory,
    overall: { tp: totalTp, fn: totalFn, fp: totalFp, recallPct: overallRecallPct },
  };
}

// --------------------------------------------------------------------------
// Paper 2: SUMMARY-tuned.json (already aggregated)
// --------------------------------------------------------------------------

interface Paper2SummaryEntry {
  category: string;
  counts: { tp: number; fn: number; fp_attributed?: number };
  recall: number | null;
  precision: number | null;
}
interface Paper2Summary {
  aggregate: {
    tp_total: number;
    fn_total: number;
    fp_total: number;
    recall: number;
    precision: number;
    f1: number;
  };
  per_category: Paper2SummaryEntry[];
}

async function loadPaper2(path: string): Promise<PaperAggregate> {
  const text = await readFile(path, 'utf8');
  const summary = JSON.parse(text) as Paper2Summary;
  const perCategory: PerCategory[] = summary.per_category
    // The UNMAPPED bucket is bookkeeping, not a published GLBA NPI category.
    // Drop it from the bar chart but keep it represented in the overall counts
    // (which already include its FPs via aggregate.fp_total).
    .filter((e) => e.category !== 'UNMAPPED')
    .map((e) => ({
      category: e.category,
      tp: e.counts.tp,
      fn: e.counts.fn,
      recallPct: e.recall,
      precisionPct: e.precision,
    }));
  return {
    perCategory,
    overall: {
      tp: summary.aggregate.tp_total,
      fn: summary.aggregate.fn_total,
      fp: summary.aggregate.fp_total,
      recallPct: summary.aggregate.recall,
    },
  };
}

// --------------------------------------------------------------------------
// SVG primitives
// --------------------------------------------------------------------------

/** Color palette — neutral grays + 2 accent colors, dark-mode-friendly via
 *  a tiny embedded `<style>` block using `prefers-color-scheme`. */
const COLOR = {
  bg: '#ffffff',
  bgDark: '#0d1117',
  axis: '#57606a',
  axisDark: '#9da7b1',
  text: '#1f2328',
  textDark: '#e6edf3',
  grid: '#d0d7de',
  gridDark: '#30363d',
  green: '#2da44e', // recall ≥ threshold
  orange: '#bf8700', // recall < threshold
  blue: '#0969da', // Paper 1 in comparison chart
  purple: '#8250df', // Paper 2 in comparison chart
} as const;

function svgHeader(width: number, height: number, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `role="img" aria-labelledby="title">` +
    `<title id="title">${escapeXml(title)}</title>` +
    `<style>` +
    `.bg{fill:${COLOR.bg}}` +
    `.axis{stroke:${COLOR.axis};fill:${COLOR.axis}}` +
    `.text{fill:${COLOR.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}` +
    `.grid{stroke:${COLOR.grid}}` +
    `@media (prefers-color-scheme: dark){` +
    `.bg{fill:${COLOR.bgDark}}` +
    `.axis{stroke:${COLOR.axisDark};fill:${COLOR.axisDark}}` +
    `.text{fill:${COLOR.textDark}}` +
    `.grid{stroke:${COLOR.gridDark}}` +
    `}` +
    `</style>` +
    `<rect class="bg" width="${width}" height="${height}"/>`
  );
}

function svgFooter(): string {
  return `</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 2-decimal fixed format (no locale dependency). */
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

// --------------------------------------------------------------------------
// Horizontal bar chart (used for both Paper 1 and Paper 2 per-category figs)
// --------------------------------------------------------------------------

interface BarChartOpts {
  title: string;
  subtitle: string;
  rows: readonly PerCategory[];
  /** Source label rendered at the bottom of the figure. */
  source: string;
  /** Note rendered below the source label, e.g. legend interpretation. */
  note: string;
}

function renderHorizontalBarChart(opts: BarChartOpts): string {
  const WIDTH = 760;
  const ROW_H = 26;
  const TOP = 70; // space for title + subtitle
  const LEFT_LABELS = 200;
  const RIGHT_PAD = 70; // for the recall % text + headroom
  const BOTTOM = 70; // for x-axis labels + source line + note line
  const BAR_AREA = WIDTH - LEFT_LABELS - RIGHT_PAD;
  const HEIGHT = TOP + opts.rows.length * ROW_H + BOTTOM;

  const parts: string[] = [svgHeader(WIDTH, HEIGHT, opts.title)];

  // Title + subtitle
  parts.push(
    `<text class="text" x="20" y="30" font-size="18" font-weight="600">${escapeXml(opts.title)}</text>`,
    `<text class="text" x="20" y="52" font-size="12">${escapeXml(opts.subtitle)}</text>`,
  );

  // X-axis gridlines at 0/25/50/75/100
  const xAt = (pct: number): number => LEFT_LABELS + (pct / 100) * BAR_AREA;
  for (const tick of [0, 25, 50, 75, 100]) {
    const x = xAt(tick);
    parts.push(
      `<line class="grid" x1="${x}" y1="${TOP}" x2="${x}" y2="${TOP + opts.rows.length * ROW_H}" stroke-width="1"/>`,
    );
    parts.push(
      `<text class="text" x="${x}" y="${TOP + opts.rows.length * ROW_H + 18}" font-size="11" text-anchor="middle">${tick}%</text>`,
    );
  }

  // Rows
  for (let i = 0; i < opts.rows.length; i++) {
    const row = opts.rows[i];
    if (row === undefined) continue;
    const yCenter = TOP + i * ROW_H + ROW_H / 2;
    const yTop = TOP + i * ROW_H + 4;
    const yBar = yTop + 2;
    const barH = ROW_H - 10;

    // Category label
    parts.push(
      `<text class="text" x="${LEFT_LABELS - 10}" y="${yCenter + 4}" font-size="11" text-anchor="end">${escapeXml(row.category)}</text>`,
    );

    if (row.recallPct === null) {
      // Category absent in this paper's dataset — show a faint placeholder
      parts.push(
        `<text class="text" x="${LEFT_LABELS + 6}" y="${yCenter + 4}" font-size="11" opacity="0.5">no data (category absent)</text>`,
      );
      continue;
    }

    const pct = row.recallPct;
    const color = pct >= RECALL_THRESHOLD_PCT ? COLOR.green : COLOR.orange;
    const w = (pct / 100) * BAR_AREA;
    parts.push(
      `<rect x="${LEFT_LABELS}" y="${yBar}" width="${w.toFixed(2)}" height="${barH}" fill="${color}" rx="2"/>`,
    );
    // Recall % text to the right of the bar
    parts.push(
      `<text class="text" x="${LEFT_LABELS + w + 6}" y="${yCenter + 4}" font-size="11">${fmtPct(pct)} (n=${row.tp + row.fn})</text>`,
    );
  }

  // X-axis label
  parts.push(
    `<text class="text" x="${LEFT_LABELS + BAR_AREA / 2}" y="${TOP + opts.rows.length * ROW_H + 36}" font-size="11" text-anchor="middle">Recall (true positives ÷ ground truth, %)</text>`,
  );

  // Legend — green vs orange swatch
  const legendY = HEIGHT - 38;
  parts.push(
    `<rect x="20" y="${legendY - 9}" width="12" height="12" fill="${COLOR.green}" rx="2"/>`,
    `<text class="text" x="38" y="${legendY}" font-size="11">≥ ${RECALL_THRESHOLD_PCT}% recall</text>`,
    `<rect x="160" y="${legendY - 9}" width="12" height="12" fill="${COLOR.orange}" rx="2"/>`,
    `<text class="text" x="178" y="${legendY}" font-size="11">&lt; ${RECALL_THRESHOLD_PCT}% recall</text>`,
  );

  // Footnote
  parts.push(
    `<text class="text" x="20" y="${HEIGHT - 18}" font-size="10" opacity="0.75">${escapeXml(opts.source)}</text>`,
    `<text class="text" x="20" y="${HEIGHT - 6}" font-size="10" opacity="0.75">${escapeXml(opts.note)}</text>`,
  );

  parts.push(svgFooter());
  return parts.join('');
}

// --------------------------------------------------------------------------
// Comparison chart: Paper 1 vs Paper 2 shared categories (grouped bars)
// --------------------------------------------------------------------------

/** Shared categories — names normalized to a display label. The Paper 1
 *  HIPAA name comes first, then the Paper 2 GLBA equivalent. We render
 *  only categories whose name is identical OR semantically identical across
 *  both papers; everything else is left to the per-paper figures. */
const SHARED_CATEGORIES: ReadonlyArray<{
  display: string;
  hipaa: HipaaCategory;
  glba: string;
}> = [
  { display: 'NAME', hipaa: 'NAME', glba: 'FULL_NAME' },
  { display: 'EMAIL', hipaa: 'EMAIL', glba: 'EMAIL' },
  { display: 'PHONE', hipaa: 'PHONE', glba: 'PHONE' },
  { display: 'SSN', hipaa: 'SSN', glba: 'SSN' },
  { display: 'DATE / DOB', hipaa: 'DATE', glba: 'DOB' },
  { display: 'ADDRESS', hipaa: 'GEO_SUBDIVISION', glba: 'RESIDENTIAL_ADDRESS' },
];

function renderComparisonChart(p1: PaperAggregate, p2: PaperAggregate): string {
  const WIDTH = 760;
  const TOP = 70;
  const GROUP_H = 60; // 2 bars per group + gap
  const LEFT_LABELS = 160;
  const RIGHT_PAD = 60;
  const BOTTOM = 70;
  const BAR_AREA = WIDTH - LEFT_LABELS - RIGHT_PAD;
  const HEIGHT = TOP + SHARED_CATEGORIES.length * GROUP_H + BOTTOM;
  const xAt = (pct: number): number => LEFT_LABELS + (pct / 100) * BAR_AREA;

  const parts: string[] = [svgHeader(WIDTH, HEIGHT, 'Paper 1 vs Paper 2 — shared categories')];
  parts.push(
    `<text class="text" x="20" y="30" font-size="18" font-weight="600">Paper 1 vs Paper 2 — shared categories</text>`,
    `<text class="text" x="20" y="52" font-size="12">Recall on categories present in both HIPAA Safe Harbor and the GLBA NPI enumeration.</text>`,
  );

  // Gridlines
  for (const tick of [0, 25, 50, 75, 100]) {
    const x = xAt(tick);
    parts.push(
      `<line class="grid" x1="${x}" y1="${TOP}" x2="${x}" y2="${TOP + SHARED_CATEGORIES.length * GROUP_H}" stroke-width="1"/>`,
    );
    parts.push(
      `<text class="text" x="${x}" y="${TOP + SHARED_CATEGORIES.length * GROUP_H + 18}" font-size="11" text-anchor="middle">${tick}%</text>`,
    );
  }

  const p1Map = new Map<string, PerCategory>(p1.perCategory.map((r) => [r.category, r]));
  const p2Map = new Map<string, PerCategory>(p2.perCategory.map((r) => [r.category, r]));

  for (let i = 0; i < SHARED_CATEGORIES.length; i++) {
    const slot = SHARED_CATEGORIES[i];
    if (slot === undefined) continue;
    const groupTop = TOP + i * GROUP_H;
    parts.push(
      `<text class="text" x="${LEFT_LABELS - 10}" y="${groupTop + GROUP_H / 2 + 4}" font-size="12" font-weight="600" text-anchor="end">${escapeXml(slot.display)}</text>`,
    );

    const p1Row = p1Map.get(slot.hipaa);
    const p2Row = p2Map.get(slot.glba);
    const bars: Array<{ y: number; pct: number | null | undefined; label: string; color: string }> = [
      { y: groupTop + 8, pct: p1Row?.recallPct, label: 'Paper 1', color: COLOR.blue },
      { y: groupTop + 30, pct: p2Row?.recallPct, label: 'Paper 2', color: COLOR.purple },
    ];
    for (const b of bars) {
      if (b.pct === null || b.pct === undefined) continue;
      const w = (b.pct / 100) * BAR_AREA;
      parts.push(
        `<rect x="${LEFT_LABELS}" y="${b.y}" width="${w.toFixed(2)}" height="18" fill="${b.color}" rx="2"/>`,
        `<text class="text" x="${LEFT_LABELS + w + 6}" y="${b.y + 13}" font-size="11">${b.label}: ${fmtPct(b.pct)}</text>`,
      );
    }
  }

  parts.push(
    `<text class="text" x="${LEFT_LABELS + BAR_AREA / 2}" y="${TOP + SHARED_CATEGORIES.length * GROUP_H + 36}" font-size="11" text-anchor="middle">Recall (true positives ÷ ground truth, %)</text>`,
  );

  // Legend
  const legendY = HEIGHT - 38;
  parts.push(
    `<rect x="20" y="${legendY - 9}" width="12" height="12" fill="${COLOR.blue}" rx="2"/>`,
    `<text class="text" x="38" y="${legendY}" font-size="11">Paper 1 (HIPAA Safe Harbor, MTSamples)</text>`,
    `<rect x="320" y="${legendY - 9}" width="12" height="12" fill="${COLOR.purple}" rx="2"/>`,
    `<text class="text" x="338" y="${legendY}" font-size="11">Paper 2 (GLBA NPI, CFPB tuned run)</text>`,
  );

  parts.push(
    `<text class="text" x="20" y="${HEIGHT - 18}" font-size="10" opacity="0.75">Source: ${escapeXml(SOURCE_LABEL_P1)} + ${escapeXml(SOURCE_LABEL_P2)}</text>`,
    `<text class="text" x="20" y="${HEIGHT - 6}" font-size="10" opacity="0.75">"Date / DOB": HIPAA DATE includes any clinical date; GLBA DOB is date-of-birth only. ADDRESS: HIPAA GEO_SUBDIVISION vs GLBA RESIDENTIAL_ADDRESS.</text>`,
  );

  parts.push(svgFooter());
  return parts.join('');
}

// --------------------------------------------------------------------------
// Pipeline diagram: L1 → L2 → L3 → L4 + signed claim emission
// --------------------------------------------------------------------------

function renderPipelineDiagram(): string {
  const WIDTH = 760;
  const HEIGHT = 320;
  const BOX_W = 130;
  const BOX_H = 70;
  const Y = 110;
  const GAP = 25;
  // Boxes laid out horizontally; arrows between them.
  const boxes: Array<{ x: number; title: string; sub: string; stage: 'sanitize' | 'adversarial' | 'output' }> = [
    { x: 20, title: 'L1', sub: 'Regex', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 1, title: 'L2', sub: 'Deny-list', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 2, title: 'L3', sub: 'PII Shield (Qwen)', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 3, title: 'L4', sub: 'reid-guard', stage: 'adversarial' },
    { x: 20 + (BOX_W + GAP) * 4, title: 'Signed claim', sub: 'witness-emitted', stage: 'output' },
  ];

  const parts: string[] = [svgHeader(WIDTH, HEIGHT, 'Lucairn sanitization + adversarial-test pipeline')];

  parts.push(
    `<text class="text" x="20" y="30" font-size="18" font-weight="600">Lucairn sanitization + adversarial-test pipeline</text>`,
    `<text class="text" x="20" y="52" font-size="12">Customer text flows L1 → L4. L1-L3 sanitize; L4 is an adversarial re-identification scorer.</text>`,
  );

  // Group brackets
  const sanitizeStart = boxes[0]?.x ?? 0;
  const sanitizeEnd = (boxes[2]?.x ?? 0) + BOX_W;
  parts.push(
    `<rect x="${sanitizeStart - 6}" y="${Y - 26}" width="${sanitizeEnd - sanitizeStart + 12}" height="${BOX_H + 36}" fill="none" stroke="${COLOR.grid}" stroke-dasharray="3,2" rx="6"/>`,
    `<text class="text" x="${(sanitizeStart + sanitizeEnd) / 2}" y="${Y - 12}" font-size="11" text-anchor="middle" opacity="0.7">sanitization layers</text>`,
  );
  const advX = boxes[3]?.x ?? 0;
  parts.push(
    `<rect x="${advX - 6}" y="${Y - 26}" width="${BOX_W + 12}" height="${BOX_H + 36}" fill="none" stroke="${COLOR.grid}" stroke-dasharray="3,2" rx="6"/>`,
    `<text class="text" x="${advX + BOX_W / 2}" y="${Y - 12}" font-size="11" text-anchor="middle" opacity="0.7">adversarial test</text>`,
  );

  // Customer doc label (input)
  parts.push(
    `<text class="text" x="${sanitizeStart - 6}" y="${Y + BOX_H + 36}" font-size="10" opacity="0.7">in: customer doc</text>`,
    `<text class="text" x="${(boxes[4]?.x ?? 0) + BOX_W}" y="${Y + BOX_H + 36}" font-size="10" text-anchor="end" opacity="0.7">out: signed claim → customer</text>`,
  );

  // Boxes
  for (const b of boxes) {
    const fill =
      b.stage === 'sanitize' ? COLOR.blue : b.stage === 'adversarial' ? COLOR.purple : COLOR.green;
    parts.push(
      `<rect x="${b.x}" y="${Y}" width="${BOX_W}" height="${BOX_H}" fill="${fill}" rx="6"/>`,
      `<text x="${b.x + BOX_W / 2}" y="${Y + 28}" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(b.title)}</text>`,
      `<text x="${b.x + BOX_W / 2}" y="${Y + 50}" font-size="11" fill="#ffffff" text-anchor="middle">${escapeXml(b.sub)}</text>`,
    );
  }

  // Arrows
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i];
    const b = boxes[i + 1];
    if (a === undefined || b === undefined) continue;
    const x1 = a.x + BOX_W;
    const x2 = b.x;
    const y = Y + BOX_H / 2;
    parts.push(
      `<line class="axis" x1="${x1}" y1="${y}" x2="${x2 - 6}" y2="${y}" stroke-width="2"/>`,
      `<polygon class="axis" points="${x2 - 6},${y - 4} ${x2},${y} ${x2 - 6},${y + 4}"/>`,
    );
  }

  parts.push(
    `<text class="text" x="20" y="${HEIGHT - 18}" font-size="10" opacity="0.75">${escapeXml(SOURCE_LABEL_PIPELINE)}</text>`,
    `<text class="text" x="20" y="${HEIGHT - 6}" font-size="10" opacity="0.75">L1-L3 redact PII before any LLM call; L4 runs an attacker-LLM (Llama-3.1-8B) over the sanitized output + an aux corpus to score residual re-identification risk.</text>`,
  );

  parts.push(svgFooter());
  return parts.join('');
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  // Resolve everything relative to the repository root (the script's grandparent dir).
  const here = new URL('.', import.meta.url).pathname;
  const root = resolve(here, '..');

  process.stdout.write(`[build-figures] root=${root}\n`);

  const p1 = await aggregatePaper1(resolve(root, PAPER1_NDJSON));
  process.stdout.write(
    `[build-figures] paper-1 aggregated: overall tp=${p1.overall.tp} fn=${p1.overall.fn} fp=${p1.overall.fp} recall=${p1.overall.recallPct.toFixed(2)}%\n`,
  );
  const p2 = await loadPaper2(resolve(root, PAPER2_SUMMARY));
  process.stdout.write(
    `[build-figures] paper-2 loaded:     overall tp=${p2.overall.tp} fn=${p2.overall.fn} fp=${p2.overall.fp} recall=${p2.overall.recallPct.toFixed(2)}%\n`,
  );

  const figures: Array<{ path: string; content: string }> = [
    {
      path: 'paper1-recall-per-category.svg',
      content: renderHorizontalBarChart({
        title: 'Paper 1 — HIPAA Safe Harbor per-category recall',
        subtitle: 'MTSamples (CC0) + synthetic PII injection at i2b2 density, 500-row Measurement B subset, tuned sanitizer.',
        rows: p1.perCategory,
        source: SOURCE_LABEL_P1,
        note: `Green: recall ≥ ${RECALL_THRESHOLD_PCT}%. Orange: recall < ${RECALL_THRESHOLD_PCT}%. n = ground-truth annotations in this category.`,
      }),
    },
    {
      path: 'paper2-recall-per-category.svg',
      content: renderHorizontalBarChart({
        title: 'Paper 2 — GLBA NPI per-category recall',
        subtitle: 'CFPB Consumer Complaint Database (US public domain) + synthetic NPI injection, 500-row Measurement B subset, tuned sanitizer.',
        rows: p2.perCategory,
        source: SOURCE_LABEL_P2,
        note: `Green: recall ≥ ${RECALL_THRESHOLD_PCT}%. Orange: recall < ${RECALL_THRESHOLD_PCT}%. n = ground-truth annotations in this category.`,
      }),
    },
    {
      path: 'paper1-vs-paper2-precision-recall.svg',
      content: renderComparisonChart(p1, p2),
    },
    {
      path: 'methodology-pipeline.svg',
      content: renderPipelineDiagram(),
    },
  ];

  const outDirAbs = resolve(root, OUT_DIR);
  await mkdir(outDirAbs, { recursive: true });
  for (const f of figures) {
    const full = resolve(outDirAbs, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, 'utf8');
    process.stdout.write(`[build-figures] wrote ${OUT_DIR}/${f.path} (${f.content.length} bytes)\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[build-figures] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
