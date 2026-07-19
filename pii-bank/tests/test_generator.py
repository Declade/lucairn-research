"""S2 generator contracts: deterministic, schema-valid, grouped, and balanced."""

from __future__ import annotations

import hashlib
import importlib.util
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pytest

PII_BANK_DIR = Path(__file__).resolve().parent.parent
GENERATOR_DIR = PII_BANK_DIR / "generator"
sys.path.insert(0, str(GENERATOR_DIR))

generator_spec = importlib.util.spec_from_file_location("s2_generate", GENERATOR_DIR / "generate.py")
generator = importlib.util.module_from_spec(generator_spec)
sys.modules["s2_generate"] = generator
generator_spec.loader.exec_module(generator)  # type: ignore[union-attr]

validator_spec = importlib.util.spec_from_file_location("s2_validate", PII_BANK_DIR / "validate.py")
validator = importlib.util.module_from_spec(validator_spec)
sys.modules["s2_validate"] = validator
validator_spec.loader.exec_module(validator)  # type: ignore[union-attr]


def read_jsonl(path: Path) -> list[dict]:
    return [validator.json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def cumulative_rows() -> dict[int, list[dict]]:
    """Load the three non-overlapping shards as their named checkpoints."""
    rows: list[dict] = []
    checkpoints: dict[int, list[dict]] = {}
    for (filename, _), total in zip(generator.SHARDS, generator.CHECKPOINT_TOTALS):
        rows.extend(read_jsonl(PII_BANK_DIR / "rows" / filename))
        checkpoints[total] = list(rows)
    return checkpoints


def test_determinism_two_runs_are_byte_identical(tmp_path: Path):
    first_rows, second_rows = tmp_path / "one", tmp_path / "two"
    first_report, second_report = tmp_path / "one.md", tmp_path / "two.md"
    generator.generate(first_rows, first_report)
    generator.generate(second_rows, second_report)
    for filename, _ in generator.SHARDS:
        assert (first_rows / filename).read_bytes() == (second_rows / filename).read_bytes()
        assert (first_rows / filename).read_bytes() == (PII_BANK_DIR / "rows" / filename).read_bytes()
    assert first_report.read_bytes() == second_report.read_bytes()
    assert first_report.read_bytes() == (GENERATOR_DIR / "REPORT.md").read_bytes()


def test_schema_validity_via_s1_validate_helpers():
    all_rows: list[tuple[dict, int, str]] = []
    for filename, _ in generator.SHARDS:
        for line_no, item in enumerate(read_jsonl(PII_BANK_DIR / "rows" / filename), start=1):
            assert validator.validate_row(item, line_no, filename) == []
            all_rows.append((item, line_no, filename))
    assert validator.enforce_quarantine(all_rows) == []
    assert validator.check_duplicate_ids(all_rows) == []


def test_same_surface_counterfactuals_cover_every_ambiguous_class():
    families: dict[str, list[dict]] = defaultdict(list)
    for item in cumulative_rows()[8000]:
        families[item["family_id"]].append(item)
    prefixes = ("hard-de-function-", "hard-vendor-", "hard-region-", "hard-role-", "hard-location-", "struct-name-")
    observed = set()
    for family_id, items in families.items():
        prefix = next((value for value in prefixes if family_id.startswith(value)), None)
        if prefix is None:
            continue
        observed.add(prefix)
        assert len(items) == 2
        assert {span["expected"] for item in items for span in item["spans"]} == {"KEEP", "REDACT"}
        assert items[0]["spans"][0]["surface"] == items[1]["spans"][0]["surface"]
    assert observed == set(prefixes)
    hard_families = [items for family_id, items in families.items() if family_id.startswith("hard-")]
    assert len(hard_families) == 1000
    assert all(items[0]["spans"][0]["surface"] == items[1]["spans"][0]["surface"] for items in hard_families)
    marker_counts: dict[str, Counter[str]] = defaultdict(Counter)
    all_marker_counts: Counter[str] = Counter()
    for family_id, items in families.items():
        if family_id.startswith(("hard-vendor-", "hard-region-", "hard-role-")):
            redact = next(item for item in items if item["spans"][0]["expected"] == "REDACT")
            class_index = int(family_id.rsplit("-", 1)[1]) // 5
            marker = generator.PERSON_USAGE_FAMILIES[class_index % 20 % len(generator.PERSON_USAGE_FAMILIES)]
            assert marker in redact["text"].casefold()
            assert "fictional person named" not in redact["text"].casefold()
            marker_counts[family_id.split("-")[1]][marker] += 1
            all_marker_counts[marker] += 1
        if family_id.startswith("hard-location-"):
            redact = next(item for item in items if item["spans"][0]["expected"] == "REDACT")
            class_index = int(family_id.rsplit("-", 1)[1]) // 5
            expected_category, _ = generator.LOCATION_REDACT[class_index % len(generator.LOCATION_REDACT)]
            assert redact["spans"][0]["category"] == expected_category
    for class_name, counts in marker_counts.items():
        total = sum(counts.values())
        assert len(counts) >= 10, class_name
        assert max(counts.values()) / total <= 0.15, (class_name, counts)
    assert len(all_marker_counts) >= 10
    assert max(all_marker_counts.values()) / sum(all_marker_counts.values()) <= 0.15


def test_function_keep_frames_are_word_class_compatible():
    rows = cumulative_rows()[8000]
    assert set(generator.FUNCTION_KEEP) == set(generator.PEOPLE["function_word_surnames"])
    for row in rows:
        if row["family_id"].startswith("hard-de-function-") and row["spans"][0]["expected"] == "KEEP":
            word = row["spans"][0]["surface"]
            compatible = {frame.format(surface=word) for frame in generator.FUNCTION_KEEP[word]}
            assert row["text"] in compatible


def test_every_vocab_entry_is_observed_in_its_8k_class():
    rows = cumulative_rows()[8000]

    def text_for(prefix: str) -> str:
        return "\n".join(item["text"] for item in rows if item["family_id"].startswith(prefix))

    hard_text = text_for("hard-")
    struct_text = text_for("struct-")
    general_text = text_for("general-")
    pools = {
        "general English people": (generator.PEOPLE["en"], general_text),
        "general German people": (generator.PEOPLE["de"], general_text),
        "function-word surnames": (generator.PEOPLE["function_word_surnames"], hard_text),
        "vendors": (generator.DOMAIN["vendors"], hard_text),
        "AWS regions": (generator.DOMAIN["aws_regions"], hard_text),
        "Azure regions": (generator.DOMAIN["azure_regions"], hard_text),
        "roles": (generator.DOMAIN["roles"], hard_text),
        "places": (generator.DOMAIN["places"], hard_text),
        "schema keys": (generator.DOMAIN["schema_keys"], struct_text),
        "ticket prefixes": (generator.DOMAIN["ticket_prefixes"], struct_text),
        "opaque ids": (generator.DOMAIN["opaque_ids"], struct_text),
        "clean identifiers": (generator.DOMAIN["clean_identifiers"], struct_text),
    }
    for pool_name, (pool, rendered) in pools.items():
        missing = [entry for entry in pool if entry not in rendered]
        assert not missing, f"{pool_name} missing from 8k output: {missing}"
    for lang in ("en", "de"):
        missing_forms = [
            form
            for name in generator.PEOPLE[lang]
            for form in generator.identifier_forms(name)
            if form not in struct_text
        ]
        assert not missing_forms, f"structural {lang} identifier forms missing from 8k output: {missing_forms}"


def test_frame_diversity_is_at_least_twenty_per_bucket_class():
    rows = cumulative_rows()[8000]
    assert sum(len(frames) for frames in generator.FUNCTION_KEEP.values()) >= 20
    assert len(generator.FUNCTION_REDACT) >= 20
    for frames in (generator.VENDOR_KEEP, generator.VENDOR_PERSON, generator.REGION_KEEP, generator.REGION_PERSON,
                   generator.ROLE_KEEP, generator.ROLE_PERSON, generator.LOCATION_KEEP, generator.LOCATION_REDACT,
                   generator.EN_GENERAL_PERSON, generator.EN_GENERAL_CLEAN, generator.DE_GENERAL_PERSON,
                   generator.DE_GENERAL_CLEAN, generator.EN_STRUCTURAL_FRAMES, generator.DE_STRUCTURAL_FRAMES):
        assert len(frames) >= 20

    family_ids = {item["family_id"] for item in rows}
    hard_prefixes = ("hard-de-function-", "hard-vendor-", "hard-region-", "hard-role-", "hard-location-")
    for prefix in hard_prefixes:
        indexes = {int(family_id.rsplit("-", 1)[1]) // 5 % 20 for family_id in family_ids if family_id.startswith(prefix)}
        assert len(indexes) >= 20, prefix
    dynamic_values = [
        *generator.DOMAIN["schema_keys"],
        *generator.DOMAIN["clean_identifiers"],
        *generator.DOMAIN["ticket_prefixes"],
        *generator.DOMAIN["opaque_ids"],
    ]

    def rendered_signature(item: dict) -> str:
        span = item["spans"][0]
        text = item["text"][: span["start"]] + "<SPAN>" + item["text"][span["end"] :]
        text = re.sub(r"(?:SYN|DEMO|LAB|QA)-\d{5}-(?:qx7m2|rv4k9|na8t1|pd6w3)", "<TICKET>", text)
        for value in dynamic_values:
            text = text.replace(value, "<VOCAB>")
        return text

    for lang in ("en", "de"):
        indexes = {
            int(family_id.rsplit("-", 1)[1]) // 2 % 20
            for family_id in family_ids
            if family_id.startswith(f"general-{lang}-")
        }
        assert len(indexes) >= 20, lang
        struct_indexes = {
            int(family_id.rsplit("-", 1)[1]) // 2 % 20
            for family_id in family_ids
            if family_id.startswith(f"struct-name-{lang}-")
        }
        assert len(struct_indexes) >= 20, lang
        redacted_signatures = {
            rendered_signature(item)
            for item in rows
            if item["family_id"].startswith(f"struct-name-{lang}-") and item["spans"][0]["expected"] == "REDACT"
        }
        keep_signatures = {
            rendered_signature(item)
            for item in rows
            if item["family_id"].startswith(f"struct-name-{lang}-") and item["spans"][0]["expected"] == "KEEP"
        }
        assert len(redacted_signatures) >= 20, lang
        assert len(keep_signatures) >= 20, lang


def test_hard_keep_zones_match_explicit_frame_types():
    rows = cumulative_rows()[8000]
    classes = {
        "hard-vendor-": (generator.VENDOR_KEEP, generator.VENDOR_KEEP_ZONES),
        "hard-region-": (generator.REGION_KEEP, generator.REGION_KEEP_ZONES),
        "hard-location-": (generator.LOCATION_KEEP, generator.LOCATION_KEEP_ZONES),
    }
    for prefix, (frames, zones) in classes.items():
        assert len(frames) == len(zones) == 20
        observed = set()
        for row in rows:
            if not row["family_id"].startswith(prefix) or row["spans"][0]["expected"] != "KEEP":
                continue
            class_index = int(row["family_id"].rsplit("-", 1)[1]) // 5
            frame_index = class_index % len(frames)
            expected_zone = zones[frame_index]
            observed.add(frame_index)
            assert row["zone"] == expected_zone
            if expected_zone == "prose":
                assert not row["text"].lstrip().startswith("{")
                assert " = " not in row["text"]
            elif expected_zone == "json_value":
                assert row["text"].lstrip().startswith("{")
            elif expected_zone == "code_identifier":
                assert " = " in row["text"]
            elif expected_zone == "schema_label":
                assert any(token in row["text"] for token in ("schema", "label", "field="))
            else:
                assert expected_zone == "technical_id"
                assert "=" in row["text"] or ":" in row["text"]
        assert observed == set(range(20)), prefix


def test_structural_span_context_has_locked_minimum_and_mean():
    structural_rows = [item for item in cumulative_rows()[8000] if item["family_id"].startswith("struct-")]
    counts = [
        len(item["text"][: span["start"]].split()) + len(item["text"][span["end"] :].split())
        for item in structural_rows
        for span in item["spans"]
    ]
    assert len(counts) == 2000
    assert min(counts) >= 8
    assert sum(counts) / len(counts) >= 10


def test_split_is_predeclared_by_family_hash():
    for item in cumulative_rows()[8000]:
        expected = "dev" if hashlib.sha256(item["family_id"].encode()).digest()[-1] % 10 in {0, 1} else "train"
        assert item["split"] == expected


def test_cumulative_superset_property_and_unique_ids():
    checkpoints = cumulative_rows()
    ids_1k = {item["id"] for item in checkpoints[1000]}
    ids_3k = {item["id"] for item in checkpoints[3000]}
    ids_8k = {item["id"] for item in checkpoints[8000]}
    assert len(ids_1k) == 1000
    assert len(ids_3k) == 3000
    assert len(ids_8k) == 8000
    assert ids_1k < ids_3k < ids_8k


@pytest.mark.parametrize("total", generator.CHECKPOINT_TOTALS)
def test_bucket_share_sanity(total: int):
    prefix_to_bucket = {
        "hard-": "contextual_hard_negative",
        "struct-": "structural_domain_positive",
        "general-": "general_synthetic",
    }
    counts: Counter[str] = Counter()
    for item in cumulative_rows()[total]:
        bucket = next(value for prefix, value in prefix_to_bucket.items() if item["family_id"].startswith(prefix))
        counts[bucket] += 1
    assert counts == Counter(
        {
            "contextual_hard_negative": total // 4,
            "structural_domain_positive": total // 4,
            "general_synthetic": total // 2,
        }
    )
