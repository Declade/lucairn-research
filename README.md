# Lucairn Research Program

**Open-source PII detection benchmarks for LLM pipelines on regulated-industry text — measured against HIPAA Safe Harbor (Paper 1) and an operational GLBA NPI enumeration (Paper 2).**

Empirical methodology code behind the per-industry vendor-published benchmark papers at [lucairn.eu/en/research](https://lucairn.eu/en/research). Every quantitative claim in every paper traces back to a script in this repo. Clone, install, run.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Papers](https://img.shields.io/badge/papers-2_shipped-blue)](https://lucairn.eu/en/research)
[![Lucairn](https://img.shields.io/badge/built_by-Lucairn-black)](https://lucairn.eu)

> Lucairn is the AI evidence layer for EU regulated companies. Per-row signed cryptographic certificates over every LLM call, in evidence formats EU AI Act Articles 10, 12, 14, and 15 reference. This repo is the open methodology code behind the benchmark papers. Code is MIT-licensed; per-dataset license is documented in each `datasets/<industry>/RECIPE.md`.

---

## Published papers

| # | Industry | Paper | Dataset | Regulatory framework cited |
|---|---|---|---|---|
| 1 | Healthcare / clinical | **[Clinical PII redaction benchmark (MTSamples, HIPAA Safe Harbor)](https://lucairn.eu/en/research/clinical-pii-redaction-benchmark)** | MTSamples (Kaggle, CC0) + synthetic PII re-injection at i2b2 density | HIPAA Safe Harbor enumeration — 45 CFR § 164.514(b)(2)(i) |
| 2 | Finance / consumer-banking | **[Financial PII redaction benchmark (CFPB Consumer Complaint Database, GLBA NPI)](https://lucairn.eu/en/research/financial-pii-redaction-benchmark)** | CFPB Consumer Complaint Database (US federal public domain) + synthetic NPI re-injection | GLBA NPI — operational enumeration derived from 16 CFR § 313.3(n), 16 CFR Part 314, and PCI-DSS v4.0 |

Each paper is published in three places:

- A canonical landing page on `lucairn.eu/en/research/<slug>` (linked above; the `/research/<slug>` form 307-redirects to the EN-locale path)
- A long-form blog write-up on `lucairn.eu/en/blog/<slug>` for general readers
- This repository — full methodology, per-dataset RECIPE, signed-certificate appendices, and the harness code that produced the numbers

---

## What this repo is

The complete, independently-reproducible methodology code behind every Lucairn Research Program paper: dataset acquisition, PII re-injection harness, end-to-end pipeline runner against a Lucairn gateway, per-category recall computation, and per-paper appendix generation.

**Designed for independent reproducibility.** Clone, install, set two environment variables (`LUCAIRN_GATEWAY_URL`, `LUCAIRN_API_KEY`), run `pnpm dataset:download && pnpm dataset:inject-pii && pnpm run pipeline -- --live --rows=500` (or `--mock` for a no-credentials smoke run). A third-party reader who disagrees with a number can re-run it. See [Reproduce a paper](#reproduce-a-paper) for the full per-paper command sequences.

## What this repo is NOT

- Not a Lucairn product. The Lucairn platform itself (gateway, sanitizer, witness, certificate verifier) lives in separate repositories.
- Not a customer-deployment artifact. These are vendor-published methodology papers; the publisher and the methodology are named in full. No customer attribution, no persona-driven narrative, no attributed endorsement quotes.
- Not a CLI or a publishable npm package. It is a methodology codebase, run from a clone.
- Not a customer-implementation report. The artifact frame is a vendor benchmark / methodology paper.
- Not legal advice. Regulatory references are factual citations to primary sources (EUR-Lex Regulation 2024/1689; HHS HIPAA Safe Harbor enumeration; 16 CFR § 313.3(n)/(o), 16 CFR Part 314, PCI-DSS v4.0 — from which Paper 2's operational 17-category GLBA NPI enumeration is derived, since GLBA defines NPI by exclusion rather than a closed list; published clinical-NLP de-identification literature). They are not interpretations.

---

## What these papers measure (and what they do NOT claim)

The Lucairn Research Program publishes **empirical PII detection benchmarks** for LLM pipelines on regulated-industry text. Each paper measures detection-rate and recall against a published category enumeration — HIPAA Safe Harbor for Paper 1, an operational GLBA NPI enumeration for Paper 2 — using a deterministic synthetic re-injection methodology because no publicly redistributable regulated-industry corpus ships with annotated ground-truth PII labels.

The papers are **measurement evidence**, not AI Act high-risk-system deployment work. A downstream operator who builds an Annex III high-risk AI system on top of an LLM pipeline can use this kind of empirical PII-detection evidence as one input to a **GDPR Art. 32** (security of processing), **EU AI Act Art. 10** (data and data governance), or **EU AI Act Art. 15** (accuracy, robustness, and cybersecurity) compliance dossier — but the act of running and publishing the benchmark is not itself the deployment of a high-risk AI system. The papers do not adjudicate any specific Annex III use case; "healthcare" and "finance" here name the empirical corpus domain, not an Annex III classification.

The signed-certificate methodology (every row produces a signed cert with full lineage) is a property of the Lucairn platform under test, not of the benchmark itself; it incidentally produces lineage evidence relevant to **EU AI Act Art. 12** (record-keeping) for downstream systems that retain those certs.

For the EU AI Act calendar (Article 5 prohibitions in force 2 Feb 2025, GPAI obligations 2 Aug 2025, Chapter III high-risk-system obligations 2 Aug 2026, Article 6(1) classification 2 Aug 2027), see Regulation (EU) 2024/1689 Articles 6, 111, 113 and the EU AI Office Service Desk.

---

## Methodology summary

Each paper uses the same two-measurement structure because no publicly redistributable dataset in the regulated industries we care about ships with annotated ground-truth PII labels.

1. **Measurement A — raw-corpus detection.** Lucairn runs over the **deterministic 500-row carrier subset in its raw pre-injection form** (the same subset Measurement B then augments). Reports detection counts per category (HIPAA Safe Harbor for healthcare; the 17-category operational GLBA NPI enumeration for finance). **No ground-truth recall is claimed** — there is no published per-token annotation against the raw corpus. The 500-row subset (rather than the full corpus) is used for computational tractability and so the same row set carries through into Measurement B with deterministic ground truth.
2. **Measurement B — known-ground-truth recall.** The same 500-row subset is augmented with synthetic PII at controlled density (~20–25 PHI entities per healthcare note, after Stubbs & Uzuner 2015; equivalent NPI density for finance — set for methodological continuity with Paper 1, not against an empirical finance-corpus baseline). Recall and precision are measured against the **known injected entities only**; real residual PII in this subset is acknowledged but not counted as ground truth.

Full methodology in:

- [`datasets/healthcare/RECIPE.md`](./datasets/healthcare/RECIPE.md) — MTSamples acquisition, HIPAA Safe Harbor category mapping, synthetic PII injection at i2b2 density.
- [`datasets/finance/RECIPE.md`](./datasets/finance/RECIPE.md) — CFPB Consumer Complaint Database acquisition, GLBA NPI operational enumeration, synthetic NPI injection.

---

## Reproduce a paper

The `run-pipeline.ts` harness requires an explicit auth mode (`--mock` or `--live`) — there is no implicit default. `--mock` mounts an in-process msw mock and needs no credentials; `--live` requires `LUCAIRN_GATEWAY_URL` and `LUCAIRN_API_KEY` in env (or `--gateway` / `--api-key` flags).

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

**Mock-only smoke run** (exercises the math layer; no gateway, no credentials):

```bash
pnpm run pipeline -- --mock --rows=500 --output=/tmp/paper-1-raw.ndjson
pnpm run collect-certs -- --input=/tmp/paper-1-raw.ndjson --output=/tmp/paper-1-CERTIFICATES.csv
pnpm run compute-recall -- \
  --truth=datasets/healthcare/with-injected-pii/ground-truth.jsonl \
  --input=/tmp/paper-1-raw.ndjson \
  --rows=500 \
  --output=/tmp/paper-1-SUMMARY.json
```

**Live run against a Lucairn gateway** (requires credentials):

```bash
export LUCAIRN_GATEWAY_URL=https://gateway.lucairn.eu
export LUCAIRN_API_KEY=lcr_live_...          # or veil_live_... during the legacy-prefix grace window
pnpm run pipeline -- --live --rows=500 --output=/tmp/paper-1-raw.ndjson
# collect-certs + compute-recall are identical to the mock-run invocations above.
```

### Paper 2 — Finance (GLBA NPI, CFPB Consumer Complaint Database)

There is no `--industry=` flag — Paper 2 is run by pointing the harness's `--truth`, `--subset`, and `--narrative-column` flags at the finance dataset, and analyzed with `analyze:finance` (which uses GLBA-category mapping instead of HIPAA).

```bash
pnpm dataset:download:finance          # downloads complaints.csv.zip from CFPB public file server
pnpm dataset:inject-finance-pii        # deterministic Faker-seeded NPI injection
pnpm dataset:verify-finance-injection  # round-trip + SHA-256 check
```

**Mock-only smoke run:**

```bash
pnpm run pipeline -- --mock \
  --truth=datasets/finance/with-injected-pii/ground-truth.jsonl \
  --subset=datasets/finance/with-injected-pii/measurement-b-subset.csv \
  --narrative-column='Consumer complaint narrative' \
  --activity-id-prefix=paper-2-finance \
  --rows=500 \
  --output=/tmp/paper-2-raw.ndjson

pnpm run analyze:finance -- \
  --input=/tmp/paper-2-raw.ndjson \
  --output=/tmp/paper-2-SUMMARY.json
```

**Live run against a Lucairn gateway:**

```bash
export LUCAIRN_GATEWAY_URL=https://gateway.lucairn.eu
export LUCAIRN_API_KEY=lcr_live_...          # or veil_live_... during the legacy-prefix grace window
pnpm run pipeline -- --live \
  --truth=datasets/finance/with-injected-pii/ground-truth.jsonl \
  --subset=datasets/finance/with-injected-pii/measurement-b-subset.csv \
  --narrative-column='Consumer complaint narrative' \
  --activity-id-prefix=paper-2-finance \
  --rows=500 \
  --output=/tmp/paper-2-raw.ndjson

pnpm run analyze:finance -- \
  --input=/tmp/paper-2-raw.ndjson \
  --output=/tmp/paper-2-SUMMARY.json
```

Full per-flag reference: `pnpm run pipeline -- --help`.

### Prerequisites

- Node.js ≥ 18.17 (matches `package.json` `engines.node`)
- pnpm 10.x
- Kaggle CLI installed (`pipx install kaggle`) with a working `~/.kaggle/kaggle.json` API token (Paper 1 only — Paper 2's CFPB dataset is downloaded via direct HTTPS).
- For a live run: a Lucairn gateway URL + API key (`LUCAIRN_GATEWAY_URL` + `LUCAIRN_API_KEY`). Mock-only smoke runs (`--mock`) need neither.

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

A machine-readable citation is in [`CITATION.cff`](./CITATION.cff) (GitHub's "Cite this repository" feature surfaces it on the repo sidebar). For a specific paper, cite the paper's canonical URL on `lucairn.eu/en/research/<slug>` and the repository commit SHA that produced its `SUMMARY.json`.

---

## License

- **Code:** MIT — see [`LICENSE`](./LICENSE).
- **Per-paper datasets:** see each `datasets/<industry>/RECIPE.md` for license + provenance.
  - Paper 1 (MTSamples): CC0 1.0 Universal (Kaggle).
  - Paper 2 (CFPB Consumer Complaint Database): US federal government work, public domain (17 U.S.C. § 105).

---

## Related Lucairn surfaces

- [lucairn.eu/en/research](https://lucairn.eu/en/research) — Research Program index, paper landing pages.
- [lucairn.eu/en/blog](https://lucairn.eu/en/blog) — Long-form blog write-ups, including non-paper engineering posts (architecture, compliance, hardware evaluation).
- [lucairn.eu](https://lucairn.eu) — Lucairn platform homepage (the product behind the methodology).
