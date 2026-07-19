# Base-mix admission protocol

This is an S2 admission artifact, not an admitted training corpus. No public
base data was fetched, copied, or mixed into the generated S2 shards during
this repair. S3 may use a candidate only after every item below is recorded in
an immutable local inspection record and the approval row is signed off.

## Candidate register — leads only

| Candidate public source | Claimed data type | License note to verify on the pinned source snapshot | Admission status |
|---|---|---|---|
| AI4Privacy PII masking datasets | Claimed synthetic PII masking examples | Capture the dataset-card license, version/revision, attribution and redistribution terms before any download; a catalog label is not evidence of anonymization. | Not inspected; not admitted |
| Synthea synthetic patient records | Programmatically generated, synthetic health-record data | Verify the pinned release's Apache-2.0 notice and whether the specific exported corpus has extra terms; inspect fields because synthetic does not automatically mean ontology-compatible. | Not inspected; not admitted |
| Presidio/Faker-generated public examples | Locally reproducible synthetic examples rather than a fixed corpus | Verify the source/release licenses for the generator and locale providers; preserve the exact seed and generated partition manifest. | Candidate generation route only; not admitted |

“Public” and “license-labelled” are insufficient. A candidate is admissible
only when the inspection evidence establishes **synthetic or
anonymized-verified** content. Real-person, scraped, weakly de-identified,
unknown-provenance, or licence-ambiguous examples are rejected.

## Required inspection procedure

1. Pin the exact upstream URL, revision/hash, retrieval date, licence text and
   attribution/redistribution requirements in a local inspection record. Do
   not rely on a mutable dataset card.
2. Keep the upstream source's original `test`/`validation` partitions outside
   training. If partitions are absent, split only after the synthetic or
   anonymized-verified determination and record the grouped split method.
3. Run `fetch_inspect.py --local PATH` against an already-authorized local
   snapshot. It performs an offline structural inventory only; it never
   downloads a dataset or treats a heuristic as an admission decision.
4. Manually inspect a stratified sample, including each language, field/zone,
   label, rare surface pattern, and every example flagged by the inventory.
   Verify that apparent people, emails, addresses, account numbers, or IDs are
   demonstrably synthetic/anonymized-verified and that offsets/labels can be
   regenerated.
5. Compare text hashes against every quarantined eval asset and the frozen S2
   train/dev artifacts. Any overlap, unresolved provenance, licence failure,
   or retained original test partition is a rejection.
6. Complete the mapping table below, record the intended training split and
   hash manifest, and obtain explicit admission before S3. Re-run the bank
   contamination and split-integrity gates after any admitted mix is staged.

## Ontology → Lucairn-category mapping template

| Upstream ontology label | Example zone/context | Lucairn category | Expected action | Mapping rationale | Reviewer | Status |
|---|---|---|---|---|---|---|
| `PERSON` | prose / ticket assignee | `PERSON` | `REDACT` |  |  | pending |
| `LOCATION` / `GPE` | prose / address field | `LOCATION` | `REDACT` |  |  | pending |
| `ORGANIZATION` / vendor | schema / prose | `VENDOR` or no-map | Treat technical vendor labels separately from persons. |  | pending |
| `EMAIL` | JSON value | `EMAIL` | `REDACT` |  |  | pending |
| `PHONE` | JSON value | `PHONE` | `REDACT` |  |  | pending |
| `ID` / account token | technical identifier | `TECHNICAL_IDENTIFIER` or no-map | Require zone-specific KEEP/REDACT decision. |  | pending |
| unmapped label | any | no-map | exclude | Never silently coerce an uncertain ontology. |  | pending |

## Admission decision record

| Candidate + immutable revision | Licence verified | Synthetic/anonymized evidence | Original test partition excluded | Inspection report hash | Mapping complete | Decision |
|---|---|---|---|---|---|---|
| `ai4privacy/pii-masking-300k` @ `c8c77895a005822682b66ab547fc0422579bc1d3` | ✗ — non-commercial-only license (LICENSE.md: "Commercial Use: Strictly no licensing is available directly for companies without prior discussion"); no written commercial agreement obtained; watermark/enforcement clause present | N/A — not reached (license gate failed first; card claims "Synthetic data generated using proprietary algorithms" unverified by sampling) | N/A — not reached (no data files downloaded) | `a74f501a8955554f32a2c8918bcfc663e561802043f788f88a8738fc0a9b3cab` (`~/Opus Advisor/context/pii-bank/base-mix/admission-record-ai4privacy-c8c77895.md`) | ✗ — not built (conditioned on license PASS) | **REJECTED** |
| `ai4privacy/openpii-masking-mini-10k` @ `ad851605dfd3c1a3fefe51c8d8f1cc0e4a6853d0` (coordinator-approved substitution within the registered AI4Privacy family) | ✓ — CC-BY-4.0 declared in frontmatter + card body at the pinned revision; parent `pii-masking-openpii-1m` terms verbatim permit "Research, commercial use, redistribution, and modification"; no rider license files; attribution block recorded in the inspection record for ENV.md/go-no-go | ✓ — card + parent claim synthetic-only ("synthetic PII only — no real personal data"); seeded 220-row sample (seed 20260720, all 23 langs; 44/44 EN+DE read) + full-corpus scans: 0 real public figures (16/16 pattern hits = substring coincidences), 9.9% Luhn-valid cards (random-digit), 7-domain uniform freemail, template incoherences throughout, 0 scraped-content indicators; contamination 0 vs all quarantined eval assets + frozen S2 train/dev | ✓ — usable-train = `data/train-00000-of-00001.parquet` ONLY (9,000 rows); validation parquet (1,000) excluded from all training; ⚠ in-row `split` column unreliable (constant "train") — file placement is authoritative | `090d2e44f84fa4328abce5e6910377db8d4b1a310c3c0838ffeedbb32f1f0087` (`~/Opus Advisor/context/pii-bank/base-mix/admission-record-ai4privacy-mini10k-ad851605.md`) | ✓ — 19 data-enumerated labels mapped: 6 → PERSON/LOCATION/EMAIL/PHONE, 13 explicitly EXCLUDED (all deterministic-ID classes, DATE/AGE/GENDER/SEX/TITLE, conditional BUILDINGNUM/ZIPCODE); codepoint+surface converter contract verified 81,471/81,471 spans | **ADMITTED** (scoped per record) |

This implements PRD § Methodology “Base-mix admission”: synthetic or
anonymized-verified public data only, documented PII inspection, explicit
ontology mapping, and original test partitions preserved outside training.
