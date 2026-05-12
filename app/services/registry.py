"""Resolve the active ASR model directory and validate `registry/models.yaml`.

Implements the design decision "Resolve the active model via MODEL_DIR override and
MODEL_NAME registry lookup" plus the spec requirements for the v2 registry schema:

- Required fields: `repo_id`, `format` (only `"ct2"`), `compute_type`, `local_dir`,
  `size`, `languages`, `description`.
- Optional fields: `subfolder`, `revision`, `default`.
- Exactly one entry SHALL set `default: true`.
"""

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


HARDCODED_FALLBACK_MODEL_NAME = "breeze-asr-25"
DEFAULT_MODELS_ROOT = Path("models")
DEFAULT_REGISTRY_PATH = Path("registry/models.yaml")
ACCEPTED_FORMAT = "ct2"

REQUIRED_ENTRY_FIELDS = (
    "repo_id",
    "format",
    "compute_type",
    "local_dir",
    "size",
    "languages",
    "description",
)


class RegistryError(RuntimeError):
    """Raised when `registry/models.yaml` is missing required fields, has the wrong
    format discriminator, or violates the exactly-one-default invariant."""


def load_registry(path: Path | str | None = None) -> dict[str, dict[str, Any]]:
    """Read and validate the registry. Returns the {name: entry} mapping."""
    p = Path(path) if path else DEFAULT_REGISTRY_PATH
    if not p.exists():
        raise RegistryError(f"Registry file not found: {p}")
    try:
        with p.open() as f:
            data = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        raise RegistryError(f"Malformed YAML in {p}: {e}") from e

    if not isinstance(data, dict) or "models" not in data:
        raise RegistryError(
            f"Registry must contain a top-level 'models:' mapping (got {type(data).__name__})"
        )
    entries = data["models"]
    if not isinstance(entries, dict) or not entries:
        raise RegistryError("Registry 'models:' must be a non-empty mapping")

    defaults: list[str] = []
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            raise RegistryError(f"Entry '{name}' must be a mapping")
        missing = [f for f in REQUIRED_ENTRY_FIELDS if f not in entry]
        if missing:
            raise RegistryError(
                f"Entry '{name}' is missing required field(s): {', '.join(missing)}"
            )
        if entry["format"] != ACCEPTED_FORMAT:
            raise RegistryError(
                f"Entry '{name}' has format='{entry['format']}'; only 'ct2' is accepted in v2"
            )
        if entry.get("default") is True:
            defaults.append(name)

    if len(defaults) == 0:
        raise RegistryError(
            "Registry has no default entry — exactly one entry SHALL set `default: true`"
        )
    if len(defaults) > 1:
        raise RegistryError(
            f"Registry has multiple default entries ({', '.join(defaults)}); "
            "exactly one entry SHALL set `default: true`"
        )

    return entries


def default_model_name(path: Path | str | None = None) -> str:
    """Return the name of the entry flagged `default: true`."""
    entries = load_registry(path)
    for name, entry in entries.items():
        if entry.get("default") is True:
            return name
    # load_registry would have raised already, but appease mypy.
    raise RegistryError("No default entry found")  # pragma: no cover


def resolve_model_dir(model_name: str | None, model_dir_override: str | None) -> str:
    """Resolve the on-disk CT2 model directory to load at startup.

    Precedence:
        1. `MODEL_DIR` env override (verbatim).
        2. `MODEL_NAME` registry lookup → `./models/<entry.local_dir>` (silently
           falls back to `./models/<MODEL_NAME>` if the registry can't be parsed).
        3. Hard-coded `./models/breeze-asr-25` fallback when MODEL_NAME is unset.
    """
    if model_dir_override:
        return model_dir_override
    name = model_name or HARDCODED_FALLBACK_MODEL_NAME

    try:
        entries = load_registry()
        entry = entries.get(name)
        if entry and "local_dir" in entry:
            return str(DEFAULT_MODELS_ROOT / entry["local_dir"])
    except RegistryError as e:
        logger.warning("Falling back to ./models/%s — %s", name, e)

    return str(DEFAULT_MODELS_ROOT / name)
