# pii-bank — labeled-data bank for the GLiNER fine-tune pilot

Schema, quarantine tooling, and fully-synthetic seed rows for the PII labeled-data
bank described in
[`prd-2026-07-19-pii-data-bank-finetune-pilot.md`](https://github.com/Declade/Opus-Advisor)
(`Opus Advisor/specs/prd-2026-07-19-pii-data-bank-finetune-pilot.md`, Status Locked).

This directory is **PUBLIC** (`Declade/lucairn-research`, default branch `main`).
Per the PRD's Locked constraint on data placement, it contains **schema, tooling,
the eval-quarantine manifest (hashes only), and fully-synthetic seed rows only.**
Every row with `provenance` other than `synthetic-generated` — measured-live gate
findings, dogfood transcripts, and eval-only imports from other repos — lives in
the LOCAL-ONLY root `~/Opus Advisor/context/pii-bank/` and is referenced from here
by absolute path + sha256, never by content. See `manifest.json` and `INTAKE.md`.

## Row schema

Every row is one JSON object per line in a `rows/*.jsonl` file. Fields:

| Field | Type | Values | Notes |
|---|---|---|---|
| `id` | string | any, unique within the bank | stable identifier |
| `text` | string | any | the labeled example text |
| `lang` | string | `en` \| `de` | |
| `zone` | string | `prose` \| `json_value` \| `json_key` \| `schema_label` \| `technical_id` \| `url` \| `code_identifier` \| `comment` \| `string_literal` | mirrors the two-lane zoner taxonomy from `design-2026-07-17-sanitizer-typed-two-lane.md` |
| `spans` | list of objects | `{start, end, category, expected}` | `start`/`end` are **byte offsets** into `text`; `expected` is `REDACT` \| `KEEP` |
| `org_id` | string \| null | any org identifier, or `null` | `null` = global (default); non-null rows are reserved for the future per-org Enterprise custom-shield tier — see `INTAKE.md` § Org-scoping |
| `provenance` | string | `synthetic-generated` \| `measured-live` \| `dogfood` \| `eval-import` | governs where the row is allowed to live and which split it may carry — see Quarantine rules below |
| `consent_basis` | string | `synthetic` \| `own-data` \| `contracted` \| `public-corpus` | |
| `split` | string | `train` \| `dev` \| `eval-only` | grouped by `family_id`, never assigned per-row (see below) |
| `family_id` | string | any | source/template/entity family identifier. **All rows sharing a `family_id` must share the same `split`** — splitting must never happen within a family, only across families. Enforced by `validate.py`. |
| `source` | string | free text | pointer back to the findings doc / gate round / generator run id that produced this row |
| `created` | string | `YYYY-MM-DD` | |

## Quarantine rules (enforced by `validate.py`)

1. Any row with `split` in `{train, dev}` **must** have `provenance = synthetic-generated`.
   Measured/dogfood/eval-import rows may only ever carry `split = eval-only`.
2. Any row physically committed under this repo's `rows/` directory must **not**
   have `provenance` in `{measured-live, dogfood}` — those rows belong in the
   local-only root, never in the public repo.
3. Rows sharing a `family_id` must all carry the same `split` value.

These rules exist so that training never touches measured/customer-adjacent
content and so a corpus can never be quietly re-split at the row level in a way
that leaks a family across train/eval (sol pre-lock r1 methodology protocol,
PRD § Methodology protocol — "Splits by FAMILY, never by row").

## Files in this directory

- `README.md` — this file (schema spec).
- `manifest.json` — eval-quarantine manifest: sha256 + location class for every
  measured/eval-only asset referenced by this bank (see below).
- `validate.py` — stdlib-only CLI: schema validation, quarantine enforcement,
  manifest hash verification (`--check-manifest`), and train/eval contamination
  scan (`--contamination`).
- `tests/test_validate.py` — pytest coverage for every FAIL class.
- `INTAKE.md` — discipline doc: how a verified finding becomes a bank row, and
  the org-scoping design.
- `rows/synthetic-seed.jsonl` — 5–10 fully-synthetic demonstration rows proving
  the schema round-trips through `validate.py`.

## Local-only root

`~/Opus Advisor/context/pii-bank/` (not part of this repo):

- `eval-imports/` — pristine copies of the two DSA eval fixtures extracted from
  `origin/main` (see `manifest.json` for hashes + the exact commit SHA).
- `measured/` — measured/dogfood rows; never committed here.

## Usage

```bash
cd pii-bank
python3 validate.py                    # schema + quarantine checks
python3 validate.py --check-manifest   # + recompute manifest hashes
python3 validate.py --contamination    # + train/eval n-gram overlap scan
python3 -m pytest tests/               # unit tests
```
