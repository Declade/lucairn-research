"""Pytest coverage for pii-bank/validate.py.

Covers: a valid row passes clean; each FAIL class fires (bad enum,
train+measured-provenance, public-repo+dogfood-provenance, span out-of-bounds,
span surface mismatch / missing surface, byte-authored offsets on non-ASCII
text, family-split inconsistency, manifest hash mismatch via a temp file,
manifest home-directory path leak); local-root resolution via
PII_BANK_LOCAL_ROOT; and the contamination check fires on a real overlap and
stays clean without one.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import unicodedata
from pathlib import Path, PurePosixPath

import pytest

PII_BANK_DIR = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("validate", PII_BANK_DIR / "validate.py")
validate = importlib.util.module_from_spec(spec)
sys.modules["validate"] = validate
spec.loader.exec_module(validate)  # type: ignore[union-attr]


def make_valid_row(**overrides) -> dict:
    row = {
        "id": "test-row-001",
        "text": "John Smith lives in Berlin.",
        "lang": "en",
        "zone": "prose",
        "spans": [
            # Codepoint offsets + surface. NOTE: the pre-surface version of this
            # fixture carried [21,27] for Berlin -- which slices "erlin." -- and
            # bounds-only validation accepted it: the exact latent class the
            # surface check now catches.
            {"start": 0, "end": 10, "category": "PERSON", "expected": "REDACT", "surface": "John Smith"},
            {"start": 20, "end": 26, "category": "LOCATION", "expected": "REDACT", "surface": "Berlin"},
        ],
        "org_id": None,
        "provenance": "synthetic-generated",
        "consent_basis": "synthetic",
        "split": "train",
        "family_id": "test-family-001",
        "source": "unit test",
        "created": "2026-07-19",
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# validate_row
# ---------------------------------------------------------------------------


class TestValidRow:
    def test_valid_row_passes_clean(self):
        row = make_valid_row()
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert fails == [], f"expected zero failures, got: {[str(f) for f in fails]}"

    def test_valid_row_with_empty_spans_passes(self):
        row = make_valid_row(text="No PII here at all.", spans=[])
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert fails == []

    def test_valid_row_with_null_org_id_passes(self):
        row = make_valid_row(org_id=None)
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert fails == []

    def test_valid_row_with_string_org_id_passes(self):
        row = make_valid_row(org_id="acme-corp")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert fails == []


class TestBadEnum:
    def test_bad_lang_fails(self):
        row = make_valid_row(lang="fr")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("lang" in str(f) for f in fails)

    def test_bad_zone_fails(self):
        row = make_valid_row(zone="not_a_real_zone")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("zone" in str(f) for f in fails)

    def test_bad_provenance_fails(self):
        row = make_valid_row(provenance="scraped-from-nowhere")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("provenance" in str(f) for f in fails)

    def test_bad_consent_basis_fails(self):
        row = make_valid_row(consent_basis="implied")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("consent_basis" in str(f) for f in fails)

    def test_bad_split_fails(self):
        row = make_valid_row(split="validation")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("split" in str(f) for f in fails)

    def test_bad_span_expected_fails(self):
        row = make_valid_row(
            spans=[{"start": 0, "end": 4, "category": "PERSON", "expected": "MAYBE", "surface": "John"}]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("expected" in str(f) for f in fails)

    def test_unknown_field_fails(self):
        row = make_valid_row()
        row["unexpected_extra_field"] = "surprise"
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("unknown field" in str(f) for f in fails)

    def test_missing_field_fails(self):
        row = make_valid_row()
        del row["consent_basis"]
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("missing required field" in str(f) for f in fails)

    def test_bad_created_format_fails(self):
        row = make_valid_row(created="07/19/2026")
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("created" in str(f) for f in fails)


class TestSpanOutOfBounds:
    # Invalid offsets skip the surface-equality check (nothing safe to slice),
    # but the surface FIELD must still be present -- "x" placeholders below.
    def test_span_end_past_text_length_fails(self):
        row = make_valid_row(
            text="short",
            spans=[{"start": 0, "end": 999, "category": "PERSON", "expected": "REDACT", "surface": "x"}],
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("out of bounds" in str(f) for f in fails)

    def test_span_start_past_text_length_fails(self):
        row = make_valid_row(
            text="short",
            spans=[{"start": 999, "end": 1000, "category": "PERSON", "expected": "REDACT", "surface": "x"}],
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("out of bounds" in str(f) for f in fails)

    def test_negative_span_offset_fails(self):
        row = make_valid_row(
            text="short",
            spans=[{"start": -1, "end": 3, "category": "PERSON", "expected": "REDACT", "surface": "x"}],
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("negative offset" in str(f) for f in fails)

    def test_end_before_start_fails(self):
        row = make_valid_row(
            text="short text",
            spans=[{"start": 5, "end": 2, "category": "PERSON", "expected": "REDACT", "surface": "x"}],
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("end must be > start" in str(f) for f in fails)

    def test_zero_width_span_fails(self):
        # terra F5: start == end previously passed (sliced "" == surface "")
        row = make_valid_row(
            text="short text",
            spans=[{"start": 5, "end": 5, "category": "PERSON", "expected": "REDACT", "surface": "x"}],
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("zero-width" in str(f) for f in fails)

    def test_bool_offsets_fail(self):
        # terra F5: bool subclasses int -- True previously passed as an offset
        t = make_valid_row()["text"]
        row = make_valid_row(
            spans=[{"start": True, "end": 24, "category": "PERSON", "expected": "REDACT", "surface": t[1:24]}]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("bool is not a valid offset" in str(f) for f in fails)

    def test_empty_surface_fails(self):
        # terra F5: surface must be a NON-EMPTY string
        row = make_valid_row(
            spans=[{"start": 0, "end": 10, "category": "PERSON", "expected": "REDACT", "surface": ""}]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("surface must be a non-empty string" in str(f) for f in fails)

    def test_span_not_a_dict_fails(self):
        row = make_valid_row(spans=["not-a-span-object"])
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("span is not an object" in str(f) for f in fails)

    def test_span_missing_field_fails(self):
        row = make_valid_row(spans=[{"start": 0, "end": 4, "category": "PERSON"}])
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("missing span field" in str(f) for f in fails)

    def test_span_unknown_field_fails(self):
        row = make_valid_row(
            spans=[
                {
                    "start": 0,
                    "end": 4,
                    "category": "PERSON",
                    "expected": "REDACT",
                    "surface": "John",
                    "confidence": 0.9,
                }
            ]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("unknown span field" in str(f) for f in fails)


# ---------------------------------------------------------------------------
# surface + codepoint-offset convention (bug-hunter finding on 41cd9e5:
# byte-vs-codepoint span confusion was undetectable -- both conventions passed
# bounds-only checks on ASCII rows and silently poisoned non-ASCII rows)
# ---------------------------------------------------------------------------


class TestSurfaceAndCodepointOffsets:
    UMLAUT_TEXT = "Frau Müller aus München meldete den Vorfall."
    # Codepoint (str-index) offsets -- the declared convention.
    CP_START = UMLAUT_TEXT.index("Müller")          # 5
    CP_END = CP_START + len("Müller")               # 11
    # Byte-derived offsets -- the mislabel class the reviewer proved slipped
    # through: 'ü' is 2 bytes in UTF-8, so the byte end lands one past.
    BYTE_START = len(UMLAUT_TEXT[:5].encode("utf-8"))                 # 5
    BYTE_END = BYTE_START + len("Müller".encode("utf-8"))             # 12

    def _umlaut_row(self, start: int, end: int) -> dict:
        return make_valid_row(
            id="umlaut-probe-row",
            lang="de",
            text=self.UMLAUT_TEXT,
            spans=[{"start": start, "end": end, "category": "PERSON", "expected": "REDACT", "surface": "Müller"}],
        )

    def test_codepoint_correct_umlaut_span_passes(self):
        row = self._umlaut_row(self.CP_START, self.CP_END)
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert fails == [], f"expected zero failures, got: {[str(f) for f in fails]}"

    def test_byte_authored_umlaut_span_fails_via_surface_mismatch(self):
        # Pre-fix, this span passed bounds-only validation despite slicing
        # 'üller ' instead of 'Müller'. It must now FAIL.
        assert self.BYTE_END != self.CP_END  # the probe is only meaningful if they diverge
        row = self._umlaut_row(self.BYTE_START, self.BYTE_END)
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("surface mismatch" in str(f) for f in fails)

    def test_surface_mismatch_on_ascii_fails(self):
        row = make_valid_row(
            spans=[{"start": 0, "end": 10, "category": "PERSON", "expected": "REDACT", "surface": "Jane Smith"}]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("surface mismatch" in str(f) for f in fails)

    def test_missing_surface_fails(self):
        row = make_valid_row(spans=[{"start": 0, "end": 10, "category": "PERSON", "expected": "REDACT"}])
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("missing span field" in str(f) and "surface" in str(f) for f in fails)

    def test_surface_wrong_type_fails(self):
        row = make_valid_row(
            spans=[{"start": 0, "end": 10, "category": "PERSON", "expected": "REDACT", "surface": 42}]
        )
        fails = validate.validate_row(row, 1, "test.jsonl")
        assert any("surface must be a non-empty string" in str(f) for f in fails)

    def test_main_end_to_end_on_umlaut_rows(self, tmp_path, monkeypatch):
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps({"entries": []}), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)

        # Codepoint-correct umlaut row file -> exit 0
        good_dir = tmp_path / "good" / "rows"
        good_dir.mkdir(parents=True)
        good_row = self._umlaut_row(self.CP_START, self.CP_END)
        (good_dir / "umlaut.jsonl").write_text(
            json.dumps(good_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        monkeypatch.setattr(validate, "ROWS_DIR", good_dir)
        assert validate.main([]) == 0

        # Byte-authored umlaut row file -> exit 1
        bad_dir = tmp_path / "bad" / "rows"
        bad_dir.mkdir(parents=True)
        bad_row = self._umlaut_row(self.BYTE_START, self.BYTE_END)
        (bad_dir / "umlaut.jsonl").write_text(
            json.dumps(bad_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        monkeypatch.setattr(validate, "ROWS_DIR", bad_dir)
        assert validate.main([]) == 1


# ---------------------------------------------------------------------------
# enforce_quarantine
# ---------------------------------------------------------------------------


class TestQuarantineTrainMeasured:
    def test_train_split_with_measured_provenance_fails(self):
        row = make_valid_row(split="train", provenance="measured-live")
        fails = validate.enforce_quarantine([(row, 1, "test.jsonl")])
        assert any("quarantine violation" in str(f) and "requires provenance" in str(f) for f in fails)

    def test_dev_split_with_dogfood_provenance_fails(self):
        row = make_valid_row(split="dev", provenance="dogfood")
        fails = validate.enforce_quarantine([(row, 1, "test.jsonl")])
        assert any("quarantine violation" in str(f) and "requires provenance" in str(f) for f in fails)

    def test_train_split_with_synthetic_provenance_passes(self):
        row = make_valid_row(split="train", provenance="synthetic-generated")
        fails = validate.enforce_quarantine([(row, 1, "test.jsonl")])
        assert fails == []

    def test_eval_only_split_with_measured_provenance_passes_rule1(self):
        # Rule 1 only restricts train/dev; eval-only + measured-live is fine for rule 1
        # (rule 2, the in-repo-provenance ban, is a SEPARATE check tested below).
        row = make_valid_row(split="eval-only", provenance="measured-live", family_id="fam-eval-1")
        fails = validate.enforce_quarantine([(row, 1, "test.jsonl")])
        rule1_fails = [f for f in fails if "requires provenance" in str(f)]
        assert rule1_fails == []


class TestQuarantinePublicDogfood:
    def test_public_repo_row_with_dogfood_provenance_fails(self):
        row = make_valid_row(split="eval-only", provenance="dogfood", family_id="fam-dogfood-1")
        fails = validate.enforce_quarantine([(row, 1, "rows/synthetic-seed.jsonl")])
        assert any("forbidden inside the public repo" in str(f) for f in fails)

    def test_public_repo_row_with_measured_live_provenance_fails(self):
        row = make_valid_row(split="eval-only", provenance="measured-live", family_id="fam-measured-1")
        fails = validate.enforce_quarantine([(row, 1, "rows/synthetic-seed.jsonl")])
        assert any("forbidden inside the public repo" in str(f) for f in fails)

    def test_public_repo_row_with_synthetic_provenance_passes(self):
        row = make_valid_row(provenance="synthetic-generated")
        fails = validate.enforce_quarantine([(row, 1, "rows/synthetic-seed.jsonl")])
        assert fails == []

    def test_public_repo_row_with_eval_import_provenance_fails(self):
        # terra F1: the old deny-list named only measured-live/dogfood, so an
        # eval-import row placed in repo rows/ passed -- the data-placement
        # bypass. rows/ is an allow-list now: synthetic-generated ONLY.
        row = make_valid_row(
            split="eval-only",
            provenance="eval-import",
            consent_basis="public-corpus",
            family_id="fam-evimport-1",
        )
        fails = validate.enforce_quarantine([(row, 1, "rows/synthetic-seed.jsonl")])
        assert any("forbidden inside the public repo" in str(f) for f in fails)

    def test_eval_import_in_repo_caught_end_to_end(self, tmp_path, monkeypatch):
        # terra F1 e2e repro: main() must exit 1 on an eval-import row in rows/
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        row = make_valid_row(
            id="evimport-row",
            split="eval-only",
            provenance="eval-import",
            consent_basis="public-corpus",
            family_id="fam-evimport-e2e",
        )
        (rows_dir / "ev.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps({"entries": []}), encoding="utf-8")
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)
        assert validate.main([]) == 1


class TestDuplicateRowIds:
    def test_duplicate_id_across_files_fails(self):
        # terra F4: duplicate ids were silently accepted bank-wide
        row_a = make_valid_row(id="dup-id")
        row_b = make_valid_row(id="dup-id", family_id="test-family-001")
        fails = validate.check_duplicate_ids([(row_a, 1, "a.jsonl"), (row_b, 3, "b.jsonl")])
        assert len(fails) == 1
        msg = str(fails[0])
        assert "duplicate row id" in msg and "a.jsonl:1" in msg and "b.jsonl:3" in msg

    def test_unique_ids_pass(self):
        row_a = make_valid_row(id="id-one")
        row_b = make_valid_row(id="id-two")
        assert validate.check_duplicate_ids([(row_a, 1, "a.jsonl"), (row_b, 2, "a.jsonl")]) == []

    def test_duplicate_id_caught_end_to_end(self, tmp_path, monkeypatch):
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        (rows_dir / "dup.jsonl").write_text(
            json.dumps(make_valid_row(id="dup-id")) + "\n" + json.dumps(make_valid_row(id="dup-id")) + "\n",
            encoding="utf-8",
        )
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps({"entries": []}), encoding="utf-8")
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)
        assert validate.main([]) == 1


class TestDuplicateJsonKeys:
    def test_duplicate_key_in_rows_line_fails_parse(self, tmp_path):
        # terra F6: json.loads silently last-wins on duplicate keys, letting a
        # second 'split' key shadow the first (same class as DSA
        # over-redaction R1-F4)
        p = tmp_path / "dup-key.jsonl"
        p.write_text('{"a": 1, "a": 2}\n', encoding="utf-8")
        parsed = validate.parse_jsonl(p)
        assert len(parsed) == 1
        line_no, obj, parse_error = parsed[0]
        assert obj is None
        assert parse_error is not None and "duplicate JSON key" in parse_error

    def test_duplicate_key_in_manifest_fails(self, tmp_path, monkeypatch):
        mp = tmp_path / "manifest.json"
        mp.write_text('{"entries": [], "entries": []}', encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        fails, _warns = validate.check_manifest()
        assert any("duplicate JSON key" in str(f) for f in fails)

    def test_duplicate_key_manifest_caught_in_default_mode(self, tmp_path, monkeypatch):
        # manifest_hygiene_only (plain `validate.py` run) must also reject it
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        (rows_dir / "ok.jsonl").write_text(json.dumps(make_valid_row()) + "\n", encoding="utf-8")
        mp = tmp_path / "manifest.json"
        mp.write_text('{"entries": [], "entries": []}', encoding="utf-8")
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        assert validate.main([]) == 1


class TestFamilySplitConsistency:
    def test_family_split_across_two_splits_fails(self):
        row_a = make_valid_row(id="a", family_id="shared-family", split="train", provenance="synthetic-generated")
        row_b = make_valid_row(id="b", family_id="shared-family", split="eval-only", provenance="measured-live")
        fails = validate.enforce_quarantine([(row_a, 1, "test.jsonl"), (row_b, 2, "test.jsonl")])
        assert any("spans multiple splits" in str(f) for f in fails)

    def test_family_same_split_passes(self):
        row_a = make_valid_row(id="a", family_id="shared-family", split="train", provenance="synthetic-generated")
        row_b = make_valid_row(id="b", family_id="shared-family", split="train", provenance="synthetic-generated")
        fails = validate.enforce_quarantine([(row_a, 1, "test.jsonl"), (row_b, 2, "test.jsonl")])
        family_fails = [f for f in fails if "spans multiple splits" in str(f)]
        assert family_fails == []


# ---------------------------------------------------------------------------
# check_manifest
# ---------------------------------------------------------------------------


class TestManifestMismatch:
    def test_manifest_hash_mismatch_fails(self, tmp_path, monkeypatch):
        asset = tmp_path / "asset.jsonl"
        asset.write_text('{"text": "hello world"}\n', encoding="utf-8")

        manifest = {
            "entries": [
                {
                    "path_or_ref": str(asset),
                    "sha256": "0" * 64,  # deliberately wrong
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)
        fails, warns = validate.check_manifest()
        assert any("sha256 mismatch" in str(f) for f in fails)

    def test_manifest_hash_match_passes(self, tmp_path, monkeypatch):
        asset = tmp_path / "asset.jsonl"
        content = '{"text": "hello world"}\n'
        asset.write_text(content, encoding="utf-8")
        actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        manifest = {
            "entries": [
                {
                    "path_or_ref": str(asset),
                    "sha256": actual_hash,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)
        fails, warns = validate.check_manifest()
        assert fails == []

    def test_manifest_missing_local_file_warns_not_fails(self, tmp_path, monkeypatch):
        missing_asset = tmp_path / "does-not-exist.jsonl"
        manifest = {
            "entries": [
                {
                    "path_or_ref": str(missing_asset),
                    "sha256": "a" * 64,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture -- deliberately missing",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)
        fails, warns = validate.check_manifest()
        assert fails == []
        assert any("skipping hash check" in str(w) for w in warns)

    def test_manifest_missing_file_entirely_fails(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validate, "MANIFEST_PATH", tmp_path / "no-manifest-here.json")
        fails, warns = validate.check_manifest()
        assert any("not found" in str(f) for f in fails)


# ---------------------------------------------------------------------------
# manifest path-leak guard (home-directory paths in a PUBLIC repo)
# ---------------------------------------------------------------------------


class TestManifestPathLeak:
    # NOTE: the leaky fixture path is CONSTRUCTED from components (not written
    # as a literal) so that a repo-wide grep for the home-path leak class
    # stays clean -- the guard's runtime behavior is what these tests pin.
    USERS_PREFIXED = str(PurePosixPath("/", "Users", "synthetic-test-user", "leaked-asset.jsonl"))

    def _manifest_with(self, tmp_path: Path, path_or_ref: str) -> Path:
        manifest = {
            "entries": [
                {
                    "path_or_ref": path_or_ref,
                    "sha256": "a" * 64,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "leak-guard test fixture",
                }
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        return mp

    def test_users_prefixed_path_fails_check_manifest(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_with(tmp_path, self.USERS_PREFIXED))
        fails, _warns = validate.check_manifest()
        assert any("home-directory" in str(f) for f in fails)

    def test_home_literal_in_path_fails(self, tmp_path, monkeypatch):
        home = os.path.expanduser("~")
        if home == "~":
            pytest.skip("no expandable home directory on this platform")
        # Deliberately NOT macOS-user-tree-prefixed, to isolate the
        # home-literal guard from the tree guard.
        leaky = "/data" + home + "/leaked-asset.jsonl"
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_with(tmp_path, leaky))
        fails, _warns = validate.check_manifest()
        assert any("home directory" in str(f) for f in fails)

    def test_main_default_mode_catches_manifest_leak(self, tmp_path, monkeypatch):
        # The guard must fire on a plain `validate.py` run (no --check-manifest),
        # so a leaked home path can never ride a default validation pass.
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        (rows_dir / "ok.jsonl").write_text(json.dumps(make_valid_row()) + "\n", encoding="utf-8")
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_with(tmp_path, self.USERS_PREFIXED))
        assert validate.main([]) == 1

    def test_leaky_entry_skips_hash_check(self, tmp_path, monkeypatch):
        # A leak FAIL must not be accompanied by a bogus mismatch/missing
        # result for the same entry -- hygiene short-circuits that entry.
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_with(tmp_path, self.USERS_PREFIXED))
        fails, warns = validate.check_manifest()
        assert all("sha256 mismatch" not in str(f) for f in fails)
        assert warns == []

    def test_uri_scheme_path_fails(self, tmp_path, monkeypatch):
        # terra F7 exact probe: a file: URI wrapping a user-home path slipped
        # past the path-component checks. Any URI scheme now FAILs outright.
        # (Constructed so the repo-wide grep for the home-path class stays clean.)
        uri_probe = "file://" + str(PurePosixPath("/", "Users", "synthetic-test-user", "leak.jsonl"))
        fails = validate.path_or_ref_hygiene_fails("probe", uri_probe)
        assert any("URI scheme" in str(f) for f in fails)

    def test_uri_scheme_non_file_also_fails(self):
        fails = validate.path_or_ref_hygiene_fails("probe", "https://example.com/corpus.jsonl")
        assert any("URI scheme" in str(f) for f in fails)

    def test_single_slash_file_uri_fails(self):
        # bug-hunter finding on ae343f3: the RFC-8089 single-slash form
        # (file:/Users/...) carries a scheme WITHOUT '//', so the old
        # '://'-only check let it leak a home path into the public manifest.
        # (Constructed from components so the repo-wide home-path grep stays clean.)
        single_slash = "file:" + str(PurePosixPath("/", "Users", "other-operator", "eval.jsonl"))
        assert "://" not in single_slash  # the probe is only meaningful if there's no authority '//'
        fails = validate.path_or_ref_hygiene_fails("probe", single_slash)
        assert any("colons are forbidden" in str(f) for f in fails)

    def test_bare_scheme_ref_fails(self):
        # scheme:relative form (no slashes at all) -- also a colon.
        fails = validate.path_or_ref_hygiene_fails("probe", "file:eval.jsonl")
        assert any("colons are forbidden" in str(f) for f in fails)

    def test_windows_drive_letter_ref_fails(self):
        # A Windows drive letter embeds a colon and would resolve absolute.
        fails = validate.path_or_ref_hygiene_fails("probe", "C:/Users/other/eval.jsonl")
        assert any("colons are forbidden" in str(f) for f in fails)

    def test_plain_relative_refs_still_pass_hygiene(self):
        # Fail-closed-on-colon must NOT flag the legitimate committed refs,
        # which are all plain POSIX-relative (no colon anywhere).
        for ref in (
            "specs/corpus-2026-07-19-overredaction.jsonl",
            "context/pii-bank/eval-imports/clinical-german-v1.jsonl",
            "training/eval-dataset/clinical-german-v1.jsonl",
            "rows/synthetic-seed.jsonl",
        ):
            assert validate.path_or_ref_hygiene_fails("probe", ref) == [], f"unexpected fail on {ref!r}"

    def test_single_slash_file_uri_caught_in_default_mode(self, tmp_path, monkeypatch):
        # End-to-end: a single-slash file: ref in the committed manifest must
        # fail even a plain `validate.py` run (manifest_hygiene_only).
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        (rows_dir / "ok.jsonl").write_text(json.dumps(make_valid_row()) + "\n", encoding="utf-8")
        leaky = "file:" + str(PurePosixPath("/", "Users", "other-operator", "eval.jsonl"))
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_with(tmp_path, leaky))
        assert validate.main([]) == 1


class TestLocalRootResolution:
    def test_relative_local_entry_resolves_against_env_root(self, tmp_path, monkeypatch):
        root = tmp_path / "custom-root"
        (root / "sub").mkdir(parents=True)
        content = '{"text": "hello world"}\n'
        (root / "sub" / "asset.jsonl").write_text(content, encoding="utf-8")
        actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        manifest = {
            "entries": [
                {
                    "path_or_ref": "sub/asset.jsonl",
                    "sha256": actual_hash,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "env-root resolution test fixture",
                }
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")

        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        monkeypatch.setenv("PII_BANK_LOCAL_ROOT", str(root))
        fails, warns = validate.check_manifest()
        assert fails == []
        assert warns == []

    def test_relative_entry_missing_under_root_warns_not_fails(self, tmp_path, monkeypatch):
        manifest = {
            "entries": [
                {
                    "path_or_ref": "sub/definitely-missing.jsonl",
                    "sha256": "b" * 64,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "missing-under-root test fixture",
                }
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")

        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        monkeypatch.setenv("PII_BANK_LOCAL_ROOT", str(tmp_path / "empty-root"))
        fails, warns = validate.check_manifest()
        assert fails == []
        assert any("skipping hash check" in str(w) for w in warns)

    def test_default_local_root_when_env_unset(self, monkeypatch):
        monkeypatch.delenv("PII_BANK_LOCAL_ROOT", raising=False)
        assert validate.get_local_root() == Path(os.path.expanduser("~")) / "Opus Advisor"


# ---------------------------------------------------------------------------
# contamination
# ---------------------------------------------------------------------------


class TestContamination:
    def test_overlapping_8gram_fails(self, tmp_path, monkeypatch):
        shared_sentence = "the quick brown fox jumps over the lazy dog today"
        eval_asset = tmp_path / "eval.jsonl"
        eval_asset.write_text(json.dumps({"text": shared_sentence}) + "\n", encoding="utf-8")

        manifest = {
            "entries": [
                {
                    "path_or_ref": str(eval_asset),
                    "sha256": "irrelevant-for-this-test",
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)

        train_row = make_valid_row(id="contaminated-row", split="train", text=shared_sentence)
        fails = validate.run_contamination_check([(train_row, 1, "test.jsonl")])
        assert any("shares" in str(f) and "8-gram" in str(f) for f in fails)

    def test_no_overlap_passes(self, tmp_path, monkeypatch):
        eval_asset = tmp_path / "eval.jsonl"
        eval_asset.write_text(
            json.dumps({"text": "completely unrelated content about penguins in antarctica exploring ice"}) + "\n",
            encoding="utf-8",
        )

        manifest = {
            "entries": [
                {
                    "path_or_ref": str(eval_asset),
                    "sha256": "irrelevant-for-this-test",
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)

        train_row = make_valid_row(
            id="clean-row", split="train", text="A totally different sentence about mountain biking trails nearby."
        )
        fails = validate.run_contamination_check([(train_row, 1, "test.jsonl")])
        assert fails == []

    def test_eval_only_rows_are_not_scanned_against_themselves(self, tmp_path, monkeypatch):
        # contamination check only flags train/dev rows; eval-only rows must
        # be free to share text with the eval assets they came from.
        shared_sentence = "the quick brown fox jumps over the lazy dog today"
        eval_asset = tmp_path / "eval.jsonl"
        eval_asset.write_text(json.dumps({"text": shared_sentence}) + "\n", encoding="utf-8")

        manifest = {
            "entries": [
                {
                    "path_or_ref": str(eval_asset),
                    "sha256": "irrelevant-for-this-test",
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "test fixture",
                }
            ]
        }
        manifest_path = tmp_path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", manifest_path)

        eval_row = make_valid_row(
            id="eval-row", split="eval-only", provenance="eval-import", text=shared_sentence
        )
        fails = validate.run_contamination_check([(eval_row, 1, "test.jsonl")])
        assert fails == []


class TestContaminationFailClosed:
    # terra F2: with the local root absent, every asset silently skipped and
    # an EMPTY eval index passed -- the check vouched for nothing.

    def test_missing_local_root_fails(self, tmp_path, monkeypatch):
        manifest = {
            "entries": [
                {
                    "path_or_ref": "specs/some-corpus.jsonl",
                    "sha256": "a" * 64,
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "fail-closed probe",
                }
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        monkeypatch.setenv("PII_BANK_LOCAL_ROOT", str(tmp_path / "definitely-absent-root"))
        fails = validate.run_contamination_check([])
        assert any("fail-closed" in str(f) for f in fails)
        assert any("zero loadable" in str(f) for f in fails)

    def test_zero_eval_assets_fails(self, tmp_path, monkeypatch):
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps({"entries": []}), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        fails = validate.run_contamination_check([])
        assert any("zero loadable" in str(f) for f in fails)

    def test_one_missing_one_present_still_fails_and_still_scans(self, tmp_path, monkeypatch):
        shared = "the quick brown fox jumps over the lazy dog today"
        present = tmp_path / "present.jsonl"
        present.write_text(json.dumps({"text": shared}) + "\n", encoding="utf-8")
        manifest = {
            "entries": [
                {
                    "path_or_ref": str(present),
                    "sha256": "x",
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "present",
                },
                {
                    "path_or_ref": str(tmp_path / "absent.jsonl"),
                    "sha256": "x",
                    "location_class": "local",
                    "role": "eval-only",
                    "note": "absent",
                },
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        train_row = make_valid_row(id="overlap-row", text=shared)
        fails = validate.run_contamination_check([(train_row, 1, "t.jsonl")])
        # the missing asset FAILs AND the present asset still catches the overlap
        assert any("fail-closed" in str(f) for f in fails)
        assert any("8-gram" in str(f) for f in fails)


class TestContaminationPerAssetAccounting:
    # bug-hunter finding on ae343f3: a READABLE but malformed/empty JSONL
    # yielded zero n-grams and was silently OMITTED from the eval index while
    # other assets indexed -- so PASS did not prove every local/repo eval
    # asset actually loaded. Per-asset accounting is fail-closed now: every
    # asset must parse AND contribute >=1 n-gram.

    def _manifest(self, tmp_path, entries):
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps({"entries": entries}), encoding="utf-8")
        return mp

    def _local_entry(self, path, note):
        return {
            "path_or_ref": str(path),
            "sha256": "x",
            "location_class": "local",
            "role": "eval-only",
            "note": note,
        }

    def test_empty_jsonl_asset_fails_naming_it(self, tmp_path, monkeypatch):
        # PROBE 1: one empty .jsonl + one real asset -> FAIL naming the empty
        # one (pre-fix: the empty asset was silently dropped and the check
        # PASSED against only the real asset).
        empty = tmp_path / "empty.jsonl"
        empty.write_text("", encoding="utf-8")
        real = tmp_path / "real.jsonl"
        real.write_text(
            json.dumps({"text": "penguins in antarctica exploring the vast frozen ice shelves today"}) + "\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(
            validate,
            "MANIFEST_PATH",
            self._manifest(tmp_path, [self._local_entry(empty, "empty"), self._local_entry(real, "real")]),
        )
        clean_train = make_valid_row(
            id="clean-train", split="train", text="A totally different sentence about mountain biking trails."
        )
        fails = validate.run_contamination_check([(clean_train, 1, "t.jsonl")])
        # names the empty asset with the zero-n-gram reason
        assert any("zero n-grams" in str(f) and "empty.jsonl" in str(f) for f in fails)

    def test_whitespace_only_jsonl_asset_fails(self, tmp_path, monkeypatch):
        # A file with only blank lines also contributes zero n-grams.
        blanks = tmp_path / "blanks.jsonl"
        blanks.write_text("\n   \n\n", encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest(tmp_path, [self._local_entry(blanks, "blanks")]))
        fails = validate.run_contamination_check([])
        assert any("zero n-grams" in str(f) and "blanks.jsonl" in str(f) for f in fails)

    def test_malformed_jsonl_asset_fails(self, tmp_path, monkeypatch):
        # PROBE 2: a readable-but-unparseable .jsonl -> FAIL (parse-failure).
        bad = tmp_path / "malformed.jsonl"
        bad.write_text("{this is not valid json at all,,,\n", encoding="utf-8")
        real = tmp_path / "real.jsonl"
        real.write_text(
            json.dumps({"text": "penguins in antarctica exploring the vast frozen ice shelves today"}) + "\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(
            validate,
            "MANIFEST_PATH",
            self._manifest(tmp_path, [self._local_entry(bad, "malformed"), self._local_entry(real, "real")]),
        )
        fails = validate.run_contamination_check([])
        assert any("parse-failure" in str(f) and "malformed.jsonl" in str(f) for f in fails)

    def test_malformed_json_asset_fails(self, tmp_path, monkeypatch):
        # A .json asset (the CF2-oracle format) that is unparseable also FAILs.
        badjson = tmp_path / "oracle.json"
        badjson.write_text("{not valid json", encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest(tmp_path, [self._local_entry(badjson, "badjson")]))
        fails = validate.run_contamination_check([])
        assert any("parse-failure" in str(f) and "oracle.json" in str(f) for f in fails)

    def test_valid_json_asset_indexes_and_catches_overlap(self, tmp_path, monkeypatch):
        # A well-formed .json asset must parse, contribute n-grams, and catch
        # an overlap -- proving the .json path is scannable, not just gated.
        shared = "the quick brown fox jumps over the lazy dog today in the park"
        oracle = tmp_path / "oracle.json"
        oracle.write_text(json.dumps({"cases": [{"sentence": shared}]}), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest(tmp_path, [self._local_entry(oracle, "oracle")]))
        train_row = make_valid_row(id="json-overlap", split="train", text=shared)
        fails = validate.run_contamination_check([(train_row, 1, "t.jsonl")])
        assert any("8-gram" in str(f) for f in fails)

    def test_empty_asset_caught_end_to_end(self, tmp_path, monkeypatch):
        # main --contamination must exit 1 when a manifest eval asset is empty.
        rows_dir = tmp_path / "rows"
        rows_dir.mkdir()
        (rows_dir / "ok.jsonl").write_text(json.dumps(make_valid_row()) + "\n", encoding="utf-8")
        empty = tmp_path / "empty.jsonl"
        empty.write_text("", encoding="utf-8")
        monkeypatch.setattr(validate, "ROWS_DIR", rows_dir)
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest(tmp_path, [self._local_entry(empty, "empty")]))
        assert validate.main(["--contamination"]) == 1

    def test_all_assets_loading_still_passes(self, tmp_path, monkeypatch):
        # Regression: when every asset parses AND contributes n-grams, and no
        # train/dev row overlaps, the check PASSES (no false positive from the
        # new per-asset gate).
        a = tmp_path / "a.jsonl"
        a.write_text(json.dumps({"text": "alpha bravo charlie delta echo foxtrot golf hotel india"}) + "\n", encoding="utf-8")
        b = tmp_path / "b.md"
        b.write_text("juliet kilo lima mike november oscar papa quebec romeo sierra tango", encoding="utf-8")
        monkeypatch.setattr(
            validate,
            "MANIFEST_PATH",
            self._manifest(tmp_path, [self._local_entry(a, "a"), self._local_entry(b, "b")]),
        )
        clean_train = make_valid_row(
            id="clean", split="train", text="completely disjoint words zebra yankee xray whiskey victor uniform tango"
        )
        fails = validate.run_contamination_check([(clean_train, 1, "t.jsonl")])
        assert fails == [], f"expected clean PASS, got: {[str(f) for f in fails]}"


class TestContaminationUnicodeNormalization:
    # terra F3: NFD and NFC encodings of the same text shared ZERO 8-grams,
    # so a canonically-different copy of eval text evaded the check entirely.

    NFC_SENTENCE = unicodedata.normalize(
        "NFC", "café münchen besucht die alte bäckerei am marktplatz heute"
    )
    NFD_SENTENCE = unicodedata.normalize("NFD", NFC_SENTENCE)

    def _manifest_for(self, tmp_path, eval_text):
        asset = tmp_path / "eval.jsonl"
        asset.write_text(json.dumps({"text": eval_text}, ensure_ascii=False) + "\n", encoding="utf-8")
        mp = tmp_path / "manifest.json"
        mp.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "path_or_ref": str(asset),
                            "sha256": "x",
                            "location_class": "local",
                            "role": "eval-only",
                            "note": "unicode probe",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        return mp

    def test_nfd_vs_nfc_now_collides(self, tmp_path, monkeypatch):
        assert self.NFC_SENTENCE != self.NFD_SENTENCE  # probe only meaningful if raw forms differ
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_for(tmp_path, self.NFC_SENTENCE))
        train_row = make_valid_row(id="nfd-row", lang="de", text=self.NFD_SENTENCE)
        fails = validate.run_contamination_check([(train_row, 1, "t.jsonl")])
        assert any("8-gram" in str(f) for f in fails)

    def test_sharp_s_vs_ss_now_collides(self, tmp_path, monkeypatch):
        eval_text = "die alte straße war gesperrt für den verkehr heute"
        train_text = "die alte STRASSE war gesperrt für den verkehr heute"
        monkeypatch.setattr(validate, "MANIFEST_PATH", self._manifest_for(tmp_path, eval_text))
        train_row = make_valid_row(id="ss-row", lang="de", text=train_text)
        fails = validate.run_contamination_check([(train_row, 1, "t.jsonl")])
        assert any("8-gram" in str(f) for f in fails)


class TestContaminationRepoEntries:
    # terra F8 (advisory): 'repo' entries were invisible to contamination;
    # S2 repo-resident eval assets must be covered from day one.

    def test_repo_entry_indexed_and_catches_overlap(self, tmp_path, monkeypatch):
        seed_line = json.loads(
            (PII_BANK_DIR / "rows" / "synthetic-seed.jsonl").read_text(encoding="utf-8").splitlines()[0]
        )
        manifest = {
            "entries": [
                {
                    "path_or_ref": "rows/synthetic-seed.jsonl",
                    "sha256": "x",
                    "location_class": "repo",
                    "role": "eval-only",
                    "note": "repo-entry probe",
                }
            ]
        }
        mp = tmp_path / "manifest.json"
        mp.write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(validate, "MANIFEST_PATH", mp)
        train_row = make_valid_row(id="repo-overlap-row", text=seed_line["text"])
        fails = validate.run_contamination_check([(train_row, 1, "t.jsonl")])
        assert any("8-gram" in str(f) for f in fails)


# ---------------------------------------------------------------------------
# end-to-end main() smoke tests
# ---------------------------------------------------------------------------


class TestMainEndToEnd:
    def _write_bank(self, tmp_path: Path, rows: list[dict], manifest_entries: list[dict] | None = None):
        bank_dir = tmp_path / "pii-bank"
        rows_dir = bank_dir / "rows"
        rows_dir.mkdir(parents=True)
        with open(rows_dir / "test.jsonl", "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        manifest = {"entries": manifest_entries or []}
        with open(bank_dir / "manifest.json", "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        return bank_dir

    def test_main_exits_zero_on_clean_bank(self, tmp_path, monkeypatch):
        bank_dir = self._write_bank(tmp_path, [make_valid_row()])
        monkeypatch.setattr(validate, "ROWS_DIR", bank_dir / "rows")
        monkeypatch.setattr(validate, "MANIFEST_PATH", bank_dir / "manifest.json")
        exit_code = validate.main([])
        assert exit_code == 0

    def test_main_exits_one_on_bad_row(self, tmp_path, monkeypatch, capsys):
        bad_row = make_valid_row(lang="fr")
        bank_dir = self._write_bank(tmp_path, [bad_row])
        monkeypatch.setattr(validate, "ROWS_DIR", bank_dir / "rows")
        monkeypatch.setattr(validate, "MANIFEST_PATH", bank_dir / "manifest.json")
        exit_code = validate.main([])
        assert exit_code == 1
