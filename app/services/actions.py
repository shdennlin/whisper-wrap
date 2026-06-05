"""Prompt-action template registry loader.

Loads named prompt templates from `registry/actions.yaml`. Each template carries
an `id`, a `label`/`labels` pair, an optional `category`/`category_labels` pair,
and a `template` string containing the literal placeholder `{transcript}`. The
PWA fetches these via `GET /actions` and substitutes the placeholder
client-side before POSTing the wrapped prompt to `/ask`.

`label` accepts either a single string (shorthand for `{en: <string>}`) or a
mapping of locale code → display string. The loader normalizes both forms into
a non-empty `labels: Mapping[str, str]` plus a legacy `label: str` (set to
`labels["en"]` when present, else the first inserted value in the mapping).

`category` is optional. It accepts either:
  - a string (the category id, e.g. `cleanup`), OR
  - a mapping `{id: <str>, labels: {<locale>: <str>, ...}}` carrying its own
    bilingual display labels.

The top-level `categories:` block declares display order and bilingual labels
for category groupings. It is optional; when absent the API returns an empty
list and the frontend renders all chips under a single "Misc" heading.

Validation contract (per openspec/specs/prompt-actions/spec.md):
  - Missing file → log a WARNING, return an empty list. Server SHALL still start.
  - Malformed YAML → log a WARNING, return an empty list. Server SHALL still start.
  - Duplicate `id`, missing `{transcript}` placeholder, missing required field,
    empty label mapping, non-string mapping value, label that is neither a
    string nor a mapping, invalid `category` shape, or duplicate `categories.id`
    → raise `ActionRegistryError`. Server SHALL refuse to start so the operator
    notices.
  - Unknown locale keys in a label mapping are silently passed through
    (forward-compat clause).
  - Action whose `category` id is not in the top-level `categories:` block →
    log a WARNING, still load. The frontend renders the chip under "Misc".
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

DEFAULT_REGISTRY_PATH = Path("registry/actions.yaml")
TRANSCRIPT_PLACEHOLDER = "{transcript}"
DEFAULT_LOCALE = "en"
_REQUIRED_FIELDS = ("id", "label", "template")


class ActionRegistryError(RuntimeError):
    """Configuration error in `registry/actions.yaml` — server SHALL refuse to start."""


@dataclass(frozen=True)
class ActionTemplate:
    id: str
    label: str
    template: str
    labels: Mapping[str, str] = field(default_factory=dict)
    category: str | None = None
    category_labels: Mapping[str, str] | None = None
    description: str | None = None
    description_labels: Mapping[str, str] | None = None


@dataclass(frozen=True)
class CategoryDefinition:
    id: str
    label: str
    labels: Mapping[str, str]


def _normalize_locale_mapping(raw: object, error_owner: str) -> dict[str, str]:
    """Shared locale→string validator used by labels and category labels.

    `error_owner` is a human-readable noun phrase like `action 'foo' label`
    that gets prefixed onto the raised ActionRegistryError message.
    """
    if not isinstance(raw, Mapping):
        raise ActionRegistryError(
            f"{error_owner} must be a string or mapping (got {type(raw).__name__})"
        )
    if not raw:
        raise ActionRegistryError(
            f"{error_owner} is an empty mapping; provide at least one locale entry"
        )
    normalized: dict[str, str] = {}
    for locale_key, value in raw.items():
        if not isinstance(locale_key, str):
            raise ActionRegistryError(
                f"{error_owner} has non-string locale key {locale_key!r}"
            )
        if not isinstance(value, str):
            raise ActionRegistryError(
                f"{error_owner} value for locale {locale_key!r} is not a string "
                f"(got {type(value).__name__})"
            )
        if not value:
            raise ActionRegistryError(
                f"{error_owner} value for locale {locale_key!r} is empty"
            )
        normalized[locale_key] = value
    return normalized


def _normalize_label(raw: object, action_id: str) -> dict[str, str]:
    """Normalize a YAML action `label` value into a non-empty `{locale: text}` mapping."""
    if isinstance(raw, str):
        if not raw:
            raise ActionRegistryError(f"action {action_id!r} has an empty label string")
        return {DEFAULT_LOCALE: raw}
    return _normalize_locale_mapping(raw, f"action {action_id!r} label")


def _normalize_description(raw: object, action_id: str) -> dict[str, str]:
    """Normalize a YAML action `description` value.

    Same rules as `label`: string shorthand → `{DEFAULT_LOCALE: <string>}`;
    mapping → validated as a non-empty locale mapping. Empty string and other
    invalid shapes raise — but the field is OPTIONAL, so the caller skips
    this entirely when `description` is absent or `None`.
    """
    if isinstance(raw, str):
        if not raw:
            raise ActionRegistryError(
                f"action {action_id!r} has an empty description string"
            )
        return {DEFAULT_LOCALE: raw}
    return _normalize_locale_mapping(raw, f"action {action_id!r} description")


def _normalize_category(
    raw: object, action_id: str
) -> tuple[str, dict[str, str] | None]:
    """Normalize an action `category` field into `(id, labels_or_None)`.

    String shorthand → `(string, None)`. Mapping with `id` + `labels` → both
    populated. Any other shape raises `ActionRegistryError`.
    """
    if isinstance(raw, str):
        if not raw:
            raise ActionRegistryError(
                f"action {action_id!r} has an empty category string"
            )
        return raw, None
    if isinstance(raw, Mapping):
        cat_id = raw.get("id")
        if not isinstance(cat_id, str) or not cat_id:
            raise ActionRegistryError(
                f"action {action_id!r} category mapping is missing a "
                f"non-empty string `id` field"
            )
        if "labels" not in raw:
            raise ActionRegistryError(
                f"action {action_id!r} category mapping is missing a `labels` field"
            )
        cat_labels = _normalize_locale_mapping(
            raw["labels"],
            f"action {action_id!r} category {cat_id!r} labels",
        )
        return cat_id, cat_labels
    raise ActionRegistryError(
        f"action {action_id!r} category must be a string or mapping "
        f"(got {type(raw).__name__})"
    )


def _normalize_category_definition_label(raw: object, cat_id: str) -> dict[str, str]:
    """Normalize a top-level category `label` (same rules as action label)."""
    if isinstance(raw, str):
        if not raw:
            raise ActionRegistryError(f"category {cat_id!r} has an empty label string")
        return {DEFAULT_LOCALE: raw}
    return _normalize_locale_mapping(raw, f"category {cat_id!r} label")


def _legacy_label(labels: Mapping[str, str]) -> str:
    """Pick the back-compat single-string label: en if present, else first inserted."""
    if DEFAULT_LOCALE in labels:
        return labels[DEFAULT_LOCALE]
    return next(iter(labels.values()))


def _load_yaml_root(path: Path) -> dict | None:
    """Shared YAML reader: returns the root mapping, or None on file-not-found
    / parse-error / non-mapping root (all of which downstream loaders treat as
    "no data, warn and return []")."""
    if not path.is_file():
        return None
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        return None
    if not isinstance(raw, dict):
        return None
    return raw


def load_categories(path: Path) -> list[CategoryDefinition]:
    """Load the top-level `categories:` block. Absent/empty block → []."""
    raw = _load_yaml_root(path)
    if raw is None:
        return []

    entries = raw.get("categories")
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ActionRegistryError(
            f"{path}: top-level 'categories' must be a list, "
            f"got {type(entries).__name__}"
        )

    seen_ids: set[str] = set()
    result: list[CategoryDefinition] = []
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ActionRegistryError(
                f"{path}: category #{idx} is not a mapping (got {type(entry).__name__})"
            )
        cat_id = entry.get("id")
        if not isinstance(cat_id, str) or not cat_id:
            raise ActionRegistryError(
                f"{path}: category #{idx} is missing a non-empty string `id`"
            )
        if cat_id in seen_ids:
            raise ActionRegistryError(f"{path}: duplicate category id {cat_id!r}")
        seen_ids.add(cat_id)

        if "label" not in entry:
            raise ActionRegistryError(
                f"{path}: category {cat_id!r} is missing required field `label`"
            )
        labels = _normalize_category_definition_label(entry["label"], cat_id)
        result.append(
            CategoryDefinition(
                id=cat_id,
                label=_legacy_label(labels),
                labels=labels,
            )
        )

    return result


def load_actions(path: Path) -> list[ActionTemplate]:
    if not path.is_file():
        logger.warning(
            "prompt-actions: registry not found at %s; serving empty actions list", path
        )
        return []

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        logger.warning(
            "prompt-actions: failed to parse %s (%s); serving empty actions list",
            path,
            e,
        )
        return []

    if not isinstance(raw, dict):
        logger.warning(
            "prompt-actions: %s is not a mapping; serving empty actions list", path
        )
        return []

    entries = raw.get("actions", [])
    if not isinstance(entries, list):
        raise ActionRegistryError(
            f"{path}: top-level 'actions' must be a list, got {type(entries).__name__}"
        )

    known_category_ids = {c.id for c in load_categories(path)}

    seen_ids: set[str] = set()
    result: list[ActionTemplate] = []
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ActionRegistryError(
                f"{path}: entry #{idx} is not a mapping (got {type(entry).__name__})"
            )

        missing = [
            f for f in _REQUIRED_FIELDS if f not in entry or entry[f] in (None, "")
        ]
        if missing:
            entry_id = entry.get("id", f"#{idx}")
            raise ActionRegistryError(
                f"{path}: action {entry_id!r} is missing required field(s): {', '.join(missing)}"
            )

        action_id = str(entry["id"])
        if action_id in seen_ids:
            raise ActionRegistryError(f"{path}: duplicate action id {action_id!r}")
        seen_ids.add(action_id)

        labels = _normalize_label(entry["label"], action_id)

        template = str(entry["template"])
        if TRANSCRIPT_PLACEHOLDER not in template:
            raise ActionRegistryError(
                f"{path}: action {action_id!r} template is missing the "
                f"{TRANSCRIPT_PLACEHOLDER} placeholder"
            )

        category: str | None = None
        category_labels: Mapping[str, str] | None = None
        if "category" in entry and entry["category"] is not None:
            category, category_labels = _normalize_category(
                entry["category"], action_id
            )
            if known_category_ids and category not in known_category_ids:
                logger.warning(
                    "prompt-actions: action %r references unknown category %r "
                    "(not declared in top-level `categories:` block)",
                    action_id,
                    category,
                )

        description: str | None = None
        description_labels: Mapping[str, str] | None = None
        if "description" in entry and entry["description"] is not None:
            description_labels = _normalize_description(entry["description"], action_id)
            description = _legacy_label(description_labels)

        result.append(
            ActionTemplate(
                id=action_id,
                label=_legacy_label(labels),
                labels=labels,
                template=template,
                category=category,
                category_labels=category_labels,
                description=description,
                description_labels=description_labels,
            )
        )

    return result
