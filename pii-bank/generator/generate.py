#!/usr/bin/env python3
"""Deterministically generate the S2 synthetic corpus checkpoint shards.

The three files are *cumulative shards*, not repeated full snapshots: reading
generated-1k, then adding generated-3k, then generated-8k produces the
1,000/3,000/8,000-row nested checkpoints.  This is necessary because S1
enforces IDs unique across every rows/*.jsonl file.

No evaluation asset is read by this program.  All text is built from the
frame and vocabulary banks beside it.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from frames_de import (
    FUNCTION_KEEP,
    FUNCTION_REDACT,
    GENERAL_CLEAN as DE_GENERAL_CLEAN,
    GENERAL_PERSON as DE_GENERAL_PERSON,
    STRUCTURAL_CONTEXTS as DE_STRUCTURAL_CONTEXTS,
    STRUCTURAL_FRAMES as DE_STRUCTURAL_FRAMES,
)
from frames_en import (
    GENERAL_CLEAN as EN_GENERAL_CLEAN,
    GENERAL_PERSON as EN_GENERAL_PERSON,
    LOCATION_KEEP,
    LOCATION_KEEP_ZONES,
    LOCATION_REDACT,
    REGION_KEEP,
    REGION_KEEP_ZONES,
    REGION_PERSON,
    ROLE_KEEP,
    ROLE_PERSON,
    STRUCTURAL_CONTEXTS as EN_STRUCTURAL_CONTEXTS,
    STRUCTURAL_FRAMES as EN_STRUCTURAL_FRAMES,
    VENDOR_KEEP,
    VENDOR_KEEP_ZONES,
    VENDOR_PERSON,
)

HERE = Path(__file__).resolve().parent
ROWS_DIR = HERE.parent / "rows"
VOCAB_DIR = HERE / "vocab"
SEED = 20260719
CREATED = "2026-07-19"
SOURCE = "generator/s2-seeded-v1"

# A checkpoint is formed by concatenating every shard through that label.
SHARDS = (("generated-1k.jsonl", 1000), ("generated-3k.jsonl", 2000), ("generated-8k.jsonl", 5000))
CHECKPOINT_TOTALS = (1000, 3000, 8000)
BUCKETS = ("contextual_hard_negative", "structural_domain_positive", "general_synthetic")
TARGET_FAMILIES = {
    1000: {"contextual_hard_negative": 125, "structural_domain_positive": 125, "general_synthetic": 250},
    3000: {"contextual_hard_negative": 375, "structural_domain_positive": 375, "general_synthetic": 750},
    8000: {"contextual_hard_negative": 1000, "structural_domain_positive": 1000, "general_synthetic": 2000},
}
PERSON_USAGE_FAMILIES = (
    "mr", "ms", "colleague", "employee", "designated reviewer",
    "assigned reviewer", "training contact", "known as", "analyst", "team member",
)


def load_vocab(name: str) -> dict[str, Any]:
    with (VOCAB_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


PEOPLE = load_vocab("people.json")
DOMAIN = load_vocab("domain.json")


def split_for_family(family_id: str) -> str:
    """The predeclared S2 family split rule."""
    return "dev" if hashlib.sha256(family_id.encode("utf-8")).digest()[-1] % 10 in {0, 1} else "train"


def identifier_forms(name: str) -> tuple[str, str, str]:
    """Return fresh snake_slug, camelCase, and dotted name identifiers."""
    folded = name.casefold().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    words = re.findall(r"[a-z]+", folded)
    snake = "_".join(words) + "_admin"
    camel = words[0] + "".join(word.title() for word in words[1:]) + "Owner"
    dotted = ".".join(words) + ".delegate"
    return snake, camel, dotted


def span(text: str, surface: str, expected: str, category: str, occurrence: int = 0) -> dict[str, Any]:
    """Build a validator-safe codepoint span from the final string.

    `str.find` is the single source of truth for offsets; no literals are
    hand-authored.  The surface is copied from the actual final text slice.
    """
    start = -1
    seek_from = 0
    for _ in range(occurrence + 1):
        start = text.find(surface, seek_from)
        if start < 0:
            raise ValueError(f"surface {surface!r} absent from generated text {text!r}")
        seek_from = start + len(surface)
    end = start + len(surface)
    return {"start": start, "end": end, "category": category, "expected": expected, "surface": text[start:end]}


def row(family_id: str, number: int, text: str, lang: str, zone: str, spans: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": f"gen2-{family_id}-{number}",
        "text": text,
        "lang": lang,
        "zone": zone,
        "spans": spans,
        "org_id": None,
        "provenance": "synthetic-generated",
        "consent_basis": "synthetic",
        "split": split_for_family(family_id),
        "family_id": family_id,
        "source": SOURCE,
        "created": CREATED,
    }


def hard_family(index: int) -> tuple[str, list[dict[str, Any]]]:
    """Paired contextual hard negatives and their person/place contrasts."""
    kind = index % 5
    # ``index % 5`` selects the hard class.  It must never also select a
    # member of a five-item pool: that caused the audit's Weil/Ora Cle
    # collapse.  The per-class cycle is intentionally independent.
    class_index = index // 5

    def natural_person(frame: str, surface: str, frame_number: int) -> str:
        """Use a varied, natural person marker for a shared hard surface."""
        subject_forms = (
            f"Mr. {surface}", f"Ms. {surface}", f"Our colleague {surface}", f"Employee {surface}",
            f"The designated reviewer {surface}", f"The assigned reviewer {surface}",
            f"The training contact {surface}", f"A colleague known as {surface}",
            f"The analyst {surface}", f"The team member {surface}",
        )
        object_forms = (
            f"Mr. {surface}", f"Ms. {surface}", f"our colleague {surface}", f"employee {surface}",
            f"the designated reviewer {surface}", f"the assigned reviewer {surface}",
            f"the training contact {surface}", f"a colleague known as {surface}",
            f"the analyst {surface}", f"the team member {surface}",
        )
        forms = subject_forms if frame.startswith("{surface}") else object_forms
        return frame.format(surface=forms[frame_number % len(forms)])

    if kind == 0:
        word = PEOPLE["function_word_surnames"][class_index % len(PEOPLE["function_word_surnames"])]
        keep_frames = FUNCTION_KEEP[word]
        frame_index = class_index % len(keep_frames)
        family_id = f"hard-de-function-{index:04d}"
        keep = keep_frames[frame_index].format(surface=word)
        redact = FUNCTION_REDACT[class_index % len(FUNCTION_REDACT)].format(surface=word)
        return family_id, [
            row(family_id, 1, keep, "de", "prose", [span(keep, word, "KEEP", "PERSON")]),
            row(family_id, 2, redact, "de", "prose", [span(redact, word, "REDACT", "PERSON")]),
        ]
    if kind == 1:
        vendor = DOMAIN["vendors"][class_index % len(DOMAIN["vendors"])]
        frame_index = class_index % len(VENDOR_KEEP)
        family_id = f"hard-vendor-{index:04d}"
        keep = VENDOR_KEEP[frame_index].format(surface=vendor)
        redact = natural_person(VENDOR_PERSON[frame_index], vendor, frame_index)
        return family_id, [
            row(family_id, 1, keep, "en", VENDOR_KEEP_ZONES[frame_index], [span(keep, vendor, "KEEP", "VENDOR")]),
            row(family_id, 2, redact, "en", "prose", [span(redact, vendor, "REDACT", "PERSON")]),
        ]
    if kind == 2:
        regions = DOMAIN["aws_regions"] + DOMAIN["azure_regions"]
        region = regions[class_index % len(regions)]
        frame_index = class_index % len(REGION_KEEP)
        family_id = f"hard-region-{index:04d}"
        keep = REGION_KEEP[frame_index].format(surface=region)
        redact = natural_person(REGION_PERSON[frame_index], region, frame_index)
        return family_id, [
            row(family_id, 1, keep, "en", REGION_KEEP_ZONES[frame_index], [span(keep, region, "KEEP", "LOCATION")]),
            row(family_id, 2, redact, "en", "prose", [span(redact, region, "REDACT", "PERSON")]),
        ]
    if kind == 3:
        role = DOMAIN["roles"][class_index % len(DOMAIN["roles"])]
        frame_index = class_index % len(ROLE_KEEP)
        family_id = f"hard-role-{index:04d}"
        keep = ROLE_KEEP[frame_index].format(surface=role)
        redact = natural_person(ROLE_PERSON[frame_index], role, frame_index)
        return family_id, [
            row(family_id, 1, keep, "en", "prose", [span(keep, role, "KEEP", "ROLE")]),
            row(family_id, 2, redact, "en", "prose", [span(redact, role, "REDACT", "PERSON")]),
        ]
    place = DOMAIN["places"][class_index % len(DOMAIN["places"])]
    frame_index = class_index % len(LOCATION_KEEP)
    family_id = f"hard-location-{index:04d}"
    keep = LOCATION_KEEP[frame_index].format(surface=place)
    redact_category, redact_frame = LOCATION_REDACT[frame_index]
    redact = redact_frame.format(surface=place)
    return family_id, [
        row(family_id, 1, keep, "en", LOCATION_KEEP_ZONES[frame_index], [span(keep, place, "KEEP", "LOCATION")]),
        row(family_id, 2, redact, "en", "prose", [span(redact, place, "REDACT", redact_category)]),
    ]


def structural_family(index: int) -> tuple[str, list[dict[str, Any]]]:
    """Technical fragments paired with an equivalent fragment without a name."""
    lang = "de" if index % 2 else "en"
    language_index = index // 2
    name = PEOPLE[lang][language_index % len(PEOPLE[lang])]
    identifier = identifier_forms(name)[(language_index // len(PEOPLE[lang])) % 3]
    clean_identifier = DOMAIN["clean_identifiers"][index % len(DOMAIN["clean_identifiers"])]
    ticket = f"{DOMAIN['ticket_prefixes'][index % 4]}-{index:05d}-{DOMAIN['opaque_ids'][index % 4]}"
    schema_key = DOMAIN["schema_keys"][index % len(DOMAIN["schema_keys"])]
    family_id = f"struct-name-{lang}-{index:04d}"
    frames = DE_STRUCTURAL_FRAMES if lang == "de" else EN_STRUCTURAL_FRAMES
    contexts = DE_STRUCTURAL_CONTEXTS if lang == "de" else EN_STRUCTURAL_CONTEXTS
    zone, redact_frame, keep_frame = frames[language_index % len(frames)]
    before, after = contexts[language_index % len(contexts)]
    hint = f"schema_key={schema_key} clean_identifier={clean_identifier}"
    redacted = f"{before}\n{redact_frame.format(surface=identifier, ticket=ticket)}\n{after} {hint}"
    clean = f"{before}\n{keep_frame.format(surface=identifier, ticket=ticket)}\n{after} {hint}"
    return family_id, [
        row(family_id, 1, redacted, lang, zone, [span(redacted, identifier, "REDACT", "PERSON")]),
        row(family_id, 2, clean, lang, zone, [span(clean, identifier, "KEEP", "TECHNICAL_IDENTIFIER")]),
    ]


def general_family(index: int) -> tuple[str, list[dict[str, Any]]]:
    """General EN/DE business prose: one person row and one clean control."""
    lang = "de" if index % 2 else "en"
    language_index = index // 2
    name = PEOPLE[lang][language_index % len(PEOPLE[lang])]
    person_frames = DE_GENERAL_PERSON if lang == "de" else EN_GENERAL_PERSON
    clean_frames = DE_GENERAL_CLEAN if lang == "de" else EN_GENERAL_CLEAN
    frame_index = language_index % len(person_frames)
    family_id = f"general-{lang}-{index:04d}"
    redacted = person_frames[frame_index].format(name=name)
    clean = clean_frames[frame_index]
    return family_id, [
        row(family_id, 1, redacted, lang, "prose", [span(redacted, name, "REDACT", "PERSON")]),
        row(family_id, 2, clean, lang, "prose", []),
    ]


FAMILY_BUILDERS = {
    "contextual_hard_negative": hard_family,
    "structural_domain_positive": structural_family,
    "general_synthetic": general_family,
}


def selected_families() -> dict[str, list[tuple[str, list[dict[str, Any]]]]]:
    """Seeded family-level selection from a larger deterministic candidate pool."""
    result: dict[str, list[tuple[str, list[dict[str, Any]]]]] = {}
    for bucket_number, bucket in enumerate(BUCKETS):
        candidates = [FAMILY_BUILDERS[bucket](i) for i in range(5000)]
        rng = random.Random(SEED + bucket_number)
        rng.shuffle(candidates)
        result[bucket] = candidates[: TARGET_FAMILIES[8000][bucket]]
    return result


def checkpoint_rows() -> dict[int, list[dict[str, Any]]]:
    """Return full cumulative rows for the three named checkpoints."""
    selected = selected_families()
    output: dict[int, list[dict[str, Any]]] = {}
    for total in CHECKPOINT_TOTALS:
        rows: list[dict[str, Any]] = []
        for bucket in BUCKETS:
            for _, family_rows in selected[bucket][: TARGET_FAMILIES[total][bucket]]:
                rows.extend(family_rows)
        output[total] = rows
    return output


def shard_rows() -> dict[str, list[dict[str, Any]]]:
    """Return non-overlapping physical shards that compose cumulative checkpoints."""
    checkpoints = checkpoint_rows()
    previous: list[dict[str, Any]] = []
    shards: dict[str, list[dict[str, Any]]] = {}
    for (filename, expected_count), total in zip(SHARDS, CHECKPOINT_TOTALS):
        current = checkpoints[total]
        previous_ids = {item["id"] for item in previous}
        delta = [item for item in current if item["id"] not in previous_ids]
        if len(delta) != expected_count:
            raise AssertionError(f"{filename}: expected {expected_count} rows, got {len(delta)}")
        shards[filename] = delta
        previous = current
    return shards


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    content = "".join(json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for item in rows)
    path.write_text(content, encoding="utf-8")


def report_markdown(checkpoints: dict[int, list[dict[str, Any]]]) -> str:
    lines = [
        "# S2 synthetic generator report",
        "",
        "Generation is deterministic (`SEED = 20260719`) and uses only the local frame/vocabulary banks.",
        "This is audit-driven repair round 2, a pre-training bugfix regeneration for interpretability defects, not result-driven resizing.",
        "The physical files are cumulative, non-overlapping shards: concatenate 1k; then 1k+3k; then 1k+3k+8k to form the named checkpoints. This preserves S1 bank-wide ID uniqueness while retaining nested family-level samples.",
        "",
        "| Checkpoint | Bucket | Rows | Tokens | Spans | Context tokens (min/mean) | REDACT | KEEP | EN | DE | prose | json_value | technical_id | code_identifier | schema_label |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for total in CHECKPOINT_TOTALS:
        rows = checkpoints[total]
        for bucket in BUCKETS:
            prefix = {"contextual_hard_negative": "hard-", "structural_domain_positive": "struct-", "general_synthetic": "general-"}[bucket]
            bucket_rows = [item for item in rows if item["family_id"].startswith(prefix)]
            tokens = sum(len(item["text"].split()) for item in bucket_rows)
            spans = [entry for item in bucket_rows for entry in item["spans"]]
            context_counts = [
                len(item["text"][: entry["start"]].split()) + len(item["text"][entry["end"] :].split())
                for item in bucket_rows
                for entry in item["spans"]
            ]
            labels = Counter(entry["expected"] for entry in spans)
            langs = Counter(item["lang"] for item in bucket_rows)
            zones = Counter(item["zone"] for item in bucket_rows)
            lines.append(
                "| {total} | {bucket} | {rows} | {tokens} | {spans} | {context_min}/{context_mean:.2f} | {redact} | {keep} | {en} | {de} | {prose} | {json_value} | {technical_id} | {code_identifier} | {schema_label} |".format(
                    total=total,
                    bucket=bucket,
                    rows=len(bucket_rows),
                    tokens=tokens,
                    spans=len(spans),
                    context_min=min(context_counts) if context_counts else 0,
                    context_mean=sum(context_counts) / len(context_counts) if context_counts else 0,
                    redact=labels["REDACT"],
                    keep=labels["KEEP"],
                    en=langs["en"],
                    de=langs["de"],
                    prose=zones["prose"],
                    json_value=zones["json_value"],
                    technical_id=zones["technical_id"],
                    code_identifier=zones["code_identifier"],
                    schema_label=zones["schema_label"],
                )
            )
    lines.extend(
        [
            "",
            "## Composition checks",
            "",
            "- Checkpoint bucket shares are exactly 25% contextual hard negatives, 25% structural/domain positives, and 50% general synthetic rows.",
            "- Each selected family has two rows and one deterministic family split: `sha256(family_id)` last byte modulo 10 is dev for 0/1, otherwise train.",
            "- Every hard family is a true same-surface counterfactual: German function-word surname, vendor, region, role phrase, and place/schema contexts. Structural families likewise reuse a name-bearing snake/camel/dotted identifier in person and technical contexts.",
        ]
    )
    return "\n".join(lines) + "\n"


def generate(output_rows_dir: Path = ROWS_DIR, report_path: Path | None = None) -> None:
    """Write all deterministic S2 outputs."""
    output_rows_dir.mkdir(parents=True, exist_ok=True)
    shards = shard_rows()
    for filename, _ in SHARDS:
        write_jsonl(output_rows_dir / filename, shards[filename])
    if report_path is None:
        report_path = HERE / "REPORT.md"
    report_path.write_text(report_markdown(checkpoint_rows()), encoding="utf-8")


if __name__ == "__main__":
    generate()
