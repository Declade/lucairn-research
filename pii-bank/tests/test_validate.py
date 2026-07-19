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
        assert any("end < start" in str(f) for f in fails)

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
        assert any("surface must be a string" in str(f) for f in fails)

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
