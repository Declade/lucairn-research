/**
 * Public API surface for @lucairn/research methodology code.
 *
 * The repo is not published to npm; consumers run it from a clone. This
 * barrel keeps the script + test imports terse and documents the supported
 * extension points for future research papers.
 */

export {
  HIPAA_CATEGORIES,
  type HipaaCategory,
  type InjectedEntity,
  type InjectedRow,
} from './inject-pii-core.js';

export {
  LUCAIRN_TO_HIPAA,
  parsePlaceholderType,
  placeholderToHipaaCategory,
} from './hipaa-category-mapping.js';

export {
  type GatewayClient,
  type GatewayClientOptions,
  GatewayClientError,
  type GatewayRequestBody,
  type GatewayResponse,
  type GatewayRowInput,
  type GatewayRowResult,
  type GroundTruthEvaluation,
  type GroundTruthExtra,
  type GroundTruthMatch,
  type GroundTruthMiss,
  type ProvingGroundAnnotation,
  type VeilHint,
  extractCertUrls,
  makeGatewayClient,
  readGatewayEnv,
} from './gateway-client.js';

export {
  type ExtractedRedaction,
  type RedactionVerdict,
  extractFromEvaluation,
  unmappedExtraTypes,
} from './redaction-extractor.js';

export {
  type CategoryCounts,
  type OverallCounts,
  type PredictedSpan,
  type RecallSummary,
  type RowBreakdown,
  type SpanEntity,
  SPAN_OVERLAP_THRESHOLD,
  aggregateExtracted,
  computeRecallFromSpans,
} from './recall.js';

export { emitCsv, parseCsv, type CsvRow } from './csv.js';

// --- REDACT eval harness (PRD Slice 10) ---
// Deliberately separate taxonomy from the HIPAA/GLBA exports above — see
// src/redact-eval/schema.ts doc-comment for why this is not merged into the
// existing recall.ts / redaction-extractor.ts modules.
export {
  GDPR_TIERS,
  MATCH_MODES,
  type EvalRecord,
  type GdprTier,
  type GoldEntity,
  type MatchMode,
  type PredictedEntity,
  type PredictedRecord,
} from './redact-eval/schema.js';

export {
  type RateTriple,
  type ScoreSummary,
  scoreRecords,
} from './redact-eval/scorer.js';

export { redactRecordToInternal } from './redact-eval/adapters/redact.js';

export { SYNTHETIC_MULTILINGUAL_FIXTURE } from './redact-eval/fixtures/synthetic-multilingual.js';
