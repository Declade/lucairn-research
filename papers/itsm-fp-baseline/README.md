# ITSM false-positive baseline (S5-BASELINE)

Baseline quality numbers for the CURRENT L1+L2 sanitizer stack — the "before"
bracket for `prd-2026-07-04-redaction-quality-overhaul.md` § Slice 5, taken
BEFORE Slice 3 changes any recognizer. Not a published Research Program paper
(no `lucairn.eu/en/research` landing page); an internal quality-tracking
artifact scoped to one PRD workstream, kept in `papers/` because it reuses
the same harness conventions (gold fixtures + SUMMARY.json + raw-results
gitignore pattern) as Papers 1/2.

## What this measures

The ITSM/ServiceNow-shaped false-positive classes documented in the PRD's
Exhibit-A evidence (`recognizers.py:143-149` `phone_broad` timestamp
lookahead, field-name→PERSON, `.md`→URL, context-free `iso_date`→DOB,
INC-numbers-as-non-ID), plus a recall floor over real-shaped PII (name,
email, phone, IBAN, DOB-with-birth-context) that any recognizer change in
Slice 3 must not regress.

## How it was run

**Harness note (premise correction):** PR #8 / merge `20be12c`
(`src/redact-eval/`) is a **scoring library**, not an end-to-end pipeline
runner — its `redactRecordToInternal` adapter (`src/redact-eval/adapters/
redact.ts`) is an intentional NEVER-GUESS stub for a *different*, unrelated
academic dataset ingestion (arXiv:2606.19881, PRD Slice 10 of the
2026-07-02 tech-trends roadmap), and does not call any sanitizer. The
Paper-1/2-style `scripts/run-pipeline.ts` harness DOES call a running
sanitizer, but only via a live gateway HTTP endpoint (`--live` +
`LUCAIRN_GATEWAY_URL`/`LUCAIRN_API_KEY`) or an in-process mock (`--mock`,
not the real sanitizer) — there is no documented mode that drives a
dockerized local sanitizer, and no docker/podman is available in this
evaluation environment. `dual-sandbox-architecture/venv` (referenced as an
existing Presidio+spaCy install) does not actually contain any installed
packages (empty except `.gitignore`/`.DS_Store`).

Given that, this baseline runs the sanitizer's actual L1+L2 **detection
code** directly and locally (no gateway, no docker, read-only against
`dual-sandbox-architecture`), and scores the result with the REDACT
harness's real scorer:

1. **`scripts/run-sanitizer-probe.py`** (Python) — imports
   `services/sanitizer/{presidio_scan,recognizers,known_entity,placeholders,
   language}.py` in-process from a fresh venv (Presidio 2.2.355 + spaCy
   3.8.13 + `en_core_web_md`/`de_core_news_sm`), constructed with the exact
   production config values transcribed from
   `dual-sandbox-architecture/config/default-sanitizer.yaml` (confidence
   threshold 0.35, the full 42-name `custom_recognizers` list, the three
   safe-terms files). Runs L1 (`KnownEntityMatcher`, seeded with an EMPTY
   identity-fields dict — see script docstring: a synthetic freetext ITSM
   corpus has no customer directory to seed L1 from, so L1 correctly
   contributes zero matches here, exactly as in a fresh customer
   environment) then L2 (`PresidioScanner`) against each fixture text, and
   emits `PredictedRecord[]` JSON (schema.ts-shaped).
2. **`scripts/run-itsm-baseline.ts`** (TypeScript) — imports the shipped
   `scoreRecords()` from `src/redact-eval/scorer.ts` UNCHANGED and scores
   the probe's predictions against `fixtures/itsm-gold.json` gold spans
   (partial-overlap mode). This is genuine harness reuse, not a parallel
   scorer.

Piiranha/GLiNER (Phase-7 ML sidecar) and the L3 Qwen shield are NOT
exercised — both are separately gated `enabled:false` / `--skip-l3-gate`
in production per the PRD's problem statement; this baseline is L1+L2 only,
matching the PRD's own framing ("L1+L2 competitive standalone").

## Reproduce

```bash
# 1. One-time: build a Python 3.12 venv with Presidio + spaCy (NOT the repo's
#    own venv/tooling — a disposable local venv; only reads
#    dual-sandbox-architecture, never writes to it).
python3.12 -m venv /tmp/sanitizer-eval-venv
source /tmp/sanitizer-eval-venv/bin/activate
pip install presidio-analyzer==2.2.355 spacy==3.8.13 jellyfish==1.1.3 \
  langdetect==1.0.9 pyyaml==6.0.2 click
python3 -m spacy download en_core_web_md
python3 -m spacy download de_core_news_sm   # needed because supported_languages: [de, en]

# 2. Run the sanitizer probe (adjust --fixtures/--output paths as needed;
#    point --sanitizer-dir/--config-dir, or DSA_SANITIZER_DIR/DSA_CONFIG_DIR,
#    at your dual-sandbox-architecture clone -- read-only, never written to).
python3 scripts/run-sanitizer-probe.py \
  --fixtures papers/itsm-fp-baseline/fixtures/itsm-gold.json \
  --output papers/itsm-fp-baseline/raw-results/RUN-predictions.json \
  --sanitizer-dir "$DSA_ROOT/services/sanitizer" \
  --config-dir "$DSA_ROOT/config"

# (Alternatively, export DSA_SANITIZER_DIR and DSA_CONFIG_DIR instead of
# passing the flags.)

# 3. Score with the real REDACT harness scorer.
node --import tsx scripts/run-itsm-baseline.ts \
  --gold=papers/itsm-fp-baseline/fixtures/itsm-gold.json \
  --predictions=papers/itsm-fp-baseline/raw-results/RUN-predictions.json \
  --output=papers/itsm-fp-baseline/SUMMARY-RUN.json
```

