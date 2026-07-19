#!/usr/bin/env python3
"""Standalone production-semantic GLiNER span scorer for S3/S4 evidence."""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from tooling import (
    BASE_CHECKPOINT,
    BASE_REVISION,
    CATEGORY_BY_LABEL,
    DEFAULT_DEV_PATH,
    LABEL_ORDER,
    MANIFEST_PATH,
    ToolingError,
    assert_not_eval_only_path,
    load_json,
    load_jsonl,
    local_ref,
    require_local_root,
    resolve_local_ref,
    sha256_file,
)


THRESHOLD = 0.4

_EVAL_CATEGORY_ALIASES = {
    "person": "PERSON",
    "people": "PERSON",
    "name": "PERSON",
    "location": "LOCATION",
    "place": "LOCATION",
    "vendor": "VENDOR",
    "organisation": "VENDOR",
    "organization": "VENDOR",
    "role": "ROLE",
    "job title": "ROLE",
    "technical identifier": "TECHNICAL_IDENTIFIER",
    "technical_identifier": "TECHNICAL_IDENTIFIER",
    "identifier": "TECHNICAL_IDENTIFIER",
}
_EXTRA_MODEL_LANE_CATEGORIES = frozenset({"EMAIL"})


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _metric(tp: int, fp: int, fn: int) -> dict[str, float | int | None]:
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    f1 = None if precision is None or recall is None or precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}


def _category(label: Any) -> str | None:
    value = str(label).strip().casefold()
    return CATEGORY_BY_LABEL.get(value)


def _spans_overlap(left: tuple[int, int, str], right: tuple[int, int, str]) -> bool:
    return left[2] == right[2] and left[0] < right[1] and right[0] < left[1]


def normalize_prediction(
    entity: dict[str, Any], *, label_to_category: Mapping[str, str] | None = None
) -> tuple[int, int, str] | None:
    label_map = label_to_category or CATEGORY_BY_LABEL
    category = label_map.get(str(entity.get("label", "")).strip().casefold())
    start, end = entity.get("start"), entity.get("end")
    if category is None or not isinstance(start, int) or not isinstance(end, int) or end <= start:
        return None
    return start, end, category


def _eval_category(value: Any) -> str | None:
    """Normalize canonical and common external final-eval category spellings."""
    text = str(value).strip()
    if text in CATEGORY_BY_LABEL:
        return CATEGORY_BY_LABEL[text]
    upper = text.upper()
    if upper in {category for category, _ in LABEL_ORDER}:
        return upper
    aliased = _EVAL_CATEGORY_ALIASES.get(text.casefold())
    if aliased is not None:
        return aliased
    candidate = upper.replace(" ", "_")
    if candidate in _EXTRA_MODEL_LANE_CATEGORIES:
        return candidate
    return None


def _eval_expected(value: Any) -> str:
    if value is None:
        return "REDACT"
    normalized = str(value).strip().upper()
    if normalized in {"REDACT", "MASK", "REMOVE", "SENSITIVE", "TRUE"}:
        return "REDACT"
    if normalized in {"KEEP", "ALLOW", "SAFE", "FALSE"}:
        return "KEEP"
    raise ToolingError(f"unsupported eval expected/action value: {value!r}")


def _eval_redact(value: Any) -> str:
    """Interpret the legacy `redact` field without treating false as KEEP."""
    if value is True:
        return "REDACT"
    if value is False:
        raise ToolingError("redact=false is ambiguous; use expected/action='KEEP' instead")
    if isinstance(value, str) and value.strip().upper() in {"REDACT", "KEEP"}:
        return value.strip().upper()
    raise ToolingError("redact must be boolean true or an explicit REDACT/KEEP string")


