# Lucairn Research Program

**Open-source PII detection benchmarks and re-identification risk evaluation for LLM pipelines under the EU AI Act, HIPAA, and GLBA.**

Empirical methodology code behind the per-industry vendor-published benchmark papers at [lucairn.eu/research](https://lucairn.eu/research). Every quantitative claim in every paper traces back to a script in this repo. Clone, install, run.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Papers](https://img.shields.io/badge/papers-2_shipped-blue)](https://lucairn.eu/research)
[![Lucairn](https://img.shields.io/badge/built_by-Lucairn-black)](https://lucairn.eu)

> Lucairn is the AI evidence layer for EU regulated companies. Per-row signed cryptographic certificates over every LLM call, in evidence formats EU AI Act Articles 10, 12, 14, and 15 reference. This repo is the open methodology code behind the benchmark papers. Code is MIT-licensed; per-dataset license is documented in each `datasets/<industry>/RECIPE.md`.

---

## Published papers

| # | Industry | Paper | Dataset | Regulation surface |
|---|---|---|---|---|
| 1 | Healthcare / clinical | **[Clinical PII redaction benchmark (MTSamples, HIPAA Safe Harbor)](https://lucairn.eu/en/research/clinical-pii-redaction-benchmark)** | MTSamples (Kaggle, CC0) + synthetic PII re-injection at i2b2 density | EU AI Act Annex III high-risk healthcare; HIPAA Safe Harbor (45 CFR § 164.514(b)(2)) |
| 2 | Finance / consumer-banking | **[Financial PII redaction benchmark (CFPB Consumer Complaint Database, GLBA NPI)](https://lucairn.eu/en/research/financial-pii-redaction-benchmark)** | CFPB Consumer Complaint Database (US federal public domain) + synthetic NPI re-injection | EU AI Act Annex III high-risk finance; GLBA NPI (16 CFR Part 313) |

Each paper is published in three places:

- A canonical landing page on `lucairn.eu/research/<slug>` (linked above)
- A long-form blog write-up on `lucairn.eu/blog/<slug>` for general readers
- This repository — full methodology, per-dataset RECIPE, signed-certificate appendices, and the harness code that produced the numbers

---

## What this repo is

The complete, independently-reproducible methodology code behind every Lucairn Research Program paper: dataset acquisition, PII re-injection harness, end-to-end pipeline runner against a Lucairn gateway, per-category recall computation, and per-paper appendix generation.

**Designed for independent reproducibility.** Clone, install, set two environment variables (`LUCAIRN_GATEWAY_URL`, `LUCAIRN_API_KEY`), run `pnpm dataset:download && pnpm dataset:inject-pii && pnpm run pipeline`. A third-party reader who disagrees with a number can re-run it.

## What this repo is NOT

- Not a Lucairn product. The Lucairn platform itself (gateway, sanitizer, witness, certificate verifier) lives in separate repositories.
- Not a customer-deployment artifact. These are vendor-published methodology papers; the publisher and the methodology are named in full. No customer attribution, no persona-driven narrative, no attributed endorsement quotes.
- Not a CLI or a publishable npm package. It is a methodology codebase, run from a clone.
- Not a customer-implementation report. The artifact frame is a vendor benchmark / methodology paper.
- Not legal advice. Regulatory references are factual citations to primary sources (EUR-Lex Regulation 2024/1689; HHS HIPAA Safe Harbor enumeration; 16 CFR Part 313 GLBA NPI enumeration; published clinical-NLP de-identification literature); they are not interpretations.

---

## EU AI Act Annex III compliance context

EU AI Act enforcement is rolling. The relevant calendar for high-risk classification:

- **2 February 2025** — Article 5 prohibitions in force.
- **2 August 2025** — General-Purpose AI Model (GPAI) obligations in force.
- **2 August 2026** — Chapter III high-risk-system obligations (Articles 8–15) apply for AI systems newly placed on the market in the Annex III high-risk areas (Article 6(2)). This is the trigger date Paper 1's and Paper 2's measurements are scoped to.
- **2 August 2027** — Article 6(1) classification (high-risk AI as safety components of products covered by Annex I Union harmonisation legislation) applies. Pre-existing high-risk systems and GPAI models follow the separate timeline in Article 111.

Sources: Regulation (EU) 2024/1689 Articles 6, 111, 113; AI Office Service Desk; artificialintelligenceact.eu.

Each paper's headline measurement is **Cat-1 evidence completeness** (AI Act Articles 10 and 15 — data governance and accuracy/robustness) for a specific Annex III high-risk industry use case. The methodology — every row produces a signed cert with full lineage — incidentally produces evidence relevant to Cat-2 (Article 12 record-keeping) and Cat-3 (the inventory bundle of Articles 10 + 12 + 14 + 15), but those are not the headline claim.

---

## Methodology summary

Each paper uses the same two-measurement structure because no publicly redistributable dataset in the regulated industries we care about ships with annotated ground-truth PII labels.

1. **Measurement A — raw-corpus detection.** Lucairn runs over the full corpus. Reports detection counts per regulatory category (HIPAA Safe Harbor for healthcare; GLBA NPI for finance). **No ground-truth recall is claimed** — there is no published per-token annotation.
2. **Measurement B — known-ground-truth recall.** A 500-row deterministic-seed subset is augmented with synthetic PII at literature-baseline density (~20–25 PHI entities per healthcare note, after Stubbs & Uzuner 2015; equivalent NPI density for finance). Recall and precision are measured against the **known injected entities only**; real residual PII in this subset is acknowledged but not counted as ground truth.

Full methodology in:

- [`datasets/healthcare/RECIPE.md`](./datasets/healthcare/RECIPE.md) — MTSamples acquisition, HIPAA Safe Harbor category mapping, synthetic PII injection at i2b2 density.
- [`datasets/finance/RECIPE.md`](./datasets/finance/RECIPE.md) — CFPB Consumer Complaint Database acquisition, GLBA NPI category mapping, synthetic NPI injection.

---

## Reproduce a paper

### Paper 1 — Healthcare (HIPAA Safe Harbor, MTSamples)

```bash
git clone https://github.com/Declade/lucairn-research.git
cd lucairn-research
pnpm install
pnpm dataset:download         # uses Kaggle CLI; requires ~/.kaggle/kaggle.json
pnpm dataset:inject-pii       # deterministic Faker-seeded PII injection
pnpm dataset:verify-injection # round-trip + SHA-256 check
pnpm test                     # methodology unit tests
```

Then run the harness against a Lucairn gateway (set `LUCAIRN_GATEWAY_URL` and `LUCAIRN_API_KEY`):

```bash
pnpm run pipeline -- --rows=500 --output=/tmp/paper-1-raw.ndjson
pnpm run collect-certs -- --input=/tmp/paper-1-raw.ndjson --output=/tmp/paper-1-CERTIFICATES.csv
pnpm run compute-recall \
  -- --truth=datasets/healthcare/with-injected-pii/ground-truth.jsonl \
  --redactions-source=ndjson \
  --rows=500 \
  --output=/tmp/paper-1-SUMMARY.json
```

For a mock-only smoke run that exercises the math layer without calling a live gateway, append `--mock` to the pipeline command.

### Paper 2 — Finance (GLBA NPI, CFPB Consumer Complaint Database)

```bash
pnpm dataset:download:finance          # downloads complaints.csv.zip from CFPB public file server
pnpm dataset:inject-finance-pii        # deterministic Faker-seeded NPI injection
pnpm dataset:verify-finance-injection  # round-trip + SHA-256 check
pnpm run pipeline -- --industry=finance --rows=500 --output=/tmp/paper-2-raw.ndjson
pnpm run analyze:finance -- --input=/tmp/paper-2-raw.ndjson
```

### Prerequisites

- Node.js ≥ 18.17 (matches `package.json` `engines.node`)
- pnpm 10.x
- Kaggle CLI installed (`pipx install kaggle`) with a working `~/.kaggle/kaggle.json` API token (Paper 1 only — Paper 2's CFPB dataset is downloaded via direct HTTPS).
- A Lucairn gateway URL + API key for the live harness (for mock-only smoke runs neither is required).

---

## Repository structure

```
lucairn-research/
├── README.md
├── LICENSE                                  # MIT (code)
├── CITATION.cff                             # cite this repository
├── package.json                             # private, methodology code only
├── tsconfig.json
├── .github/workflows/ci.yml                 # typecheck + build + test on Ubuntu + macOS × Node 18/20/22
├── src/
│   ├── csv.ts                               # CSV / NDJSON helpers
│   ├── gateway-client.ts                    # Lucairn gateway HTTP client
│   ├── hipaa-category-mapping.ts            # Paper 1 — HIPAA Safe Harbor 18 identifier mapping
│   ├── glba-category-mapping.ts             # Paper 2 — GLBA NPI category mapping
│   ├── inject-pii-core.ts                   # healthcare PII injector
│   ├── inject-finance-pii-core.ts           # finance NPI injector
│   ├── recall.ts                            # per-category recall / precision / F1
│   └── redaction-extractor.ts               # parse Lucairn redaction events
├── scripts/
│   ├── download-mtsamples.ts                # Kaggle CLI wrapper for Paper 1
│   ├── download-cfpb.ts                     # CFPB public file download for Paper 2
│   ├── inject-pii.ts                        # Paper 1 injection
│   ├── inject-finance-pii.ts                # Paper 2 injection
│   ├── verify-injection.ts                  # round-trip + SHA-256 invariant (Paper 1)
│   ├── verify-finance-injection.ts          # round-trip + SHA-256 invariant (Paper 2)
│   ├── run-pipeline.ts                      # end-to-end harness against the gateway
│   ├── collect-certs.ts                     # CERTIFICATES.csv appendix generator
│   ├── compute-recall.ts                    # SUMMARY.json generator
│   ├── analyze-finance-ndjson.ts            # Paper 2 detection-rate analysis
│   └── compare-finance-summaries.py         # Paper 2 baseline vs tuned diff
├── papers/
│   ├── _template/                           # paper-output schema (SUMMARY.schema.json)
│   ├── paper-1-healthcare/                  # Paper 1 artifacts, raw results, sanitizer config
│   └── paper-2-finance/                     # Paper 2 SUMMARY baseline + tuned, raw results
└── datasets/
    ├── healthcare/
    │   ├── RECIPE.md                        # Paper 1 full methodology + license + sources
    │   ├── raw/                             # gitignored; populated by `pnpm dataset:download`
    │   └── with-injected-pii/               # gitignored; populated by `pnpm dataset:inject-pii`
    └── finance/
        ├── RECIPE.md                        # Paper 2 full methodology + license + sources
        ├── raw/                             # gitignored; populated by `pnpm dataset:download:finance`
        └── with-injected-pii/               # gitignored; populated by `pnpm dataset:inject-finance-pii`
```

---

## Citation

A machine-readable citation is in [`CITATION.cff`](./CITATION.cff) (GitHub's "Cite this repository" feature surfaces it on the repo sidebar). For a specific paper, cite the paper's canonical URL on `lucairn.eu/research/<slug>` and the repository commit SHA that produced its `SUMMARY.json`.

---

## License

- **Code:** MIT — see [`LICENSE`](./LICENSE).
- **Per-paper datasets:** see each `datasets/<industry>/RECIPE.md` for license + provenance.
  - Paper 1 (MTSamples): CC0 1.0 Universal (Kaggle).
  - Paper 2 (CFPB Consumer Complaint Database): US federal government work, public domain (17 U.S.C. § 105).

---

## Related Lucairn surfaces

- [lucairn.eu/research](https://lucairn.eu/research) — Research Program index, paper landing pages.
- [lucairn.eu/blog](https://lucairn.eu/blog) — Long-form blog write-ups, including non-paper engineering posts (architecture, compliance, hardware evaluation).
- [lucairn.eu](https://lucairn.eu) — Lucairn platform homepage (the product behind the methodology).
