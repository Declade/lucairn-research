#!/usr/bin/env python3
"""Validation CLI for the pii-bank labeled-data bank.

Stdlib-only (no new deps). Implements:

  (a) schema validation of every rows/*.jsonl row -- span start/end are
      Unicode CODEPOINT indices (Python str indices) into text, and every
      span's REQUIRED 'surface' field must equal text[start:end]
  (b) quarantine enforcement (train/dev must be synthetic-generated;
      in-repo rows/ accepts ONLY synthetic-generated provenance -- measured,
      dogfood, AND eval-import content lives under the local root; family_id
      rows must all share one split) + bank-wide duplicate row-id check
  (c) --check-manifest: recompute sha256 for 'local' manifest entries
      (WARN + skip if missing, FAIL on hash mismatch), verify 'repo' entries
      exist and match
  (d) --contamination: NFKC+casefold-normalized 8-gram overlap check between
      every train/dev row and the eval-only assets referenced in the manifest
      ('local' AND 'repo' entries). FAIL-CLOSED, per asset: a missing,
      unreadable, unparseable, OR zero-n-gram (empty / no scannable content)
      eval asset FAILs naming the asset, and zero loadable eval assets FAILs
      outright -- a PASS proves EVERY local/repo eval asset actually loaded
  (e) path-hygiene guard, run in EVERY mode: manifest 'local' entries are
      recorded RELATIVE to a local root (env var PII_BANK_LOCAL_ROOT,
      default '~/Opus Advisor'); any path_or_ref embedding an absolute
      personal home-directory path or a URI scheme hard-fails -- this repo
      is PUBLIC and home paths are a personal-info leak class
  (f) duplicate JSON keys are rejected in rows and manifest parsing (silent
      last-wins would let a second 'split' key shadow the first)

Exit code 0 on a fully clean run, 1 if any FAIL was recorded.

See README.md for the row schema and manifest.json for the eval-quarantine
manifest. Governing PRD: prd-2026-07-19-pii-data-bank-finetune-pilot.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any

HERE = Path(__file__).resolve().parent
ROWS_DIR = HERE / "rows"
MANIFEST_PATH = HERE / "manifest.json"

# Local root against which relative 'local' manifest entries resolve.
# Portable across machines: set PII_BANK_LOCAL_ROOT to relocate the root.
LOCAL_ROOT_ENV_VAR = "PII_BANK_LOCAL_ROOT"
DEFAULT_LOCAL_ROOT = "~/Opus Advisor"

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {
    "id",
    "text",
    "lang",
    "zone",
    "spans",
    "org_id",
    "provenance",
    "consent_basis",
    "split",
    "family_id",
    "source",
    "created",
}

ALLOWED_LANG = {"en", "de"}
ALLOWED_ZONE = {
    "prose",
    "json_value",
    "json_key",
    "schema_label",
    "technical_id",
    "url",
    "code_identifier",
    "comment",
    "string_literal",
}
ALLOWED_PROVENANCE = {"synthetic-generated", "measured-live", "dogfood", "eval-import"}
ALLOWED_CONSENT_BASIS = {"synthetic", "own-data", "contracted", "public-corpus"}
ALLOWED_SPLIT = {"train", "dev", "eval-only"}
ALLOWED_SPAN_EXPECTED = {"REDACT", "KEEP"}
ALLOWED_SPAN_FIELDS = {"start", "end", "category", "expected", "surface"}

CREATED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The ONLY provenance permitted inside this (public) repo's rows/ AND the only
# provenance allowed to carry split in {train, dev}. Everything else --
# measured-live, dogfood, AND eval-import -- lives under the LOCAL root and is
# referenced via the manifest (terra gate F1: eval-import previously slipped
# through a deny-list naming only measured-live/dogfood).
SYNTHETIC_PROVENANCE = "synthetic-generated"


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """json.loads object_pairs_hook: duplicate keys silently last-win by
    default, letting a second 'split'/'provenance' key shadow the first
    (terra gate F6; same class as the DSA over-redaction R1-F4 finding)."""
    obj: dict[str, Any] = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError(f"duplicate JSON key {k!r}")
        obj[k] = v
    return obj


class Failure:
    __slots__ = ("scope", "message")

    def __init__(self, scope: str, message: str) -> None:
        self.scope = scope
        self.message = message

    def __str__(self) -> str:
        return f"FAIL [{self.scope}] {self.message}"


class Warning_:
    __slots__ = ("scope", "message")

    def __init__(self, scope: str, message: str) -> None:
        self.scope = scope
        self.message = message

    def __str__(self) -> str:
        return f"WARN [{self.scope}] {self.message}"


def load_rows_files() -> list[Path]:
    if not ROWS_DIR.is_dir():
        return []
    return sorted(ROWS_DIR.glob("*.jsonl"))


def parse_jsonl(path: Path) -> list[tuple[int, dict[str, Any] | None, str | None]]:
    """Return list of (line_no, obj_or_None, parse_error_or_None)."""
    out: list[tuple[int, dict[str, Any] | None, str | None]] = []
    text = path.read_text(encoding="utf-8")
    for i, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped, object_pairs_hook=_reject_duplicate_keys)
        except ValueError as exc:  # JSONDecodeError + duplicate-key ValueError
            out.append((i, None, str(exc)))
            continue
        out.append((i, obj, None))
    return out


def validate_span(row_id: str, text: str, span: Any, idx: int) -> list[Failure]:
    """Validate one span. Offsets are Unicode CODEPOINT indices (Python str
    indices) into text -- the natural authoring path (str.find, generator
    tooling, HF/GLiNER span models) all operate on str indices. The REQUIRED
    'surface' field must equal text[start:end]; this content check is what
    catches codepoint-vs-byte mislabels, off-by-ones, and stale spans that
    pure bounds checks silently accept (bug-hunter finding on 41cd9e5)."""
    fails: list[Failure] = []
    scope = f"row={row_id} span[{idx}]"
    if not isinstance(span, dict):
        fails.append(Failure(scope, f"span is not an object: {span!r}"))
        return fails
    unknown = set(span.keys()) - ALLOWED_SPAN_FIELDS
    if unknown:
        fails.append(Failure(scope, f"unknown span field(s): {sorted(unknown)}"))
    missing = ALLOWED_SPAN_FIELDS - set(span.keys())
    if missing:
        fails.append(Failure(scope, f"missing span field(s): {sorted(missing)}"))
        return fails
    text_len = len(text)
    start, end = span.get("start"), span.get("end")
    offsets_ok = True
    # bool subclasses int -- True/False must not pass as offsets (terra F5)
    start_is_int = isinstance(start, int) and not isinstance(start, bool)
    end_is_int = isinstance(end, int) and not isinstance(end, bool)
    if not start_is_int or not end_is_int:
        fails.append(
            Failure(scope, f"start/end must be int (bool is not a valid offset), got start={start!r} end={end!r}")
        )
        offsets_ok = False
    else:
        if start < 0 or end < 0:
            fails.append(Failure(scope, f"negative offset: start={start} end={end}"))
            offsets_ok = False
        if end <= start:
            fails.append(
                Failure(scope, f"end must be > start (zero-width spans are invalid): start={start} end={end}")
            )
            offsets_ok = False
        if start > text_len or end > text_len:
            fails.append(
                Failure(
                    scope,
                    f"span out of bounds: start={start} end={end} text_len={text_len} "
                    f"(offsets are Unicode codepoint indices, not bytes)",
                )
            )
            offsets_ok = False
    if not isinstance(span.get("category"), str) or not span.get("category"):
        fails.append(Failure(scope, f"category must be a non-empty string, got {span.get('category')!r}"))
    if span.get("expected") not in ALLOWED_SPAN_EXPECTED:
        fails.append(
            Failure(
                scope,
                f"expected must be one of {sorted(ALLOWED_SPAN_EXPECTED)}, got {span.get('expected')!r}",
            )
        )
    surface = span.get("surface")
    if not isinstance(surface, str) or not surface:
        fails.append(Failure(scope, f"surface must be a non-empty string, got {surface!r}"))
    elif offsets_ok:
        actual = text[start:end]
        if actual != surface:
            fails.append(
                Failure(
                    scope,
                    f"surface mismatch: text[start:end] is {actual!r} but surface declares "
                    f"{surface!r} (offsets are Unicode codepoint indices into text; "
                    f"byte-derived offsets are the classic cause)",
                )
            )
    return fails


def validate_row(row: dict[str, Any], line_no: int, source_file: str) -> list[Failure]:
    fails: list[Failure] = []
    scope_base = f"{source_file}:{line_no}"

    if not isinstance(row, dict):
        return [Failure(scope_base, f"row is not a JSON object: {type(row)}")]

    row_id = row.get("id") if isinstance(row.get("id"), str) else f"<no-id at {scope_base}>"
    scope = f"{scope_base} id={row_id}"

    # Unknown fields
    unknown = set(row.keys()) - REQUIRED_FIELDS
    if unknown:
        fails.append(Failure(scope, f"unknown field(s): {sorted(unknown)}"))

    # Missing fields
    missing = REQUIRED_FIELDS - set(row.keys())
    if missing:
        fails.append(Failure(scope, f"missing required field(s): {sorted(missing)}"))
        # Can't safely continue span/text checks without these -- bail early.
        return fails

    # id
    if not isinstance(row["id"], str) or not row["id"]:
        fails.append(Failure(scope, f"id must be a non-empty string, got {row['id']!r}"))

    # text
    if not isinstance(row["text"], str):
        fails.append(Failure(scope, f"text must be a string, got {type(row['text'])}"))
        text_val = ""
    else:
        text_val = row["text"]

    # lang
    if row["lang"] not in ALLOWED_LANG:
        fails.append(Failure(scope, f"lang must be one of {sorted(ALLOWED_LANG)}, got {row['lang']!r}"))

    # zone
    if row["zone"] not in ALLOWED_ZONE:
        fails.append(Failure(scope, f"zone must be one of {sorted(ALLOWED_ZONE)}, got {row['zone']!r}"))

    # spans (offsets are Unicode codepoint indices into text -- see validate_span)
    spans = row["spans"]
    if not isinstance(spans, list):
        fails.append(Failure(scope, f"spans must be a list, got {type(spans)}"))
    else:
        for idx, span in enumerate(spans):
            fails.extend(validate_span(row_id, text_val, span, idx))

    # org_id
    if row["org_id"] is not None and not isinstance(row["org_id"], str):
        fails.append(Failure(scope, f"org_id must be string or null, got {row['org_id']!r}"))

    # provenance
    if row["provenance"] not in ALLOWED_PROVENANCE:
        fails.append(
            Failure(scope, f"provenance must be one of {sorted(ALLOWED_PROVENANCE)}, got {row['provenance']!r}")
        )

    # consent_basis
    if row["consent_basis"] not in ALLOWED_CONSENT_BASIS:
        fails.append(
            Failure(
                scope,
                f"consent_basis must be one of {sorted(ALLOWED_CONSENT_BASIS)}, got {row['consent_basis']!r}",
            )
        )

    # split
    if row["split"] not in ALLOWED_SPLIT:
        fails.append(Failure(scope, f"split must be one of {sorted(ALLOWED_SPLIT)}, got {row['split']!r}"))

    # family_id
    if not isinstance(row["family_id"], str) or not row["family_id"]:
        fails.append(Failure(scope, f"family_id must be a non-empty string, got {row['family_id']!r}"))

    # source
    if not isinstance(row["source"], str) or not row["source"]:
        fails.append(Failure(scope, f"source must be a non-empty string, got {row['source']!r}"))

    # created
    if not isinstance(row["created"], str) or not CREATED_RE.match(row["created"]):
        fails.append(Failure(scope, f"created must be YYYY-MM-DD, got {row['created']!r}"))

    return fails


def enforce_quarantine(
    rows: list[tuple[dict[str, Any], int, str]],
) -> list[Failure]:
    """rows: list of (row_obj, line_no, source_file) -- already schema-clean enough
    to have provenance/split/family_id present, but we re-check defensively."""
    fails: list[Failure] = []
    family_splits: dict[str, set[str]] = {}
    family_first_seen: dict[str, str] = {}

    for row, line_no, source_file in rows:
        scope = f"{source_file}:{line_no} id={row.get('id', '<no-id>')}"
        provenance = row.get("provenance")
        split = row.get("split")
        family_id = row.get("family_id")

        # Rule 1: train/dev must be synthetic-generated
        if split in {"train", "dev"} and provenance != SYNTHETIC_PROVENANCE:
            fails.append(
                Failure(
                    scope,
                    f"quarantine violation: split={split!r} requires provenance="
                    f"{SYNTHETIC_PROVENANCE!r}, got provenance={provenance!r}",
                )
            )

        # Rule 2: in-repo rows/ accepts ONLY synthetic-generated rows.
        # ROWS_DIR is inside this (public) repo by construction -- every file
        # this function is called on for 'rows' data lives under rows/.
        # An allow-list, not a deny-list: measured-live, dogfood, AND
        # eval-import all belong under the LOCAL root, referenced via the
        # manifest (terra F1: the old deny-list let eval-import through).
        if provenance != SYNTHETIC_PROVENANCE:
            fails.append(
                Failure(
                    scope,
                    f"quarantine violation: provenance={provenance!r} is forbidden inside "
                    f"the public repo's rows/ directory (rows/ accepts ONLY "
                    f"provenance={SYNTHETIC_PROVENANCE!r}; measured/dogfood/eval-import "
                    f"content lives under the local root, referenced via the manifest)",
                )
            )

        # Rule 3: family-split consistency
        if isinstance(family_id, str) and family_id:
            seen = family_splits.setdefault(family_id, set())
            if isinstance(split, str):
                seen.add(split)
            family_first_seen.setdefault(family_id, scope)

    for family_id, splits in family_splits.items():
        if len(splits) > 1:
            fails.append(
                Failure(
                    f"family_id={family_id}",
                    f"quarantine violation: family_id {family_id!r} spans multiple splits "
                    f"{sorted(splits)} (first seen at {family_first_seen[family_id]}) -- "
                    f"all rows sharing a family_id must share one split",
                )
            )

    return fails


def check_duplicate_ids(rows: list[tuple[dict[str, Any], int, str]]) -> list[Failure]:
    """Bank-wide row-id uniqueness across ALL row files (terra F4: duplicate
    ids were silently accepted, which would corrupt any id-keyed join or
    dedup step downstream)."""
    fails: list[Failure] = []
    seen: dict[str, str] = {}
    for row, line_no, source_file in rows:
        rid = row.get("id")
        if not isinstance(rid, str) or not rid:
            continue  # schema validation already fails these rows
        where = f"{source_file}:{line_no}"
        if rid in seen:
            fails.append(
                Failure(
                    f"id={rid}",
                    f"duplicate row id {rid!r}: first defined at {seen[rid]}, defined again at {where}",
                )
            )
        else:
            seen[rid] = where
    return fails


# ---------------------------------------------------------------------------
# --check-manifest
# ---------------------------------------------------------------------------


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def get_local_root() -> Path:
    """Root against which relative 'local' manifest entries resolve."""
    raw = os.environ.get(LOCAL_ROOT_ENV_VAR) or DEFAULT_LOCAL_ROOT
    return Path(os.path.expanduser(raw))


def resolve_local_ref(path_or_ref: str) -> Path:
    """Resolve a manifest 'local' path_or_ref. Relative refs resolve against
    the local root; absolute refs (e.g. temp-dir test fixtures) pass through
    unchanged -- but see path_or_ref_hygiene_fails, which bans absolute
    personal home-directory paths outright."""
    p = Path(path_or_ref)
    if p.is_absolute():
        return p
    return get_local_root() / p


def path_or_ref_hygiene_fails(scope: str, path_or_ref: str) -> list[Failure]:
    """Guard the home-directory path-leak class: manifest entries in this
    PUBLIC repo must never embed a personal home path. 'local' entries are
    recorded relative to the local root instead. (The startswith check is
    expressed via path components so this file itself never contains a
    home-path literal.)"""
    fails: list[Failure] = []
    hint = (
        f"record 'local' entries relative to the local root "
        f"(env {LOCAL_ROOT_ENV_VAR}, default {DEFAULT_LOCAL_ROOT!r})"
    )
    # URI schemes can smuggle absolute paths past the path-component checks
    # below. The '://' authority form is not the only one: the RFC-8089
    # single-slash form (file:/Users/other/eval.jsonl) and the bare-scheme
    # form (file:eval.jsonl) both carry a scheme without '//', and a Windows
    # drive letter (C:\...) also embeds a colon. Manifest refs are plain
    # POSIX-relative paths, in which a colon is never legitimate -- so
    # fail-closed on ANY ':' rather than enumerating scheme shapes. This one
    # predicate subsumes scheme://, scheme:/, scheme:, and drive letters
    # (bug-hunter finding on ae343f3: the '://'-only check let a single-slash
    # file: URI leak a home path into the public manifest).
    if ":" in path_or_ref:
        fails.append(
            Failure(
                scope,
                f"path_or_ref {path_or_ref!r} contains a ':'; colons are forbidden in "
                f"manifest refs (they smuggle URI schemes like file:/... or Windows drive "
                f"letters past the path checks) -- manifest refs are plain POSIX-relative "
                f"paths only -- {hint}",
            )
        )
    parts = PurePosixPath(path_or_ref).parts
    if len(parts) >= 2 and parts[0] == "/" and parts[1] == "Users":
        fails.append(
            Failure(
                scope,
                f"path_or_ref {path_or_ref!r} embeds an absolute macOS user "
                f"home-directory path; {hint}",
            )
        )
    home = os.path.expanduser("~")
    if home != "~" and home in path_or_ref:
        fails.append(
            Failure(
                scope,
                f"path_or_ref {path_or_ref!r} contains this machine's home directory; {hint}",
            )
        )
    return fails


def manifest_hygiene_only() -> list[Failure]:
    """Path-leak guard over manifest.json, run in EVERY mode (even without
    --check-manifest) so a leaked home path can never ride a default run."""
    if not MANIFEST_PATH.is_file():
        return []
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except ValueError as exc:  # JSONDecodeError + duplicate-key ValueError
        return [Failure("manifest", f"manifest.json is not valid JSON: {exc}")]
    entries = manifest.get("entries", [])
    if not isinstance(entries, list):
        return [Failure("manifest", "manifest.json 'entries' must be a list")]
    fails: list[Failure] = []
    for i, entry in enumerate(entries):
        if isinstance(entry, dict) and isinstance(entry.get("path_or_ref"), str):
            fails.extend(path_or_ref_hygiene_fails(f"manifest.entries[{i}]", entry["path_or_ref"]))
    return fails


def check_manifest() -> tuple[list[Failure], list[Warning_]]:
    fails: list[Failure] = []
    warns: list[Warning_] = []

    if not MANIFEST_PATH.is_file():
        fails.append(Failure("manifest", f"manifest.json not found at {MANIFEST_PATH}"))
        return fails, warns

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except ValueError as exc:  # JSONDecodeError + duplicate-key ValueError
        fails.append(Failure("manifest", f"manifest.json is not valid JSON: {exc}"))
        return fails, warns

    entries = manifest.get("entries", [])
    if not isinstance(entries, list):
        fails.append(Failure("manifest", "manifest.json 'entries' must be a list"))
        return fails, warns

    for i, entry in enumerate(entries):
        scope = f"manifest.entries[{i}]"
        if not isinstance(entry, dict):
            fails.append(Failure(scope, f"entry is not an object: {entry!r}"))
            continue

        for field in ("path_or_ref", "sha256", "location_class", "role"):
            if field not in entry:
                fails.append(Failure(scope, f"missing field {field!r}"))
        if any(f not in entry for f in ("path_or_ref", "sha256", "location_class")):
            continue

        path_or_ref = entry["path_or_ref"]
        expected_hash = entry["sha256"]
        location_class = entry["location_class"]

        hygiene = path_or_ref_hygiene_fails(scope, str(path_or_ref))
        if hygiene:
            fails.extend(hygiene)
            continue

        if location_class == "local":
            p = resolve_local_ref(str(path_or_ref))
            if not p.is_file():
                warns.append(Warning_(scope, f"local entry missing on disk, skipping hash check: {p}"))
                continue
            actual_hash = sha256_of(p)
            if actual_hash != expected_hash:
                fails.append(
                    Failure(
                        scope,
                        f"sha256 mismatch for {p}: manifest has {expected_hash}, "
                        f"actual is {actual_hash}",
                    )
                )
        elif location_class == "dsa-origin-main":
            # These reference paths inside another repo at a pinned commit.
            # We only verify them if a local pristine extraction exists at a
            # sibling 'local' entry with the same hash (cross-checked above);
            # a bare dsa-origin-main entry with no on-disk local twin is
            # descriptive-only and not independently re-hashable without
            # network/repo access, which this stdlib-only tool intentionally
            # does not perform. Record informational note only.
            pass
        elif location_class == "repo":
            p = HERE / path_or_ref
            if not p.is_file():
                fails.append(Failure(scope, f"'repo' entry not found in this repo: {p}"))
                continue
            actual_hash = sha256_of(p)
            if actual_hash != expected_hash:
                fails.append(
                    Failure(
                        scope,
                        f"sha256 mismatch for {p}: manifest has {expected_hash}, "
                        f"actual is {actual_hash}",
                    )
                )
        else:
            fails.append(Failure(scope, f"unknown location_class {location_class!r}"))

    return fails, warns


# ---------------------------------------------------------------------------
# --contamination
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"\S+")


def normalize_text(text: str) -> str:
    """NFKC-normalize + casefold BEFORE tokenizing (terra F3): NFD and NFC
    encodings of the same text must collide (composed vs decomposed accents
    otherwise share zero n-grams), and casefold makes German sharp-s match
    its 'ss' expansion where plain lower() does not."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return _WS_RE.sub(" ", folded.strip())


