"""Prompt-action template registry loader.

Loads named prompt templates from `registry/actions.yaml`. Each template carries
an `id`, a UTF-8 `label`, and a `template` string containing the literal
placeholder `{transcript}`. The PWA fetches these via `GET /actions` and
substitutes the placeholder client-side before POSTing the wrapped prompt
to `/ask`.

Validation contract (per openspec/specs/prompt-actions/spec.md):
  - Missing file → log a WARNING, return an empty list. Server SHALL still start.
  - Malformed YAML → log a WARNING, return an empty list. Server SHALL still start.
  - Duplicate `id`, missing `{transcript}` placeholder, or missing required field
    → raise `ActionRegistryError`. Server SHALL refuse to start so the operator
    notices.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

DEFAULT_REGISTRY_PATH = Path("registry/actions.yaml")
TRANSCRIPT_PLACEHOLDER = "{transcript}"
_REQUIRED_FIELDS = ("id", "label", "template")


class ActionRegistryError(RuntimeError):
    """Configuration error in `registry/actions.yaml` — server SHALL refuse to start."""


@dataclass(frozen=True)
class ActionTemplate:
    id: str
    label: str
    template: str


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

    seen_ids: set[str] = set()
    result: list[ActionTemplate] = []
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ActionRegistryError(
                f"{path}: entry #{idx} is not a mapping (got {type(entry).__name__})"
            )

        missing = [f for f in _REQUIRED_FIELDS if f not in entry or entry[f] in (None, "")]
        if missing:
            entry_id = entry.get("id", f"#{idx}")
            raise ActionRegistryError(
                f"{path}: action {entry_id!r} is missing required field(s): {', '.join(missing)}"
            )

        action_id = str(entry["id"])
        if action_id in seen_ids:
            raise ActionRegistryError(
                f"{path}: duplicate action id {action_id!r}"
            )
        seen_ids.add(action_id)

        template = str(entry["template"])
        if TRANSCRIPT_PLACEHOLDER not in template:
            raise ActionRegistryError(
                f"{path}: action {action_id!r} template is missing the "
                f"{TRANSCRIPT_PLACEHOLDER} placeholder"
            )

        result.append(
            ActionTemplate(
                id=action_id,
                label=str(entry["label"]),
                template=template,
            )
        )

    return result
