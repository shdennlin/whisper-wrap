"""Invariants on the shipped `registry/models.yaml` that the variants-schema
tests do not cover.

The variants-schema tests in `test_registry_variants.py` use synthetic registry
files in tmp_path. This file asserts properties of the actual shipped registry.
"""

from app.services.registry import (
    DEFAULT_REGISTRY_PATH,
    default_model_name,
    load_registry,
)


def test_shipped_default_declares_ct2_and_ggml_variants():
    """The shipped default model SHALL declare at least one ct2 variant and at
    least one ggml variant so the meeting analysis endpoint can resolve a ct2
    path on every platform without requiring a separate model download.
    """
    entries = load_registry(DEFAULT_REGISTRY_PATH)
    name = default_model_name(DEFAULT_REGISTRY_PATH)
    formats = {v["format"] for v in entries[name]["variants"]}
    assert "ct2" in formats, f"default {name} is missing a ct2 variant"
    assert "ggml" in formats, f"default {name} is missing a ggml variant"
