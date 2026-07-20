#!/usr/bin/env python3
"""Executable, logged S3 selection on the frozen dev artifact only.

This module intentionally has no loader for quarantined assets.  It may inspect
the public manifest solely to reject declared paths before any file is opened.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eval_model import evaluate_loaded_model, load_model
from tooling import (
    AI4PRIVACY_BASE_MIX,
    DEFAULT_DEV_PATH,
    ToolingError,
    assert_config_has_no_eval_only_paths,
    assert_not_eval_only_path,
    load_json,
    load_jsonl,
    load_run_config,
    local_ref,
    local_runs_root,
    require_local_root,
    resolve_local_ref,
    sha256_file,
    verify_frozen_dev,
    write_json,
)
from train import run_training


RUN_CONFIGS = Path(__file__).resolve().parent / "run_configs"
PREREGISTERED_GRID = RUN_CONFIGS / "selection-grid.json"
PREREGISTERED_SHA256 = {
    "selection-grid.json": "430640ad2cec045671d827d80706afeda9faf6fdfa9de06ce950bc742dc89a53",
    "seed1.json": "9076eb95d565b87f110b42eb51d1dcb41a68ae8edd16d721f5c5ed7e75c1e238",
    "seed2.json": "71e16749afeceefbb82e69a1b5073950736b9fc74a3bd60609fe874ec7f4eb43",
    "seed3.json": "8eb665527b7f9c56c6c85b62a72e73fa5ebeb2e18fe3b9477a229d6e0f1f02c1",
    "baseline.json": "4adb817a1d47d76b26f88dbfad79670f0156ca24e64ee608c1b6ec4c3cb1714e",
}
DECLARED_CANDIDATE_IDS = (
    "1k-default",
    "1k-low-lr",
    "3k-default",
    "3k-low-lr",
    "8k-default",
    "8k-low-lr",
)


def assert_selection_custody(path: Path | str, *, local_root: Path) -> None:
    """Public test hook: reject a manifest eval-only path without opening it."""
    assert_not_eval_only_path(path, local_root=local_root)


def _assert_preregistered_file(path: Path) -> None:
    """Selection is intentionally limited to the committed pre-registration."""
    try:
        expected = PREREGISTERED_SHA256[path.name]
    except KeyError as exc:
        raise ToolingError(f"selection uses only preregistered config files, not {path.name}") from exc
    if path.parent.resolve() != RUN_CONFIGS.resolve() or sha256_file(path) != expected:
        raise ToolingError(f"preregistered selection file is missing, moved, or hash-modified: {path.name}")


def _validate_declared_grid(grid: dict[str, Any]) -> None:
    candidates = grid.get("candidates")
    if not isinstance(candidates, list):
        raise ToolingError("selection grid must contain a candidates list")
    identifiers = tuple(str(item.get("candidate_id")) for item in candidates if isinstance(item, dict))
    corpus_sizes = tuple(int(item.get("corpus_size", -1)) for item in candidates if isinstance(item, dict))
    if identifiers != DECLARED_CANDIDATE_IDS or corpus_sizes != (1000, 1000, 3000, 3000, 8000, 8000):
        raise ToolingError("selection grid differs from the declared 1k/3k/8k candidate set")
    if grid.get("training_base_config") != "seed1.json" or grid.get("baseline_config") != "baseline.json":
        raise ToolingError("selection grid differs from the declared seed1/baseline provenance")
    if grid.get("base_mix") != AI4PRIVACY_BASE_MIX:
        raise ToolingError("selection grid differs from the admitted ai4privacy mini-10k replay freeze")


def _assert_local_operator_path(path: Path, *, local_root: Path, purpose: str) -> None:
    try:
        path.resolve().relative_to(local_root)
    except ValueError as exc:
        raise ToolingError(f"{purpose} must remain under PII_BANK_LOCAL_ROOT") from exc


def _append_log(path: Path, event: dict[str, Any]) -> None:
    if path.exists():
        current = load_json(path)
        if not isinstance(current, list):
            raise ToolingError(f"selection log is not a JSON list: {path}")
    else:
        current = []
    current.append(event)
    write_json(path, current)


def _config_hash(config: dict[str, Any]) -> str:
    serialized = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _parse_artifact_pairs(values: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ToolingError("--artifact must be CANDIDATE_ID=LOCAL_ARTIFACT_PATH")
        candidate_id, artifact = value.split("=", 1)
        if not candidate_id or not artifact:
            raise ToolingError("--artifact must be CANDIDATE_ID=LOCAL_ARTIFACT_PATH")
        result[candidate_id] = Path(artifact)
    return result


def _candidate_config(base: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    config = copy.deepcopy(base)
    candidate_id = str(candidate["candidate_id"])
    config["run_id"] = f"dev-select-{candidate_id}"
    config["mode"] = "dev-explore"
    config["corpus_size"] = int(candidate["corpus_size"])
    overrides = candidate.get("overrides", {})
    if not isinstance(overrides, dict):
        raise ToolingError(f"candidate {candidate_id} overrides must be an object")
    config["training"].update(overrides)
    return config


def _metric_value(metrics: dict[str, Any], name: str) -> float:
    value = metrics.get(name)
    if not isinstance(value, (int, float)):
        raise ToolingError(f"selection metric {name!r} missing/non-numeric in dev score")
    return float(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score the predeclared S3 corpus/hyperparameter grid on frozen dev only")
    parser.add_argument("--grid", type=Path, default=PREREGISTERED_GRID, help="locked preregistered grid; alternate paths are refused")
    parser.add_argument("--dev", type=Path, default=DEFAULT_DEV_PATH)
    parser.add_argument("--local-root", type=str, default=None)
    parser.add_argument("--artifact", action="append", default=[], help="CANDIDATE_ID=LOCAL_ARTIFACT_PATH; may repeat")
    parser.add_argument("--execute-training", action="store_true", help="run missing candidates as dev-explore; never final-eval")
    parser.add_argument("--smoke-report", type=Path, default=None, help="required passing MPS smoke report when --execute-training is used")
    parser.add_argument("--selection-log", type=Path, default=None)
    parser.add_argument("--output-final-config", type=Path, default=None)
    parser.add_argument("--device", choices=("mps", "cpu"), default="mps")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        local_root = require_local_root(args.local_root)
        # These path-only manifest checks precede every input read and every
        # output write.  They never dereference an eval-only asset.
        assert_selection_custody(args.dev, local_root=local_root)
        assert_selection_custody(args.grid, local_root=local_root)
        artifact_pairs = _parse_artifact_pairs(args.artifact)
        for artifact in artifact_pairs.values():
            assert_selection_custody(artifact, local_root=local_root)
            _assert_local_operator_path(artifact, local_root=local_root, purpose="candidate artifact")
        if args.smoke_report is not None:
            assert_selection_custody(args.smoke_report, local_root=local_root)
            _assert_local_operator_path(args.smoke_report, local_root=local_root, purpose="smoke report")
        log_path = args.selection_log or local_runs_root(local_root) / "selection" / "selection-log.json"
        output_path = args.output_final_config or local_runs_root(local_root) / "selection" / "frozen-final-config.json"
        for output in (log_path, output_path):
            assert_selection_custody(output, local_root=local_root)
            _assert_local_operator_path(output, local_root=local_root, purpose="selection logs/config")
        _assert_preregistered_file(args.grid)
        # This must precede dataset parsing, model loading, and every scorer call.
        dev_sha = verify_frozen_dev(args.dev)
        dev_rows = load_jsonl(args.dev)
        grid = load_json(args.grid)
        if not isinstance(grid, dict):
            raise ToolingError("selection grid must be an object")
        _validate_declared_grid(grid)
        base_path = args.grid.parent / str(grid["training_base_config"])
        baseline_path = args.grid.parent / str(grid["baseline_config"])
        assert_selection_custody(base_path, local_root=local_root)
        assert_selection_custody(baseline_path, local_root=local_root)
        _assert_preregistered_file(base_path)
        _assert_preregistered_file(baseline_path)
        base_config = load_run_config(base_path)
        baseline_config = load_run_config(baseline_path)
        assert_config_has_no_eval_only_paths(base_config, local_root=local_root)
        assert_config_has_no_eval_only_paths(baseline_config, local_root=local_root)

        # Baseline is deliberately scored first, before any candidate artifact.
        baseline_metrics = evaluate_loaded_model(load_model(None, local_root=local_root, device=args.device), dev_rows)
        _append_log(
            log_path,
            {
                "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                "kind": "baseline-first",
                "candidate_id": baseline_config["run_id"],
                "config_sha256": _config_hash(baseline_config),
                "frozen_dev_sha256": dev_sha,
                "metrics": baseline_metrics,
            },
        )

        scored: list[dict[str, Any]] = []
        for candidate in grid["candidates"]:
            if not isinstance(candidate, dict):
                raise ToolingError("selection candidate must be an object")
            candidate_id = str(candidate["candidate_id"])
            config = _candidate_config(base_config, candidate)
            assert_config_has_no_eval_only_paths(config, local_root=local_root)
            if candidate_id in artifact_pairs:
                artifact = artifact_pairs[candidate_id]
                provenance_path = artifact.parent / "run.json"
                assert_selection_custody(provenance_path, local_root=local_root)
                if not provenance_path.is_file():
                    raise ToolingError("candidate artifact must have a sibling local run.json provenance record")
                run_record = load_json(provenance_path)
                if not isinstance(run_record, dict) or "no_base_mix" not in run_record:
                    raise ToolingError("candidate run.json lacks the required no_base_mix provenance marker")
                if _config_hash(run_record.get("config", {})) != _config_hash(config):
                    raise ToolingError("candidate artifact run.json config does not match the declared selection-grid candidate")
            elif args.execute_training:
                run_record = run_training(
                    config,
                    mode="dev-explore",
                    local_root=local_root,
                    device=args.device,
                    smoke_report=args.smoke_report,
                )
                artifact = resolve_local_ref(str(run_record["artifact"]["local_ref"]), local_root)
                for epoch_event in run_record.get("epochs", []):
                    if not isinstance(epoch_event, dict) or not isinstance(epoch_event.get("dev_metrics_saved_reloaded"), dict):
                        raise ToolingError("dev-explore run record lacks saved-and-reloaded epoch metrics")
                    _append_log(
                        log_path,
                        {
                            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                            "kind": "dev-selection-epoch-saved-reloaded",
                            "candidate_id": candidate_id,
                            "config_sha256": _config_hash(config),
                            "frozen_dev_sha256": dev_sha,
                            "epoch": epoch_event.get("epoch"),
                            "artifact_tree_sha256": epoch_event.get("saved_artifact_tree_sha256"),
                            "metrics": epoch_event["dev_metrics_saved_reloaded"],
                        },
                    )
            else:
                raise ToolingError(f"candidate {candidate_id} has no artifact; pass --artifact or --execute-training")
            metrics = evaluate_loaded_model(load_model(artifact, local_root=local_root, device=args.device), dev_rows)
            event = {
                "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                "kind": "dev-selection-candidate",
                "candidate_id": candidate_id,
                "config_sha256": _config_hash(config),
                "frozen_dev_sha256": dev_sha,
                "artifact_local_ref": local_ref(artifact, local_root),
                "run_status": run_record["status"],
                "no_base_mix": bool(run_record.get("no_base_mix", False)),
                "metrics": metrics,
            }
            _append_log(log_path, event)
            scored.append({"candidate": candidate, "config": config, "event": event})
        metric_name = str(grid.get("selection_metric", "macro_f1"))
        best = max(scored, key=lambda item: _metric_value(item["event"]["metrics"], metric_name))
        no_base_mix = bool(best["event"]["no_base_mix"])
        selected_config = copy.deepcopy(best["config"])
        seed_paths = [args.grid.parent / name for name in ("seed1.json", "seed2.json", "seed3.json")]
        for seed_path in seed_paths:
            assert_selection_custody(seed_path, local_root=local_root)
            _assert_preregistered_file(seed_path)
        seed_configs = [load_run_config(seed_path) for seed_path in seed_paths]
        final_seed_configs = []
        for seed_config in seed_configs:
            final_seed = copy.deepcopy(selected_config)
            final_seed["mode"] = "dev-explore" if no_base_mix else "final"
            final_seed["run_id"] = seed_config["run_id"]
            final_seed["seed"] = seed_config["seed"]
            final_seed_configs.append(final_seed)
        frozen = {
            "schema_version": 1,
            "status": "DEV-EXPLORE-NO-BASE-MIX" if no_base_mix else "FROZEN-FINAL-CONFIG",
            "selection_metric": metric_name,
            "selected_candidate": best["candidate"],
            "final_seed_configs": final_seed_configs,
            "baseline_first": {"config": baseline_config["run_id"], "metrics": baseline_metrics},
            "frozen_dev_sha256": dev_sha,
            "selection_log_local_ref": local_ref(log_path, local_root),
            "custody": "dev-only selection; no eval-only manifest asset was opened",
        }
        write_json(output_path, frozen)
        print(json.dumps(frozen, ensure_ascii=False, sort_keys=True))
        return 0
    except ToolingError as exc:
        print(f"SELECTION ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
