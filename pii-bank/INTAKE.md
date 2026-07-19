# INTAKE — how a finding becomes a bank row

This doc is the intake discipline for the pii-bank (see `README.md` for the row
schema, `manifest.json` for the eval-quarantine manifest). Governing PRD:
`prd-2026-07-19-pii-data-bank-finetune-pilot.md`.

## How a verified gate finding / differential FP / live-run case becomes a row

1. **Identify the source.** Every row's `source` field must point back to a
   concrete artifact: a findings doc, a gate round, or a generator run id.
   Never author a row from memory or from an unverified claim.

2. **Label it.** Determine the `lang`, `zone` (mirrors the two-lane zoner
   taxonomy), and every `spans` entry (`start`/`end` Unicode codepoint offsets
   — Python `str` indices — into `text`, `category`, `expected: REDACT|KEEP`,
   and the REQUIRED `surface` string, which must equal `text[start:end]`
   exactly; author offsets with `str.find`/`str.index`, never on encoded
   bytes). If the finding is a contrast pair
   (same surface form, different expected outcome depending on context — e.g.
   "integration user" as a system role vs. a name-adjacent phrase), author
   BOTH sides as separate rows sharing one `family_id`.

3. **Tag provenance + consent_basis + split.**
   - A finding that came from a **measured/live gate run, a differential, or
     Marc's own dogfood transcript** gets `provenance: measured-live` or
     `provenance: dogfood`, and `consent_basis` reflecting how that data was
     obtained (`own-data` for Marc's dogfood, `contracted` if a customer
     engagement's own environment produced it under contract — never anything
     that implies pooled/cross-customer use). These rows are **eval-only**
     (`split: eval-only`) by construction — see Quarantine rules in
     `README.md`. **They are never committed to this repo.** They go under
     the LOCAL-ONLY root (env `PII_BANK_LOCAL_ROOT`, default
     `~/Opus Advisor`) at `context/pii-bank/measured/`, and are referenced
     from this repo's `manifest.json` by local-root-relative path + sha256 —
     never by absolute personal path (`validate.py` hard-fails those).
   - A finding that is **re-synthesized** as a fresh, non-identifying variant
     (same class of surface form/context, different actual content — e.g. a
     different snake_case identifier that exhibits the same FP class as a
     measured one) gets `provenance: synthetic-generated`, `consent_basis:
     synthetic`, and may carry `split: train` or `split: dev`. This is the
     ONLY path by which a verified real-world finding's *signal* enters
     training data — the row content itself is never the original measured
     text.
   - An externally sourced eval asset **imported wholesale** (e.g. a public
     PII benchmark corpus admitted per the base-mix protocol) gets
     `provenance: eval-import`.

4. **Run `validate.py` before committing anything.** It will hard-fail any
   row that violates the quarantine rules (train/dev + non-synthetic
   provenance; in-repo + measured/dogfood provenance; a `family_id` split
   across multiple `split` values).

## Org-scoping (three-tier design; schema only — no build here)

The bank's `org_id` field exists so this workstream's schema doesn't need a
painful retrofit when the future Enterprise per-org tier is built. Per the
PRD (`prd-2026-07-19-pii-data-bank-finetune-pilot.md` § Out of scope, and the
research assessment `specs/findings-2026-07-19-pii-sanitization-research-assessment.md`
§ Org-scoping), the design has three tiers:

1. **Global (`org_id: null`)** — the default, and the ONLY tier this pilot
   trains against. Every row in `rows/synthetic-seed.jsonl` and every row
   this pilot's synthetic corpus (S2) generates is global.
2. **Per-org Enterprise custom-shield** — a future paid add-on (locked in
   `CLAUDE.md` § Locked decisions: "Custom-trained level-3 PII shield =
   Enterprise-only", always framed as "Custom-trained PII shield (your domain
   corpus, priced per scope)"). A customer's `org_id`-tagged rows would train
   a shield fine-tuned on THEIR domain corpus only.
3. **No cross-org pooling** — an org's rows are never mixed into another
   org's fine-tune, and never mixed into the global tier without an explicit,
   separately-authorized re-classification step. This bank's schema records
   `org_id` at row-creation time specifically so that boundary is enforceable
   later without having to re-audit every historical row for its true origin.

Building the per-org tier itself — intake pipeline, isolation guarantees,
billing, retraining cadence — is **out of scope for this PRD** and requires
its own grill + PRD.

## Retrain cadence

Out of scope for this PRD. A future PRD will define how often the bank's
synthetic corpus gets regenerated, how active-learning candidates from
production gate findings get triaged into new rows, and what triggers a
re-fine-tune. Nothing in this slice implies a cadence commitment.
