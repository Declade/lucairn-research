#!/usr/bin/env python3
"""
run_sanitizer_probe.py

S5-BASELINE driver: runs the CURRENT (pre-Slice-3) L1+L2 sanitizer detection
code from dual-sandbox-architecture/services/sanitizer, in-process, against
the ITSM gold fixture set, and emits PredictedRecord[]-shaped JSON matching
lucairn-research/src/redact-eval/schema.ts's PredictedRecord interface.

READ-ONLY against dual-sandbox-architecture: this script only imports its
Python modules (sys.path insert) and instantiates PresidioScanner using the
exact config values from dual-sandbox-architecture/config/default-sanitizer.yaml
(the real product-default config, not the services/sanitizer/config/ fragment
which is explicitly documented as NOT the production default). No files in
dual-sandbox-architecture are written to.

L1 (KnownEntityMatcher) is constructed with an EMPTY identity_fields dict —
this is not a shortcut: L1 matches known identity-field VALUES seeded from a
customer's own directory/CRM data (see known_entity.py KnownEntityMatcher
constructor + FIELD_TYPE_MAP). A synthetic freetext ITSM ticket-notes corpus
has no such directory to seed from, so L1 correctly contributes zero matches
here by construction, exactly as it would in a fresh customer environment
before any identity-field ingestion. The baseline is therefore an HONEST
L1+L2 run, not an L2-only run dressed up as L1+L2 — L1 is exercised (the
matcher runs), it just has nothing to match against.

Output: PredictedRecord[] JSON (schema.ts) written to stdout or --output.
"""
import argparse
import json
import os
import sys
from pathlib import Path


def _resolve_dir(cli_value: str | None, env_var: str, label: str) -> Path:
    """Resolve a required directory from --flag > env var, with no default
    that would bake in a personal path. Fails loudly if neither is set."""
    raw = cli_value or os.environ.get(env_var)
    if not raw:
        sys.exit(
            f"error: {label} not set. Pass --{label.lower().replace('_', '-')} "
            f"or set the {env_var} environment variable to the path of your "
            f"dual-sandbox-architecture clone's {label} (read-only; never written to)."
        )
    return Path(raw)


def _parse_known_args() -> argparse.Namespace:
    """Parse just the two dir-resolution flags early, before the rest of
    argparse setup, since SANITIZER_DIR must be on sys.path before the
    sanitizer-module imports below can succeed."""
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--sanitizer-dir")
    ap.add_argument("--config-dir")
    known, _ = ap.parse_known_args()
    return known


_early_args = _parse_known_args()
SANITIZER_DIR = _resolve_dir(_early_args.sanitizer_dir, "DSA_SANITIZER_DIR", "SANITIZER_DIR")
CONFIG_DIR = _resolve_dir(_early_args.config_dir, "DSA_CONFIG_DIR", "CONFIG_DIR")

sys.path.insert(0, str(SANITIZER_DIR))

from known_entity import KnownEntityMatcher  # noqa: E402
from language import detect_language  # noqa: E402
from placeholders import PlaceholderRegistry  # noqa: E402
from presidio_scan import PresidioScanner  # noqa: E402
from recognizers import get_recognizers, build_extra_person_recognizer  # noqa: E402

# ---------------------------------------------------------------------------
# Production config values, copied VERBATIM from
# dual-sandbox-architecture/config/default-sanitizer.yaml (sanitizer.presidio
# + sanitizer.known_entity_matching sections), read on 2026-07-04. If that
# YAML changes, re-sync this list — this is a literal transcription, not a
# YAML loader, because config.py's full loader pulls in redis / prometheus /
# grpc plumbing this standalone probe deliberately avoids.
# ---------------------------------------------------------------------------
CUSTOM_RECOGNIZER_NAMES = [
    "sozialversicherungsnummer", "us_ssn", "steuer_id", "personalausweisnummer",
    "german_zip_code", "credit_card_extended", "phone_extended", "german_names",
    "german_street", "date_of_birth", "account_number", "fallnummer", "vin",
    "license_plate", "swift_bic", "passport_number", "drivers_license",
    "street_address", "password", "krankenversichertennummer",
    "openai_api_key", "anthropic_api_key", "stripe_webhook_secret", "jwt_token",
    "github_pat", "credit_card_suffix_idiom",
    "german_aktenzeichen", "spanish_dni", "french_insee", "italian_codice_fiscale",
    "belgian_rnn", "dutch_bsn", "order_number",
    "de_companies", "drugs_and_diagnoses", "de_places", "software_products",
    "format_ticket", "format_numeric_run", "format_hex_block", "format_uuid",
    "format_ulid",
]
PRESIDIO_CONFIDENCE_THRESHOLD = 0.35
SAFE_TERMS_FILE = str(CONFIG_DIR / "medical-terms.txt")
STRICT_SAFE_TERMS_FILE = str(CONFIG_DIR / "safe-terms-strict.txt")
SPACY_LOCATION_STOP_TERMS_FILE = str(CONFIG_DIR / "safe-terms-strict-location.txt")
SAFE_PATTERNS = [r"-?\d{1,3}\.\d{4,}"]
SUPPORTED_LANGUAGES = ["de", "en"]
MAX_FIELD_CHARS = 16000  # app.py's field-size gate; generous headroom for short fixtures.

