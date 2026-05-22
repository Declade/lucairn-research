# Paper 2 sanitizer-config artifacts

This directory contains the recognizer + safelist artifacts the Paper 2 benchmark added to the live Lucairn sanitizer at `gateway.lucairn.eu`. These files are the **reproducible reference** — the in-tree mirror of what is deployed on `/opt/dsa/services/sanitizer/` on the production gateway.

The files were applied to the live sanitizer between the baseline (`papers/paper-2-finance/raw-results/baseline-500row-<ts>.ndjson`) and the tuned (`papers/paper-2-finance/raw-results/tuned-500row-<ts>.ndjson`) runs. The before/after deltas are documented in [`../../../docs/paper-2-finance/`](../) and the blog post at `lucairn.eu/blog/financial-pii-redaction-benchmark`.

## Files

- `recognizers.py` — the `paper2_*` `PatternRecognizer` entries added to `RECOGNIZER_DEFINITIONS` in `/opt/dsa/services/sanitizer/recognizers.py`. Snippet only — paste into the live file alongside the existing `paper1_*` entries.
- `finance-terms.txt` — a consumer-finance safelist loaded by `_load_safe_terms` in `/opt/dsa/services/sanitizer/presidio_scan.py:343-365`. Multi-character vocabulary only.

## Honest caveats

These recognizers and safelist were tuned to the synthetic-injection shapes used in this benchmark (deterministic prefix-coded IDs, US bank brand names, etc.). They are **not production-ready** for arbitrary consumer-finance corpora:

1. The `paper2_bank_account`, `paper2_card_cvv`, `paper2_credit_score`, and `paper2_account_balance` recognizers carry deliberately low base scores and rely on context words to fire. Real-world consumer-finance text contains many ambiguous 3-12 digit numbers that the context-gating limits but does not eliminate.

2. The `paper2_driver_license` and `paper2_loan_account_id` recognizers only fire because our synthetic injection uses the `DL-` / `LN-` prefixes. They do not generalise to real-world driver-license or loan-account shapes — those vary per state, per institution, and per loan product.

3. The `finance-terms.txt` safelist is calibrated to **US** consumer-finance vocabulary. Non-US deployments (EU, UK, APAC) will see different bank brand names, different card-network names (Maestro, Cartes Bancaires, JCB more prominent), different regulator abbreviations, and different colloquial terms.

The point of shipping these as a published artifact is not to claim they generalise — it is to make the empirical "tight regex per weak category + context-gated safelist" pattern reproducible by anyone running the same benchmark or running it against their own corpus.

## Reproducibility

To apply these to a self-hosted Lucairn sanitizer (matching the production
deployment path used for Paper 2):

1. Append the `paper2_*` entries from `recognizers.py` to your sanitizer's
   `RECOGNIZER_DEFINITIONS` dictionary in `services/sanitizer/recognizers.py`.
2. Append the contents of `finance-terms.txt` to your sanitizer's
   safelist file (e.g. `config/medical-terms.txt` in the dual-sandbox stack;
   the file is wired via `safe_terms_file` in `config/default-sanitizer.yaml`).
   The Lucairn safelist mechanism reads a single file; rename it to something
   generic like `safe-terms.txt` if you want to keep the naming honest after
   merging multiple verticals.
3. Add the paper2_* recognizer names to the `custom_recognizers:` list in
   `default-sanitizer.yaml` so they actually load (they are registered in
   `RECOGNIZER_DEFINITIONS` but only enabled per-customer through this list).
4. Restart the sanitizer container with your stack's canonical overlay set
   (`docker compose ... up -d --no-deps --force-recreate sanitizer`).
5. Verify: the startup log lists the active recognizer names; you should see
   `paper2_aba_routing`, `paper2_bank_account`, etc. The safelist size should
   match `wc -l finance-terms.txt + (old medical-terms.txt line count)`.

## License

MIT (same as the rest of the `lucairn-research` repo).
