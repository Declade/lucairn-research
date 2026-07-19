"""Shared, stdlib-only plumbing for the pii-bank S3 training lane.

The module deliberately has no top-level torch/GLiNER import.  That keeps
custody/configuration tests runnable on CI machines that do not have model
dependencies or an MPS device.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any, Iterable


TRAIN_DIR = Path(__file__).resolve().parent
BANK_DIR = TRAIN_DIR.parent
ROWS_DIR = BANK_DIR / "rows"
DEFAULT_DEV_PATH = ROWS_DIR / "dev.jsonl"
MANIFEST_PATH = BANK_DIR / "manifest.json"
DEV_SHA256 = "8c7b762e0eca7d3455c497fc503552b47fb62bab2945bdf807524f183051518f"
BASE_CHECKPOINT = "urchade/gliner_multi_pii-v1"
BASE_REVISION = "1fcf13e8"
LOCAL_ROOT_ENV = "PII_BANK_LOCAL_ROOT"
RUNS_RELATIVE = Path("context/pii-bank/train-runs")
CHECKPOINT_CACHE_RELATIVE = RUNS_RELATIVE / "checkpoint-cache"

# Admitted replay is intentionally loaded from the faithful stdlib-readable
# JSONL export, but the authoritative upstream train parquet is hash-checked
# too. File placement—not its unreliable in-row `split` value—defines the
# admitted partition.
AI4PRIVACY_BASE_MIX = {
    "record_path": "context/pii-bank/base-mix/admission-record-ai4privacy-mini10k-ad851605.md",
    "record_sha256": "090d2e44f84fa4328abce5e6910377db8d4b1a310c3c0838ffeedbb32f1f0087",
    "train_parquet_path": "context/pii-bank/base-mix/data-mini10k/train-00000-of-00001.parquet",
    "train_jsonl_path": "context/pii-bank/base-mix/data-mini10k/export-train.jsonl",
    "validation_parquet_path": "context/pii-bank/base-mix/data-mini10k/validation-00000-of-00001.parquet",
    "validation_jsonl_path": "context/pii-bank/base-mix/data-mini10k/export-validation.jsonl",
    "file_sha256": {
        "train_parquet": "ba471517ab5f7802ccac010a630c4c111c6de66e509087410e70829544487467",
        "train_jsonl": "9c4c2a40cc74846ab66d6ff6f6f32fb542b62dfddad7500bc69b6fba8b0e6ea7",
        "validation_parquet": "ec3d286fb14b5970880b5ad53aea100f601a5ef8eb6db2d5a76d7fc9a8f7dd23",
        "validation_jsonl": "4cd6b7392bfa3ee0fd71432ef441155c56639e5bb877e3638365566a1afca9cd",
    },
    "replay_label_policy": "GIVENNAME/SURNAME→PERSON and CITY/STREET→LOCATION only; EMAIL and TELEPHONENUM are dropped because PHONE is not frozen and EMAIL is not in the frozen training label set; all remaining upstream labels are unannotated context.",
}
AI4PRIVACY_LABEL_MAP = {
    "GIVENNAME": "PERSON",
    "SURNAME": "PERSON",
    "CITY": "LOCATION",
    "STREET": "LOCATION",
}

# The ordering is part of the frozen method, not inferred from JSON key order.
LABEL_ORDER = (
    ("PERSON", "person"),
    ("LOCATION", "location"),
    ("VENDOR", "vendor"),
    ("ROLE", "role"),
    ("TECHNICAL_IDENTIFIER", "technical identifier"),
)
LABEL_BY_CATEGORY = dict(LABEL_ORDER)
CATEGORY_BY_LABEL = {label: category for category, label in LABEL_ORDER}

METHOD_FREEZE_REQUIRED_FIELDS = frozenset(
    {
        "update_method",
        "precision",
        "sequence_length",
        "max_span_width",
        "label_order",
        "tokenizer",
        "save_reload",
        "threshold",
        "justification",
    }
)


class ToolingError(RuntimeError):
    """Base exception for a configuration or custody failure."""


class FrozenDevMismatch(ToolingError):
    pass


class CustodyError(ToolingError):
    pass


class FinalRunRefused(ToolingError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    """Hash an artifact directory without persisting its machine path."""
    if not path.is_dir():
        raise ToolingError(f"artifact directory does not exist: {path}")
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256_file(child)))
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_json(path: Path) -> Any:
    """Compatibility name for the executable scripts' JSON input helper."""
    return read_json(path)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if text:
                try:
                    row = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise ToolingError(f"invalid JSONL at {path}:{line_number}: {exc}") from exc
                if not isinstance(row, dict):
                    raise ToolingError(f"JSONL row at {path}:{line_number} is not an object")
                rows.append(row)
    if not rows:
        raise ToolingError(f"JSONL file is empty: {path}")
    return rows


