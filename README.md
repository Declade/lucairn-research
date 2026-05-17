# @lucairn/research

Empirical methodology code for the Lucairn Research Program — a per-industry series of vendor-published methodology papers measuring **EU AI Act Cat-1 evidence completeness (Articles 10 and 15 — data governance and accuracy/robustness)** end-to-end on real public datasets. The per-row signed-cert architecture incidentally produces evidence relevant to Articles 12 (record-keeping) and 14 (human oversight), but Cat-1 is the headline claim.

> **About the publisher.** Lucairn is the AI evidence layer for EU regulated companies. This repo is the open methodology code behind the papers at [lucairn.eu/research](https://lucairn.eu/research). Code is MIT-licensed; per-dataset license is documented in the corresponding `datasets/<industry>/RECIPE.md`.

## What this repo is

- The complete methodology code behind each Lucairn Research Program paper: dataset acquisition scripts, PII re-injection harness, end-to-end pipeline runner, recall computation, and per-paper appendix CSV generator.
- Designed for **independent reproducibility**: clone, install, set two environment variables (`LUCAIRN_GATEWAY`, `LUCAIRN_API_KEY`), run `pnpm dataset:download && pnpm dataset:inject-pii && pnpm run paper-<N>`.

## What this repo is NOT

- Not a Lucairn product. The Lucairn platform itself lives elsewhere (gateway, sanitizer, witness, certificate verifier).
- Not a customer-deployment artifact. These are vendor-published methodology papers; the publisher and the methodology are named in full. No customer attribution. No testimonials. No interviewed users.
- Not a CLI or a publishable npm package. It is a methodology codebase, run from a clone.
- Not a "case study". The artifact frame is a vendor benchmark / methodology paper; the word "case study" does not appear in any paper title, route slug, social card, or meta description.
- Not legal advice. Regulatory references are factual citations to primary sources (EUR-Lex Regulation 2024/1689; HHS HIPAA Safe Harbor enumeration; published clinical-NLP de-identification literature); they are not interpretations.

## Regulatory context

EU AI Act enforcement is rolling. The relevant calendar for Paper 1:

- **2 February 2025** — Article 5 prohibitions in force.
- **2 August 2025** — General-Purpose AI Model (GPAI) obligations in force.
- **2 August 2026** — Chapter III high-risk-system obligations (Articles 8–15) apply for AI systems newly placed on the market in the Annex III high-risk areas (Article 6(2)). This is the trigger date Paper 1's measurements are scoped to.
- **2 August 2027** — Article 6(1) classification (high-risk AI as safety components of products covered by Annex I Union harmonisation legislation) applies. Pre-existing high-risk systems and GPAI models follow the separate timeline in Article 111.

Sources: Regulation (EU) 2024/1689 Articles 6, 111, 113; AI Office Service Desk; artificialintelligenceact.eu.

Paper 1's headline measurement is **Cat-1 evidence completeness** (AI Act Articles 10 and 15 — data governance and accuracy/robustness) for an Annex III high-risk healthcare use case. The methodology — every row produces a signed cert with full lineage — incidentally produces evidence relevant to Cat-2 (Article 12 record-keeping) and Cat-3 (the inventory bundle of Articles 10 + 12 + 14 + 15), but those are not the headline claim of this paper. Subsequent industry papers in the series may shift the headline.

## Currently included

| Paper   | Industry              | Dataset                                            | Status      |
|---------|-----------------------|----------------------------------------------------|-------------|
| Paper 1 | Healthcare / clinical | MTSamples (Kaggle, CC0) + synthetic PII re-injection | In progress |

## Reproduce Paper 1

Detailed reproduction instructions ship with Paper 1 (Slices 2–3). For Slice 1 (scaffold + dataset acquisition), the steps are:

```bash
git clone https://github.com/Declade/lucairn-research.git
cd lucairn-research
pnpm install
pnpm dataset:download         # uses Kaggle CLI; requires ~/.kaggle/kaggle.json
pnpm dataset:inject-pii       # deterministic Faker-seeded PII injection
pnpm dataset:verify-injection # round-trip + SHA-256 check
pnpm test                     # methodology unit tests
```

Prerequisites:

- Node.js ≥ 18.17 (matches `package.json` `engines.node`)
- pnpm 10.x
- Kaggle CLI installed (`pipx install kaggle`) with a working `~/.kaggle/kaggle.json` API token

## Methodology summary (Paper 1)

The healthcare dataset (MTSamples) is **not institutionally de-identified**; it is raw clinical narrative from the public mtsamples.com archive (CC0 public domain). Paper 1 therefore reports two empirically distinct measurements:

1. **Measurement A — raw-corpus detection.** Lucairn runs over the full ~5,000-row raw corpus. Reports detection counts per HIPAA Safe Harbor category. **No ground-truth recall is claimed.**
2. **Measurement B — known-ground-truth recall.** A 500-row subset (deterministic random seed) is augmented with synthetic PII at i2b2-baseline density (~20–25 PHI entities per note, after Stubbs & Uzuner 2015). Recall and precision are measured against the **known injected entities only**; real residual PII in this subset is acknowledged but not counted as ground truth.

Full methodology in [`datasets/healthcare/RECIPE.md`](./datasets/healthcare/RECIPE.md).

## License

- **Code:** MIT — see [`LICENSE`](./LICENSE).
- **Dataset:** per-dataset; see [`datasets/<industry>/RECIPE.md`](./datasets/healthcare/RECIPE.md) for license + provenance.

## Repository structure

```
lucairn-research/
├── README.md
├── LICENSE                                  # MIT (code)
├── package.json                             # private, methodology code only
├── tsconfig.json
├── tsconfig.test.json
├── vitest.config.ts
├── .github/workflows/ci.yml                 # typecheck + build + test on Ubuntu + macOS × Node 18/20/22
├── src/
│   └── index.ts                             # placeholder; methodology modules added in Slices 2+
├── scripts/
│   ├── download-mtsamples.ts                # Kaggle CLI wrapper, integrity-checked
│   ├── inject-pii.ts                        # deterministic Faker-seeded PII injection
│   └── verify-injection.ts                  # round-trip + SHA-256 invariant check
├── test/
│   ├── inject-pii.spec.ts
│   └── verify-injection.spec.ts
└── datasets/
    └── healthcare/
        ├── RECIPE.md                        # full methodology, sources, license
        ├── raw/                             # gitignored; populated by `pnpm dataset:download`
        └── with-injected-pii/               # gitignored; populated by `pnpm dataset:inject-pii`
```
