"""Emit-site gates for S3 tooling; deliberately no model imports/training."""

from __future__ import annotations

import copy
import json
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


TRAIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAIN_DIR))

import select_on_dev  # noqa: E402
import smoke  # noqa: E402
import eval_model  # noqa: E402
from eval_model import evaluate_loaded_model, load_quarantined_eval_rows, score_predictions  # noqa: E402
from powerfloor_freeze import current_dev_counts, parse_frozen_power_floors, verify_power_floors  # noqa: E402
from tooling import (  # noqa: E402
    AI4PRIVACY_BASE_MIX,
    CustodyError,
    DEV_SHA256,
    FrozenDevMismatch,
    LABEL_ORDER,
    METHOD_FREEZE_REQUIRED_FIELDS,
    ToolingError,
    FinalRunRefused,
    ai4privacy_replay_row,
    load_synthetic_checkpoint,
    load_run_config,
    row_to_gliner_example,
    sha256_file,
    validate_run_config,
    verify_frozen_dev,
)


class TrainToolingTests(unittest.TestCase):
    def test_dev_sha_verification_refuses_wrong_hash_before_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tampered = Path(directory) / "dev.jsonl"
            tampered.write_text('{"text":"tampered"}\n', encoding="utf-8")
            with self.assertRaises(FrozenDevMismatch):
                verify_frozen_dev(tampered, DEV_SHA256)

    def test_custody_assert_fires_for_manifest_eval_only_path_without_reading_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            # The asset deliberately does not exist. A path-only custody check
            # must still reject it before any attempted open/read.
            forbidden = local_root / "context/pii-bank/eval-imports/clinical-german-v1.jsonl"
            with self.assertRaises(CustodyError):
                select_on_dev.assert_selection_custody(forbidden, local_root=local_root)

    def test_power_floor_is_no_higher_than_current_frozen_dev_evidence(self) -> None:
        floors = parse_frozen_power_floors()
        verify_power_floors(floors, current_dev_counts())
        self.assertEqual(len(floors), 9)
        rendered = (TRAIN_DIR / "POWER-FLOOR.md").read_text(encoding="utf-8")
        for floor in floors:
            self.assertIn(
                f"| {floor['bucket']} | {floor['class']} | {floor['lang']} | {floor['min_cases']} | {floor['min_spans']} |",
                rendered,
            )

    def test_preregistered_run_configs_are_complete_and_seed_only_varies(self) -> None:
        config_dir = TRAIN_DIR / "run_configs"
        configs = [load_run_config(config_dir / name) for name in ("seed1.json", "seed2.json", "seed3.json", "baseline.json")]
        for config in configs:
            self.assertTrue(METHOD_FREEZE_REQUIRED_FIELDS.issubset(config["method_freeze"]))
            self.assertEqual(config["method_freeze"]["update_method"], "full_fine_tune")
            self.assertEqual(config["method_freeze"]["precision"], "fp32")
            self.assertTrue(config["method_freeze"]["save_reload"]["evaluate_only_saved_and_reloaded"])
        seeds = configs[:3]
        canonical = []
        for config in seeds:
            material = json.loads(json.dumps(config))
            material.pop("seed")
            material.pop("run_id")
            canonical.append(material)
        self.assertEqual(canonical[0], canonical[1])
        self.assertEqual(canonical[1], canonical[2])
        self.assertEqual(len({config["seed"] for config in seeds}), 3)

    def test_smoke_cli_has_locked_arg_contract(self) -> None:
        parser = smoke.build_parser()
        actions = {option for action in parser._actions for option in action.option_strings}
        self.assertTrue({"--sample-path", "--parity-tolerance", "--parity-absolute-tolerance"}.issubset(actions))
        args = parser.parse_args([])
        self.assertEqual(args.rows, 10)
        self.assertEqual(args.parity_tolerance, 0.02)
        self.assertEqual(args.parity_absolute_tolerance, 0.05)
        self.assertEqual(args.seed, 104729)

    def test_json_adjacent_structural_span_converts_to_word_level_gliner_indices(self) -> None:
        row = next(row for row in load_synthetic_checkpoint(1000) if row["id"] == "gen2-struct-name-de-f09-p031-1")
        example = row_to_gliner_example(row)
        self.assertEqual(example["ner"], [[15, 15, "person"]])

    def test_exact_span_scorer_counts_keep_prediction_as_false_positive(self) -> None:
        rows = [
            {
                "text": "Ada met Dublin.",
                "lang": "en",
                "spans": [
                    {"start": 0, "end": 3, "category": "PERSON", "expected": "REDACT"},
                    {"start": 8, "end": 14, "category": "LOCATION", "expected": "KEEP"},
                ],
            }
        ]
        result = score_predictions(
            rows,
            lambda _text: [
                {"start": 0, "end": 3, "label": "person"},
                {"start": 8, "end": 14, "label": "location"},
            ],
        )
        self.assertEqual(result["overall"]["tp"], 1)
        self.assertEqual(result["overall"]["fp"], 1)
        self.assertEqual(result["overall"]["fn"], 0)
        self.assertEqual(result["per_category_lang"]["PERSON|en"]["recall"], 1.0)

    def test_selection_rejects_eval_only_dev_before_frozen_hash_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            forbidden = local_root / "context/pii-bank/eval-imports/clinical-german-v1.jsonl"
            stream = io.StringIO()
            with redirect_stdout(stream):
                result = select_on_dev.main(["--local-root", str(local_root), "--dev", str(forbidden)])
            self.assertEqual(result, 1)
            self.assertIn("eval-only", stream.getvalue())

    def test_eval_rejects_quarantined_path_via_dev_flag_without_model_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            forbidden = local_root / "context/pii-bank/eval-imports/clinical-german-v1.jsonl"
            stream = io.StringIO()
            with redirect_stdout(stream):
                result = eval_model.main(["--local-root", str(local_root), "--dev", str(forbidden)])
            self.assertEqual(result, 1)
            self.assertIn("eval-only", stream.getvalue())

    def test_smoke_report_cannot_escape_local_root_before_model_import(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            outside = local_root.parent / "outside-smoke.json"
            stream = io.StringIO()
            with redirect_stdout(stream):
                result = smoke.main(["--local-root", str(local_root), "--report", str(outside)])
            self.assertEqual(result, 1)
            self.assertIn("PII_BANK_LOCAL_ROOT", stream.getvalue())

    def test_selection_refuses_an_unregistered_grid_before_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            alternate_grid = local_root / "alternate-grid.json"
            stream = io.StringIO()
            with redirect_stdout(stream):
                result = select_on_dev.main(["--local-root", str(local_root), "--grid", str(alternate_grid)])
            self.assertEqual(result, 1)
            self.assertIn("preregistered", stream.getvalue())

    def test_run_config_cannot_replace_the_immutable_frozen_dev_pin(self) -> None:
        config = load_run_config(TRAIN_DIR / "run_configs" / "seed1.json")
        config["dev_sha256"] = "0" * 64
        with self.assertRaisesRegex(ToolingError, "frozen DEV_SHA256"):
            validate_run_config(config)

    def test_quarantined_json_adapter_normalizes_structured_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "final.json"
            fixture.write_text(
                json.dumps({"rows": [{"input": "Ada", "language": "en", "entities": [{"begin": 0, "stop": 3, "type": "person"}]}]}),
                encoding="utf-8",
            )
            self.assertEqual(
                load_quarantined_eval_rows(fixture),
                [{"text": "Ada", "lang": "en", "spans": [{"start": 0, "end": 3, "category": "PERSON", "expected": "REDACT"}]}],
            )

    def test_quarantined_markdown_adapter_accepts_fenced_json_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "breadth.md"
            fixture.write_text(
                "# held-out\n\n```json\n[{\"text\": \"Ada\", \"spans\": [{\"start\": 0, \"end\": 3, \"category\": \"PERSON\"}]}]\n```\n",
                encoding="utf-8",
            )
            self.assertEqual(load_quarantined_eval_rows(fixture)[0]["spans"][0]["category"], "PERSON")

    def test_final_scorer_prompts_fixed_breadth_and_counts_unprompted_gold_category_fp(self) -> None:
        class FakeModel:
            def __init__(self) -> None:
                self.labels: list[str] = []

            def predict_entities(self, _text: str, labels: list[str], **_kwargs: object) -> list[dict[str, object]]:
                self.labels = labels
                return [
                    {"start": 0, "end": 3, "label": "person"},
                    {"start": 4, "end": 8, "label": "vendor"},
                ]

        model = FakeModel()
        result = evaluate_loaded_model(
            model,
            [{"text": "Ada Acme", "lang": "en", "spans": [{"start": 0, "end": 3, "category": "PERSON", "expected": "REDACT"}]}],
        )
        self.assertEqual(model.labels, [label for _, label in LABEL_ORDER])
        self.assertEqual(result["overall"]["tp"], 1)
        self.assertEqual(result["overall"]["fp"], 1)
        self.assertEqual(result["per_category"]["VENDOR"]["fp"], 1)

    def test_quarantined_loader_accepts_a_declared_extra_category(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "final.jsonl"
            fixture.write_text(
                '{"text":"ada@example.test","spans":[{"start":0,"end":16,"category":"EMAIL","expected":"REDACT"}]}\n',
                encoding="utf-8",
            )
            self.assertEqual(load_quarantined_eval_rows(fixture)[0]["spans"][0]["category"], "EMAIL")

    def test_quarantined_loader_rejects_unknown_category_typo(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "final.jsonl"
            fixture.write_text(
                '{"text":"Ada","spans":[{"start":0,"end":3,"category":"PERSN","expected":"REDACT"}]}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ToolingError, "unsupported category"):
                load_quarantined_eval_rows(fixture)

    def test_quarantined_loader_rejects_bare_redact_false(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "final.jsonl"
            fixture.write_text(
                '{"text":"Ada","spans":[{"start":0,"end":3,"category":"PERSON","redact":false}]}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ToolingError, "redact=false is ambiguous"):
                load_quarantined_eval_rows(fixture)

    def test_normalized_companion_requires_hash_binding_to_manifest_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_root = Path(directory)
            companion = local_root / "frozen-final.jsonl"
            companion.write_text('{"text":"Ada","spans":[]}\n', encoding="utf-8")
            metadata = local_root / "frozen-final.meta.json"
            metadata.write_text(
                json.dumps(
                    {
                        "source_manifest_entry": "context/pii-bank/eval-imports/clinical-german-v1.jsonl",
                        "source_manifest_sha256": "a" * 64,
                        "companion_sha256": sha256_file(companion),
                    }
                ),
                encoding="utf-8",
            )
            provenance = eval_model._verify_normalized_companion(
                companion,
                metadata,
                manifest_entry="context/pii-bank/eval-imports/clinical-german-v1.jsonl",
                manifest_sha256="a" * 64,
                local_root=local_root,
            )
            self.assertEqual(provenance["sha256"], sha256_file(companion))
            metadata.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ToolingError, "does not bind"):
                eval_model._verify_normalized_companion(
                    companion,
                    metadata,
                    manifest_entry="context/pii-bank/eval-imports/clinical-german-v1.jsonl",
                    manifest_sha256="a" * 64,
                    local_root=local_root,
                )

    def test_base_mix_hash_gate_refuses_a_wrong_file_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = Path(directory) / "export-train.jsonl"
            payload.write_text('{"source_text":"Ada","privacy_mask":[],"language":"en","uid":1}\n', encoding="utf-8")
            with self.assertRaisesRegex(FinalRunRefused, "SHA-256"):
                __import__("tooling")._require_hash(payload, "0" * 64, description="fixture train export")

    def test_base_mix_mapping_drops_excluded_labels_and_preserves_codepoint_surfaces(self) -> None:
        text = "Ada Doe of Bonn on Main St emails ada@example.test."
        row = ai4privacy_replay_row(
            {
                "source_text": text,
                "language": "en",
                "uid": 42,
                # Deliberately unreliable: conversion must not consult this field.
                "split": "validation",
                "privacy_mask": [
                    {"start": 0, "end": 3, "label": "GIVENNAME", "value": "Ada"},
                    {"start": 4, "end": 7, "label": "SURNAME", "value": "Doe"},
                    {"start": 11, "end": 15, "label": "CITY", "value": "Bonn"},
                    {"start": 19, "end": 26, "label": "STREET", "value": "Main St"},
                    {"start": 34, "end": 50, "label": "EMAIL", "value": "ada@example.test"},
                ],
            }
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual([span["category"] for span in row["spans"]], ["PERSON", "PERSON", "LOCATION", "LOCATION"])
        self.assertEqual([span["surface"] for span in row["spans"]], ["Ada", "Doe", "Bonn", "Main St"])
        self.assertEqual(row["family_id"], "ai4privacy-mini10k-42")
        self.assertEqual(row["split"], "train")

    def test_base_mix_validation_file_is_never_accepted_as_train_input(self) -> None:
        altered = copy.deepcopy(AI4PRIVACY_BASE_MIX)
        altered["train_jsonl_path"] = altered["validation_jsonl_path"]
        original = __import__("tooling").AI4PRIVACY_BASE_MIX
        try:
            __import__("tooling").AI4PRIVACY_BASE_MIX = altered
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(FinalRunRefused, "validation base-mix files are excluded"):
                    __import__("tooling").require_admitted_base_mix({"base_mix": altered}, Path(directory))
        finally:
            __import__("tooling").AI4PRIVACY_BASE_MIX = original


if __name__ == "__main__":
    unittest.main()
