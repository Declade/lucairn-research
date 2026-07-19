#!/usr/bin/env python3
"""Freeze and verify S3's numeric dev evidence floors before training."""

from __future__ import annotations

import argparse
import re
from collections import Counter
from pathlib import Path
from typing import Any

from tooling import DEFAULT_DEV_PATH, ROWS_DIR, ToolingError, load_jsonl


FLOOR_OUTPUT = Path(__file__).resolve().with_name("POWER-FLOOR.md")
MANIFEST_PATH = ROWS_DIR / "DEV-MANIFEST.md"
TABLE_PATTERN = re.compile(r"^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|$")


def parse_manifest_floors(path: Path = MANIFEST_PATH) -> list[dict[str, Any]]:
    return _parse_floor_table(path, "| Bucket | Class | Lang | Dev rows | Dev spans |")


def parse_frozen_power_floors(path: Path = FLOOR_OUTPUT) -> list[dict[str, Any]]:
    """Read the committed numerical freeze, never a mutable source manifest."""
    return _parse_floor_table(path, "| Bucket | Class | Lang | Minimum cases | Minimum spans |")


def _parse_floor_table(path: Path, header: str) -> list[dict[str, Any]]:
    floors: list[dict[str, Any]] = []
    in_table = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(header):
            in_table = True
            continue
        if in_table and line.startswith("|---"):
            continue
        if in_table:
            match = TABLE_PATTERN.match(line)
            if not match:
                break
            bucket, class_name, lang, rows, spans = match.groups()
            floors.append(
                {
                    "bucket": bucket,
                    "class": class_name,
                    "lang": lang,
                    "min_cases": int(rows),
                    "min_spans": int(spans),
                }
            )
    if not floors:
        raise ToolingError(f"no power-floor table found in {path}")
    return floors


def _bucket_and_class(row: dict[str, Any]) -> tuple[str, str]:
    family_id = str(row["family_id"])
    if family_id.startswith("hard-"):
        return "contextual_hard_negative", family_id.split("-f", 1)[0].removeprefix("hard-")
    if family_id.startswith("struct-"):
        return "structural_domain_positive", "name-in-technical-zone"
    return "general_synthetic", "general-person-clean-control"


def current_dev_counts(path: Path = DEFAULT_DEV_PATH) -> dict[tuple[str, str, str], tuple[int, int]]:
    counts: Counter[tuple[str, str, str]] = Counter()
    spans: Counter[tuple[str, str, str]] = Counter()
    for row in load_jsonl(path):
        bucket, class_name = _bucket_and_class(row)
        key = (bucket, class_name, str(row["lang"]))
        counts[key] += 1
        spans[key] += len(row["spans"])
    return {key: (counts[key], spans[key]) for key in counts}


def verify_power_floors(floors: list[dict[str, Any]], counts: dict[tuple[str, str, str], tuple[int, int]]) -> None:
    failures: list[str] = []
    for floor in floors:
        key = (floor["bucket"], floor["class"], floor["lang"])
        current_cases, current_spans = counts.get(key, (0, 0))
        if current_cases < floor["min_cases"] or current_spans < floor["min_spans"]:
            failures.append(
                f"{key}: current cases/spans {current_cases}/{current_spans} below frozen floor "
                f"{floor['min_cases']}/{floor['min_spans']}"
            )
    if failures:
        raise ToolingError("INCONCLUSIVE: frozen dev is below a power floor: " + "; ".join(failures))


def render_power_floor(floors: list[dict[str, Any]]) -> str:
    rows = "\n".join(
        f"| {floor['bucket']} | {floor['class']} | {floor['lang']} | {floor['min_cases']} | {floor['min_spans']} |"
        for floor in floors
    )
    return (
        "# S3 frozen power floors\n\n"
        "These numeric minima are copied verbatim from the frozen `rows/DEV-MANIFEST.md` before training. "
        "They are minimum cases and labeled spans, not target counts.\n\n"
        "| Bucket | Class | Lang | Minimum cases | Minimum spans |\n"
        "|---|---|---|---:|---:|\n"
        f"{rows}\n\n"
        "A future dev artifact below any row's floor makes the affected success bar **INCONCLUSIVE**; it is never silently relabeled NO-GO. "
        "`powerfloor_freeze.py --check` is the pre-training gate.\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Freeze/check numeric S3 dev power floors")
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--dev", type=Path, default=DEFAULT_DEV_PATH)
    parser.add_argument("--output", type=Path, default=FLOOR_OUTPUT)
    parser.add_argument("--check", action="store_true", help="verify the current dev artifact instead of rewriting output")
    args = parser.parse_args(argv)
    floors = parse_frozen_power_floors(args.output) if args.check else parse_manifest_floors(args.manifest)
    verify_power_floors(floors, current_dev_counts(args.dev))
    if not args.check:
        args.output.write_text(render_power_floor(floors), encoding="utf-8")
        print(f"wrote {args.output}")
    else:
        print("power floors verified")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolingError as exc:
        print(f"POWER-FLOOR ERROR: {exc}")
        raise SystemExit(1)
