#!/usr/bin/env python3
"""Deterministic, custody-safe full FP32 GLiNER fine-tuning for S3."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
from pathlib import Path
from typing import Any

from eval_model import evaluate_loaded_model, load_model
from powerfloor_freeze import current_dev_counts, parse_frozen_power_floors, verify_power_floors
from tooling import (
    BASE_CHECKPOINT,
    BASE_REVISION,
    DEV_SHA256,
    DEFAULT_DEV_PATH,
    FinalRunRefused,
    ToolingError,
    assert_config_has_no_eval_only_paths,
    assert_not_eval_only_path,
    code_hashes,
    host_environment,
    load_json,
    load_jsonl,
    load_run_config,
    load_synthetic_checkpoint,
    local_cache_root,
    local_ref,
    local_runs_root,
    require_admitted_base_mix,
    require_local_root,
    rows_to_gliner_examples,
    sample_update_weighted_rows,
    seed_everything,
    sha256_file,
    sha256_tree,
    verify_frozen_dev,
    write_json,
    checkpoint_shards,
)


def _safe_run_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise ToolingError("run_id may contain only letters, digits, '.', '_', and '-'")
    return value


def _require_smoke_gate(path: Path | None, *, local_root: Path) -> None:
    if path is None:
        raise FinalRunRefused("final run requires --smoke-report from a passing smoke.py MPS gate")
    assert_not_eval_only_path(path, local_root=local_root)
    report = load_json(path)
    if not isinstance(report, dict) or report.get("status") != "PASS":
        raise FinalRunRefused("final run requires a smoke report whose status is PASS")
    if report.get("sample_rows") != 10 or report.get("protocol") != "10-row FP32 forward/backward CPU-MPS parity":
        raise FinalRunRefused("smoke report is not the locked 10-row FP32 MPS protocol")


def _loss_by_epoch(log_history: list[dict[str, Any]], epochs: int) -> dict[int, float | None]:
    values: dict[int, float | None] = {epoch: None for epoch in range(1, epochs + 1)}
    for event in log_history:
        if not isinstance(event, dict) or "loss" not in event:
            continue
        event_epoch = event.get("epoch")
        if isinstance(event_epoch, (int, float)):
            epoch = min(epochs, max(1, math.ceil(float(event_epoch))))
            values[epoch] = float(event["loss"])
    return values


def _epoch_metrics(
    *,
    artifact: Path,
    epochs: int,
    steps_per_epoch: int,
    losses: dict[int, float | None],
    dev_rows: list[dict[str, Any]],
    local_root: Path,
    device: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for epoch in range(1, epochs + 1):
        checkpoint = artifact / f"checkpoint-{epoch * steps_per_epoch}"
        # Trainer checkpoints are persisted each epoch.  The last row uses the
        # explicit final saved artifact, which is the sole acceptance artifact.
        reload_target = artifact if epoch == epochs else checkpoint
        if not reload_target.is_dir():
            raise ToolingError(f"expected saved checkpoint for epoch {epoch} is missing: {reload_target}")
        metrics = evaluate_loaded_model(load_model(reload_target, local_root=local_root, device=device), dev_rows)
        result.append(
            {
                "epoch": epoch,
                "loss": losses[epoch],
                "saved_artifact_tree_sha256": sha256_tree(reload_target),
                "dev_metrics_saved_reloaded": metrics,
            }
        )
    return result


def run_training(
    config: dict[str, Any],
    *,
    mode: str | None = None,
    local_root: Path | None = None,
    device: str = "mps",
    smoke_report: Path | None = None,
    run_id_override: str | None = None,
) -> dict[str, Any]:
    """Run one train configuration; callable by executable dev selection."""
    try:
        import torch
        from gliner import GLiNER
    except ImportError as exc:  # pragma: no cover - actual training only
        raise ToolingError("training requires pinned torch and gliner dependencies") from exc
    active_mode = mode or str(config.get("mode", "final"))
    if active_mode not in {"final", "smoke", "dev-explore"}:
        raise ToolingError("mode must be final, smoke, or dev-explore")
    if device != "mps":
        raise ToolingError("S3 full fine-tuning is MacBook MPS-only; use smoke.py for the CPU parity leg")
    if not torch.backends.mps.is_available():
        raise ToolingError("MPS unavailable; full training is gated")
    root = local_root or require_local_root()
    assert_config_has_no_eval_only_paths(config, local_root=root)
    if active_mode in {"final", "dev-explore"}:
        _require_smoke_gate(smoke_report, local_root=root)
    cache_dir = local_cache_root(root)
    cache_dir.mkdir(parents=True, exist_ok=True)
    run_id = _safe_run_id(run_id_override or str(config["run_id"]))
    run_dir = local_runs_root(root) / run_id
    artifact = run_dir / "artifact"
    if run_dir.exists():
        raise ToolingError(f"refusing to overwrite existing local run directory: {run_dir}")

    if config.get("dev_sha256") != DEV_SHA256:
        raise ToolingError("config dev_sha256 differs from the immutable frozen dev pin")
    verify_frozen_dev(DEFAULT_DEV_PATH)
    verify_power_floors(parse_frozen_power_floors(), current_dev_counts())
    dev_rows = load_jsonl(DEFAULT_DEV_PATH)
    seed = int(config["seed"])
    seed_everything(seed)
    torch.use_deterministic_algorithms(True)

    if active_mode == "final":
        base_rows = require_admitted_base_mix(config, root)
    else:
        try:
            base_rows = require_admitted_base_mix(config, root)
        except FinalRunRefused:
            base_rows = []
    training = config["training"]
    batch_size = int(training["batch_size"])
    epochs = int(training["epochs"])
    if batch_size < 1 or epochs < 1:
        raise ToolingError("training batch_size and epochs must be positive")
    synthetic_rows = load_synthetic_checkpoint(int(config["corpus_size"]))
    # A complete epoch is sampler-owned replay exposure, not duplicated source rows.
    steps_per_epoch = math.ceil(len(synthetic_rows) / batch_size)
    sampled = sample_update_weighted_rows(
        synthetic_rows=synthetic_rows,
        base_rows=base_rows,
        updates=steps_per_epoch * epochs,
        batch_size=batch_size,
        seed=seed,
    )
    examples = rows_to_gliner_examples(sampled.rows)
    run_dir.mkdir(parents=True, exist_ok=False)
    model = GLiNER.from_pretrained(
        BASE_CHECKPOINT,
        revision=BASE_REVISION,
        cache_dir=cache_dir,
        map_location=device,
        max_length=int(config["method_freeze"]["sequence_length"]),
        max_width=int(config["method_freeze"]["max_span_width"]),
    )
    model.to(device)
    model.float()
    frozen = [name for name, parameter in model.named_parameters() if not parameter.requires_grad]
    if frozen:
        raise ToolingError(f"full fine-tune method freeze violated; frozen parameters found: {frozen[:3]}")
    trainer = model.train_model(
        train_dataset=examples,
        eval_dataset=None,
        output_dir=str(artifact),
        max_steps=steps_per_epoch * epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=float(training["learning_rate_encoder"]),
        others_lr=float(training["learning_rate_other"]),
        weight_decay=float(training["weight_decay_encoder"]),
        others_weight_decay=float(training["weight_decay_other"]),
        max_grad_norm=float(training["max_grad_norm"]),
        lr_scheduler_type=str(training["scheduler"]),
        warmup_ratio=float(training["warmup_ratio"]),
        loss_reduction=str(training["loss_reduction"]),
        save_strategy="steps",
        save_steps=steps_per_epoch,
        logging_steps=steps_per_epoch,
        logging_strategy="steps",
        save_total_limit=epochs + 1,
        bf16=False,
        fp16=False,
        dataloader_num_workers=0,
        report_to="none",
        seed=seed,
    )
    trainer.save_model(str(artifact))
    # Do not accept native-state scores: every metric below loads a saved file.
    loss_by_epoch = _loss_by_epoch(list(getattr(trainer.state, "log_history", [])), epochs)
    missing_losses = [epoch for epoch, loss in loss_by_epoch.items() if loss is None]
    if missing_losses:
        raise ToolingError(f"trainer did not emit the required per-epoch loss records for epoch(s): {missing_losses}")
    epoch_metrics = _epoch_metrics(
        artifact=artifact,
        epochs=epochs,
        steps_per_epoch=steps_per_epoch,
        losses=loss_by_epoch,
        dev_rows=dev_rows,
        local_root=root,
        device=device,
    )
    run_json = {
        "schema_version": 1,
        "status": "completed-dev-explore-no-base-mix" if sampled.report["no_base_mix"] else "completed",
        "mode": active_mode,
        "no_base_mix": sampled.report["no_base_mix"],
        "config": config,
        "method_freeze": config["method_freeze"],
        "frozen_dev_sha256": sha256_file(DEFAULT_DEV_PATH),
        "synthetic_input_sha256": {path.name: sha256_file(path) for path in checkpoint_shards(int(config["corpus_size"]))},
        "sampler": sampled.report,
        "environment": host_environment(),
        "training_code_sha256": code_hashes(),
        "artifact": {"local_ref": local_ref(artifact, root), "tree_sha256": sha256_tree(artifact)},
        "epochs": epoch_metrics,
    }
    write_json(run_dir / "run.json", run_json)
    return run_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run frozen S3 full FP32 GLiNER fine-tuning")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--mode", choices=("final", "smoke", "dev-explore"), default=None)
    parser.add_argument("--local-root", type=str, default=None)
    parser.add_argument("--smoke-report", type=Path, default=None, help="required MPS PASS report for final mode")
    parser.add_argument("--run-id", type=str, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        local_root = require_local_root(args.local_root)
        assert_not_eval_only_path(args.config, local_root=local_root)
        config = load_run_config(args.config)
        result = run_training(
            copy.deepcopy(config),
            mode=args.mode,
            local_root=local_root,
            smoke_report=args.smoke_report,
            run_id_override=args.run_id,
        )
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ToolingError as exc:
        print(f"TRAIN ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