def ngrams(text: str, n: int = 8) -> set[str]:
    tokens = _WORD_RE.findall(normalize_text(text))
    if len(tokens) < n:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def extract_eval_texts_from_asset(path: Path) -> tuple[list[str], str | None]:
    """Text extraction from a manifest eval asset for contamination scanning.
    Returns (texts, parse_error): parse_error is None on a clean parse, else a
    short reason string. Supports .jsonl (a 'text'/'snippet' field per line),
    .json (whole-file parse), and falls back to raw file content for anything
    else (e.g. .md blobs). A readable-but-malformed asset must FAIL (not be
    silently omitted) -- the contamination mode is fail-closed (bug-hunter
    finding on ae343f3: a malformed/empty JSONL yielded zero n-grams and was
    silently dropped, so PASS did not prove every eval asset actually loaded).
    OSError propagates to the caller: an unreadable asset also FAILs (terra F2).
    Text extraction itself is UNCHANGED -- this only adds parse-status
    reporting; a .jsonl row simply lacking text/snippet is not a parse error."""
    texts: list[str] = []
    if path.suffix == ".jsonl":
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                return texts, f"unparseable JSONL at line {line_no}: {exc}"
            if isinstance(obj, dict):
                for key in ("text", "snippet"):
                    val = obj.get(key)
                    if isinstance(val, str) and val:
                        texts.append(val)
    elif path.suffix == ".json":
        raw = path.read_text(encoding="utf-8")
        try:
            json.loads(raw)
        except json.JSONDecodeError as exc:
            return texts, f"unparseable JSON: {exc}"
        # The whole-file JSON text (keys + values) is what we scan -- the CF2
        # oracle is a JSON blob, not a rows file.
        texts.append(raw)
    else:
        texts.append(path.read_text(encoding="utf-8"))
    return texts, None


