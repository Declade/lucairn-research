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
| _fill at S3 admission_ |  |  |  |  |  | pending |

This implements PRD § Methodology “Base-mix admission”: synthetic or
anonymized-verified public data only, documented PII inspection, explicit
ontology mapping, and original test partitions preserved outside training.
