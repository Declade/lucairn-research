# Healthcare Dataset Construction Recipe — Paper 1

This document is the methodology of record for the healthcare dataset used in Paper 1 of the Lucairn Research Program. Every quantitative claim in the paper traces back to a step in this recipe; every step is reproducible from the scripts in `../../scripts/`.

## Provenance

- **Source dataset:** `tboyle10/medicaltranscriptions` on Kaggle — <https://www.kaggle.com/datasets/tboyle10/medicaltranscriptions>.
- **Original publisher:** scraped from <https://www.mtsamples.com/>, a public archive of de-identified medical transcription sample reports maintained for medical-transcription training purposes.
- **Approximate row count:** ~4,999 rows after Kaggle CSV export.
- **Schema (5 columns):** `description`, `medical_specialty`, `sample_name`, `transcription`, `keywords`.
- **Download method:** Kaggle CLI (`kaggle datasets download -d tboyle10/medicaltranscriptions -p datasets/healthcare/raw/ --unzip`); see `../../scripts/download-mtsamples.ts`.
- **Tamper-resistance:** the SHA-256 of the downloaded `mtsamples.csv` is recorded in `EXPECTED-HASHES.json` after first acquisition. Any subsequent run that produces a different hash fails the verification gate. This is not a license-enforcement mechanism; it is a reproducibility check.

## License (CC0)

