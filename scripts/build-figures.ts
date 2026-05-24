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
 *   - Paper 1: papers/paper-1-healthcare/SUMMARY-tuned.json
 *     Pre-aggregated per-category recall numbers. Produced by
 *     scripts/aggregate-paper1-summary.ts from the harness NDJSON. The raw
 *     NDJSON itself is gitignored (per the repo convention "only summaries
 *     are checked in"); the summary JSON is small and stable, so it lives in
 *     git and feeds reproducible figure regeneration from a fresh clone.
 *   - Paper 2: papers/paper-2-finance/SUMMARY-tuned.json
 *     Already aggregated by pnpm run analyze:finance.
 *
 * Determinism:
 *   Identical inputs produce byte-identical outputs. There are NO timestamps,
 *   PRNGs, locale-dependent number formats, or file-mtime reads in the
 *   rendered SVG. The "Source: ..." footnote uses a fixed SOURCE_LABEL
 *   constant per figure.
 *
 * Failure modes:
 *   - Input files missing or malformed JSON: throws with a descriptive error
 *     including the failing path. Published benchmark figures must NEVER be
 *     generated from a silently-truncated or partial input; the malformed-row
 *     hard-fail is enforced upstream in aggregate-paper1-summary.ts as well.
 *
 * Re-run:
 *   pnpm run build-figures
 *
 * Adding a new figure: add a renderFooN() returning an SVG string, then
 * push a new entry into the figures array at the bottom of main(). Keep the
 * output below 50KB per file so git diffs stay readable.
 *
 * No new package dependencies: the SVGs are built from typed template
 * literals.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

const PAPER1_SUMMARY = 'papers/paper-1-healthcare/SUMMARY-tuned.json';
const PAPER2_SUMMARY = 'papers/paper-2-finance/SUMMARY-tuned.json';

const OUT_DIR = 'docs/figures';

/** Recall threshold (%) above which a category is rendered green; below = orange.
 *  Documented in each figure footnote so it is not a magic number. */
const RECALL_THRESHOLD_PCT = 90;

/** Fixed source labels, baked into figures. The "Source:" prefix is added by
 *  the renderer (renderHorizontalBarChart) so these constants do not include
 *  it themselves — that avoids a "Source: Source: ..." double-prefix in the
 *  cross-paper comparison chart, which prepends its own "Source:". */
const SOURCE_LABEL_P1 = 'papers/paper-1-healthcare/SUMMARY-tuned.json (tuned run, 500 rows)';
const SOURCE_LABEL_P2 = 'papers/paper-2-finance/SUMMARY-tuned.json (tuned run, 500 rows)';
const SOURCE_LABEL_PIPELINE = 'Architecture diagram — Lucairn dual-sandbox pipeline';

/** Long descriptions for each figure. Rendered into the SVG as a <desc>
 *  element and referenced via aria-describedby on the root <svg> so screen
 *  readers pick them up. These complement the shorter <title> element. */
const FIGURE_DESCRIPTIONS = {
  paper1:
    'Horizontal bar chart of HIPAA Safe Harbor per-category recall on the Paper 1 healthcare dataset (MTSamples, 500-row tuned-sanitizer run). Each bar shows recall as a percentage with the ground-truth annotation count; bars are colored green at or above 90 percent recall and orange below 90 percent.',
  paper2:
    'Horizontal bar chart of GLBA NPI per-category recall on the Paper 2 finance dataset (CFPB Consumer Complaint Database, 500-row tuned-sanitizer run). Each bar shows recall as a percentage with the ground-truth annotation count; bars are colored green at or above 90 percent recall and orange below 90 percent.',
  comparison:
    'Grouped horizontal bar chart comparing Paper 1 (HIPAA Safe Harbor, MTSamples, blue) and Paper 2 (GLBA NPI, CFPB, purple) recall on the six PII categories that appear in both enumerations: NAME / FULL_NAME, EMAIL, PHONE, SSN, DATE / DOB, and ADDRESS.',
  pipeline:
    'Architecture diagram of the Lucairn sanitization plus adversarial-test pipeline. Customer text flows left-to-right through five boxes: L1 known-entity matching, L2 Presidio NER, L3 PII Shield (Qwen 2.5 7B), L4 reid-guard adversarial scorer (Llama-3.1-8B), and a final witness-emitted signed claim. L1 through L3 are grouped as the sanitization stage; L4 is grouped as the adversarial test stage. A post-detection deny-list / safelist filter is applied across L1 and L2 to suppress false positives but is not itself a layer.',
} as const;

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
// Shared aggregate shape
// --------------------------------------------------------------------------

interface PerCategory {
  readonly category: string;
  readonly tp: number;
  readonly fn: number;
  /** Recall as a percentage 0-100, or null if (tp+fn) == 0 (category absent). */
  readonly recallPct: number | null;
  /** Optional precision percentage 0-100, when the source exposes FP attribution. */
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

// --------------------------------------------------------------------------
// Paper 1: SUMMARY-tuned.json (pre-aggregated by aggregate-paper1-summary.ts)
// --------------------------------------------------------------------------

interface Paper1SummaryEntry {
  category: string;
  counts: { tp: number; fn: number };
  recall: number | null;
}
interface Paper1Summary {
  aggregate: { tp_total: number; fn_total: number; fp_total: number; recall: number };
  per_category: Paper1SummaryEntry[];
}

async function loadPaper1(path: string): Promise<PaperAggregate> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `build-figures: failed to read Paper 1 summary '${path}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let summary: Paper1Summary;
  try {
    summary = JSON.parse(text) as Paper1Summary;
  } catch (err) {
    throw new Error(
      `build-figures: malformed JSON in '${path}': ${
        err instanceof Error ? err.message : String(err)
      }. Regenerate with: pnpm aggregate:paper1`,
    );
  }
  // Build a map of provided categories so the chart row order matches the
  // canonical HIPAA enumeration regardless of input order, and any missing
  // category falls through to a "no data" row.
  const byCat = new Map<string, Paper1SummaryEntry>(
    summary.per_category.map((e) => [e.category, e]),
  );
  const perCategory: PerCategory[] = HIPAA_CATEGORIES.map((cat) => {
    const e = byCat.get(cat);
    if (e === undefined) {
      return { category: cat, tp: 0, fn: 0, recallPct: null };
    }
    return {
      category: cat,
      tp: e.counts.tp,
      fn: e.counts.fn,
      recallPct: e.recall,
    };
  });
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
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `build-figures: failed to read Paper 2 summary '${path}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let summary: Paper2Summary;
  try {
    summary = JSON.parse(text) as Paper2Summary;
  } catch (err) {
    throw new Error(
      `build-figures: malformed JSON in '${path}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
 *  a tiny embedded <style> block using prefers-color-scheme. */
const COLOR = {
  bg: '#ffffff',
  bgDark: '#0d1117',
  axis: '#57606a',
  axisDark: '#9da7b1',
  text: '#1f2328',
  textDark: '#e6edf3',
  grid: '#d0d7de',
  gridDark: '#30363d',
  green: '#2da44e', // recall >= threshold
  orange: '#bf8700', // recall < threshold
  blue: '#0969da', // Paper 1 in comparison chart
  purple: '#8250df', // Paper 2 in comparison chart
} as const;

function svgHeader(width: number, height: number, title: string, description: string): string {
  // Use stable, figure-local element ids so multiple SVGs can be embedded on
  // one page without an id collision. The ids are namespaced by the figure
  // width+height because all four figures have distinct dimensions.
  const titleId = `title-${width}x${height}`;
  const descId = `desc-${width}x${height}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `role="img" aria-labelledby="${titleId}" aria-describedby="${descId}">` +
    `<title id="${titleId}">${escapeXml(title)}</title>` +
    `<desc id="${descId}">${escapeXml(description)}</desc>` +
    `<style>` +
    `.bg{fill:${COLOR.bg}}` +
    `.axis{stroke:${COLOR.axis};fill:${COLOR.axis}}` +
    `.text{fill:${COLOR.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}` +
    `.grid{stroke:${COLOR.grid}}` +
    `.groupBracket{stroke:${COLOR.grid};fill:none}` +
    `@media (prefers-color-scheme: dark){` +
    `.bg{fill:${COLOR.bgDark}}` +
    `.axis{stroke:${COLOR.axisDark};fill:${COLOR.axisDark}}` +
    `.text{fill:${COLOR.textDark}}` +
    `.grid{stroke:${COLOR.gridDark}}` +
    `.groupBracket{stroke:${COLOR.gridDark}}` +
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

/** 1-decimal fixed format (no locale dependency). */
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

// --------------------------------------------------------------------------
// Horizontal bar chart (used for both Paper 1 and Paper 2 per-category figs)
// --------------------------------------------------------------------------

interface BarChartOpts {
  title: string;
  subtitle: string;
  description: string;
  rows: readonly PerCategory[];
  /** Source label rendered at the bottom of the figure (without the "Source:"
   *  prefix — the renderer adds it). */
  source: string;
  /** Note rendered below the source label, e.g. legend interpretation. */
  note: string;
}

function renderHorizontalBarChart(opts: BarChartOpts): string {
  // WIDTH bumped 760 -> 880 (Codex r2): the right-side per-row label
  //   "<recall%>% (n=NNNN)" is appended at x = LEFT_LABELS + barWidth + 6.
  //   At 100% recall + a 4-digit n, that string is ~95px wide; with the
  //   previous WIDTH=760 + RIGHT_PAD=70 the label overran the viewBox by
  //   ~25-40px and was clipped on the right edge in Paper 1, Paper 2, and
  //   the comparison chart. The 880px viewBox gives the longest label
  //   (~"100.0% (n=8916)") comfortable headroom inside RIGHT_PAD without
  //   shrinking BAR_AREA or changing column proportions.
  const WIDTH = 880;
  const ROW_H = 26;
  const TOP = 70; // space for title + subtitle
  const LEFT_LABELS = 200;
  const RIGHT_PAD = 130; // for the recall % text (~95px at 100% + 4-digit n) + headroom
  const BOTTOM = 70; // for x-axis labels + source line + note line
  const BAR_AREA = WIDTH - LEFT_LABELS - RIGHT_PAD;
  const HEIGHT = TOP + opts.rows.length * ROW_H + BOTTOM;

  const parts: string[] = [svgHeader(WIDTH, HEIGHT, opts.title, opts.description)];

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
    `<text class="text" x="20" y="${HEIGHT - 18}" font-size="10" opacity="0.75">Source: ${escapeXml(opts.source)}</text>`,
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
  // WIDTH bumped 760 -> 880 (Codex r2): "Paper 1: 100.0%" / "Paper 2: 100.0%"
  //   right-side labels overran the viewBox at 100% recall under the previous
  //   760+RIGHT_PAD=60 budget. Also the source footer concatenates two long
  //   SOURCE_LABEL_* strings on one line and was clipping on the right edge.
  //   880 + RIGHT_PAD=120 keeps the right-side labels inside the viewBox at
  //   every recall value AND fits the concatenated source-line footer.
  const WIDTH = 880;
  const TOP = 70;
  const GROUP_H = 60; // 2 bars per group + gap
  const LEFT_LABELS = 160;
  const RIGHT_PAD = 120;
  const BOTTOM = 70;
  const BAR_AREA = WIDTH - LEFT_LABELS - RIGHT_PAD;
  const HEIGHT = TOP + SHARED_CATEGORIES.length * GROUP_H + BOTTOM;
  const xAt = (pct: number): number => LEFT_LABELS + (pct / 100) * BAR_AREA;

  const parts: string[] = [
    svgHeader(
      WIDTH,
      HEIGHT,
      'Paper 1 vs Paper 2 — shared categories',
      FIGURE_DESCRIPTIONS.comparison,
    ),
  ];
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
// Pipeline diagram: L1 -> L2 -> L3 -> L4 + signed claim emission
// --------------------------------------------------------------------------

function renderPipelineDiagram(): string {
  // WIDTH bumped 760 -> 800 (Codex r2): the rightmost box ("Signed claim",
  //   index 4) sits at x = 20 + (BOX_W + GAP) * 4 = 640 with BOX_W=130, so
  //   it ends at x=770 — 10px past the previous 760px viewBox. The "out:
  //   signed claim → customer" footer text was anchored at x = box5.x + BOX_W
  //   = 770 with text-anchor="end", clipping the same way. 800px gives the
  //   final box a clean 30px right margin while keeping the diagram compact.
  const WIDTH = 800;
  // HEIGHT bumped 320 -> 340 (Codex r2): the footer note text (~270 chars at
  //   font-size 10) overflowed the 800px viewBox on a single line; splitting
  //   it onto two stacked lines adds ~12px of vertical space.
  const HEIGHT = 340;
  const BOX_W = 130;
  const BOX_H = 70;
  const Y = 110;
  const GAP = 25;
  // Layer labels match the canonical sanitizer architecture in
  // dual-sandbox-architecture (services/sanitizer/known_entity.py:155 for L1,
  // services/sanitizer/presidio_scan.py:147 for L2, the LLM-sanitizer design
  // spec for L3, the L4 reid-guard PRD for L4). The deny-list / safelist is a
  // post-detection FP filter applied across L1+L2 — NOT a layer of its own.
  const boxes: Array<{ x: number; title: string; sub: string; stage: 'sanitize' | 'adversarial' | 'output' }> = [
    { x: 20, title: 'L1', sub: 'Known-entity match', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 1, title: 'L2', sub: 'Presidio NER', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 2, title: 'L3', sub: 'PII Shield (Qwen)', stage: 'sanitize' },
    { x: 20 + (BOX_W + GAP) * 3, title: 'L4', sub: 'reid-guard', stage: 'adversarial' },
    { x: 20 + (BOX_W + GAP) * 4, title: 'Signed claim', sub: 'witness-emitted', stage: 'output' },
  ];

  const parts: string[] = [
    svgHeader(
      WIDTH,
      HEIGHT,
      'Lucairn sanitization + adversarial-test pipeline',
      FIGURE_DESCRIPTIONS.pipeline,
    ),
  ];

  parts.push(
    `<text class="text" x="20" y="30" font-size="18" font-weight="600">Lucairn sanitization + adversarial-test pipeline</text>`,
    `<text class="text" x="20" y="52" font-size="12">Customer text flows L1 → L4. L1-L3 sanitize; L4 is an adversarial re-identification scorer.</text>`,
  );

  // Group brackets — class="groupBracket" so the stroke swaps in dark mode.
  const sanitizeStart = boxes[0]?.x ?? 0;
  const sanitizeEnd = (boxes[2]?.x ?? 0) + BOX_W;
  parts.push(
    `<rect class="groupBracket" x="${sanitizeStart - 6}" y="${Y - 26}" width="${sanitizeEnd - sanitizeStart + 12}" height="${BOX_H + 36}" stroke-dasharray="3,2" rx="6"/>`,
    `<text class="text" x="${(sanitizeStart + sanitizeEnd) / 2}" y="${Y - 12}" font-size="11" text-anchor="middle" opacity="0.7">sanitization layers</text>`,
  );
  const advX = boxes[3]?.x ?? 0;
  parts.push(
    `<rect class="groupBracket" x="${advX - 6}" y="${Y - 26}" width="${BOX_W + 12}" height="${BOX_H + 36}" stroke-dasharray="3,2" rx="6"/>`,
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

  // Footer is THREE stacked lines (source label + 2 wrapped note lines) to
  // avoid the previous single-line note that overran the viewBox on the right.
  parts.push(
    `<text class="text" x="20" y="${HEIGHT - 30}" font-size="10" opacity="0.75">${escapeXml(SOURCE_LABEL_PIPELINE)}</text>`,
    `<text class="text" x="20" y="${HEIGHT - 18}" font-size="10" opacity="0.75">Deny-list / safelist is a post-detection FP filter applied across L1+L2, not a layer.</text>`,
    `<text class="text" x="20" y="${HEIGHT - 6}" font-size="10" opacity="0.75">L4 runs an attacker LLM (Llama-3.1-8B) over post-L3 sanitized text + an aux corpus to score residual re-identification risk.</text>`,
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

  const p1 = await loadPaper1(resolve(root, PAPER1_SUMMARY));
  process.stdout.write(
    `[build-figures] paper-1 loaded: overall tp=${p1.overall.tp} fn=${p1.overall.fn} fp=${p1.overall.fp} recall=${p1.overall.recallPct.toFixed(2)}%\n`,
  );
  const p2 = await loadPaper2(resolve(root, PAPER2_SUMMARY));
  process.stdout.write(
    `[build-figures] paper-2 loaded: overall tp=${p2.overall.tp} fn=${p2.overall.fn} fp=${p2.overall.fp} recall=${p2.overall.recallPct.toFixed(2)}%\n`,
  );

  const figures: Array<{ path: string; content: string }> = [
    {
      path: 'paper1-recall-per-category.svg',
      content: renderHorizontalBarChart({
        title: 'Paper 1 — HIPAA Safe Harbor per-category recall',
        subtitle: 'MTSamples (CC0) + synthetic PII injection at i2b2 density, 500-row Measurement B subset, tuned sanitizer.',
        description: FIGURE_DESCRIPTIONS.paper1,
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
        description: FIGURE_DESCRIPTIONS.paper2,
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
