#!/usr/bin/env python3
"""Offline-only base-mix inspection stub.

This intentionally has no networking code. Supply an already-authorized local
JSON, JSONL, or text snapshot; the script reports structural signals for a
human admission review and does not approve, copy, or download any dataset.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

EMAIL_RE = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")
PHONE_RE = re.compile(r"\b(?:\+?\d[\d .()-]{6,}\d)\b")
KEYS = ("text", "sentence", "content", "tokens", "label", "labels", "ner_tags", "split")


def canonical(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def records(path: Path) -> Iterable[Any]:
    if path.suffix.lower() == ".jsonl":
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                yield {"_line": line_no, "value": json.loads(line)}
        return
    if path.suffix.lower() == ".json":
        yield {"_line": 1, "value": json.loads(path.read_text(encoding="utf-8"))}
        return
    yield {"_line": 1, "value": path.read_text(encoding="utf-8")}


def text_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from text_values(item)
    elif isinstance(value, dict):
        for key in KEYS:
            if key in value:
                yield from text_values(value[key])


def inspect(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    labels: Counter[str] = Counter()
    splits: Counter[str] = Counter()
    texts: list[str] = []
    objects = 0
    for wrapped in records(path):
        value = wrapped["value"]
        objects += 1
        if isinstance(value, dict):
            for key in ("label", "labels", "ner_tags"):
                item = value.get(key)
                if isinstance(item, str):
                    labels[item] += 1
                elif isinstance(item, list):
                    labels.update(str(part) for part in item)
            if isinstance(value.get("split"), str):
                splits[value["split"]] += 1
        texts.extend(text_values(value))
    canon = [canonical(text) for text in texts if canonical(text)]
    return {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "records": objects,
        "text_fields": len(texts),
        "canonical_distinct_text": len(set(canon)),
        "duplicate_canonical_text": len(canon) - len(set(canon)),
        "email_like_text_fields": sum(bool(EMAIL_RE.search(text)) for text in texts),
        "phone_like_text_fields": sum(bool(PHONE_RE.search(text)) for text in texts),
        "labels": dict(sorted(labels.items())),
        "declared_splits": dict(sorted(splits.items())),
        "admission": "PENDING HUMAN REVIEW — offline inventory is not provenance or licence verification",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", type=Path, required=True, help="authorized local JSON, JSONL, or text snapshot")
    args = parser.parse_args()
    if not args.local.is_file():
        parser.error(f"not a readable file: {args.local}")
    print(json.dumps(inspect(args.local), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
