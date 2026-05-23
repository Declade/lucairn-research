# Finance Dataset Construction Recipe — Paper 2

This document is the methodology of record for the finance dataset used in Paper 2 of the Lucairn Research Program. Every quantitative claim in the paper traces back to a step in this recipe; every step is reproducible from the scripts in `../../scripts/`.

## Provenance

- **Source dataset:** Consumer Financial Protection Bureau (CFPB) Consumer Complaint Database — the public, machine-readable export of complaints US consumers have filed against financial institutions since 2011.
- **Source URL:** <https://files.consumerfinance.gov/ccdb/complaints.csv.zip>.
- **Original publisher:** Consumer Financial Protection Bureau (CFPB), an independent agency of the United States federal government.
- **Approximate row count:** ~5–7 million complaints (the database grows daily; see `raw/ACQUISITION.json` for the exact count of the specific acquisition that produced the numbers reported in Paper 2).
- **Schema (18 columns):** `Date received`, `Product`, `Sub-product`, `Issue`, `Sub-issue`, `Consumer complaint narrative`, `Company public response`, `Company`, `State`, `ZIP code`, `Tags`, `Consumer consent provided?`, `Submitted via`, `Date sent to company`, `Company response to consumer`, `Timely response?`, `Consumer disputed?`, `Complaint ID`.
- **Carrier-text column:** `Consumer complaint narrative` — the free-text portion of a complaint that the consumer opted to publish. Only a minority of complaints have a non-empty narrative; the Paper 2 subset is sampled from the non-empty subset.
- **Download method:** direct HTTPS download via `curl` from CFPB's public file server; see `../../scripts/download-cfpb.ts`.
- **Tamper-resistance:** the SHA-256 of the downloaded `complaints.csv` is recorded in `EXPECTED-HASH.txt` after first acquisition. The CFPB database is updated daily, so a fresh download will produce a new hash; the script flags this as expected for a re-acquisition and writes the new hash on operator confirmation. The hash check is a determinism gate for *a single acquisition snapshot*, not a license enforcement.

## License (US Federal government work — public domain)

