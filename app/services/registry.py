"""Resolve the active ASR model variant and validate `registry/models.yaml`.

v2.1 schema: each model entry has a `variants` list. Each variant declares a
`format` discriminator (`ct2` or `ggml`), format-specific fields, and optional
`default_on` per-platform routing hints.

Top-level entry fields (required):
  - `description` (string)
  - `languages` (list of strings)
  - `variants` (non-empty list of variant maps)

Top-level entry fields (optional):
  - `size` (string, applies to model as a whole)
  - `default` (bool, exactly one entry across the registry SHALL set this to true)

Variant fields (required for every variant):
  - `format` (string, one of `"ct2"` or `"ggml"`)
  - `local_dir` (string, path relative to `./models/`)

Variant fields (ct2-specific):
  - `compute_type` (string, required)

Variant fields (ggml-specific):
  - `quant` (string, required)
  - `filename` (string, required — ggml `.bin` inside `local_dir`)
  - `coreml_encoder` (string, required — `.mlmodelc` directory inside `local_dir`)

Variant fields (optional, any format):
  - `repo_id`, `subfolder`, `revision`, `default_on`
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


HARDCODED_FALLBACK_MODEL_NAME = "breeze-asr-25"
DEFAULT_MODELS_ROOT = Path("models")
DEFAULT_REGISTRY_PATH = Path("registry/models.yaml")
ACCEPTED_FORMATS: tuple[str, ...] = ("ct2", "ggml")
PLATFORM_TAGS: tuple[str, ...] = ("darwin", "linux")

REQUIRED_ENTRY_FIELDS: tuple[str, ...] = ("description", "languages", "variants")
REQUIRED_VARIANT_FIELDS: tuple[str, ...] = ("format", "local_dir")
REQUIRED_CT2_FIELDS: tuple[str, ...] = ("compute_type",)
REQUIRED_GGML_FIELDS: tuple[str, ...] = ("quant", "filename", "coreml_encoder")


class RegistryError(RuntimeError):
    """Raised when `registry/models.yaml` is malformed, has an unsupported variant
    format, violates the exactly-one-default invariant, or platform variant
    resolution finds no match."""


def load_registry(path: Path | str | None = None) -> dict[str, dict[str, Any]]:
    """Read and validate the variants-schema registry. Returns {name: entry}."""
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
        _validate_entry(name, entry)
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


def _validate_entry(name: str, entry: dict[str, Any]) -> None:
    missing = [f for f in REQUIRED_ENTRY_FIELDS if f not in entry]
    if missing:
        raise RegistryError(
            f"Entry '{name}' is missing required field(s): {', '.join(missing)}"
        )
    variants = entry["variants"]
    if not isinstance(variants, list):
        raise RegistryError(f"Entry '{name}' field `variants` SHALL be a list")
    if len(variants) == 0:
        raise RegistryError(
            f"Entry '{name}' SHALL declare at least one variant (got empty list)"
        )
    for idx, variant in enumerate(variants):
        if not isinstance(variant, dict):
            raise RegistryError(f"Entry '{name}' variant #{idx} must be a mapping")
        _validate_variant(name, idx, variant)


def _validate_variant(entry_name: str, idx: int, variant: dict[str, Any]) -> None:
    missing = [f for f in REQUIRED_VARIANT_FIELDS if f not in variant]
    if missing:
        raise RegistryError(
            f"Entry '{entry_name}' variant #{idx} is missing required field(s): "
            f"{', '.join(missing)}"
        )
    fmt = variant["format"]
    if fmt not in ACCEPTED_FORMATS:
        raise RegistryError(
            f"Entry '{entry_name}' variant #{idx} has format={fmt!r}; "
            f"accepted values: {', '.join(ACCEPTED_FORMATS)}"
        )
    fmt_required = REQUIRED_CT2_FIELDS if fmt == "ct2" else REQUIRED_GGML_FIELDS
    fmt_missing = [f for f in fmt_required if f not in variant]
    if fmt_missing:
        raise RegistryError(
            f"Entry '{entry_name}' variant #{idx} (format={fmt}) is missing "
            f"required field(s): {', '.join(fmt_missing)}"
        )


def default_model_name(path: Path | str | None = None) -> str:
    """Return the name of the entry flagged `default: true`."""
    entries = load_registry(path)
    for name, entry in entries.items():
        if entry.get("default") is True:
            return name
    raise RegistryError("No default entry found")  # pragma: no cover


def resolve_variant(
    entry: dict[str, Any],
    *,
    platform: str,
    backend_format: str | None,
) -> dict[str, Any]:
    """Pick the variant of `entry` that matches the current platform / override.

    Precedence:
      1. `backend_format` argument (from `BACKEND_FORMAT` env var) — choose the
         first variant with that `format`. Fail if no variant matches.
      2. Otherwise, choose the first variant whose `default_on` list contains
         `platform`. Fail if no variant matches.

    Raises `RegistryError` when resolution finds zero matching variants.
    """
    variants = entry["variants"]

    if backend_format is not None:
        if backend_format not in ACCEPTED_FORMATS:
            raise RegistryError(
                f"BACKEND_FORMAT={backend_format!r} is not one of "
                f"{', '.join(ACCEPTED_FORMATS)}"
            )
        if backend_format == "ggml" and platform != "darwin":
            raise RegistryError(
                f"BACKEND_FORMAT=ggml is not available on {platform}; "
                "pywhispercpp ships only on darwin. Set BACKEND_FORMAT=ct2 or "
                "leave it unset."
            )
        matching = [v for v in variants if v["format"] == backend_format]
        if not matching:
            raise RegistryError(
                f"BACKEND_FORMAT={backend_format!r} requested but the active "
                f"model has no variant with that format"
            )
        return matching[0]

    matching = [v for v in variants if platform in v.get("default_on", [])]
    if not matching:
        raise RegistryError(
            f"No variant of the active model targets platform={platform!r}. "
            f"Set BACKEND_FORMAT=<{'|'.join(ACCEPTED_FORMATS)}> to choose explicitly."
        )
    return matching[0]


def resolve_model_dir(
    model_name: str | None,
    model_dir_override: str | None,
    *,
    platform: str | None = None,
    backend_format: str | None = None,
) -> str:
    """Resolve the on-disk model directory to load at startup.

    Precedence:
        1. `MODEL_DIR` env override (verbatim path).
        2. Registry lookup with platform-aware variant resolution.
        3. Hard-coded `./models/<MODEL_NAME>` fallback when registry parse fails.
    """
    if model_dir_override:
        return model_dir_override
    import sys

    name = model_name or HARDCODED_FALLBACK_MODEL_NAME
    host_platform = platform or sys.platform  # "darwin", "linux", etc.

    try:
        entries = load_registry()
        entry = entries.get(name)
        if entry:
            variant = resolve_variant(
                entry, platform=host_platform, backend_format=backend_format
            )
            return str(DEFAULT_MODELS_ROOT / variant["local_dir"])
    except RegistryError as e:
        logger.warning("Falling back to ./models/%s — %s", name, e)

    return str(DEFAULT_MODELS_ROOT / name)
