# S2 synthetic generator report

Generation is deterministic (`SEED = 20260719`) and uses only the local frame/vocabulary banks.
This is audit-driven repair round 2, a pre-training bugfix regeneration for interpretability defects, not result-driven resizing.
The physical files are cumulative, non-overlapping shards: concatenate 1k; then 1k+3k; then 1k+3k+8k to form the named checkpoints. This preserves S1 bank-wide ID uniqueness while retaining nested family-level samples.

| Checkpoint | Bucket | Rows | Tokens | Spans | Context tokens (min/mean) | REDACT | KEEP | EN | DE | prose | json_value | technical_id | code_identifier | schema_label |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | contextual_hard_negative | 250 | 2601 | 250 | 2/9.37 | 125 | 125 | 200 | 50 | 213 | 10 | 13 | 6 | 8 |
| 1000 | structural_domain_positive | 250 | 5802 | 250 | 16/23.55 | 125 | 125 | 134 | 116 | 0 | 86 | 62 | 102 | 0 |
| 1000 | general_synthetic | 500 | 5169 | 250 | 7/9.23 | 250 | 0 | 236 | 264 | 500 | 0 | 0 | 0 | 0 |
| 3000 | contextual_hard_negative | 750 | 7739 | 750 | 2/9.35 | 375 | 375 | 588 | 162 | 644 | 31 | 30 | 21 | 24 |
| 3000 | structural_domain_positive | 750 | 17236 | 750 | 16/23.33 | 375 | 375 | 392 | 358 | 0 | 260 | 204 | 286 | 0 |
| 3000 | general_synthetic | 1500 | 15540 | 750 | 7/9.24 | 750 | 0 | 720 | 780 | 1500 | 0 | 0 | 0 | 0 |
| 8000 | contextual_hard_negative | 2000 | 20880 | 2000 | 2/9.49 | 1000 | 1000 | 1624 | 376 | 1734 | 78 | 73 | 67 | 48 |
| 8000 | structural_domain_positive | 2000 | 46482 | 2000 | 16/23.55 | 1000 | 1000 | 984 | 1016 | 0 | 618 | 582 | 800 | 0 |
| 8000 | general_synthetic | 4000 | 41555 | 2000 | 7/9.27 | 2000 | 0 | 1992 | 2008 | 4000 | 0 | 0 | 0 | 0 |

## Composition checks

- Checkpoint bucket shares are exactly 25% contextual hard negatives, 25% structural/domain positives, and 50% general synthetic rows.
- Each selected family has two rows and one deterministic family split: `sha256(family_id)` last byte modulo 10 is dev for 0/1, otherwise train.
- Every hard family is a true same-surface counterfactual: German function-word surname, vendor, region, role phrase, and place/schema contexts. Structural families likewise reuse a name-bearing snake/camel/dotted identifier in person and technical contexts.
