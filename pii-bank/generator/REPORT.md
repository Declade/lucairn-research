# S2 composition-repair report

**Fable-authorized composition repair.** Headline counts are canonical-unique signal; raw rows are secondary.
The train checkpoints contain no dev lineages. `dev.jsonl` is frozen separately and is not part of any physical shard or cumulative checkpoint.

## Cumulative train checkpoints — distinct signal headline

| Checkpoint | Bucket | Canonical unique examples | Tokens | Spans | Raw rows | Families | Rows/family | Masked signatures | Max masked multiplicity | Unique incremental signal |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | contextual_hard_negative | 250 | 5221 | 250 | 250 | 125 | 2 | 250 | 1 |  |
| 1000 | structural_domain_positive | 250 | 8464 | 250 | 250 | 125 | 2 | 250 | 1 |  |
| 1000 | general_synthetic | 500 | 10980 | 250 | 500 | 250 | 2 | 500 | 1 | 1000 |
| 3000 | contextual_hard_negative | 750 | 15395 | 750 | 750 | 375 | 2 | 750 | 1 |  |
| 3000 | structural_domain_positive | 750 | 25708 | 750 | 750 | 375 | 2 | 750 | 1 |  |
| 3000 | general_synthetic | 1500 | 32970 | 750 | 1500 | 750 | 2 | 1500 | 1 | 2000 |
| 8000 | contextual_hard_negative | 2000 | 41691 | 2000 | 2000 | 1000 | 2 | 2000 | 1 |  |
| 8000 | structural_domain_positive | 2000 | 69116 | 2000 | 2000 | 1000 | 2 | 2000 | 1 |  |
| 8000 | general_synthetic | 4000 | 87997 | 2000 | 4000 | 2000 | 2 | 4000 | 1 | 5000 |

## Physical train shards — separate from cumulative checkpoints

| Shard | Raw rows | Canonical unique examples | Hard | Struct | General |
|---|---:|---:|---:|---:|---:|
| generated-1k.jsonl | 1000 | 1000 | 250 | 250 | 500 |
| generated-3k.jsonl | 2000 | 2000 | 500 | 500 | 1000 |
| generated-8k.jsonl | 5000 | 5000 | 1250 | 1250 | 2500 |

## Frozen dev and split overlap

- Frozen dev: 2000 raw/canonical-unique rows; hard=500, struct=500, general=1000; sha256 is recorded in `rows/DEV-MANIFEST.md`.
- Exact canonical train↔dev overlap: 0. Masked-context train↔dev overlap: 0. Masked multiplicity max: 1.
- Nearest masked train char-5-gram Jaccard for dev: p50=0.4887, p95=0.5978, max=0.7143, ≥0.80 tail=0/2000; ≥0.90 ceiling failures: 0.
- Vocabulary allocation: every source-pool surface appears under at least one train lineage and one disjoint dev lineage. Derived structural identifier forms follow the named residual policy below.

## Descope residuals — derived identifier-form dev coverage

- Train-only derived form: `jonas_vale_admin` (EN).
- Train-only derived form: `maja_kuehn_admin` (DE).
- Reason: template scarcity under lineage-disjointness; neither form is selected by the four held-out structural frame lineages. The snake-slug class is dev-covered through every other derived identifier form. This is the predeclared descope rule, not padding or a source-vocabulary exception.

## Determinism re-proof

- Regeneration is byte-identical under `PYTHONHASHSEED=0`, `12345`, and `random`; selection uses explicit seeded PRNGs, ordered tuples, and sorted JSON keys only.
- Locale consideration: no locale-sensitive collation or formatting is used; Unicode normalization for corpus identity is explicit NFKC + casefold.
