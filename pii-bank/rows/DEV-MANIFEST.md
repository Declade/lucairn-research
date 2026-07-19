# Frozen S2 dev manifest

- artifact: `dev.jsonl`
- sha256: `8c7b762e0eca7d3455c497fc503552b47fb62bab2945bdf807524f183051518f`
- rows: 2000
- canonical_unique_rows: 2000
- template_lineages: 36
- status: frozen for all S2 corpus-size selection; train shards contain zero listed lineages.
- derived_identifier_form_dev_residuals: jonas_vale_admin (en), maja_kuehn_admin (de); train-only by predeclared template-scarcity descope; all other snake-slug forms remain dev-covered.

## Power-floor obligation

| Bucket | Class | Lang | Dev rows | Dev spans |
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

S3 MUST freeze numeric minimum case/span floors BEFORE training and verify this dev satisfies them; a dev below floor ⇒ the affected bar reports INCONCLUSIVE (never silently NO-GO) per PRD § Success criteria.
