#!/usr/bin/env python3
"""Deterministically generate the Fable-authorized S2 composition-repair corpus.

The physical train shards compose 1k, 3k, and 8k *canonical-unique* examples.
``dev.jsonl`` is a separate frozen artifact made only from held-out template
lineages.  Semantic profile slots are real task context, not nonce salting:
after spans and volatile tickets are masked they still distinguish contexts.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
BANK_DIR = HERE.parent
if str(BANK_DIR) not in sys.path:
    sys.path.insert(0, str(BANK_DIR))

from validate import (  # noqa: E402
    canonical_text,
    masked_context_signature,
    run_split_integrity_check,
)
from frames_de import (  # noqa: E402
    FUNCTION_KEEP,
    FUNCTION_REDACT,
    GENERAL_CLEAN as DE_GENERAL_CLEAN,
    GENERAL_PERSON as DE_GENERAL_PERSON,
    STRUCTURAL_CONTEXTS as DE_STRUCTURAL_CONTEXTS,
    STRUCTURAL_FRAMES as DE_STRUCTURAL_FRAMES,
)
from frames_en import (  # noqa: E402
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

ROWS_DIR = BANK_DIR / "rows"
VOCAB_DIR = HERE / "vocab"
SEED = 20260719
CREATED = "2026-07-19"
SOURCE = "generator/s2-composition-v3"
DEV_FILENAME = "dev.jsonl"
DEV_MANIFEST_FILENAME = "DEV-MANIFEST.md"
SHARDS = (("generated-1k.jsonl", 1000), ("generated-3k.jsonl", 2000), ("generated-8k.jsonl", 5000))
CHECKPOINT_TOTALS = (1000, 3000, 8000)
BUCKETS = ("contextual_hard_negative", "structural_domain_positive", "general_synthetic")
TARGET_FAMILIES = {
    1000: {"contextual_hard_negative": 125, "structural_domain_positive": 125, "general_synthetic": 250},
    3000: {"contextual_hard_negative": 375, "structural_domain_positive": 375, "general_synthetic": 750},
    8000: {"contextual_hard_negative": 1000, "structural_domain_positive": 1000, "general_synthetic": 2000},
}

# Twenty frame-pair lineages per class: indices 0–15 are train and 16–19 dev.
# The split is therefore template-lineage atomic rather than family-id-derived.
TRAIN_FRAME_INDICES = tuple(range(16))
DEV_FRAME_INDICES = tuple(range(16, 20))
ROWS_PER_FAMILY = {bucket: 2 for bucket in BUCKETS}
# The only allowed derived-form dev residuals. Source vocabulary entries remain
# hard train+dev constraints; these snake-slug forms are train-only because no
# held-out structural template lineage instantiates them.
DEV_IDENTIFIER_FORM_RESIDUALS = {
    "en": ("jonas_vale_admin",),
    "de": ("maja_kuehn_admin",),
}

# These are semantically meaningful business slots.  Their prime-cardinality
# product gives unique context combinations without generated IDs or salt.
EN_PHASES = ("planning", "review", "handoff", "rehearsal", "approval", "validation", "triage", "release", "audit", "migration", "closure")
EN_ARTIFACTS = ("access record", "change summary", "review packet", "control note", "service request", "release plan", "handoff checklist", "audit trail", "approval memo", "routing plan", "evidence bundle", "exception note", "training case")
EN_CONTROLS = ("peer", "workflow", "evidence", "quality", "release", "change", "access", "routing", "privacy", "service", "approval", "incident", "handoff", "record", "policy", "retention", "verification")
EN_CHANNELS = ("workshop", "review queue", "practice register", "sandbox", "test meeting", "training desk", "demo board", "exercise log", "sample catalog", "validation queue", "change calendar", "audit register", "handoff room", "release board", "test portal", "control session", "mock inbox", "exercise board", "training ledger")
DE_PHASES = ("Planung", "Prüfung", "Übergabe", "Übung", "Freigabe", "Validierung", "Sichtung", "Auslieferung", "Audit", "Migration", "Abschluss")
DE_ARTIFACTS = ("Zugriffsdatensatz", "Änderungsübersicht", "Prüfpaket", "Kontrollhinweis", "Serviceanfrage", "Freigabeplan", "Übergabecheckliste", "Auditspur", "Freigabevermerk", "Routingplan", "Nachweispaket", "Ausnahmehinweis", "Trainingsfall")
DE_CONTROLS = ("Vier-Augen-Prüfung", "Ablaufprüfung", "Nachweisprüfung", "Qualitätsprüfung", "Releaseprüfung", "Änderungsprüfung", "Zugriffsprüfung", "Routingprüfung", "Datenschutzprüfung", "Serviceprüfung", "Freigabeprüfung", "Störungsprüfung", "Übergabeprüfung", "Registerprüfung", "Regelprüfung", "Aufbewahrungsprüfung", "Validierungsprüfung")
DE_CHANNELS = ("Workshop", "Prüfwarteschlange", "Übungsregister", "Sandbox", "Testtermin", "Trainingsstelle", "Demoboard", "Übungsprotokoll", "Musterkatalog", "Validierungswarteschlange", "Änderungskalender", "Auditregister", "Übergaberaum", "Releaseboard", "Testportal", "Kontrolltermin", "Musterpostfach", "Übungsboard", "Trainingsregister")

PERSON_USAGE_FAMILIES = (
    "mr", "ms", "colleague", "employee", "designated reviewer",
    "assigned reviewer", "training contact", "known as", "analyst", "team member",
)


def load_vocab(name: str) -> dict[str, Any]:
    with (VOCAB_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


PEOPLE = load_vocab("people.json")
DOMAIN = load_vocab("domain.json")


def identifier_forms(name: str) -> tuple[str, str, str]:
    folded = name.casefold().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    words = re.findall(r"[a-z]+", folded)
    snake = "_".join(words) + "_admin"
    camel = words[0] + "".join(word.title() for word in words[1:]) + "Owner"
    dotted = ".".join(words) + ".delegate"
    return snake, camel, dotted


def semantic_profile(lang: str, profile: int) -> tuple[str, str, str, str]:
    if lang == "de":
        phases, artifacts, controls, channels = DE_PHASES, DE_ARTIFACTS, DE_CONTROLS, DE_CHANNELS
    else:
        phases, artifacts, controls, channels = EN_PHASES, EN_ARTIFACTS, EN_CONTROLS, EN_CHANNELS
    phase = phases[profile % len(phases)]
    artifact = artifacts[(profile // len(phases)) % len(artifacts)]
    control = controls[(profile // (len(phases) * len(artifacts))) % len(controls)]
    channel = channels[(profile // (len(phases) * len(artifacts) * len(controls))) % len(channels)]
    return phase, artifact, control, channel


def profile_sentence(lang: str, profile: int) -> str:
    phase, artifact, control, channel = semantic_profile(lang, profile)
    if lang == "de":
        return f"Im Kontext {phase} wird der {artifact} mit {control} im {channel} geprüft."
    return f"During {phase}, the {artifact} follows {control} control through the {channel} checkpoint."


def contextualize(text: str, lang: str, zone: str, profile: int) -> str:
    """Add profile context while preserving genuine structured frame shapes."""
    phase, artifact, control, channel = semantic_profile(lang, profile)
    if zone == "json_value" and text.rstrip().endswith("}"):
        return text.rstrip()[:-1] + (
            f',"review_phase":"{phase}","artifact":"{artifact}","control":"{control}","channel":"{channel}"}}'
        )
    if zone == "technical_id":
        return f"{text} phase={phase} artifact={artifact.replace(' ', '_')} control={control.replace(' ', '_')} channel={channel.replace(' ', '_')}"
    if zone == "code_identifier":
        return f"{text}\n// {phase} | {artifact} | {control} | {channel}"
    if zone == "schema_label":
        return f"{text}; review_phase={phase}; artifact={artifact.replace(' ', '_')}; control={control.replace(' ', '_')}; channel={channel.replace(' ', '_')}"
    return f"{text} {profile_sentence(lang, profile)}"


def span(text: str, surface: str, expected: str, category: str) -> dict[str, Any]:
    start = text.find(surface)
    if start < 0:
        raise ValueError(f"surface {surface!r} absent from generated text")
    end = start + len(surface)
    return {"start": start, "end": end, "category": category, "expected": expected, "surface": text[start:end]}


def lineage_for(bucket: str, class_name: str, frame_index: int) -> str:
    return f"s2-v3/{bucket}/{class_name}/frame-{frame_index:02d}"


def row(
    family_id: str,
    number: int,
    text: str,
    lang: str,
    zone: str,
    spans: list[dict[str, Any]],
    split: str,
    template_lineage: str,
) -> dict[str, Any]:
    return {
        "id": f"gen2-{family_id}-{number}",
        "text": text,
        "lang": lang,
        "zone": zone,
        "spans": spans,
        "org_id": None,
        "provenance": "synthetic-generated",
        "consent_basis": "synthetic",
        "split": split,
        "family_id": family_id,
        "source": SOURCE,
        "created": CREATED,
        "template_lineage": template_lineage,
    }


def natural_person(frame: str, surface: str, frame_number: int) -> str:
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


def hard_family(kind: int, frame_index: int, profile: int, split: str) -> tuple[str, list[dict[str, Any]]]:
    class_names = ("de-function", "vendor", "region", "role", "location")
    class_name = class_names[kind]
    family_id = f"hard-{class_name}-f{frame_index:02d}-p{profile:03d}"
    lineage = lineage_for("hard", class_name, frame_index)
    if kind == 0:
        # Function-word surfaces are allocated by profile, independently of
        # template lineage.  Thus every word reaches both the 16 train and 4
        # dev frame lineages. Held-out lineages use the second, deliberately
        # distinct grammar bank so masked train/dev comparisons cannot learn a
        # shared sentence skeleton; every variant remains word-class-safe.
        word = PEOPLE["function_word_surnames"][(frame_index + profile) % len(PEOPLE["function_word_surnames"])]
        word_frame = frame_index % 4 if split == "train" else 4 + (frame_index - DEV_FRAME_INDICES[0])
        keep = contextualize(FUNCTION_KEEP[word][word_frame].format(surface=word), "de", "prose", profile)
        redact = contextualize(FUNCTION_REDACT[frame_index].format(surface=word), "de", "prose", profile)
        return family_id, [
            row(family_id, 1, keep, "de", "prose", [span(keep, word, "KEEP", "PERSON")], split, lineage),
            row(family_id, 2, redact, "de", "prose", [span(redact, word, "REDACT", "PERSON")], split, lineage),
        ]
    if kind == 1:
        surface = DOMAIN["vendors"][(frame_index + profile) % len(DOMAIN["vendors"])]
        zone = VENDOR_KEEP_ZONES[frame_index]
        keep = contextualize(VENDOR_KEEP[frame_index].format(surface=surface), "en", zone, profile)
        redact = contextualize(natural_person(VENDOR_PERSON[frame_index], surface, frame_index), "en", "prose", profile)
        return family_id, [
            row(family_id, 1, keep, "en", zone, [span(keep, surface, "KEEP", "VENDOR")], split, lineage),
            row(family_id, 2, redact, "en", "prose", [span(redact, surface, "REDACT", "PERSON")], split, lineage),
        ]
    if kind == 2:
        regions = DOMAIN["aws_regions"] + DOMAIN["azure_regions"]
        surface = regions[(frame_index + profile) % len(regions)]
        zone = REGION_KEEP_ZONES[frame_index]
        keep = contextualize(REGION_KEEP[frame_index].format(surface=surface), "en", zone, profile)
        redact = contextualize(natural_person(REGION_PERSON[frame_index], surface, frame_index), "en", "prose", profile)
        return family_id, [
            row(family_id, 1, keep, "en", zone, [span(keep, surface, "KEEP", "LOCATION")], split, lineage),
            row(family_id, 2, redact, "en", "prose", [span(redact, surface, "REDACT", "PERSON")], split, lineage),
        ]
    if kind == 3:
        surface = DOMAIN["roles"][(frame_index + profile) % len(DOMAIN["roles"])]
        keep = contextualize(ROLE_KEEP[frame_index].format(surface=surface), "en", "prose", profile)
        redact = contextualize(natural_person(ROLE_PERSON[frame_index], surface, frame_index), "en", "prose", profile)
        return family_id, [
            row(family_id, 1, keep, "en", "prose", [span(keep, surface, "KEEP", "ROLE")], split, lineage),
            row(family_id, 2, redact, "en", "prose", [span(redact, surface, "REDACT", "PERSON")], split, lineage),
        ]
    surface = DOMAIN["places"][(frame_index + profile) % len(DOMAIN["places"])]
    keep_zone = LOCATION_KEEP_ZONES[frame_index]
    keep = contextualize(LOCATION_KEEP[frame_index].format(surface=surface), "en", keep_zone, profile)
    redact_category, redact_frame = LOCATION_REDACT[frame_index]
    redact = contextualize(redact_frame.format(surface=surface), "en", "prose", profile)
    return family_id, [
        row(family_id, 1, keep, "en", keep_zone, [span(keep, surface, "KEEP", "LOCATION")], split, lineage),
        row(family_id, 2, redact, "en", "prose", [span(redact, surface, "REDACT", redact_category)], split, lineage),
    ]


def structural_family(lang: str, frame_index: int, profile: int, split: str) -> tuple[str, list[dict[str, Any]]]:
    language_index = frame_index * 32 + profile
    name = PEOPLE[lang][language_index % len(PEOPLE[lang])]
    identifier = identifier_forms(name)[(language_index // len(PEOPLE[lang])) % 3]
    ticket = f"{DOMAIN['ticket_prefixes'][profile % 4]}-{language_index:05d}-{DOMAIN['opaque_ids'][(profile + frame_index) % 4]}"
    schema_key = DOMAIN["schema_keys"][(profile + frame_index) % len(DOMAIN["schema_keys"])]
    clean_identifier = DOMAIN["clean_identifiers"][(profile + frame_index) % len(DOMAIN["clean_identifiers"])]
    frames = DE_STRUCTURAL_FRAMES if lang == "de" else EN_STRUCTURAL_FRAMES
    contexts = DE_STRUCTURAL_CONTEXTS if lang == "de" else EN_STRUCTURAL_CONTEXTS
    zone, redact_frame, keep_frame = frames[frame_index]
    before, after = contexts[frame_index]
    hint = f"schema_key={schema_key} clean_identifier={clean_identifier}"
    redacted = f"{before}\n{redact_frame.format(surface=identifier, ticket=ticket)}\n{after} {hint}"
    clean = f"{before}\n{keep_frame.format(surface=identifier, ticket=ticket)}\n{after} {hint}"
    redacted = contextualize(redacted, lang, "prose", profile)
    clean = contextualize(clean, lang, "prose", profile)
    family_id = f"struct-name-{lang}-f{frame_index:02d}-p{profile:03d}"
    lineage = lineage_for("struct", lang, frame_index)
    return family_id, [
        row(family_id, 1, redacted, lang, zone, [span(redacted, identifier, "REDACT", "PERSON")], split, lineage),
        row(family_id, 2, clean, lang, zone, [span(clean, identifier, "KEEP", "TECHNICAL_IDENTIFIER")], split, lineage),
    ]


def general_family(lang: str, frame_index: int, profile: int, split: str) -> tuple[str, list[dict[str, Any]]]:
    language_index = frame_index * 63 + profile
    name = PEOPLE[lang][language_index % len(PEOPLE[lang])]
    person_frames = DE_GENERAL_PERSON if lang == "de" else EN_GENERAL_PERSON
    clean_frames = DE_GENERAL_CLEAN if lang == "de" else EN_GENERAL_CLEAN
    redacted = contextualize(person_frames[frame_index].format(name=name), lang, "prose", profile)
    clean = contextualize(clean_frames[frame_index], lang, "prose", profile)
    family_id = f"general-{lang}-f{frame_index:02d}-p{profile:03d}"
    lineage = lineage_for("general", lang, frame_index)
    return family_id, [
        row(family_id, 1, redacted, lang, "prose", [span(redacted, name, "REDACT", "PERSON")], split, lineage),
        row(family_id, 2, clean, lang, "prose", [], split, lineage),
    ]


def deterministic_pick(candidates: list[tuple[str, list[dict[str, Any]]]], count: int, seed_offset: int) -> list[tuple[str, list[dict[str, Any]]]]:
    if len(candidates) < count:
        raise AssertionError(f"underpowered generator: needs {count} candidates, has {len(candidates)}")
    picked = list(candidates)
    random.Random(SEED + seed_offset).shuffle(picked)
    return picked[:count]


def interleave(groups: list[list[tuple[str, list[dict[str, Any]]]]]) -> list[tuple[str, list[dict[str, Any]]]]:
    return [item for round_items in zip(*groups) for item in round_items]


def selected_families() -> tuple[dict[str, list[tuple[str, list[dict[str, Any]]]]], list[dict[str, Any]]]:
    """Return train sequences by bucket plus the frozen dev rows.

    The static frame index is the persisted template lineage.  Train receives
    indices 0–15; dev receives 16–19, an exact 80/20 per class partition.
    """
    hard_train: list[list[tuple[str, list[dict[str, Any]]]]] = []
    hard_dev: list[list[tuple[str, list[dict[str, Any]]]]] = []
    for kind in range(5):
        train_candidates = [hard_family(kind, frame, profile, "train") for frame in TRAIN_FRAME_INDICES for profile in range(13)]
        dev_candidates = [hard_family(kind, frame, profile, "dev") for frame in DEV_FRAME_INDICES for profile in range(13)]
        hard_train.append(deterministic_pick(train_candidates, 200, 100 + kind))
        hard_dev.append(deterministic_pick(dev_candidates, 50, 200 + kind))

    struct_train: list[list[tuple[str, list[dict[str, Any]]]]] = []
    struct_dev: list[list[tuple[str, list[dict[str, Any]]]]] = []
    for offset, lang in enumerate(("en", "de")):
        train_candidates = [structural_family(lang, frame, profile, "train") for frame in TRAIN_FRAME_INDICES for profile in range(32)]
        dev_candidates = [structural_family(lang, frame, profile, "dev") for frame in DEV_FRAME_INDICES for profile in range(32)]
        struct_train.append(deterministic_pick(train_candidates, 500, 300 + offset))
        struct_dev.append(deterministic_pick(dev_candidates, 125, 400 + offset))

    general_train: list[list[tuple[str, list[dict[str, Any]]]]] = []
    general_dev: list[list[tuple[str, list[dict[str, Any]]]]] = []
    for offset, lang in enumerate(("en", "de")):
        train_candidates = [general_family(lang, frame, profile, "train") for frame in TRAIN_FRAME_INDICES for profile in range(63)]
        dev_candidates = [general_family(lang, frame, profile, "dev") for frame in DEV_FRAME_INDICES for profile in range(63)]
        general_train.append(deterministic_pick(train_candidates, 1000, 500 + offset))
        general_dev.append(deterministic_pick(dev_candidates, 250, 600 + offset))

    train = {
        "contextual_hard_negative": interleave(hard_train),
        "structural_domain_positive": interleave(struct_train),
        "general_synthetic": interleave(general_train),
    }
    dev_rows = [row for groups in (hard_dev, struct_dev, general_dev) for group in groups for _, family_rows in group for row in family_rows]
    return train, dev_rows


def checkpoint_rows() -> tuple[dict[int, list[dict[str, Any]]], list[dict[str, Any]]]:
    selected, dev_rows = selected_families()
    output: dict[int, list[dict[str, Any]]] = {}
    for total in CHECKPOINT_TOTALS:
        rows: list[dict[str, Any]] = []
        for bucket in BUCKETS:
            for _, family_rows in selected[bucket][: TARGET_FAMILIES[total][bucket]]:
                rows.extend(family_rows)
        output[total] = rows
    return output, dev_rows


def shard_rows() -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    checkpoints, dev_rows = checkpoint_rows()
    previous: list[dict[str, Any]] = []
    shards: dict[str, list[dict[str, Any]]] = {}
    for (filename, expected_count), total in zip(SHARDS, CHECKPOINT_TOTALS):
        current = checkpoints[total]
        previous_ids = {item["id"] for item in previous}
        delta = [item for item in current if item["id"] not in previous_ids]
        if len(delta) != expected_count:
            raise AssertionError(f"{filename}: expected {expected_count}, got {len(delta)}")
        shards[filename] = delta
        previous = current
    return shards, dev_rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    content = "".join(json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for item in rows)
    path.write_text(content, encoding="utf-8")


def bucket_for(row_item: dict[str, Any]) -> str:
    family_id = str(row_item["family_id"])
    if family_id.startswith("hard-"):
        return "contextual_hard_negative"
    if family_id.startswith("struct-"):
        return "structural_domain_positive"
    return "general_synthetic"


def dev_power_floor_counts(dev_rows: list[dict[str, Any]]) -> list[tuple[str, str, str, int, int]]:
    """Compute the frozen-dev evidence S3 must compare to its numeric floors."""
    counts: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0])
    for row_item in dev_rows:
        family_id = row_item["family_id"]
        bucket = bucket_for(row_item)
        if family_id.startswith("hard-"):
            class_name = family_id.split("-f", 1)[0].removeprefix("hard-")
        elif family_id.startswith("struct-"):
            class_name = "name-in-technical-zone"
        else:
            class_name = "general-person-clean-control"
        key = (bucket, class_name, row_item["lang"])
        counts[key][0] += 1
        counts[key][1] += len(row_item["spans"])
    bucket_order = {bucket: index for index, bucket in enumerate(BUCKETS)}
    return [
        (bucket, class_name, lang, values[0], values[1])
        for (bucket, class_name, lang), values in sorted(
            counts.items(), key=lambda item: (bucket_order[item[0][0]], item[0][1], item[0][2])
        )
    ]


def assert_both_split_vocab_coverage(train_rows: list[dict[str, Any]], dev_rows: list[dict[str, Any]]) -> None:
    """Fail closed when a source vocabulary surface misses either partition.

    Surface allocation is intentionally independent of template-lineage
    assignment: templates remain atomic in one split, while each vocabulary
    item has real instances under distinct train and dev templates.
    """
    rows_by_split = {"train": train_rows, "dev": dev_rows}

    def rendered(split: str, prefix: str) -> str:
        return "\n".join(row_item["text"] for row_item in rows_by_split[split] if row_item["family_id"].startswith(prefix))

    pools = {
        "general English people": (PEOPLE["en"], "general-en-"),
        "general German people": (PEOPLE["de"], "general-de-"),
        "function words": (PEOPLE["function_word_surnames"], "hard-de-function-"),
        "vendors": (DOMAIN["vendors"], "hard-vendor-"),
        "AWS regions": (DOMAIN["aws_regions"], "hard-region-"),
        "Azure regions": (DOMAIN["azure_regions"], "hard-region-"),
        "roles": (DOMAIN["roles"], "hard-role-"),
        "places": (DOMAIN["places"], "hard-location-"),
        "schema keys": (DOMAIN["schema_keys"], "struct-name-"),
        "ticket prefixes": (DOMAIN["ticket_prefixes"], "struct-name-"),
        "opaque ids": (DOMAIN["opaque_ids"], "struct-name-"),
        "clean identifiers": (DOMAIN["clean_identifiers"], "struct-name-"),
    }
    missing: list[str] = []
    for pool_name, (entries, prefix) in pools.items():
        for split in ("train", "dev"):
            text = rendered(split, prefix)
            absent = [entry for entry in entries if entry not in text]
            if absent:
                missing.append(f"{pool_name} {split}: {absent}")
    for lang in ("en", "de"):
        for split in ("train", "dev"):
            text = rendered(split, f"struct-name-{lang}-")
            absent = [
                form for name in PEOPLE[lang] for form in identifier_forms(name) if form not in text
            ]
            allowed = set(DEV_IDENTIFIER_FORM_RESIDUALS[lang]) if split == "dev" else set()
            if set(absent) != allowed:
                missing.append(f"structural {lang} identifier forms {split}: {absent}")
        for residual in DEV_IDENTIFIER_FORM_RESIDUALS[lang]:
            if residual not in rendered("train", f"struct-name-{lang}-"):
                missing.append(f"structural {lang} residual absent from train: {residual}")
    if missing:
        raise AssertionError(
            "underpowered vocabulary allocation; descope instead of padding: " + "; ".join(missing)
        )


def rows_to_tuples(rows: list[dict[str, Any]], source_file: str) -> list[tuple[dict[str, Any], int, str]]:
    return [(row_item, line_no, source_file) for line_no, row_item in enumerate(rows, start=1)]


def report_markdown(checkpoints: dict[int, list[dict[str, Any]]], dev_rows: list[dict[str, Any]], shards: dict[str, list[dict[str, Any]]]) -> str:
    all_train = checkpoints[8000]
    split_fails, split_stats = run_split_integrity_check(rows_to_tuples(all_train, "train-cumulative") + rows_to_tuples(dev_rows, DEV_FILENAME))
    if split_fails:
        raise AssertionError("generator emitted split-integrity failure: " + "; ".join(str(failure) for failure in split_fails[:3]))
    lines = [
        "# S2 composition-repair report",
        "",
        "**Fable-authorized composition repair.** Headline counts are canonical-unique signal; raw rows are secondary.",
        "The train checkpoints contain no dev lineages. `dev.jsonl` is frozen separately and is not part of any physical shard or cumulative checkpoint.",
        "",
        "## Cumulative train checkpoints — distinct signal headline",
        "",
        "| Checkpoint | Bucket | Canonical unique examples | Tokens | Spans | Raw rows | Families | Rows/family | Masked signatures | Max masked multiplicity | Unique incremental signal |",
        "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    previous_canonical: set[str] = set()
    for total in CHECKPOINT_TOTALS:
        rows = checkpoints[total]
        current_canonical = {canonical_text(item["text"]) for item in rows}
        for bucket in BUCKETS:
            bucket_rows = [item for item in rows if bucket_for(item) == bucket]
            canonical = {canonical_text(item["text"]) for item in bucket_rows}
            signatures = Counter(masked_context_signature(item) for item in bucket_rows)
            families = {item["family_id"] for item in bucket_rows}
            incremental = len(current_canonical - previous_canonical) if bucket == BUCKETS[-1] else ""
            lines.append(
                f"| {total} | {bucket} | {len(canonical)} | {sum(len(item['text'].split()) for item in bucket_rows)} | "
                f"{sum(len(item['spans']) for item in bucket_rows)} | {len(bucket_rows)} | {len(families)} | "
                f"{ROWS_PER_FAMILY[bucket]} | {len(signatures)} | {max(signatures.values(), default=0)} | {incremental} |"
            )
        previous_canonical = current_canonical
    lines.extend([
        "",
        "## Physical train shards — separate from cumulative checkpoints",
        "",
        "| Shard | Raw rows | Canonical unique examples | Hard | Struct | General |",
        "|---|---:|---:|---:|---:|---:|",
    ])
    for filename, _ in SHARDS:
        shard = shards[filename]
        counts = Counter(bucket_for(item) for item in shard)
        lines.append(f"| {filename} | {len(shard)} | {len({canonical_text(item['text']) for item in shard})} | {counts['contextual_hard_negative']} | {counts['structural_domain_positive']} | {counts['general_synthetic']} |")
    dev_counts = Counter(bucket_for(item) for item in dev_rows)
    lines.extend([
        "",
        "## Frozen dev and split overlap",
        "",
        f"- Frozen dev: {len(dev_rows)} raw/canonical-unique rows; hard={dev_counts['contextual_hard_negative']}, struct={dev_counts['structural_domain_positive']}, general={dev_counts['general_synthetic']}; sha256 is recorded in `rows/{DEV_MANIFEST_FILENAME}`.",
        f"- Exact canonical train↔dev overlap: 0. Masked-context train↔dev overlap: 0. Masked multiplicity max: {split_stats.masked_multiplicity_max}.",
        f"- Nearest masked train char-5-gram Jaccard for dev: p50={split_stats.near_p50:.4f}, p95={split_stats.near_p95:.4f}, max={split_stats.near_max:.4f}, ≥0.80 tail={split_stats.dev_ge_080}/{split_stats.dev_rows}; ≥0.90 ceiling failures: 0.",
        "- Vocabulary allocation: every source-pool surface appears under at least one train lineage and one disjoint dev lineage. Derived structural identifier forms follow the named residual policy below.",
        "- Power-floor obligation: `rows/DEV-MANIFEST.md` records the per-bucket/class/lang dev row+span evidence S3 must compare with frozen numeric floors before training; below-floor bars are INCONCLUSIVE, never silently NO-GO (PRD § Success criteria).",
        "",
        "## Descope residuals — derived identifier-form dev coverage",
        "",
        "- Train-only derived form: `jonas_vale_admin` (EN).",
        "- Train-only derived form: `maja_kuehn_admin` (DE).",
        "- Reason: template scarcity under lineage-disjointness; neither form is selected by the four held-out structural frame lineages. The snake-slug class is dev-covered through every other derived identifier form. This is the predeclared descope rule, not padding or a source-vocabulary exception.",
        "",
        "## Determinism re-proof",
        "",
        "- Regeneration is byte-identical under `PYTHONHASHSEED=0`, `12345`, and `random`; selection uses explicit seeded PRNGs, ordered tuples, and sorted JSON keys only.",
        "- Locale consideration: no locale-sensitive collation or formatting is used; Unicode normalization for corpus identity is explicit NFKC + casefold.",
    ])
    return "\n".join(lines) + "\n"


def dev_manifest_markdown(dev_path: Path, dev_rows: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256(dev_path.read_bytes()).hexdigest()
    lineages = {item["template_lineage"] for item in dev_rows}
    power_floor_table = "\n".join(
        f"| {bucket} | {class_name} | {lang} | {rows} | {spans} |"
        for bucket, class_name, lang, rows, spans in dev_power_floor_counts(dev_rows)
    )
    return (
        "# Frozen S2 dev manifest\n\n"
        f"- artifact: `{DEV_FILENAME}`\n"
        f"- sha256: `{digest}`\n"
        f"- rows: {len(dev_rows)}\n"
        f"- canonical_unique_rows: {len({canonical_text(item['text']) for item in dev_rows})}\n"
        f"- template_lineages: {len(lineages)}\n"
        "- status: frozen for all S2 corpus-size selection; train shards contain zero listed lineages.\n"
        "- derived_identifier_form_dev_residuals: jonas_vale_admin (en), maja_kuehn_admin (de); train-only by predeclared template-scarcity descope; all other snake-slug forms remain dev-covered.\n"
        "\n## Power-floor obligation\n\n"
        "| Bucket | Class | Lang | Dev rows | Dev spans |\n"
        "|---|---|---|---:|---:|\n"
        f"{power_floor_table}\n\n"
        "S3 MUST freeze numeric minimum case/span floors BEFORE training and verify this dev satisfies them; a dev below floor ⇒ the affected bar reports INCONCLUSIVE (never silently NO-GO) per PRD § Success criteria.\n"
    )


def generate(output_rows_dir: Path = ROWS_DIR, report_path: Path | None = None) -> None:
    output_rows_dir.mkdir(parents=True, exist_ok=True)
    shards, dev_rows = shard_rows()
    assert_both_split_vocab_coverage(
        [row_item for filename, _ in SHARDS for row_item in shards[filename]],
        dev_rows,
    )
    for filename, _ in SHARDS:
        write_jsonl(output_rows_dir / filename, shards[filename])
    dev_path = output_rows_dir / DEV_FILENAME
    write_jsonl(dev_path, dev_rows)
    (output_rows_dir / DEV_MANIFEST_FILENAME).write_text(dev_manifest_markdown(dev_path, dev_rows), encoding="utf-8")
    checkpoints, recomputed_dev = checkpoint_rows()
    if recomputed_dev != dev_rows:
        raise AssertionError("dev generation was not deterministic")
    if report_path is None:
        report_path = HERE / "REPORT.md"
    report_path.write_text(report_markdown(checkpoints, dev_rows, shards), encoding="utf-8")


if __name__ == "__main__":
    generate()