def _normalize_eval_row(record: Mapping[str, Any], *, source: Path, index: int) -> dict[str, Any]:
    """Map a structured final-eval row into the production scorer schema.

    This is deliberately an adapter, not inference: malformed or ambiguous
    content fails closed instead of silently changing offsets/actions.
    """
    text = next((record.get(key) for key in ("text", "input", "content", "sentence") if isinstance(record.get(key), str)), None)
    if text is None:
        raise ToolingError(f"{source}:{index} has no text/input/content/sentence string")
    language = next((record.get(key) for key in ("lang", "language") if record.get(key) is not None), "unknown")
    raw_spans = next((record.get(key) for key in ("spans", "entities", "expected_spans") if key in record), None)
    if not isinstance(raw_spans, list):
        raise ToolingError(f"{source}:{index} has no structured spans/entities list")
    spans: list[dict[str, Any]] = []
    for span_index, raw_span in enumerate(raw_spans, start=1):
        if not isinstance(raw_span, Mapping):
            raise ToolingError(f"{source}:{index} span {span_index} is not an object")
        start = next((raw_span.get(key) for key in ("start", "offset_start", "begin") if isinstance(raw_span.get(key), int)), None)
        end = next((raw_span.get(key) for key in ("end", "offset_end", "stop") if isinstance(raw_span.get(key), int)), None)
        category_value = next((raw_span.get(key) for key in ("category", "label", "type", "entity_type") if raw_span.get(key) is not None), None)
        category = _eval_category(category_value)
        if start is None or end is None or start < 0 or end <= start or end > len(text):
            raise ToolingError(f"{source}:{index} span {span_index} has invalid codepoint offsets")
        if category is None:
            raise ToolingError(f"{source}:{index} span {span_index} has an unsupported category {category_value!r}")
        if "redact" in raw_span:
            expected = _eval_redact(raw_span["redact"])
        else:
            action_value = next((raw_span.get(key) for key in ("expected", "action") if key in raw_span), None)
            expected = _eval_expected(action_value)
        spans.append({"start": start, "end": end, "category": category, "expected": expected})
    return {"text": text, "lang": str(language), "spans": spans}


def _records_from_json_payload(payload: Any, *, source: Path) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, Mapping):
        records = next(
            (
                payload[key]
                for key in ("rows", "items", "cases", "examples", "data")
                if isinstance(payload.get(key), list)
            ),
            [payload] if any(key in payload for key in ("text", "input", "content", "sentence")) else None,
        )
    else:
        records = None
    if not isinstance(records, list) or not all(isinstance(item, Mapping) for item in records):
        raise ToolingError(
            f"{source} is not a supported structured eval payload; use JSON/JSONL rows with text and spans/entities"
        )
    if not records:
        raise ToolingError(f"{source} contains no structured eval records")
    return records


def load_quarantined_eval_rows(path: Path) -> list[dict[str, Any]]:
    """Load only after --final-eval custody authorization.

    JSONL is accepted directly. JSON supports a top-level list or common row
    containers. Markdown supports JSON/JSONL fenced payloads, preserving the
    no-extra-dependency constraint while refusing unstructured prose.
    """
    suffix = path.suffix.casefold()
    if suffix == ".jsonl":
        records: list[Mapping[str, Any]] = load_jsonl(path)
    elif suffix == ".json":
        records = _records_from_json_payload(load_json(path), source=path)
    elif suffix in {".md", ".markdown"}:
        document = path.read_text(encoding="utf-8")
        blocks = re.findall(r"```(?:json|jsonl)?\s*\n(.*?)```", document, flags=re.IGNORECASE | re.DOTALL)
        decoded: list[Mapping[str, Any]] = []
        for block in blocks:
            try:
                payload = json.loads(block)
                decoded.extend(_records_from_json_payload(payload, source=path))
            except json.JSONDecodeError:
                try:
                    decoded.extend(_records_from_json_payload([json.loads(line) for line in block.splitlines() if line.strip()], source=path))
                except json.JSONDecodeError as exc:
                    raise ToolingError(f"{path} has a non-JSON eval fence; provide canonical structured rows") from exc
        if not decoded:
            raise ToolingError(f"{path} has no fenced JSON/JSONL eval rows; provide canonical structured rows")
        records = decoded
    else:
        raise ToolingError(f"unsupported quarantined eval extension {path.suffix!r}; expected .jsonl, .json, or .md")
    return [_normalize_eval_row(record, source=path, index=index) for index, record in enumerate(records, start=1)]