The Kaggle dataset card declares **CC0 1.0 Universal — Public Domain Dedication** (<https://creativecommons.org/publicdomain/zero/1.0/>). CC0 permits unrestricted reuse, modification, and redistribution, with or without attribution. We attribute regardless, in the spirit of academic citation.

## Why MTSamples (and what MTSamples is and is not)

MTSamples is the strongest pre-de-identified clinical-narrative corpus available under an unambiguous redistribution license. The alternatives (MIMIC-III, MIMIC-IV, n2c2, i2b2) are all DUA-gated and cannot be redistributed by a third-party vendor under any license.

**What MTSamples IS:**

- Real medical transcription text drawn from real clinical contexts (operative notes, discharge summaries, consult letters, history-and-physical reports).
- Domain-faithful in vocabulary, abbreviation use, narrative structure, and length distribution.
- Sufficient in volume (~5,000 rows) for statistically meaningful per-PHI-category detection counts.

**What MTSamples is NOT:**

- **NOT institutionally de-identified.** MTSamples is raw text from a public website (mtsamples.com); it has not been subjected to the formal Safe Harbor (HIPAA 45 CFR § 164.514(b)(2)) or Expert Determination (45 CFR § 164.514(b)(1)) de-identification procedures that govern PHI release from a covered entity. It may contain real residual identifiers — dates, provider names, patient initials, geographic references, identifier-shaped strings — that were not redacted during the original public posting.
- NOT a benchmark with annotated ground-truth PHI labels. There is no published per-token annotation file for MTSamples comparable to the i2b2 2014 corpus.
- NOT representative of a single institution, single specialty, or single patient population. It is a heterogeneous collection by design.

These properties drive the two-measurement methodology below.

## Methodology overview — two empirically distinct measurements

Because MTSamples has no published ground-truth PHI annotations, a single measurement against the raw corpus cannot produce a defensible recall number. Paper 1 therefore reports two measurements that answer two different empirical questions.

## Slice-status timeline (current state of the implementation)

This recipe documents the *full* methodology for Paper 1. The implementation lands incrementally:

- **Slice 1 (current commit) — ships:**
  - Dataset acquisition script (`scripts/download-mtsamples.ts`)
  - Deterministic synthetic PII re-injection for Measurement B's 500-row subset (`scripts/inject-pii.ts`, `src/inject-pii-core.ts`)
  - Round-trip verification (`scripts/verify-injection.ts`)
- **Slice 2 — pending:** harness to call the Lucairn gateway row-by-row, collect cert URLs, compute recall against Measurement B's known ground truth (`scripts/run-pipeline.ts`, `scripts/collect-certs.ts`, `scripts/compute-recall.ts`)
- **Slice 3 — pending:** full Paper 1 run including **Measurement A's raw-corpus detection pass** (Lucairn over the full ~5k MTSamples corpus, reporting detection counts without ground truth) plus the Measurement B recall numbers + the `papers/paper-1-healthcare/CERTIFICATES.csv` cert-URL appendix

Until Slice 2 + Slice 3 land, the harness + Measurement A code does not exist in this repo. The methodology description below is the published target, not the current shipped state.

### Measurement A — raw-corpus detection (what does Lucairn flag in the wild?)

- **Input:** the full ~5,000-row raw MTSamples corpus, unchanged.
- **What is reported:** per-HIPAA-category detection counts (PERSON, LOCATION, DATE, …). Detection-rate is reported per category but recall is **not** claimed (no ground truth exists).
- **What this measures:** the empirical behaviour of Lucairn's sanitizer (Layers 1 + 2 + 3) on a freshly-onboarded real-world corpus. This is the experience a new operator would have on day one of pointing Lucairn at their own clinical data.
- **Interpretation rule:** "Lucairn flagged N entities of category C across M rows" — a behavioural statement. Not "Lucairn caught N% of PHI" — that would require ground truth.

### Measurement B — known-ground-truth recall (how complete is Lucairn against entities we know are there?)

- **Input:** a 500-row subset of MTSamples, selected by deterministic random sampling (seed 42, by row index). The subset is then augmented by **injecting synthetic PII** at controlled density across all 18 HIPAA Safe Harbor categories.
- **What is reported:** recall (TP / (TP + FN)), precision (TP / (TP + FP)), and per-category breakdowns — all computed **only against the known injected entities**.
- **What this measures:** the upper bound on Lucairn's recall for the categories and density we tested, on real clinical narrative as the carrier text.
- **Acknowledged limit:** the 500-row subset still contains real residual PHI from the raw corpus. We do not count those as ground truth. A model that detects real residual PHI in addition to our injected entities will not have those detections counted as TP or FP in Measurement B — they are treated as out-of-scope from Measurement B's accounting and rolled into Measurement A's per-row supplementary counts.

## PII re-injection density and source baselines

The injection density used in Measurement B is calibrated to the i2b2 2014 corpus baseline.

- **i2b2 baseline (Stubbs & Uzuner, 2015):** the i2b2 2014/UTHealth de-identification corpus comprises **1,304 longitudinal medical-record notes describing 296 diabetic patients**, with **~22 PHI entities per note on average** distributed across the i2b2 HIPAA+ extended category set. The precise total annotation count is documented in the paper full-text; we cite the per-note baseline only because that is the value our re-injection density references.
  - Reference: Stubbs A., Uzuner Ö. "Annotating longitudinal clinical narratives for de-identification: The 2014 i2b2/UTHealth corpus." *Journal of Biomedical Informatics*, vol. 58, supplement, pp. S20–S29, 2015. PMID: 26319540. DOI: <https://doi.org/10.1016/j.jbi.2015.07.020>.
- **Target injection density for Measurement B:** **20–25 PHI entities per note**, sampled uniformly within that range per row.
- **Per-category distribution:** roughly approximates the i2b2 empirical proportions — DATE is the most frequent category (~35%), followed by NAME (~20%), LOCATION (~15%), ID-shaped categories (~10% combined), with the remaining 11 Safe Harbor categories splitting the residual ~20% uniformly. Exact per-row counts are determined by the deterministic Faker seed and recorded in the per-row ground-truth JSONL.

## Re-injection categories (HIPAA Safe Harbor enumeration)

The 18 categories of identifiers that, per HHS 45 CFR § 164.514(b)(2)(i), must be removed for Safe Harbor de-identification. The Lucairn Research Program injects synthetic instances of each of these into Measurement B's subset, ensuring full category coverage.

1. **Names** — patient, family, employer.
2. **All geographic subdivisions smaller than a State** (street address, city, county, precinct, ZIP code, and equivalent geocodes), except the initial three digits of the ZIP code where the geographic unit formed by combining all ZIP codes with those three initial digits contains more than 20,000 people per current US Census data; ZIP-code prefixes for areas of 20,000 or fewer people are changed to `000` (45 CFR §164.514(b)(2)(i)(B)).
3. **Dates** (except year) directly related to an individual — birth date, admission date, discharge date, date of death — and all ages over 89 and all elements of dates indicative of such age.
4. **Telephone numbers.**
5. **Fax numbers.**
6. **Electronic mail addresses.**
7. **Social Security numbers.**
8. **Medical record numbers.**
9. **Health plan beneficiary numbers.**
10. **Account numbers.**
11. **Certificate/license numbers.**
12. **Vehicle identifiers** and serial numbers, including license plate numbers.
13. **Device identifiers** and serial numbers.
14. **Web Universal Resource Locators (URLs).**
15. **Internet Protocol (IP) address numbers.**
16. **Biometric identifiers**, including finger and voice prints. *(Injected as a single labelled placeholder shape per row — `BIO-FINGERPRINT-<16 uppercase alphanumeric>` (e.g. `BIO-FINGERPRINT-A4F2K9LM3PQR7XYZ`); biometric encoding is out of scope for this recipe.)*
17. **Full face photographic images and any comparable images.** *(Injected as a single labelled placeholder shape per row — `face-photo://<12 alphanumeric>.jpg` (e.g. `face-photo://aB3kL9mN2pQr.jpg`); binary image content is out of scope for this recipe.)*
18. **Any other unique identifying number, characteristic, or code** — injected as a single labelled placeholder shape per row — `STUDY-<8 uppercase alphanumeric>` (e.g. `STUDY-K7M2X9PQ`).

Per-category placeholder shapes 1–15 are emitted by Faker primitives (see `src/inject-pii-core.ts` `synthesizeValue`) and therefore exhibit Faker's natural shape variation; categories 16/17/18 use a single deterministic shape each, as the underlying real-world identifiers (raw biometric encodings, binary image bytes, opaque study tokens) have no canonical synthetic shape.

For all 18 categories, the **per-row count** of injected PHI entities is sampled uniformly within the `[MIN_PHI_PER_ROW, MAX_PHI_PER_ROW] = [20, 25]` range per row (see `src/inject-pii-core.ts:185` — `pickInt(rowRng, MIN_PHI_PER_ROW, MAX_PHI_PER_ROW)`), with the exact count for each row determined by the deterministic row-RNG seed.

Source: HHS Office for Civil Rights — *Guidance Regarding Methods for De-identification of Protected Health Information in Accordance with the Health Insurance Portability and Accountability Act (HIPAA) Privacy Rule* — <https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html>.

## Deterministic seed and reproducibility

- **Faker seed:** `42` (fixed, hard-coded in `../../scripts/inject-pii.ts`).
- **Row-selection seed:** `42` (same constant, applied to a Mulberry32 PRNG seeded with `42` for the 500-row subset selection).
- **Per-row category-distribution seed:** derived per row as `42 * 1_000_003 + rowIndex`.
- **Reproducibility invariant:** running `pnpm dataset:inject-pii` on the same `datasets/healthcare/raw/mtsamples.csv` MUST produce a byte-identical `datasets/healthcare/with-injected-pii/measurement-b-subset.csv` and a byte-identical `ground-truth.jsonl`. This invariant is asserted by `pnpm dataset:verify-injection`, which compares SHA-256 hashes of both output files against `datasets/healthcare/with-injected-pii/EXPECTED-HASHES.json`.
- **Why this matters:** independent researchers must be able to reproduce Paper 1's exact numbers from a fresh clone of this repo. Any non-determinism in the re-injection step would break reproducibility.

## What the recipe does NOT claim

- The injected PII distribution is **realistic** in clinical-NLP terms — it follows the i2b2 BASELINES, which are themselves a model. Real clinical notes vary widely.
- The raw MTSamples corpus is de-identified — **it is not**. See "What MTSamples is NOT" above.
- The Measurement-A detection counts constitute recall — **they do not**. They are behavioural counts in the absence of ground truth.
- The recall numbers from Measurement B generalise to other clinical corpora, other specialties, other languages, or other healthcare-data carriers — **not claimed**. They describe Lucairn's behaviour on a single corpus under a single injection recipe.
- Compliance with any specific regulatory regime is established by these measurements — **not claimed**. The measurements are an input to a compliance assessment, not the assessment itself.

## References

- **EU AI Act:** Regulation (EU) 2024/1689 of the European Parliament and of the Council of 13 June 2024 laying down harmonised rules on artificial intelligence (Artificial Intelligence Act). EUR-Lex: <http://data.europa.eu/eli/reg/2024/1689/oj>.
- **i2b2 2014 corpus baseline:** Stubbs A., Uzuner Ö. "Annotating longitudinal clinical narratives for de-identification: The 2014 i2b2/UTHealth corpus." *Journal of Biomedical Informatics*, vol. 58, supplement, pp. S20–S29, 2015. PMID: 26319540. DOI: <https://doi.org/10.1016/j.jbi.2015.07.020>.
- **HIPAA Safe Harbor enumeration:** HHS Office for Civil Rights — *Guidance Regarding Methods for De-identification of Protected Health Information* — <https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html>.
- **MTSamples original archive:** <https://www.mtsamples.com/>.
- **Kaggle dataset record:** <https://www.kaggle.com/datasets/tboyle10/medicaltranscriptions>.

## Dataset integrity record (populated after first download)

Recorded by `pnpm dataset:download` (or fill manually on first acquisition):

- `mtsamples.csv` SHA-256: *(populated after first run; see `datasets/healthcare/raw/EXPECTED-HASH.txt`)*
- Row count: *(populated)*
- Acquisition date (UTC): *(populated)*
- Acquisition Kaggle CLI version: *(populated)*