def verify_frozen_dev(path: Path = DEFAULT_DEV_PATH, expected_sha256: str = DEV_SHA256) -> str:
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise FrozenDevMismatch(
            f"frozen dev SHA-256 mismatch for {path.name}: expected {expected_sha256}, got {actual}; refusing to score"
        )
    return actual


def require_local_root(value: str | None = None) -> Path:
    root_text = value if value is not None else os.environ.get(LOCAL_ROOT_ENV)
    if not root_text:
        raise ToolingError(
            f"{LOCAL_ROOT_ENV} is required: it owns checkpoint cache and all non-committed run artifacts"
        )
    root = Path(root_text).expanduser().resolve()
    if not root.is_dir():
        raise ToolingError(f"{LOCAL_ROOT_ENV} does not exist or is not a directory: {root}")
    return root


def local_runs_root(local_root: Path) -> Path:
    return local_root / RUNS_RELATIVE


def local_cache_root(local_root: Path) -> Path:
    return local_root / CHECKPOINT_CACHE_RELATIVE


def local_ref(path: Path, local_root: Path) -> str:
    try:
        return path.resolve().relative_to(local_root.resolve()).as_posix()
    except ValueError as exc:
        raise ToolingError("refusing to record an absolute/non-local artifact path in a run record") from exc


def resolve_local_ref(reference: str, local_root: Path) -> Path:
    relative = Path(reference)
    if relative.is_absolute() or ".." in relative.parts:
        raise CustodyError(f"local-root reference must be a safe relative path: {reference!r}")
    return (local_root / relative).resolve()


def _manifest_eval_paths(manifest_path: Path, local_root: Path | None) -> tuple[set[Path], set[str]]:
    manifest = read_json(manifest_path)
    entries = manifest.get("entries", []) if isinstance(manifest, dict) else []
    resolved: set[Path] = set()
    raw: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("role") != "eval-only":
            continue
        candidate = str(entry.get("path_or_ref", ""))
        raw.add(candidate)
        if local_root is not None and entry.get("location_class") == "local":
            resolved.add(resolve_local_ref(candidate, local_root))
    return resolved, raw


def assert_not_eval_only_path(path: Path | str, *, manifest_path: Path = MANIFEST_PATH, local_root: Path | None = None) -> None:
    """Reject a declared input path before any caller opens it.

    It reads only the public hash manifest; it never opens an eval-only asset.
    """
    supplied = Path(path)
    resolved, raw = _manifest_eval_paths(manifest_path, local_root)
    textual = supplied.as_posix()
    if textual in raw or any(textual.endswith(item) for item in raw):
        raise CustodyError(f"eval-only manifest asset is forbidden in dev selection/training input: {path}")
    if supplied.is_absolute() and supplied.resolve() in resolved:
        raise CustodyError(f"eval-only manifest asset is forbidden in dev selection/training input: {path}")
    if local_root is not None and not supplied.is_absolute():
        maybe_local = resolve_local_ref(textual, local_root)
        if maybe_local in resolved:
            raise CustodyError(f"eval-only manifest asset is forbidden in dev selection/training input: {path}")