def score_predictions(
    rows: Iterable[dict[str, Any]],
    predict: Callable[[str], Iterable[dict[str, Any]]],
    *,
    label_to_category: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Score exact spans as primary; retain boundary-overlap diagnostics."""
    global_counts: Counter[str] = Counter()
    by_category: dict[str, Counter[str]] = defaultdict(Counter)
    by_category_lang: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    boundary: Counter[str] = Counter()
    total_tokens = 0
    row_count = 0
    for row in rows:
        row_count += 1
        language = str(row.get("lang", "unknown"))
        total_tokens += max(1, len(str(row.get("text", "")).split()))
        gold = {
            (int(span["start"]), int(span["end"]), str(span["category"]))
            for span in row.get("spans", [])
            if span.get("expected") == "REDACT"
        }
        predictions = {
            item
            for item in (
                normalize_prediction(entity, label_to_category=label_to_category) for entity in predict(str(row["text"]))
            )
            if item is not None
        }
        matched = gold & predictions
        unmatched_gold = gold - matched
        unmatched_predictions = predictions - matched
        for _, _, category in matched:
            global_counts["tp"] += 1
            by_category[category]["tp"] += 1
            by_category_lang[(category, language)]["tp"] += 1
        for _, _, category in unmatched_gold:
            global_counts["fn"] += 1
            by_category[category]["fn"] += 1
            by_category_lang[(category, language)]["fn"] += 1
        for _, _, category in unmatched_predictions:
            global_counts["fp"] += 1
            by_category[category]["fp"] += 1
            by_category_lang[(category, language)]["fp"] += 1
        boundary["exact_tp"] += len(matched)
        boundary["gold_boundary_overlap"] += sum(any(_spans_overlap(item, prediction) for prediction in unmatched_predictions) for item in unmatched_gold)
        boundary["prediction_boundary_overlap"] += sum(any(_spans_overlap(item, gold_item) for gold_item in unmatched_gold) for item in unmatched_predictions)
    per_category = {category: _metric(values["tp"], values["fp"], values["fn"]) for category, values in sorted(by_category.items())}
    per_category_lang = {
        f"{category}|{language}": _metric(values["tp"], values["fp"], values["fn"])
        for (category, language), values in sorted(by_category_lang.items())
    }
    macro_values = [metric["f1"] for metric in per_category.values() if metric["f1"] is not None]
    return {
        "threshold": THRESHOLD,
        "span_scoring": "exact boundary+category primary; expected=KEEP and clean controls are negative evidence",
        "rows": row_count,
        "tokens": total_tokens,
        "overall": _metric(global_counts["tp"], global_counts["fp"], global_counts["fn"]),
        "macro_f1": sum(macro_values) / len(macro_values) if macro_values else None,
        "per_category": per_category,
        "per_category_lang": per_category_lang,
        "fp_spans_per_1k_tokens": global_counts["fp"] * 1000 / total_tokens if total_tokens else None,
        "boundary_diagnostics": dict(boundary),
    }


def evaluate_loaded_model(model: Any, rows: Iterable[dict[str, Any]], *, threshold: float = THRESHOLD) -> dict[str, Any]:
    if threshold != THRESHOLD:
        raise ToolingError("S3 production-semantic evaluation is locked at threshold 0.4")
    materialized_rows = list(rows)
    # Production-semantic scoring must always prompt the frozen model label
    # set. Narrowing it to gold categories would hide false positives in every
    # omitted category and bias the over-redaction/FP bars optimistically.
    labels = [label for _, label in LABEL_ORDER]
    label_to_category = CATEGORY_BY_LABEL

    def predict(text: str) -> Iterable[dict[str, Any]]:
        return model.predict_entities(text, labels, threshold=THRESHOLD, flat_ner=True)

    return score_predictions(materialized_rows, predict, label_to_category=label_to_category)


def paired_bootstrap(values_a: list[float], values_b: list[float], *, iterations: int = 10_000, seed: int = 0) -> dict[str, float | int]:
    """Paired non-parametric CI for metric deltas (B minus A)."""
    if len(values_a) != len(values_b) or not values_a:
        raise ToolingError("paired bootstrap requires two non-empty equally sized vectors")
    if iterations < 1:
        raise ToolingError("paired bootstrap iterations must be a positive integer")
    rng = random.Random(seed)
    deltas = []
    size = len(values_a)
    for _ in range(iterations):
        indices = [rng.randrange(size) for _ in range(size)]
        deltas.append(sum(values_b[index] - values_a[index] for index in indices) / size)
    deltas.sort()
    return {
        "paired_mean_delta": sum(right - left for left, right in zip(values_a, values_b)) / size,
        "lower_95": deltas[int(0.025 * iterations)],
        "upper_95": deltas[min(iterations - 1, int(0.975 * iterations))],
        "iterations": iterations,
        "seed": seed,
    }


def load_model(artifact: Path | None, *, local_root: Path, device: str) -> Any:
    try:
        import torch
        from gliner import GLiNER
    except ImportError as exc:  # pragma: no cover - provisioning-dependent
        raise ToolingError("evaluation requires pinned torch and gliner dependencies") from exc
    if device == "mps" and not torch.backends.mps.is_available():
        raise ToolingError("MPS requested for evaluation but unavailable")
    cache_dir = local_root / "context/pii-bank/train-runs/checkpoint-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    if artifact is None:
        model = GLiNER.from_pretrained(BASE_CHECKPOINT, revision=BASE_REVISION, cache_dir=cache_dir, map_location=device)
    else:
        try:
            artifact.resolve().relative_to(local_root)
        except ValueError as exc:
            raise ToolingError("saved evaluation artifact must remain under PII_BANK_LOCAL_ROOT") from exc
        model = GLiNER.from_pretrained(str(artifact), cache_dir=cache_dir, map_location=device)
    model.to(device)
    model.float()
    model.eval()
    return model


def _quarantined_asset(manifest_entry: str, local_root: Path) -> Path:
    manifest = load_json(MANIFEST_PATH)
    for entry in manifest.get("entries", []):
        if entry.get("path_or_ref") == manifest_entry and entry.get("role") == "eval-only":
            if entry.get("location_class") != "local":
                raise ToolingError("only local manifest entries are readable by this standalone scorer")
            asset = resolve_local_ref(manifest_entry, local_root)
            expected_sha = entry.get("sha256")
            if not isinstance(expected_sha, str) or not asset.is_file() or sha256_file(asset) != expected_sha:
                raise ToolingError("quarantined eval asset is missing or does not match its manifest SHA-256")
            return asset
    raise ToolingError("requested eval asset is not an eval-only local manifest entry")


def _verify_normalized_companion(
    companion: Path,
    metadata_path: Path,
    *,
    manifest_entry: str,
    manifest_sha256: str,
    local_root: Path,
) -> dict[str, str]:
    """Bind a frozen S4 span companion to the authorized native asset."""
    if not companion.is_file() or not metadata_path.is_file():
        raise ToolingError("normalized final eval requires both companion rows and companion metadata")
    metadata = load_json(metadata_path)
    if not isinstance(metadata, dict):
        raise ToolingError("normalized eval companion metadata must be a JSON object")
    companion_sha = sha256_file(companion)
    if (
        metadata.get("source_manifest_entry") != manifest_entry
        or metadata.get("source_manifest_sha256") != manifest_sha256
        or metadata.get("companion_sha256") != companion_sha
    ):
        raise ToolingError("normalized eval companion metadata does not bind the rows to this manifest asset/hash")
    return {
        "local_ref": local_ref(companion, local_root),
        "sha256": companion_sha,
        "metadata_local_ref": local_ref(metadata_path, local_root),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score a saved GLiNER artifact using exact span semantics at threshold 0.4")
    parser.add_argument("--artifact", type=Path, default=None, help="saved local artifact; omit for untouched pinned baseline")
    parser.add_argument("--dev", type=Path, default=DEFAULT_DEV_PATH, help="dev JSONL (the default, non-quarantined path)")
    parser.add_argument("--manifest-entry", type=str, default=None, help="eval-only local manifest path; requires --final-eval")
    parser.add_argument(
        "--normalized-eval",
        type=Path,
        default=None,
        help="S4-frozen local canonical span rows for a non-canonical manifest asset; requires --final-eval",
    )
    parser.add_argument(
        "--normalized-eval-metadata",
        type=Path,
        default=None,
        help="required JSON binding companion SHA to --manifest-entry's manifest SHA",
    )
    parser.add_argument("--final-eval", action="store_true", help="explicitly authorize one quarantined S4 evaluation")
    parser.add_argument("--local-root", type=str, default=None)
    parser.add_argument("--device", choices=("mps", "cpu"), default="mps")
    parser.add_argument("--output", type=Path, default=None, help="local-only JSON output path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        companion_provenance: dict[str, str] | None = None
        local_root = require_local_root(args.local_root)
        if args.artifact is not None:
            assert_not_eval_only_path(args.artifact, local_root=local_root)
        if args.output:
            assert_not_eval_only_path(args.output, local_root=local_root)
            try:
                args.output.resolve().relative_to(local_root)
            except ValueError as exc:
                raise ToolingError("evaluation output must remain under PII_BANK_LOCAL_ROOT") from exc
        if (args.normalized_eval is None) != (args.normalized_eval_metadata is None):
            raise ToolingError("--normalized-eval and --normalized-eval-metadata must be supplied together")
        if args.normalized_eval is not None:
            if not args.final_eval or not args.manifest_entry:
                raise ToolingError("--normalized-eval requires --final-eval and --manifest-entry")
            for path in (args.normalized_eval, args.normalized_eval_metadata):
                try:
                    path.resolve().relative_to(local_root)
                except ValueError as exc:
                    raise ToolingError("normalized final-eval rows/metadata must remain under PII_BANK_LOCAL_ROOT") from exc
        if args.manifest_entry:
            if not args.final_eval:
                raise ToolingError("quarantined eval requires explicit --final-eval")
            print("CUSTODY WARNING: reading a quarantined eval-only asset; do not use it for selection, training, prompts, or reruns.")
            source_asset = _quarantined_asset(args.manifest_entry, local_root)
            source_sha = sha256_file(source_asset)
            if args.normalized_eval:
                if args.normalized_eval_metadata is None:  # guarded above; keeps this call fail-closed
                    raise ToolingError("normalized eval companion metadata is required")
                companion_provenance = _verify_normalized_companion(
                    args.normalized_eval,
                    args.normalized_eval_metadata,
                    manifest_entry=args.manifest_entry,
                    manifest_sha256=source_sha,
                    local_root=local_root,
                )
            dataset = args.normalized_eval or source_asset
            dataset_kind = "quarantined-final-eval"
        else:
            if args.final_eval:
                raise ToolingError("--final-eval requires --manifest-entry; dev evaluation is not a final quarantine run")
            # Reject before the JSONL loader can open a declared eval-only file.
            assert_not_eval_only_path(args.dev, local_root=local_root)
            dataset = args.dev
            dataset_kind = "dev"
        rows = load_quarantined_eval_rows(dataset) if dataset_kind == "quarantined-final-eval" else load_jsonl(dataset)
        result = evaluate_loaded_model(load_model(args.artifact, local_root=local_root, device=args.device), rows)
        result.update({"dataset_kind": dataset_kind, "artifact": "untouched-pinned-baseline" if args.artifact is None else str(args.artifact)})
        if dataset_kind == "quarantined-final-eval":
            result["quarantined_manifest_entry"] = args.manifest_entry
            result["quarantined_manifest_sha256"] = source_sha
            result["scoring_rows_source"] = "s4-frozen-normalized-companion" if args.normalized_eval else "manifest-asset"
            if companion_provenance:
                result["normalized_eval_companion"] = companion_provenance
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ToolingError as exc:
        print(f"EVAL ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
