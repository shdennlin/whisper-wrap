"""Resolve the active ASR model directory.

Implements the design decision "Resolve the active model via MODEL_DIR override and
MODEL_NAME registry lookup". Task 7.1 expands this with the full `registry/models.yaml`
schema (CT2 fields, optional subfolder/revision, format discriminator); for now this
file ships a minimal resolver that honours `MODEL_DIR` overrides and falls back to
`./models/<MODEL_NAME>`.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


HARDCODED_FALLBACK_MODEL_NAME = "breeze-asr-25"
DEFAULT_MODELS_ROOT = Path("models")


def resolve_model_dir(model_name: str | None, model_dir_override: str | None) -> str:
    """Resolve the on-disk CT2 model directory to load at startup.

    Precedence:
        1. `MODEL_DIR` env override (if set) — used verbatim.
        2. `MODEL_NAME` registry lookup → `./models/<entry.local_dir>`.
        3. Hard-coded `./models/breeze-asr-25` fallback when MODEL_NAME is unset
           (per design "Resolve the active model via MODEL_DIR override and MODEL_NAME
           registry lookup").

    Task 7.1 wires the actual `registry/models.yaml` parsing into step 2; this
    minimal resolver currently maps `MODEL_NAME` directly to `./models/<name>`.
    """
    if model_dir_override:
        return model_dir_override
    name = model_name or HARDCODED_FALLBACK_MODEL_NAME
    return str(DEFAULT_MODELS_ROOT / name)
