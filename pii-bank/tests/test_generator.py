"""Emitted-file contracts for the Fable-authorized S2 composition repair."""

from __future__ import annotations

import hashlib
import importlib.util
import json
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

DEV_COVERAGE_RESIDUALS = {
    "en": {"jonas_vale_admin"},
    "de": {"maja_kuehn_admin"},
}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def train_rows() -> list[dict]:
    return [row for filename, _ in generator.SHARDS for row in read_jsonl(PII_BANK_DIR / "rows" / filename)]


def dev_rows() -> list[dict]:
    return read_jsonl(PII_BANK_DIR / "rows" / generator.DEV_FILENAME)


def all_rows() -> list[dict]:
    return train_rows() + dev_rows()


def cumulative_rows() -> dict[int, list[dict]]:
    rows, output = [], {}
    for (filename, _), total in zip(generator.SHARDS, generator.CHECKPOINT_TOTALS):
        rows.extend(read_jsonl(PII_BANK_DIR / "rows" / filename))
        output[total] = list(rows)
    return output


def frame_index(family_id: str) -> int:
    match = re.search(r"-f(\d{2})-p\d{3}$", family_id)
    assert match, family_id
    return int(match.group(1))


def test_determinism_two_runs_are_byte_identical(tmp_path: Path):
    one_rows, two_rows = tmp_path / "one", tmp_path / "two"
    one_report, two_report = tmp_path / "one.md", tmp_path / "two.md"
    generator.generate(one_rows, one_report)
    generator.generate(two_rows, two_report)
    for filename, _ in generator.SHARDS:
        assert (one_rows / filename).read_bytes() == (two_rows / filename).read_bytes()
        assert (one_rows / filename).read_bytes() == (PII_BANK_DIR / "rows" / filename).read_bytes()
    for filename in (generator.DEV_FILENAME, generator.DEV_MANIFEST_FILENAME):
        assert (one_rows / filename).read_bytes() == (two_rows / filename).read_bytes()
        assert (one_rows / filename).read_bytes() == (PII_BANK_DIR / "rows" / filename).read_bytes()
    assert one_report.read_bytes() == two_report.read_bytes() == (GENERATOR_DIR / "REPORT.md").read_bytes()


def test_generated_rows_validate_and_ids_are_unique():
    tuples = [(row, line, "generated.jsonl") for line, row in enumerate(all_rows(), 1)]
    assert all(validator.validate_row(row, line, path) == [] for row, line, path in tuples)
    assert validator.enforce_quarantine(tuples) == []
    assert validator.check_duplicate_ids(tuples) == []


def test_canonical_uniqueness_and_bucket_distinct_text_are_emitted():
    train, dev = train_rows(), dev_rows()
    canonical = [validator.canonical_text(row["text"]) for row in train + dev]
    assert (len(train), len(dev), len(canonical), len(set(canonical))) == (8000, 2000, 10000, 10000)
    assert {validator.canonical_text(row["text"]) for row in train}.isdisjoint(
        {validator.canonical_text(row["text"]) for row in dev}
    )
    for bucket in generator.BUCKETS:
        rows = [row for row in train if generator.bucket_for(row) == bucket]
        assert len({validator.canonical_text(row["text"]) for row in rows}) == (
            generator.ROWS_PER_FAMILY[bucket] * len({row["family_id"] for row in rows})
        )


def test_masked_diversity_and_general_rendered_content_guard():
    for bucket in generator.BUCKETS:
        rows = [row for row in all_rows() if generator.bucket_for(row) == bucket]
        signatures = Counter(validator.masked_context_signature(row) for row in rows)
        assert len(signatures) >= len({row["family_id"] for row in rows})
        assert max(signatures.values()) <= 2
    # Rendered content, not family IDs: volatile IDs and labeled spans are masked.
    general = [row for row in train_rows() if generator.bucket_for(row) == "general_synthetic"]
    signatures = Counter(validator.masked_context_signature(row) for row in general)
    assert len(signatures) >= len({row["family_id"] for row in general})
    assert max(signatures.values()) <= 2


def test_general_clean_controls_are_span_free_and_name_free():
    names = tuple(validator.canonical_text(name) for lang in ("en", "de") for name in generator.PEOPLE[lang])
    for row in all_rows():
        if row["family_id"].startswith("general-") and not row["spans"]:
            assert not any(name in validator.canonical_text(row["text"]) for name in names), row["id"]


