#!/usr/bin/env python3
"""FP32 CPU/MPS forward-backward parity gate for S3 full training."""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import traceback
import warnings
from contextlib import redirect_stderr
from pathlib import Path
from typing import Any

from tooling import (
    BASE_CHECKPOINT,
    BASE_REVISION,
    DEFAULT_DEV_PATH,
    ToolingError,
    assert_not_eval_only_path,
    host_environment,
    load_jsonl,
    require_local_root,
    rows_to_gliner_examples,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the S3 CPU/MPS FP32 forward/backward smoke gate")
    parser.add_argument("--sample-path", type=Path, default=DEFAULT_DEV_PATH, help="JSONL source for the deterministic 10-row sample")
    parser.add_argument("--rows", type=int, default=10, help="exact smoke sample size; default: 10")
    parser.add_argument("--parity-tolerance", type=float, default=0.02, help="relative CPU/MPS loss delta tolerance")
    parser.add_argument("--parity-absolute-tolerance", type=float, default=0.05, help="absolute CPU/MPS loss delta tolerance")
    parser.add_argument("--seed", type=int, default=104729, help="fixed parity RNG seed used independently on CPU and MPS")
    parser.add_argument("--local-root", type=str, default=None, help="override PII_BANK_LOCAL_ROOT for cache/report placement")
    parser.add_argument("--report", type=Path, default=None, help="optional local-only JSON report path")
    return parser


def _move(value: Any, device: str) -> Any:
    import torch

    if isinstance(value, torch.Tensor):
        return value.to(device)
    if isinstance(value, dict):
        return {key: _move(item, device) for key, item in value.items()}
    if isinstance(value, list):
        return [_move(item, device) for item in value]
    if isinstance(value, tuple):
        return tuple(_move(item, device) for item in value)
    return value


def _loss_from_output(output: Any) -> Any:
    import torch

    if isinstance(output, torch.Tensor):
        return output
    if isinstance(output, dict) and isinstance(output.get("loss"), torch.Tensor):
        return output["loss"]
    if hasattr(output, "loss") and isinstance(output.loss, torch.Tensor):
        return output.loss
    if isinstance(output, (list, tuple)) and output and isinstance(output[0], torch.Tensor):
        return output[0]
    raise ToolingError(f"GLiNER forward did not return a loss tensor (got {type(output).__name__})")


def _fallback_messages(emitted: list[Any], stderr: str) -> list[str]:
    messages = [
        str(item.message)
        for item in emitted
        if "mps" in str(item.message).lower() or "fallback" in str(item.message).lower()
    ]
    messages.extend(line for line in stderr.splitlines() if "mps" in line.lower() or "fallback" in line.lower())
    return messages


def _load_model(GLiNER: Any, *, cache_dir: Path, device: str) -> tuple[Any, list[str]]:
    """Capture MPS fallback reporting during checkpoint materialization too."""
    captured_stderr = io.StringIO()
    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        with redirect_stderr(captured_stderr):
            model = GLiNER.from_pretrained(
                BASE_CHECKPOINT,
                revision=BASE_REVISION,
                cache_dir=cache_dir,
                map_location=device,
            )
    return model, _fallback_messages(emitted, captured_stderr.getvalue())


def _forward_backward(model: Any, examples: list[dict[str, Any]], device: str, *, seed: int) -> tuple[float, int, list[str]]:
    """Use GLiNER's own training collator, then assert a real backward pass."""
    import torch

    fallback_stderr = io.StringIO()
    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        # PyTorch can report MPS fallback through stderr rather than a Python
        # warning.  Capture both channels across model transfer, collation,
        # forward, and backward in the persisted gate evidence.
        with redirect_stderr(fallback_stderr):
            model.to(device)
            model.float()
            # The parity gate measures backend arithmetic, not dropout masks.
            # Eval mode still computes the supervised GLiNER loss and
            # gradients, while the same seed initializes both backend RNGs.
            model.eval()
            torch.manual_seed(seed)
            if hasattr(torch, "mps") and hasattr(torch.mps, "manual_seed"):
                torch.mps.manual_seed(seed)
            # Use the same private collator that GLiNER's train_model()
            # installs in its Trainer. The data processor itself is not a
            # DataLoader factory in all pinned GLiNER releases.
            batch = _move(model._create_data_collator()(examples), device)
            model.zero_grad(set_to_none=True)
            # GLiNER's forward is keyword-only over the processor batch,
            # rather than accepting the batch dictionary as one positional
            # argument.
            loss = _loss_from_output(
                model(
                    alpha=-1,
                    gamma=0,
                    rel_alpha=-1,
                    rel_gamma=0,
                    prob_margin=0,
                    label_smoothing=0,
                    reduction="sum",
                    negatives=1.0,
                    masking="global",
                    **batch,
                )
            )
            if loss.numel() != 1:
                loss = loss.mean()
            if not bool(torch.isfinite(loss).item()):
                raise ToolingError(f"{device} loss is not finite: {loss.detach().cpu().item()}")
            loss.backward()
    finite_gradients = 0
    for parameter in model.parameters():
        if parameter.requires_grad and parameter.grad is not None:
            if not bool(torch.isfinite(parameter.grad).all().item()):
                raise ToolingError(f"{device} produced a non-finite gradient")
            finite_gradients += 1
    if finite_gradients == 0:
        raise ToolingError(f"{device} produced no gradients; this is not a backward-pass smoke")
    return float(loss.detach().cpu().item()), finite_gradients, _fallback_messages(emitted, fallback_stderr.getvalue())


def run_smoke(args: argparse.Namespace) -> dict[str, Any]:
    try:
        import torch
        from gliner import GLiNER
    except ImportError as exc:  # pragma: no cover - provisioning gate
        raise ToolingError("smoke requires pinned torch and gliner dependencies") from exc
    if args.rows != 10:
        raise ToolingError("the MPS protocol fixes the smoke sample at exactly 10 rows")
    if not torch.backends.mps.is_available():
        raise ToolingError("MPS is unavailable; full MPS training is gated")
    local_root = require_local_root(args.local_root)
    assert_not_eval_only_path(args.sample_path, local_root=local_root)
    cache_dir = local_root / "context/pii-bank/train-runs/checkpoint-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    source_rows = load_jsonl(args.sample_path)
    if len(source_rows) < args.rows:
        raise ToolingError(f"sample source has only {len(source_rows)} rows; need {args.rows}")
    examples = rows_to_gliner_examples(source_rows[: args.rows])
    # Separate loads prevent one backend's buffers/gradients influencing parity.
    cpu_model, cpu_load_fallbacks = _load_model(GLiNER, cache_dir=cache_dir, device="cpu")
    cpu_loss, cpu_gradients, cpu_fallbacks = _forward_backward(cpu_model, examples, "cpu", seed=args.seed)
    mps_model, mps_load_fallbacks = _load_model(GLiNER, cache_dir=cache_dir, device="mps")
    mps_loss, mps_gradients, mps_fallbacks = _forward_backward(mps_model, examples, "mps", seed=args.seed)
    delta = abs(cpu_loss - mps_loss)
    allowed = max(args.parity_absolute_tolerance, args.parity_tolerance * abs(cpu_loss))
    if not math.isfinite(delta) or delta > allowed:
        raise ToolingError(f"CPU/MPS loss parity failed: delta={delta:.8f}, allowed={allowed:.8f}")
    return {
        "status": "PASS",
        "protocol": "10-row FP32 forward/backward CPU-MPS parity",
        "sample_path": str(args.sample_path),
        "sample_rows": args.rows,
        "parity_seed": args.seed,
        "cpu_loss": cpu_loss,
        "mps_loss": mps_loss,
        "loss_delta": delta,
        "loss_delta_allowed": allowed,
        "cpu_finite_gradient_tensors": cpu_gradients,
        "mps_finite_gradient_tensors": mps_gradients,
        "op_fallback_events": {"cpu": cpu_load_fallbacks + cpu_fallbacks, "mps": mps_load_fallbacks + mps_fallbacks},
        "mps_fallback_enabled": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") == "1",
        "environment": host_environment(),
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.report is not None:
            local_root = require_local_root(args.local_root)
            try:
                args.report.resolve().relative_to(local_root)
            except ValueError as exc:
                raise ToolingError("smoke report must remain under PII_BANK_LOCAL_ROOT") from exc
            assert_not_eval_only_path(args.report, local_root=local_root)
        report = run_smoke(args)
    except Exception as exc:
        report = {"status": "FAIL", "error": str(exc), "traceback": traceback.format_exc(), "environment": host_environment()}
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 1
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