# GDPR-tier mapping for the sanitizer's canonical PII_TYPE labels. This is
# THIS PROBE's mapping (analogous to a future adapters/redact.ts fill-in),
# not a claim about the sanitizer's own taxonomy — the sanitizer has no
# native GDPR-tier concept. Mirrors schema.ts's tier definitions.
PII_TYPE_TO_GDPR_TIER = {
    "DOB": "HIGH", "IBAN": "HIGH", "SSN": "HIGH", "CC": "HIGH", "SECRET": "HIGH",
    "PERSON": "MED", "EMAIL": "MED", "PHONE": "MED", "ADDRESS": "MED",
    "LOCATION": "LOW", "ID": "LOW", "URL": "LOW",
}


def build_scanner() -> PresidioScanner:
    custom_recognizers = get_recognizers(CUSTOM_RECOGNIZER_NAMES)
    extra_person = build_extra_person_recognizer([])  # no operator-supplied names
    if extra_person:
        custom_recognizers.append(extra_person)
    return PresidioScanner(
        supported_languages=SUPPORTED_LANGUAGES,
        confidence_threshold=PRESIDIO_CONFIDENCE_THRESHOLD,
        safe_patterns=SAFE_PATTERNS,
        safe_terms_file=SAFE_TERMS_FILE,
        strict_safe_terms_file=STRICT_SAFE_TERMS_FILE,
        spacy_location_stop_terms_file=SPACY_LOCATION_STOP_TERMS_FILE,
        custom_recognizers=custom_recognizers,
        max_field_chars=MAX_FIELD_CHARS,
    )


def locate_span(haystack: str, needle: str, occupied: list[tuple[int, int]]) -> tuple[int, int] | None:
    """Find the next non-overlapping occurrence of `needle` in `haystack`.

    The sanitizer's ScanResult.redactions carries the matched substring
    ("original") but not its char offset (offsets are consumed internally
    for the right-to-left string-splice and discarded). To score against
    GoldEntity spans we recover offsets by locating the substring in the
    PRE-redaction text, skipping any span already claimed by an earlier
    redaction in the same record (handles duplicate substrings safely).
    """
    start = 0
    while True:
        idx = haystack.find(needle, start)
        if idx == -1:
            return None
        span = (idx, idx + len(needle))
        if not any(a < span[1] and span[0] < b for a, b in occupied):
            return span
        start = idx + 1


def run_record(scanner: PresidioScanner, text: str, language_hint: str) -> list[dict]:
    registry = PlaceholderRegistry()

    # L1: known-entity matcher, seeded with an EMPTY identity_fields dict.
    # See module docstring — correct behavior for a freetext-only fixture
    # with no customer identity directory to seed from.
    l1_matcher = KnownEntityMatcher(identity_fields={})
    l1_result = l1_matcher.scan(text, registry)

    lang = language_hint or detect_language(text)
    l2_result = scanner.scan(l1_result.text, lang, registry)

    all_redactions = list(l1_result.redactions) + list(l2_result.redactions)

    predictions = []
    occupied: list[tuple[int, int]] = []
    for r in all_redactions:
        original = r.get("original", "")
        if not original:
            continue
        span = locate_span(text, original, occupied)
        category = r.get("category", "")
        pred = {
            "start": None,
            "end": None,
            "type": category,
            "gdprTier": PII_TYPE_TO_GDPR_TIER.get(category),
            "_raw": r,
        }
        if span is not None:
            occupied.append(span)
            pred["start"], pred["end"] = span
        predictions.append(pred)
    return predictions


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument(
        "--sanitizer-dir",
        help="Path to dual-sandbox-architecture/services/sanitizer "
        "(or set DSA_SANITIZER_DIR). Read-only; never written to.",
    )
    ap.add_argument(
        "--config-dir",
        help="Path to dual-sandbox-architecture/config (or set DSA_CONFIG_DIR). "
        "Read-only; never written to.",
    )
    args = ap.parse_args()

    with open(args.fixtures) as f:
        records = json.load(f)

    scanner = build_scanner()

    predicted_by_record = []
    unresolved_spans = []
    for idx, rec in enumerate(records):
        preds = run_record(scanner, rec["text"], rec.get("language"))
        clean_preds = []
        for p in preds:
            if p["start"] is None:
                unresolved_spans.append({"record": rec["id"], "raw": p["_raw"]})
                continue
            clean_preds.append({
                "start": p["start"],
                "end": p["end"],
                "type": p["type"],
                "gdprTier": p["gdprTier"],
            })
        predicted_by_record.append({"recordIndex": idx, "predictions": clean_preds})

    out = {
        "predictedByRecord": predicted_by_record,
        "unresolvedSpans": unresolved_spans,
        "meta": {
            "sanitizer_source": str(SANITIZER_DIR),
            "config_source": str(CONFIG_DIR / "default-sanitizer.yaml"),
            "presidio_confidence_threshold": PRESIDIO_CONFIDENCE_THRESHOLD,
            "custom_recognizer_count": len(CUSTOM_RECOGNIZER_NAMES),
            "l1_identity_fields_seeded": 0,
            "note": "L1 KnownEntityMatcher run with empty identity_fields (no customer directory to seed on synthetic freetext fixtures) -- see script docstring.",
        },
    }
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

    print(f"Wrote {len(predicted_by_record)} records' predictions to {args.output}", file=sys.stderr)
    if unresolved_spans:
        print(f"WARNING: {len(unresolved_spans)} predicted redaction(s) could not be span-located (excluded from scoring as unmatched):", file=sys.stderr)
        for u in unresolved_spans:
            print(f"  {u}", file=sys.stderr)


if __name__ == "__main__":
    main()
