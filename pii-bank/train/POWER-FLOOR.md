# S3 frozen power floors

These numeric minima are copied verbatim from the frozen `rows/DEV-MANIFEST.md` before training. They are minimum cases and labeled spans, not target counts.

| Bucket | Class | Lang | Minimum cases | Minimum spans |
|---|---|---|---:|---:|
| contextual_hard_negative | de | de | 100 | 100 |
| contextual_hard_negative | location | en | 100 | 100 |
| contextual_hard_negative | region | en | 100 | 100 |
| contextual_hard_negative | role | en | 100 | 100 |
| contextual_hard_negative | vendor | en | 100 | 100 |
| structural_domain_positive | name-in-technical-zone | de | 250 | 250 |
| structural_domain_positive | name-in-technical-zone | en | 250 | 250 |
| general_synthetic | general-person-clean-control | de | 500 | 250 |
| general_synthetic | general-person-clean-control | en | 500 | 250 |

A future dev artifact below any row's floor makes the affected success bar **INCONCLUSIVE**; it is never silently relabeled NO-GO. `powerfloor_freeze.py --check` is the pre-training gate.