def test_lineage_is_exclusive_atomic_and_partitioned_80_20_per_class():
    lineage_splits, family_splits = defaultdict(set), defaultdict(set)
    for row in all_rows():
        lineage_splits[row["template_lineage"]].add(row["split"])
        family_splits[row["family_id"]].add(row["split"])
    assert all(len(splits) == 1 for splits in lineage_splits.values())
    assert all(len(splits) == 1 for splits in family_splits.values())
    classes = [
        *(f"s2-v3/hard/{name}/" for name in ("de-function", "vendor", "region", "role", "location")),
        *(f"s2-v3/struct/{lang}/" for lang in ("en", "de")),
        *(f"s2-v3/general/{lang}/" for lang in ("en", "de")),
    ]
    for prefix in classes:
        split_by_lineage = {
            lineage: next(iter(splits)) for lineage, splits in lineage_splits.items() if lineage.startswith(prefix)
        }
        assert len(split_by_lineage) == 20
        assert Counter(split_by_lineage.values()) == Counter({"train": 16, "dev": 4})


def test_split_integrity_on_the_actual_emitted_files():
    tuples = [(row, line, "generated.jsonl") for line, row in enumerate(all_rows(), 1)]
    failures, stats = validator.run_split_integrity_check(tuples)
    assert failures == []
    assert (stats.train_rows, stats.dev_rows, stats.masked_multiplicity_max) == (8000, 2000, 1)
    assert stats.near_max < 0.90
    assert stats.dev_ge_080 == 0


def test_same_surface_pairs_and_delta_audit_semantics():
    families: dict[str, list[dict]] = defaultdict(list)
    for row in all_rows():
        if row["family_id"].startswith(("hard-", "struct-name-")):
            families[row["family_id"]].append(row)
    prefixes = ("hard-de-function-", "hard-vendor-", "hard-region-", "hard-role-", "hard-location-", "struct-name-")
    observed = set()
    for family, rows in families.items():
        observed.add(next(prefix for prefix in prefixes if family.startswith(prefix)))
        assert len(rows) == 2
        assert {row["spans"][0]["expected"] for row in rows} == {"KEEP", "REDACT"}
        assert rows[0]["spans"][0]["surface"] == rows[1]["spans"][0]["surface"]
    assert observed == set(prefixes)
    assert len([family for family in families if family.startswith("hard-")]) == 1250
    declared_location_categories = {category for category, _ in generator.LOCATION_REDACT}
    assert declared_location_categories == {"LOCATION", "PERSON"}
    for row in all_rows():
        if row["family_id"].startswith("hard-location-"):
            span = row["spans"][0]
            if span["expected"] == "KEEP":
                assert span["category"] == "LOCATION"
            else:
                declared_category, _ = generator.LOCATION_REDACT[frame_index(row["family_id"])]
                assert span["category"] == declared_category
        if row["family_id"].startswith("hard-de-function-") and row["spans"][0]["expected"] == "KEEP":
            word = row["spans"][0]["surface"]
            assert any(row["text"].startswith(frame.format(surface=word)) for frame in generator.FUNCTION_KEEP[word])


def test_natural_person_scaffolds_are_varied_per_ambiguous_class():
    markers = ("mr.", "ms.", "our colleague", "employee", "designated reviewer", "assigned reviewer", "training contact", "colleague known as", "the analyst", "team member")
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    for row in all_rows():
        name = next((item for item in ("vendor", "region", "role") if row["family_id"].startswith(f"hard-{item}-")), None)
        if name is None or row["spans"][0]["expected"] != "REDACT":
            continue
        found = [marker for marker in markers if marker in row["text"].casefold()]
        assert len(found) == 1, row["text"]
        counts[name][found[0]] += 1
    for distribution in counts.values():
        assert len(distribution) == 10
        assert max(distribution.values()) / sum(distribution.values()) <= 0.15


