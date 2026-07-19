# S4 frozen final-eval input format

`eval_model.py` is a span scorer, not a heuristic converter of measured text.
Every score therefore needs frozen codepoint spans and expected actions. The
S3 dev artifact already has that schema. Before S4 evaluates a quarantined
asset whose native format is a measurement JSON, prose report, or rendered
expected-output fixture, S4 must create one local-only, hash-recorded canonical
companion. This is the resolution of the format ambiguity in the existing
quarantine manifest: it records asset hashes and custody, not a universal
span-label schema.

The companion is JSONL, JSON (`rows`/`items`/`cases`/`examples`/`data` list),
or Markdown containing a fenced JSON/JSONL payload. Each row is:

```json
{"text":"Ada","lang":"en","spans":[{"start":0,"end":3,"category":"PERSON","expected":"REDACT"}]}
```

Offsets are Python `str` codepoint offsets; `expected` is `REDACT` or `KEEP`.
The scorer fails closed for missing text, offsets, category, or action. It
preserves an explicitly labelled additional model-lane category for final
evaluation rather than dropping it: the GLiNER prompt is the category label and
the score reports that category separately. This does not alter S3's frozen
five-label training map.

S4 first invokes `eval_model.py --final-eval --manifest-entry …`, which prints
the custody warning and verifies the native asset's manifest SHA-256. For an
asset without native canonical rows, it also passes `--normalized-eval` and
`--normalized-eval-metadata`. The required metadata JSON is:

```json
{"source_manifest_entry":"…","source_manifest_sha256":"…","companion_sha256":"…"}
```

The scorer verifies all three fields before it reads or scores the companion,
then emits the companion's local-root-relative reference and SHA-256 in its
result. Both files must be under `PII_BANK_LOCAL_ROOT`; they are never
selection/training inputs.