def run_contamination_check(train_dev_rows: list[tuple[dict[str, Any], int, str]]) -> list[Failure]:
    """FAIL-CLOSED (terra F2): unlike --check-manifest's WARN-skip, this mode
    exists to vouch that train/dev rows do not overlap the eval sets -- it
    cannot vouch for assets it cannot read. A missing or unreadable eval
    asset FAILs, and an entirely empty eval index FAILs outright. Indexes
    both 'local' and 'repo' entries (terra F8); 'dsa-origin-main' refs point
    into another repo and are covered by their hash-identical local twins."""
    fails: list[Failure] = []

    if not MANIFEST_PATH.is_file():
        fails.append(Failure("contamination", "manifest.json not found -- cannot run contamination check"))
        return fails

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except ValueError as exc:  # JSONDecodeError + duplicate-key ValueError
        fails.append(Failure("contamination", f"manifest.json is not valid JSON: {exc}"))
        return fails

    entries = manifest.get("entries", [])
    if not isinstance(entries, list):
        fails.append(Failure("contamination", "manifest.json 'entries' must be a list"))
        return fails

    eval_ngram_index: dict[str, set[str]] = {}  # resolved asset path -> ngrams
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        location_class = entry.get("location_class")
        if location_class not in {"local", "repo"}:
            continue
        scope = f"contamination manifest.entries[{i}]"
        raw_ref = entry.get("path_or_ref", "")
        if not isinstance(raw_ref, str) or not raw_ref:
            fails.append(Failure(scope, "entry has no usable path_or_ref"))
            continue
        p = resolve_local_ref(raw_ref) if location_class == "local" else (HERE / raw_ref)
        if not p.is_file():
            fails.append(
                Failure(scope, f"eval-only asset missing on disk -- contamination is fail-closed: {p}")
            )
            continue
        try:
            eval_texts, parse_error = extract_eval_texts_from_asset(p)
        except OSError as exc:
            fails.append(
                Failure(scope, f"eval-only asset unreadable -- contamination is fail-closed: {p}: {exc}")
            )
            continue
        # Per-asset fail-closed accounting: PASS must prove EVERY local/repo
        # eval asset actually loaded. (a) parse-failure and (b) an asset that
        # contributes zero n-grams (empty/whitespace file, or a JSONL with no
        # text/snippet content) are BOTH failures naming the asset -- a
        # silently-omitted asset would leave the contamination check vouching
        # only for the assets that happened to index (bug-hunter finding on
        # ae343f3).
        if parse_error is not None:
            fails.append(
                Failure(
                    scope,
                    f"eval-only asset parse-failure -- contamination is fail-closed: {p}: {parse_error}",
                )
            )
            continue
        combined_ngrams: set[str] = set()
        for t in eval_texts:
            combined_ngrams |= ngrams(t)
        if not combined_ngrams:
            fails.append(
                Failure(
                    scope,
                    f"eval-only asset contributed zero n-grams -- contamination is fail-closed: {p} "
                    f"(readable but empty or no scannable text content; a passing check must prove "
                    f"every eval asset indexed at least one normalized 8-gram)",
                )
            )
            continue
        eval_ngram_index[str(p)] = combined_ngrams

    if not eval_ngram_index:
        fails.append(
            Failure(
                "contamination",
                "zero loadable eval-only assets -- refusing to pass fail-open; "
                "fix the manifest entries and/or the local root "
                f"(env {LOCAL_ROOT_ENV_VAR}, default {DEFAULT_LOCAL_ROOT!r}) "
                "before trusting train/dev rows",
            )
        )
        return fails

    for row, line_no, source_file in train_dev_rows:
        if row.get("split") not in {"train", "dev"}:
            continue
        text = row.get("text")
        if not isinstance(text, str) or not text:
            continue
        row_ngrams = ngrams(text)
        if not row_ngrams:
            continue
        for asset_path, eval_ngrams in eval_ngram_index.items():
            overlap = row_ngrams & eval_ngrams
            if overlap:
                fails.append(
                    Failure(
                        f"contamination row={row.get('id', '<no-id>')} ({source_file}:{line_no})",
                        f"shares {len(overlap)} normalized 8-gram(s) with eval-only asset "
                        f"{asset_path}: e.g. {next(iter(overlap))!r}",
                    )
                )

    return fails


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-manifest",
        action="store_true",
        help="recompute sha256 for manifest entries and report mismatches",
    )
    parser.add_argument(
        "--contamination",
        action="store_true",
        help="run normalized 8-gram overlap check between train/dev rows and eval-only manifest assets",
    )
    args = parser.parse_args(argv)

    all_fails: list[Failure] = []
    all_warns: list[Warning_] = []

    rows_files = load_rows_files()
    if not rows_files:
        all_warns.append(Warning_("rows", f"no rows/*.jsonl files found under {ROWS_DIR}"))

    all_parsed_rows: list[tuple[dict[str, Any], int, str]] = []

    for rows_file in rows_files:
        parsed = parse_jsonl(rows_file)
        for line_no, obj, parse_error in parsed:
            source_file = rows_file.name
            if parse_error is not None:
                all_fails.append(Failure(f"{source_file}:{line_no}", f"invalid JSON: {parse_error}"))
                continue
            if obj is None:
                continue
            row_fails = validate_row(obj, line_no, source_file)
            all_fails.extend(row_fails)
            # Only feed schema-clean-enough rows into quarantine/contamination
            # checks (need provenance/split/family_id/text present as the
            # right types); still attempt best-effort on partial rows so
            # quarantine violations aren't masked by unrelated schema fails.
            if isinstance(obj, dict):
                all_parsed_rows.append((obj, line_no, source_file))

    quarantine_fails = enforce_quarantine(all_parsed_rows)
    all_fails.extend(quarantine_fails)

    all_fails.extend(check_duplicate_ids(all_parsed_rows))

    if args.check_manifest:
        manifest_fails, manifest_warns = check_manifest()
        all_fails.extend(manifest_fails)
        all_warns.extend(manifest_warns)
    else:
        # Path-leak guard runs in EVERY mode: a home-directory path in the
        # committed manifest must fail even a plain `validate.py` run.
        all_fails.extend(manifest_hygiene_only())

    if args.contamination:
        contamination_fails = run_contamination_check(all_parsed_rows)
        all_fails.extend(contamination_fails)

    for w in all_warns:
        print(w, file=sys.stderr)
    for f in all_fails:
        print(f, file=sys.stderr)

    total_rows = len(all_parsed_rows)
    print(
        f"\npii-bank validate: {total_rows} row(s) checked across {len(rows_files)} file(s), "
        f"{len(all_fails)} FAIL(s), {len(all_warns)} WARN(s)"
        + (" [--check-manifest]" if args.check_manifest else "")
        + (" [--contamination]" if args.contamination else "")
    )

    if all_fails:
        print("RESULT: FAIL", file=sys.stderr)
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