def assert_config_has_no_eval_only_paths(value: Any, *, local_root: Path | None) -> None:
    """Walk declared path-like config fields without dereferencing their contents."""
    path_keys = {
        "base_mix_path",
        "base_mix_admission_path",
        "dev_path",
        "synthetic_path",
        "synthetic_shard",
        "artifact_path",
        "dataset_path",
        "record_path",
        "train_parquet_path",
        "train_jsonl_path",
        "validation_parquet_path",
        "validation_jsonl_path",
    }
    if isinstance(value, dict):
        for key, item in value.items():
            if key in path_keys and isinstance(item, str) and item:
                assert_not_eval_only_path(item, local_root=local_root)
            else:
                assert_config_has_no_eval_only_paths(item, local_root=local_root)
    elif isinstance(value, list):
        for item in value:
            assert_config_has_no_eval_only_paths(item, local_root=local_root)


def load_run_config(path: Path) -> dict[str, Any]:
    config = read_json(path)
    if not isinstance(config, dict):
        raise ToolingError(f"run config is not an object: {path}")
    validate_run_config(config, source=str(path))
    return config


def validate_run_config(config: dict[str, Any], *, source: str = "config") -> None:
    missing = {"schema_version", "run_id", "base_checkpoint", "dev_sha256", "method_freeze", "training", "sampler"} - set(config)
    if missing:
        raise ToolingError(f"{source} missing required fields: {sorted(missing)}")
    method = config["method_freeze"]
    if not isinstance(method, dict):
        raise ToolingError(f"{source}.method_freeze must be an object")
    missing_method = METHOD_FREEZE_REQUIRED_FIELDS - set(method)
    if missing_method:
        raise ToolingError(f"{source}.method_freeze missing: {sorted(missing_method)}")
    if method["update_method"] != "full_fine_tune" or method["precision"] != "fp32":
        raise ToolingError("S3 method freeze requires full_fine_tune + fp32")
    if method["sequence_length"] != 384 or method["max_span_width"] != 12:
        raise ToolingError("S3 method freeze requires the pinned 384-token / 12-span-width geometry")
    if method["threshold"] != 0.4:
        raise ToolingError("S3 method freeze requires the production threshold 0.4")
    if method["tokenizer"] != {"revision": BASE_REVISION, "source": "base-checkpoint-bundled"}:
        raise ToolingError("S3 method freeze requires the tokenizer bundled in the pinned checkpoint revision")
    save_reload = method["save_reload"]
    if not isinstance(save_reload, dict) or save_reload.get("evaluate_only_saved_and_reloaded") is not True:
        raise ToolingError("S3 method freeze requires saved-and-reloaded evaluation semantics")
    if not isinstance(method["justification"], str) or not method["justification"].strip():
        raise ToolingError("S3 method freeze requires a non-empty full-fine-tune justification")
    labels = method["label_order"]
    if labels != [{"category": category, "model_label": label} for category, label in LABEL_ORDER]:
        raise ToolingError("label order differs from the frozen S3 label map")
    checkpoint = config["base_checkpoint"]
    if checkpoint != {"model_id": BASE_CHECKPOINT, "revision": BASE_REVISION}:
        raise ToolingError("base checkpoint/revision differs from the pinned production checkpoint")
    if config["dev_sha256"] != DEV_SHA256:
        raise ToolingError("run config dev_sha256 differs from the frozen DEV_SHA256 pin")
    if config.get("mode") in {"final", "dev-explore"} and config.get("base_mix") != AI4PRIVACY_BASE_MIX:
        raise ToolingError("run config base_mix differs from the admitted ai4privacy mini-10k replay freeze")