def test_every_vocab_entry_and_identifier_form_is_observed_in_both_splits():
    def text_for(rows: list[dict], prefix: str) -> str:
        return "\n".join(row["text"] for row in rows if row["family_id"].startswith(prefix))

    pools = {
        "general English people": (generator.PEOPLE["en"], "general-en-"),
        "general German people": (generator.PEOPLE["de"], "general-de-"),
        "function words": (generator.PEOPLE["function_word_surnames"], "hard-de-function-"),
        "vendors": (generator.DOMAIN["vendors"], "hard-vendor-"),
        "AWS regions": (generator.DOMAIN["aws_regions"], "hard-region-"),
        "Azure regions": (generator.DOMAIN["azure_regions"], "hard-region-"),
        "roles": (generator.DOMAIN["roles"], "hard-role-"),
        "places": (generator.DOMAIN["places"], "hard-location-"),
        "schema keys": (generator.DOMAIN["schema_keys"], "struct-name-"),
        "ticket prefixes": (generator.DOMAIN["ticket_prefixes"], "struct-name-"),
        "opaque ids": (generator.DOMAIN["opaque_ids"], "struct-name-"),
        "clean identifiers": (generator.DOMAIN["clean_identifiers"], "struct-name-"),
    }
    for name, (pool, prefix) in pools.items():
        for split, rows in (("train", train_rows()), ("dev", dev_rows())):
            rendered = text_for(rows, prefix)
            assert not [entry for entry in pool if entry not in rendered], f"{name} {split}"
        for entry in pool:
            lineages_by_split = {
                split: {
                    row["template_lineage"]
                    for row in rows
                    if row["family_id"].startswith(prefix) and entry in row["text"]
                }
                for split, rows in (("train", train_rows()), ("dev", dev_rows()))
            }
            assert lineages_by_split["train"], f"{name} {entry!r} train"
            assert lineages_by_split["dev"], f"{name} {entry!r} dev"
            assert lineages_by_split["train"].isdisjoint(lineages_by_split["dev"])
    for lang in ("en", "de"):
        assert DEV_COVERAGE_RESIDUALS[lang] == set(generator.DEV_IDENTIFIER_FORM_RESIDUALS[lang])
        for split, rows in (("train", train_rows()), ("dev", dev_rows())):
            struct = text_for(rows, f"struct-name-{lang}-")
            absent = {
                form for name in generator.PEOPLE[lang] for form in generator.identifier_forms(name) if form not in struct
            }
            assert absent == (DEV_COVERAGE_RESIDUALS[lang] if split == "dev" else set()), (
                f"structural {lang} identifier forms {split}", absent
            )


def test_twenty_frames_zone_correctness_and_structural_context():
    rows = all_rows()
    prefixes = ("hard-de-function-", "hard-vendor-", "hard-region-", "hard-role-", "hard-location-", "struct-name-en-", "struct-name-de-", "general-en-", "general-de-")
    for prefix in prefixes:
        assert {frame_index(row["family_id"]) for row in rows if row["family_id"].startswith(prefix)} == set(range(20))
    for prefix, zones in (("hard-vendor-", generator.VENDOR_KEEP_ZONES), ("hard-region-", generator.REGION_KEEP_ZONES), ("hard-location-", generator.LOCATION_KEEP_ZONES)):
        for row in rows:
            if row["family_id"].startswith(prefix) and row["spans"][0]["expected"] == "KEEP":
                expected = zones[frame_index(row["family_id"])]
                assert row["zone"] == expected
                if expected == "json_value":
                    assert row["text"].lstrip().startswith("{")
                elif expected == "code_identifier":
                    assert " = " in row["text"]
                elif expected == "schema_label":
                    assert any(token in row["text"] for token in ("schema", "label", "field="))
                elif expected == "technical_id":
                    assert "=" in row["text"] or ":" in row["text"]
    structural = [row for row in rows if row["family_id"].startswith("struct-")]
    contexts = [len(row["text"][:span["start"]].split()) + len(row["text"][span["end"]:].split()) for row in structural for span in row["spans"]]
    assert min(contexts) >= 8
    assert sum(contexts) / len(contexts) >= 10


def test_cumulative_checkpoints_shares_and_ids():
    previous: set[str] = set()
    for total, rows in cumulative_rows().items():
        ids = {row["id"] for row in rows}
        assert len(ids) == len({validator.canonical_text(row["text"]) for row in rows}) == total
        assert previous < ids if previous else ids
        previous = ids
        assert Counter(generator.bucket_for(row) for row in rows) == Counter({
            "contextual_hard_negative": total // 4,
            "structural_domain_positive": total // 4,
            "general_synthetic": total // 2,
        })


def test_frozen_dev_manifest_and_report_headline_are_current():
    manifest = (PII_BANK_DIR / "rows" / generator.DEV_MANIFEST_FILENAME).read_text(encoding="utf-8")
    digest = hashlib.sha256((PII_BANK_DIR / "rows" / generator.DEV_FILENAME).read_bytes()).hexdigest()
    assert f"sha256: `{digest}`" in manifest
    report = (GENERATOR_DIR / "REPORT.md").read_text(encoding="utf-8")
    for required in ("Fable-authorized composition repair", "Canonical unique examples", "Masked signatures", "Nearest masked train char-5-gram Jaccard", "Physical train shards", "PYTHONHASHSEED=0`, `12345`, and `random`"):
        assert required in report


@pytest.mark.parametrize("total", generator.CHECKPOINT_TOTALS)
def test_bucket_share_sanity(total: int):
    assert Counter(generator.bucket_for(row) for row in cumulative_rows()[total]) == Counter({
        "contextual_hard_negative": total // 4,
        "structural_domain_positive": total // 4,
        "general_synthetic": total // 2,
    })