The CFPB Consumer Complaint Database is produced by a US federal agency in the course of its statutory mission. **Works prepared by an officer or employee of the United States Government as part of that person's official duties are not subject to copyright protection** under 17 U.S.C. § 105. The CFPB's own data-policy page confirms unrestricted reuse with attribution recommended (<https://www.consumerfinance.gov/data/>). Paper 2 attributes regardless, in the spirit of academic citation.

## Why the CFPB Consumer Complaint Database (and what it is and is not)

The CFPB database is the strongest pre-published consumer-finance narrative corpus available under an unambiguous redistribution license. The alternatives (proprietary call-centre transcripts, vendor-curated complaint corpora, FFIEC complaint subsets) are all either DUA-gated or vendor-restricted and cannot be redistributed by a third-party vendor.

**What the CFPB database IS:**

- Real complaint narrative drawn from real consumer-facing financial-services interactions (mortgages, credit cards, debt collection, consumer loans, student loans, money transfers, prepaid cards, checking accounts, savings accounts).
- Domain-faithful in vocabulary, abbreviation use, narrative structure, and length distribution.
- Sufficient in volume (millions of rows; hundreds of thousands of non-empty narratives) for statistically meaningful per-NPI-category detection counts in any 500-row subset.

**What the CFPB database is NOT:**

- **NOT institutionally redacted to a formal standard.** The CFPB does scrub certain identifiers (account numbers, full names, addresses) using internal heuristics before publishing the narrative column, but this scrubbing is not subjected to a formal Safe Harbor (GLBA 16 CFR Part 313) or Expert Determination procedure. It may contain real residual identifiers — dates, partial account references, geographic references, employer names, identifier-shaped strings — that were not redacted.
- NOT a benchmark with annotated ground-truth NPI labels. There is no published per-token annotation file for the CFPB database comparable to the i2b2 2014 corpus (healthcare) or the FinPII synthetic benchmark.
- NOT representative of a single institution, single product, or single consumer demographic. It is a heterogeneous collection by design, spanning the full US consumer-financial-services market.

These properties drive the two-measurement methodology below.

## Methodology overview — two empirically distinct measurements

Because the CFPB database has no published ground-truth NPI annotations, a single measurement against the raw corpus cannot produce a defensible recall number. Paper 2 therefore reports two measurements that answer two different empirical questions. This parallels Paper 1's MTSamples methodology exactly.

### Measurement A — raw-corpus detection (what does Lucairn flag in the wild?)

- **Input:** the deterministic 500-row Measurement B carrier subset (drawn from rows with non-empty narrative), in its raw pre-injection form.
- **What is reported:** per-GLBA-category detection counts (NAME, ADDRESS, SSN, CC, IBAN, …). Detection-rate is reported per category but recall is **not** claimed (no ground truth exists in the raw narrative).
- **What this measures:** the empirical behaviour of Lucairn's sanitizer (Layers 1 + 2 + 3) on freshly-onboarded real-world consumer-finance narrative. This is the experience a new operator would have on day one of pointing Lucairn at their own complaint or customer-narrative corpus.
- **Interpretation rule:** "Lucairn flagged N entities of category C across M rows" — a behavioural statement. Not "Lucairn caught N% of NPI" — that would require ground truth.

### Measurement B — known-ground-truth recall (how complete is Lucairn against entities we know are there?)

- **Input:** the same 500-row subset, augmented by **injecting synthetic NPI** at controlled density across the 17 GLBA NPI categories enumerated below.
- **What is reported:** recall (TP / (TP + FN)), precision (TP / (TP + FP)), and per-category breakdowns — all computed **only against the known injected entities**.
- **What this measures:** the upper bound on Lucairn's recall for the categories and density we tested, on real consumer-finance complaint narrative as the carrier text.
- **Acknowledged limit:** the 500-row subset still contains real residual identifiers from the CFPB corpus. We do not count those as ground truth. A model that detects real residual identifiers in addition to our injected entities will not have those detections counted as TP or FP in Measurement B — they are out-of-scope for Measurement B's accounting and rolled into Measurement A's per-row supplementary counts.

## NPI re-injection density and source baselines

Unlike the healthcare paper, no equivalent academic baseline exists for consumer-finance complaint narrative (the i2b2 2014 / UTHealth corpus is healthcare-specific). The Paper 2 injection density is therefore set for **methodological continuity with Paper 1**, not against an empirical finance-corpus baseline. The density is documented explicitly here so future per-density analyses can be conducted from a known reference point.

- **Target injection density for Measurement B:** **20–25 NPI entities per narrative**, sampled uniformly within that range per row. Matches the Paper 1 healthcare density.
- **Why the same density:** keeps per-row evidence load constant across papers so cross-paper category-difficulty comparisons are not confounded by density differences.
- **Per-category distribution:** the cumulative-weight distribution at `../../src/inject-finance-pii-core.ts:pickWeightedFinanceCategory` is calibrated by hand to (a) put most weight on the categories that dominate realistic complaint narrative (names + addresses + account/transaction references) and (b) preserve non-zero coverage for every GLBA category across a 500-row subset. Exact per-row counts are determined by the deterministic Faker seed and recorded in the per-row ground-truth JSONL.

## Re-injection categories (17 GLBA NPI categories)

The 17 categories below are the Paper 2 enumeration of "nonpublic personal information" (NPI) for re-injection purposes. The enumeration is derived from three primary sources, none of which provides a single closed list in the way HIPAA Safe Harbor does — so this list is documented here as the *operational* enumeration Paper 2 uses.

1. **Full name** — first + last; sometimes with middle/suffix.
2. **Residential address** — street + city + state + ZIP, 5-digit US form.
3. **Social Security Number (SSN)** — `NNN-NN-NNNN`.
4. **Email address.**
5. **Telephone number.**
6. **Date of birth** — `YYYY-MM-DD`.
7. **Bank account number** — 8–12 digit ACH-style account identifiers.
8. **Bank routing number (ABA)** — exactly 9 digits.
9. **Credit card primary account number (PAN)** — Luhn-valid 16-digit numbers.
10. **Card CVV / CVC** — 3 or 4 digits.
11. **Card expiration date** — `MM/YY`.
12. **IBAN** — International Bank Account Number, DE-prefix in our synthetic shape; FAA-equivalent identifiers for SEPA-style cross-border transactions.
13. **Tax identifier** — EIN (`NN-NNNNNNN`) or ITIN (`9NN-NN-NNNN`).
14. **Driver license number** — opaque alphanumeric identifier with `DL-` prefix in our synthetic shape.
15. **Account balance** — dollar amount with `$` sigil and `.NN` decimal portion.
16. **Credit score** — integer in `[300, 850]`.
17. **Loan account ID** — opaque alphanumeric identifier with `LN-` prefix in our synthetic shape.

**Sources for the enumeration:**

- **GLBA Privacy Rule, 16 CFR § 313.3(n)** — definition of "nonpublic personal information" + non-exhaustive examples of "personally identifiable financial information."
- **FTC Safeguards Rule, 16 CFR Part 314** — operational definition of "customer information" that financial institutions must safeguard.
- **PCI-DSS v4.0 Glossary + §3.2.1** — Account Data definition (the v4.0 Glossary defines Account Data, Cardholder Data — PAN + Cardholder Name + Expiration Date + Service Code — and Sensitive Authentication Data — CVV/CVC + Full Track + PIN; §3.2.1 is the storage-retention requirement that references these terms).
- The enumeration MIRRORS the structural pattern of HIPAA Safe Harbor's 18 identifiers (45 CFR § 164.514(b)(2)(i)) for cross-paper structural parity — but the items themselves are sourced from finance regulators, not health.

**What this enumeration does NOT claim:**

- It is NOT an exhaustive list of every NPI under GLBA (GLBA defines NPI by exclusion, not enumeration).
- It is NOT a regulatory-compliance certification of any kind. Paper 2's measurement does not constitute compliance with GLBA, PCI-DSS, CCPA, NYDFS Part 500, or any other regime.
- It is NOT a "PCI scope" assessment. PCI-DSS scope is a property of the merchant's environment, not of any single dataset measurement.

## Deterministic seed and reproducibility

- **Faker seed:** `42` (fixed, defined in `../../src/inject-pii-core.ts`; re-exported via `inject-finance-pii-core.ts`).
- **Row-selection seed:** `42` (same constant; Mulberry32 PRNG seeded with `42` for the 500-row subset selection within the non-empty-narrative index set).
- **Per-row category-distribution seed:** derived per row as `42 * 1_000_003 + rowIndex` (same formula as the healthcare core).
- **Reproducibility invariant:** running `pnpm dataset:inject-finance-pii` on the same `datasets/finance/raw/complaints.csv` MUST produce a byte-identical `datasets/finance/with-injected-pii/measurement-b-subset.csv` and a byte-identical `ground-truth.jsonl`. This invariant is asserted by `pnpm dataset:verify-finance-injection`, which compares SHA-256 hashes against `datasets/finance/with-injected-pii/EXPECTED-HASHES.json`.
- **Why this matters:** independent researchers must be able to reproduce Paper 2's exact numbers from a fresh clone of this repo + a fresh CFPB download whose SHA-256 matches the recorded acquisition hash. Any non-determinism in the re-injection step would break reproducibility.

## What the recipe does NOT claim

- The injected NPI distribution is **realistic** in finance-NLP terms — it follows a per-category weighting set for evidence-load constancy with Paper 1, NOT empirical CFPB-narrative statistics. Real complaint narratives vary widely.
- The raw CFPB narrative is itself de-identified to a formal standard — **it is not**. See "What the CFPB database is NOT" above.
- The Measurement-A detection counts constitute recall — **they do not**. They are behavioural counts in the absence of ground truth.
- The recall numbers from Measurement B generalise to other finance corpora, other product categories (mortgage vs. credit card vs. brokerage), other languages, or other consumer-finance carrier types — **not claimed**. They describe Lucairn's behaviour on a single corpus under a single injection recipe.
- Compliance with any specific regulatory regime (GLBA, PCI-DSS, CCPA, NYDFS Part 500, FFIEC, FDIC, OCC) is established by these measurements — **not claimed**. The measurements are an input to a compliance assessment, not the assessment itself.

## References

- **EU AI Act:** Regulation (EU) 2024/1689 of the European Parliament and of the Council of 13 June 2024 laying down harmonised rules on artificial intelligence (Artificial Intelligence Act). EUR-Lex: <http://data.europa.eu/eli/reg/2024/1689/oj>.
- **GLBA Privacy Rule:** 16 CFR Part 313 — Privacy of Consumer Financial Information; specifically 16 CFR § 313.3(n) for the NPI definition. <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-313>.
- **FTC Safeguards Rule:** 16 CFR Part 314 — Standards for Safeguarding Customer Information. <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-314>.
- **PCI-DSS v4.0:** Payment Card Industry Data Security Standard, Version 4.0; Glossary (Account Data, Cardholder Data, Sensitive Authentication Data definitions) + Section 3.2.1 (storage-retention requirement that references those terms). <https://www.pcisecuritystandards.org/document_library>.
- **HIPAA Safe Harbor enumeration (structural model, NOT regulatory frame):** HHS Office for Civil Rights — *Guidance Regarding Methods for De-identification of Protected Health Information*. <https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html>.
- **17 U.S.C. § 105 — Subject matter of copyright: United States Government works.** <https://www.copyright.gov/title17/92chap1.html#105>.
- **CFPB Consumer Complaint Database documentation:** <https://www.consumerfinance.gov/data-research/consumer-complaints/>.
- **CFPB data download:** <https://files.consumerfinance.gov/ccdb/complaints.csv.zip>.

## Dataset integrity record (populated after first download)

Recorded by `pnpm dataset:download:finance` (or fill manually on first acquisition):

- `complaints.csv` SHA-256: *(populated after first run; see `datasets/finance/raw/EXPECTED-HASH.txt`)*
- Row count: *(populated)*
- Acquisition date (UTC): *(populated)*
- Acquisition curl version: *(populated)*