def checkpoint_shards(corpus_size: int) -> list[Path]:
    mapping = {
        1000: [ROWS_DIR / "generated-1k.jsonl"],
        3000: [ROWS_DIR / "generated-1k.jsonl", ROWS_DIR / "generated-3k.jsonl"],
        8000: [ROWS_DIR / "generated-1k.jsonl", ROWS_DIR / "generated-3k.jsonl", ROWS_DIR / "generated-8k.jsonl"],
    }
    try:
        return mapping[corpus_size]
    except KeyError as exc:
        raise ToolingError("corpus_size must be one of 1000, 3000, 8000") from exc


def load_synthetic_checkpoint(corpus_size: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for shard in checkpoint_shards(corpus_size):
        assert_not_eval_only_path(shard)
        rows.extend(load_jsonl(shard))
    if len(rows) != corpus_size:
        raise ToolingError(f"checkpoint {corpus_size} expected {corpus_size} rows, got {len(rows)}")
    return rows


def synthetic_sampling_bucket(row: dict[str, Any]) -> str:
    family_id = str(row.get("family_id", ""))
    if family_id.startswith("hard-"):
        return "contextual_hard_negative"
    if family_id.startswith(("struct-", "general-")):
        # General synthetic rows stay fresh synthetic positives/clean controls.
        # They are deliberately not mislabeled as public base replay.
        return "structural_domain_positive"
    raise ToolingError(f"unrecognized synthetic family for sampling: {family_id!r}")


def token_count(row: dict[str, Any]) -> int:
    return max(1, len(re.findall(r"\S+", str(row.get("text", "")))))


def _require_hash(path: Path, expected: str, *, description: str) -> None:
    if not path.is_file() or sha256_file(path) != expected:
        raise FinalRunRefused(f"{description} is missing or SHA-256 does not match the admitted record")


def ai4privacy_replay_row(source: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one faithful export row without ever consulting `split`."""
    text, language, uid, masks = source.get("source_text"), source.get("language"), source.get("uid"), source.get("privacy_mask")
    if language not in {"en", "de"}:
        return None
    if not isinstance(text, str) or not isinstance(uid, int) or not isinstance(masks, list):
        raise FinalRunRefused("ai4privacy train export row is structurally invalid")
    spans: list[dict[str, Any]] = []
    for mask in masks:
        if not isinstance(mask, dict):
            raise FinalRunRefused("ai4privacy privacy_mask entry is not an object")
        category = AI4PRIVACY_LABEL_MAP.get(mask.get("label"))
        if category is None:  # Includes EMAIL/TELEPHONENUM: intentionally frozen out.
            continue
        start, end, value = mask.get("start"), mask.get("end"), mask.get("value")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or not isinstance(value, str)
            or start < 0
            or end <= start
            or end > len(text)
            or text[start:end] != value
        ):
            raise FinalRunRefused("ai4privacy span violates the admitted codepoint end-exclusive surface contract")
        spans.append({"start": start, "end": end, "category": category, "expected": "REDACT", "surface": value})
    if not spans:
        return None
    family_id = f"ai4privacy-mini10k-{uid}"
    return {
        "id": family_id,
        "text": text,
        "lang": language,
        "zone": "prose",
        "spans": spans,
        "org_id": None,
        "provenance": "synthetic-generated",
        "consent_basis": "public-corpus",
        "split": "train",
        "family_id": family_id,
        "template_lineage": family_id,
        "source": "ai4privacy/openpii-masking-mini-10k@ad851605 faithful train export",
        "created": "2026-07-20",
    }


def require_admitted_base_mix(config: dict[str, Any], local_root: Path) -> list[dict[str, Any]]:
    if config.get("base_mix") != AI4PRIVACY_BASE_MIX:
        raise FinalRunRefused("final run requires the frozen admitted ai4privacy mini-10k base_mix block")
    block = AI4PRIVACY_BASE_MIX
    if "validation" in str(block["train_parquet_path"]) or "validation" in str(block["train_jsonl_path"]):
        raise FinalRunRefused("validation base-mix files are excluded; train file placement is authoritative")
    for reference_key in ("record_path", "train_parquet_path", "train_jsonl_path", "validation_parquet_path", "validation_jsonl_path"):
        assert_not_eval_only_path(str(block[reference_key]), local_root=local_root)
    paths = {key: resolve_local_ref(str(block[f"{key}_path"]), local_root) for key in ("record", "train_parquet", "train_jsonl", "validation_parquet", "validation_jsonl")}
    _require_hash(paths["record"], str(block["record_sha256"]), description="base-mix admission record")
    for key, expected in dict(block["file_sha256"]).items():
        if key.startswith("validation_"):
            continue
        _require_hash(paths[key], expected, description=f"base-mix {key.replace('_', ' ')}")
    record = paths["record"].read_text(encoding="utf-8")
    if "**ADMITTED" not in record or "train parquet ONLY" not in record:
        raise FinalRunRefused("base-mix admission record is not the admitted train-only decision")
    for expected in (str(block["record_sha256"]), *dict(block["file_sha256"]).values()):
        if expected != str(block["record_sha256"]) and expected not in record:
            raise FinalRunRefused("base-mix admission record does not bind the configured source hashes")
    rows = [converted for source in load_jsonl(paths["train_jsonl"]) if (converted := ai4privacy_replay_row(source)) is not None]
    if not rows:
        raise FinalRunRefused("admitted train export yielded no EN/DE mapped replay rows")
    return rows


@dataclass(frozen=True)
class SampledCorpus:
    rows: list[dict[str, Any]]
    report: dict[str, Any]


def sample_update_weighted_rows(
    *,
    synthetic_rows: Iterable[dict[str, Any]],
    base_rows: Iterable[dict[str, Any]],
    updates: int,
    batch_size: int,
    seed: int,
) -> SampledCorpus:
    """Create a deterministic batch schedule balancing update and token exposure.

    Each update is homogeneous by source bucket.  Bucket selection minimizes
    the average of update-progress and token-progress against the preregistered
    target; rows are sampled with replacement so replay is sampler-owned rather
    than encoded as duplicate corpus rows.
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in synthetic_rows:
        grouped[synthetic_sampling_bucket(row)].append(row)
    base = list(base_rows)
    if base:
        grouped["base_replay"] = base
        targets = {"base_replay": 0.50, "contextual_hard_negative": 0.25, "structural_domain_positive": 0.25}
        no_base_mix = False
    else:
        targets = {"contextual_hard_negative": 0.50, "structural_domain_positive": 0.50}
        no_base_mix = True
    missing = [bucket for bucket in targets if not grouped[bucket]]
    if missing:
        raise ToolingError(f"sampling bucket(s) are empty: {missing}")

    rng = random.Random(seed)
    priority = tuple(targets)
    averages = {bucket: sum(token_count(row) for row in rows) / len(rows) for bucket, rows in grouped.items()}
    planned_tokens = sum(averages[bucket] * targets[bucket] for bucket in targets) * updates * batch_size
    target_updates = {bucket: targets[bucket] * updates for bucket in targets}
    target_tokens = {bucket: targets[bucket] * planned_tokens for bucket in targets}
    update_counts: Counter[str] = Counter()
    token_counts: Counter[str] = Counter()
    selected: list[dict[str, Any]] = []
    for _ in range(updates):
        def progress(bucket: str) -> tuple[float, int]:
            update_progress = update_counts[bucket] / max(target_updates[bucket], 1.0)
            token_progress = token_counts[bucket] / max(target_tokens[bucket], 1.0)
            return ((update_progress + token_progress) / 2, priority.index(bucket))

        bucket = min(targets, key=progress)
        batch = [rng.choice(grouped[bucket]) for _ in range(batch_size)]
        selected.extend(batch)
        update_counts[bucket] += 1
        token_counts[bucket] += sum(token_count(row) for row in batch)
    return SampledCorpus(
        rows=selected,
        report={
            "kind": "token_and_update_weighted",
            "seed": seed,
            "updates": updates,
            "batch_size": batch_size,
            "no_base_mix": no_base_mix,
            "target_fractions": targets,
            "actual_updates": dict(sorted(update_counts.items())),
            "actual_tokens": dict(sorted(token_counts.items())),
            "general_synthetic_note": "general_synthetic rows are sampled only inside structural_domain_positive; they are never counted as base_replay",
        },
    )


def _word_tokens_with_offsets(text: str) -> list[tuple[str, int, int]]:
    # GLiNER trains on word-level token indices.  JSON/code zones can place a
    # labeled identifier immediately before a quote/comma, so whitespace-only
    # splitting would make valid codepoint spans unrepresentable.  This keeps
    # word/identifier runs intact while separating adjacent punctuation.
    return [(match.group(0), match.start(), match.end()) for match in re.finditer(r"\w+|[^\w\s]", text, flags=re.UNICODE)]


def row_to_gliner_example(row: dict[str, Any]) -> dict[str, Any]:
    text = row.get("text")
    if not isinstance(text, str):
        raise ToolingError(f"row {row.get('id')!r} has no text")
    token_data = _word_tokens_with_offsets(text)
    if not token_data:
        raise ToolingError(f"row {row.get('id')!r} has no tokens")
    starts = {start: index for index, (_, start, _) in enumerate(token_data)}
    ends = {end: index for index, (_, _, end) in enumerate(token_data)}
    entities: list[list[Any]] = []
    keep_labels: set[str] = set()
    for span in row.get("spans", []):
        category = span.get("category")
        if category not in LABEL_BY_CATEGORY:
            raise ToolingError(f"row {row.get('id')!r} uses unsupported category {category!r}")
        start, end = span.get("start"), span.get("end")
        if not isinstance(start, int) or not isinstance(end, int) or start not in starts or end not in ends:
            raise ToolingError(
                f"row {row.get('id')!r} span {start}:{end} is not aligned to training word tokens"
            )
        label = LABEL_BY_CATEGORY[category]
        if span.get("expected") == "REDACT":
            entities.append([starts[start], ends[end], label])
        elif span.get("expected") == "KEEP":
            keep_labels.add(label)
        else:
            raise ToolingError(f"row {row.get('id')!r} has unknown expected action")
    return {
        "tokenized_text": [token for token, _, _ in token_data],
        "ner": entities,
        # Explicit labels keep all-clean controls trainable in GLiNER.
        "ner_labels": [label for _, label in LABEL_ORDER],
        "ner_negatives": [label for _, label in LABEL_ORDER if label in keep_labels],
    }


def rows_to_gliner_examples(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row_to_gliner_example(row) for row in rows]


def seed_everything(seed: int) -> None:
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - exercised on provisioned machine
        raise ToolingError("torch is required for training") from exc
    torch.manual_seed(seed)
    if hasattr(torch, "mps") and hasattr(torch.mps, "manual_seed"):
        torch.mps.manual_seed(seed)


def installed_versions() -> dict[str, str]:
    result = {"python": platform.python_version()}
    for package in ("torch", "gliner", "transformers"):
        try:
            result[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            result[package] = "not-installed"
    return result


def host_environment() -> dict[str, Any]:
    values: dict[str, Any] = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "versions": installed_versions(),
        "mps_fallback_env": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0"),
    }
    for name, command in (("mac_model", ["sysctl", "-n", "hw.model"]), ("ram_bytes", ["sysctl", "-n", "hw.memsize"])):
        try:
            values[name] = subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            values[name] = "unavailable"
    return values


def code_hashes() -> dict[str, str]:
    return {
        item.name: sha256_file(item)
        for item in sorted(TRAIN_DIR.glob("*.py"))
        if item.is_file()
    }
