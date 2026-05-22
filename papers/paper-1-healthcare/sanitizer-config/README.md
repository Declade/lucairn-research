# Paper 1 — sanitizer-config

The two artifacts in this directory are what the production Lucairn sanitizer was running for the Paper 1 healthcare benchmark "after" measurement.

| File | What it is |
|---|---|
| `recognizers.py` | Six `presidio_analyzer.PatternRecognizer` definitions (`paper1_health_plan_id`, `paper1_device_id`, `paper1_account_number`, `paper1_license_number`, `paper1_biometric_id`, `paper1_other_unique_id`). Each targets one of the six HIPAA Safe Harbor categories that out-of-the-box Presidio + spaCy missed catastrophically. |
| `medical-terms.txt` | The 100-term English clinical-vocabulary safelist appended to the existing German psychiatric safelist. Stops over-redaction of eponymous drugs/instruments/anatomy/clinical-descriptors (Foley, Marcaine, Babinski, Lasix, HEENT, Oropharynx, …). Wired into Presidio as the `safe_terms_file` parameter. |

## How to reproduce

1. Add `recognizers.py` to your Presidio analyzer registry:
   ```python
   from paper1_recognizers import PAPER1_RECOGNIZERS
   for rec in PAPER1_RECOGNIZERS.values():
       analyzer.registry.add_recognizer(rec)
   ```
2. Point Presidio's `safe_terms_file` at `medical-terms.txt`:
   ```yaml
   sanitizer:
     presidio:
       safe_terms_file: papers/paper-1-healthcare/sanitizer-config/medical-terms.txt
   ```
3. Run the harness at `scripts/run-pipeline.ts` against the 500-row dataset at `datasets/healthcare/with-injected-pii/measurement-b-subset.csv`.

## Caveats

- The regex prefixes (`HP-`, `DEV-`, `ACCT-`, `LIC-`, `BIO-FINGERPRINT-`, `STUDY-`) are tuned for MTSamples-style synthetic injection. Real-world insurer IDs, device serials, and account numbers will look different per organisation — the *pattern* of "tight regex per weak HIPAA category" generalises; the specific regexes do not.
- The safelist is multi-character, unambiguous English clinical vocabulary. Short tokens ("X", "IV", "PR", "Soft") were deliberately excluded after a v1 over-broad version tanked recall by ~20 pp.

License: MIT (see LICENSE at repo root).
