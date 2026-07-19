# pii-bank — labeled-data bank for the GLiNER fine-tune pilot

Schema, quarantine tooling, and fully-synthetic seed rows for the PII labeled-data
bank described in the governing PRD
`prd-2026-07-19-pii-data-bank-finetune-pilot.md` (operator-local `specs/`
directory, Status Locked).

This directory is **PUBLIC** (`Declade/lucairn-research`, default branch `main`).
Per the PRD's Locked constraint on data placement, it contains **schema, tooling,
the eval-quarantine manifest (hashes only), and fully-synthetic seed rows only.**
Every row with `provenance` other than `synthetic-generated` — measured-live gate
findings, dogfood transcripts, and eval-only imports from other repos — lives in
a LOCAL-ONLY root on the operator machine (see below) and is referenced from here
by local-root-relative path + sha256, never by content and never by absolute
personal path. See `manifest.json` and `INTAKE.md`.

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
  measured/eval-only asset referenced by this bank (see below). `local` entries
  are recorded **relative to the local root** — never as absolute paths.
- `validate.py` — stdlib-only CLI: schema validation, quarantine enforcement,
  manifest hash verification (`--check-manifest`), train/eval contamination
  scan (`--contamination`), and an always-on path-hygiene guard that hard-fails
  any manifest entry embedding a personal home-directory path (this repo is
  public; home paths are a personal-info leak class).
- `tests/test_validate.py` — pytest coverage for every FAIL class.
- `INTAKE.md` — discipline doc: how a verified finding becomes a bank row, and
  the org-scoping design.
- `rows/synthetic-seed.jsonl` — 5–10 fully-synthetic demonstration rows proving
  the schema round-trips through `validate.py`.

## Local-only root

Manifest `local` entries resolve against a configurable root on the operator
machine, set via the env var **`PII_BANK_LOCAL_ROOT`** (default:
`~/Opus Advisor`). This keeps the public manifest free of machine-specific
absolute paths and makes the tooling portable — another machine holding the
same corpora simply sets a different root. Under that root:

- `context/pii-bank/eval-imports/` — pristine copies of the two DSA eval
  fixtures extracted from `origin/main` (see `manifest.json` for hashes + the
  exact commit SHA).
- `context/pii-bank/measured/` — measured/dogfood rows; never committed here.
- `specs/` and `context/sanitizer-recall/` — the measured corpora referenced
  by the manifest's other `local` entries.

Missing local files downgrade to WARN-skip in `--check-manifest` (the public
repo's CI cannot see the operator machine); hash MISMATCHES on readable files
always FAIL.

## Usage

```bash
cd pii-bank
python3 validate.py                    # schema + quarantine + path-hygiene checks
python3 validate.py --check-manifest   # + recompute manifest hashes
python3 validate.py --contamination    # + train/eval n-gram overlap scan
python3 -m pytest tests/               # unit tests

# resolve manifest 'local' entries against a non-default root:
PII_BANK_LOCAL_ROOT=/path/to/root python3 validate.py --check-manifest
```