Post-Slice-3, re-run steps 2-3 unchanged against the updated
`recognizers.py`/`presidio_scan.py` to produce the "after" bracket — same
two commands, same fixture file, diff the two `SUMMARY-*.json` files.

## Baseline results (S5-BASELINE, pre-Slice-3, 2026-07-04)

Full machine output: [`SUMMARY-s5-baseline.json`](./SUMMARY-s5-baseline.json).

| Bucket | TP | FP | FN | Recall | Precision | F1 |
|---|---|---|---|---|---|---|
| **Overall** | 20 | 12 | 0 | **1.00** | 0.625 | 0.769 |
| GDPR HIGH (DOB, IBAN) | 2 | 2 | 0 | 1.00 | 0.50 | 0.667 |
| GDPR MED (PERSON, EMAIL, PHONE) | 8 | 5 | 0 | 1.00 | 0.615 | 0.762 |
| GDPR LOW (ID) | 10 | 5 | 0 | 1.00 | 0.667 | 0.80 |

**Recall floor: 100% (20/20)** — every real-shaped PII fixture entity (name,
email, phone, IBAN, DOB-with-birth-context) is caught. No regression risk
baseline to protect during Slice 3.

**Precision: 62.5%** (12 FP / 32 total predictions) — the ITSM FP tax the
PRD exists to fix.

### ITSM FP classes reproduced (12 FPs, by fixture)

| Fixture | FP text | Predicted as | PRD-cited class |
|---|---|---|---|
| `itsm-001-timestamp-fp` | `"2026-06-05 09"` (×2) | PHONE | timestamp→PHONE (`recognizers.py:143-149` `phone_broad`) |
| `itsm-001-timestamp-fp` | `"sys_created_on"` | PERSON | field-name→PERSON |
| `itsm-002-ticket-prefix-person-fp` | `"Ticket INC0000112"` | PERSON | adjacent/related class — NOT the state-fragment class (see Non-reproductions below); a new "Ticket "-prefix-swallowed-into-PERSON-span finding |
| `itsm-003-sys-id-fp` | 2× 32-hex sys_id/caller_id strings | ID | generic hex-string over-typed as ID (bonus finding beyond PRD's explicit list; INC/PRB numbers correctly typed ID alongside) |
| `itsm-004-field-name-fp` | `"sys_created_on"` | PERSON | field-name→PERSON (confirms class in isolation) |
| `itsm-005-md-url-fp` | `"README.md"`, `"CHANGELOG.md"`, `"incident-response.md"` | URL | `.md`→URL (Presidio `UrlRecognizer`) |
| `itsm-006-iso-date-no-context-fp` | `"2026-08-14"` | DOB | context-free `iso_date`→DOB (`recognizers.py:111/123`) |
| `itsm-010-mixed-record` | `"2026-05-11"` | DOB | context-free `iso_date`→DOB (recurrence in a mixed record) |
| `itsm-010-mixed-record` | `"sys_created_on"` | PERSON | field-name→PERSON (recurrence) |

INC/PRB ticket numbers themselves were typed `ID` correctly in **every**
fixture (`itsm-001`, `-002`, `-003`, `-005`, `-006`, `-007`, `-008`, `-009`,
`-010` all show the ticket number as a clean `ID` true positive) — the
PRD-cited "8-10 INC numbers typed non-ID (incl. `INC0000059`→LOCATION)"
class did NOT reproduce against these fixture strings with the current
config. That manifest-level count comes from the real 521-entry production
corpus; this 10-record synthetic set is not large/varied enough to force
the same LOCATION misclassification, and per MEMORY.md the A6
over-redaction fix (PR #283+#280+#281, mid-June) may have already narrowed
this specific failure mode. Flagged as a gap for Slice 3's own larger
fixture pass, not claimed as fixed by this baseline.

### Non-reproductions (documented, not swept under the rug)

**State-fragment→LOCATION (`"Progress"` sliced from `"In Progress"`,
PRD-cited `Progress ×27`)** did NOT reproduce in 7 isolated variants tried
against the current sanitizer code+config (see
[`raw-results/state-fragment-non-repro-probe.json`](./raw-results/state-fragment-non-repro-probe.json)):
plain "In Progress", with "State:" prefix, with "Current State:" +
newline-separated second field, key=value ITSM style, embedded in a full
ticket short-description sentence, and bare "In Progress" alone — all
produced zero predictions. Two explanations, not adjudicated here: (a) the
2026-07-03-logged A6 over-redaction fix already narrowed this specific
slice-pattern before this baseline was taken, or (b) the real manifest's
27 occurrences depend on a field-position/language context (e.g. German
`state`-field rendering, or a different spaCy recognizer path) not
represented in these 7 English isolated strings. **Slice 3 should re-derive
this fixture from an actual anonymized manifest excerpt rather than trust
this baseline's synthetic guess** — this is exactly the kind of premise
gap the PRD's own recall-floor discipline exists to catch.

## Files

- `fixtures/itsm-gold.json` — 10-record synthetic ITSM gold set (Erika
  Schmidt / example.com class only, no real personal data).
- `SUMMARY-s5-baseline.json` — machine-readable scorer output (checked in;
  the schema this file follows is `src/redact-eval/scorer.ts`'s
  `ScoreSummary`, NOT the HIPAA-locked `papers/_template/SUMMARY.schema.json`
  — that schema's `HipaaCategory` enum doesn't fit a GDPR-tier harness).
- `raw-results/` — gitignored per repo convention
  (`papers/*/raw-results/*`); `s5-baseline-l1l2-predictions.json` and the
  non-repro probe json are regenerable via the commands above, not
  committed.
