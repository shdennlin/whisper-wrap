"""Tests for the variants schema in app/services/registry.py (v2.1).

Covers Decision 3: variants schema for `registry/models.yaml` and Decision 4:
Platform-aware backend selection. The schema replaces v2's flat per-entry
format with a per-variant list, so every model entry may declare both a `ct2`
and a `ggml` packaging side by side.
"""

import textwrap

import pytest


def _write(tmp_path, body: str):
    p = tmp_path / "models.yaml"
    p.write_text(textwrap.dedent(body).lstrip("\n"))
    return p


def _two_variant_entry() -> str:
    return """
        models:
          breeze-asr-25:
            description: "Breeze ASR 25"
            languages: [zh, en]
            default: true
            variants:
              - format: ct2
                repo_id: shdennlin/breeze-asr-25-ct2
                compute_type: int8_float16
                local_dir: breeze-asr-25-ct2
                default_on: [linux]
              - format: ggml
                repo_id: shdennlin/breeze-asr-25-ggml
                quant: q6_k
                filename: ggml-breeze-asr-25-q6_k.bin
                coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
                local_dir: breeze-asr-25-ggml
                default_on: [darwin]
        """


def test_parses_two_variant_entry(tmp_path):
    """An entry with both ct2 and ggml variants SHALL be parsed with all fields populated."""
    from app.services.registry import load_registry

    p = _write(tmp_path, _two_variant_entry())
    entries = load_registry(p)

    assert "breeze-asr-25" in entries
    variants = entries["breeze-asr-25"]["variants"]
    assert len(variants) == 2

    ct2 = next(v for v in variants if v["format"] == "ct2")
    assert ct2["compute_type"] == "int8_float16"
    assert ct2["local_dir"] == "breeze-asr-25-ct2"
    assert ct2["default_on"] == ["linux"]

    ggml = next(v for v in variants if v["format"] == "ggml")
    assert ggml["quant"] == "q6_k"
    assert ggml["filename"] == "ggml-breeze-asr-25-q6_k.bin"
    assert ggml["coreml_encoder"] == "ggml-breeze-asr-25-encoder.mlmodelc"
    assert ggml["default_on"] == ["darwin"]


def test_rejects_empty_variants_list(tmp_path):
    """A model entry with `variants: []` SHALL be rejected."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          empty:
            description: "no variants"
            languages: [en]
            default: true
            variants: []
        """,
    )
    with pytest.raises(RegistryError, match=r"at least one variant"):
        load_registry(p)


def test_rejects_ct2_without_compute_type(tmp_path):
    """A ct2 variant missing `compute_type` SHALL be rejected with a clear error."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          bad:
            description: "ct2 missing compute_type"
            languages: [en]
            default: true
            variants:
              - format: ct2
                local_dir: bad-ct2
        """,
    )
    with pytest.raises(RegistryError, match=r"compute_type"):
        load_registry(p)


def test_rejects_ggml_without_coreml_encoder(tmp_path):
    """A ggml variant missing `coreml_encoder` SHALL be rejected."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          bad:
            description: "ggml missing coreml encoder"
            languages: [en]
            default: true
            variants:
              - format: ggml
                quant: q6_k
                filename: ggml-bad-q6_k.bin
                local_dir: bad-ggml
        """,
    )
    with pytest.raises(RegistryError, match=r"coreml_encoder"):
        load_registry(p)


def test_rejects_ggml_without_filename(tmp_path):
    """A ggml variant missing `filename` SHALL be rejected."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          bad:
            description: "ggml missing filename"
            languages: [en]
            default: true
            variants:
              - format: ggml
                quant: q6_k
                coreml_encoder: ggml-bad-encoder.mlmodelc
                local_dir: bad-ggml
        """,
    )
    with pytest.raises(RegistryError, match=r"filename"):
        load_registry(p)


def test_rejects_unknown_format(tmp_path):
    """A variant with an unrecognised `format` SHALL be rejected naming the value."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          mlx-model:
            description: "MLX not supported in v2.1"
            languages: [en]
            default: true
            variants:
              - format: mlx
                local_dir: mlx-model
        """,
    )
    with pytest.raises(RegistryError, match=r"format.*mlx"):
        load_registry(p)


def test_rejects_no_default(tmp_path):
    """A registry without any `default: true` entry SHALL be rejected."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          a:
            description: "a"
            languages: [en]
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: a
          b:
            description: "b"
            languages: [en]
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: b
        """,
    )
    with pytest.raises(RegistryError, match=r"exactly one"):
        load_registry(p)


def test_rejects_multiple_defaults(tmp_path):
    """A registry with two `default: true` entries SHALL be rejected naming them."""
    from app.services.registry import RegistryError, load_registry

    p = _write(
        tmp_path,
        """
        models:
          a:
            description: "a"
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: a
          b:
            description: "b"
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: b
        """,
    )
    with pytest.raises(RegistryError, match=r"exactly one"):
        load_registry(p)


def test_built_in_entries(tmp_path):
    """The shipped registry SHALL contain `breeze-asr-25` (multi-variant) + `large-v3-turbo` (ct2)."""
    from app.services.registry import DEFAULT_REGISTRY_PATH, load_registry

    entries = load_registry(DEFAULT_REGISTRY_PATH)

    # Exactly two top-level entries
    assert set(entries.keys()) == {"breeze-asr-25", "large-v3-turbo"}

    # breeze has both variants, ggml uses q6_k (Decision 8), default_on Mac
    breeze_variants = entries["breeze-asr-25"]["variants"]
    formats = {v["format"] for v in breeze_variants}
    assert formats == {"ct2", "ggml"}
    ggml = next(v for v in breeze_variants if v["format"] == "ggml")
    assert ggml["quant"] == "q6_k"
    assert "darwin" in ggml["default_on"]
    assert "linux" in next(v for v in breeze_variants if v["format"] == "ct2")["default_on"]

    # large-v3-turbo has only ct2
    turbo = entries["large-v3-turbo"]["variants"]
    assert len(turbo) == 1
    assert turbo[0]["format"] == "ct2"

    # Exactly one default flag
    assert entries["breeze-asr-25"].get("default") is True
    assert entries["large-v3-turbo"].get("default", False) is False


# ---------- User-extensible ----------


def test_user_extensible_single_variant(tmp_path):
    """A user-added entry with one variant SHALL be surfaced identically to built-ins."""
    from app.services.registry import load_registry

    p = _write(
        tmp_path,
        """
        models:
          builtin:
            description: "builtin"
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: builtin-ct2
          user-custom:
            description: "custom"
            languages: [zh]
            variants:
              - format: ggml
                quant: q5_0
                filename: ggml-custom-q5_0.bin
                coreml_encoder: ggml-custom-encoder.mlmodelc
                local_dir: user-custom-ggml
        """,
    )
    entries = load_registry(p)
    assert "user-custom" in entries
    assert entries["user-custom"]["variants"][0]["quant"] == "q5_0"


def test_user_extensible_multi_variant(tmp_path):
    """A user-added entry with multiple variants SHALL parse like built-ins."""
    from app.services.registry import load_registry

    p = _write(
        tmp_path,
        """
        models:
          builtin:
            description: "builtin"
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: builtin-ct2
          dual:
            description: "user multi-variant"
            languages: [zh, en]
            variants:
              - format: ct2
                compute_type: float16
                local_dir: dual-ct2
              - format: ggml
                quant: q4_0
                filename: ggml-dual-q4_0.bin
                coreml_encoder: ggml-dual-encoder.mlmodelc
                local_dir: dual-ggml
        """,
    )
    entries = load_registry(p)
    assert "dual" in entries
    assert len(entries["dual"]["variants"]) == 2


# ---------- Variant resolution (Decision 4: Platform-aware backend selection) ----------


def test_variant_resolution_darwin_default(tmp_path, monkeypatch):
    """On darwin with no BACKEND_FORMAT, the ggml variant (default_on: [darwin]) SHALL win."""
    from app.services.registry import load_registry, resolve_variant

    p = _write(tmp_path, _two_variant_entry())
    entries = load_registry(p)
    chosen = resolve_variant(
        entries["breeze-asr-25"], platform="darwin", backend_format=None
    )
    assert chosen["format"] == "ggml"


def test_variant_resolution_linux_default(tmp_path):
    from app.services.registry import load_registry, resolve_variant

    p = _write(tmp_path, _two_variant_entry())
    entries = load_registry(p)
    chosen = resolve_variant(
        entries["breeze-asr-25"], platform="linux", backend_format=None
    )
    assert chosen["format"] == "ct2"


def test_variant_resolution_backend_format_override(tmp_path):
    """BACKEND_FORMAT=ct2 on darwin SHALL choose the ct2 variant despite default_on=[linux]."""
    from app.services.registry import load_registry, resolve_variant

    p = _write(tmp_path, _two_variant_entry())
    entries = load_registry(p)
    chosen = resolve_variant(
        entries["breeze-asr-25"], platform="darwin", backend_format="ct2"
    )
    assert chosen["format"] == "ct2"


def test_variant_resolution_no_match_fails(tmp_path):
    """When no variant's default_on matches the platform and no override is set, fail."""
    from app.services.registry import (
        RegistryError,
        load_registry,
        resolve_variant,
    )

    p = _write(
        tmp_path,
        """
        models:
          mac-only:
            description: "Mac-only model"
            languages: [zh]
            default: true
            variants:
              - format: ggml
                quant: q6_k
                filename: ggml-mac-only.bin
                coreml_encoder: ggml-mac-only-encoder.mlmodelc
                local_dir: mac-only
                default_on: [darwin]
        """,
    )
    entries = load_registry(p)
    with pytest.raises(RegistryError, match=r"BACKEND_FORMAT"):
        resolve_variant(
            entries["mac-only"], platform="linux", backend_format=None
        )


def test_variant_resolution_ggml_on_linux_fails(tmp_path):
    """BACKEND_FORMAT=ggml on linux SHALL be rejected (pywhispercpp is darwin-only)."""
    from app.services.registry import (
        RegistryError,
        load_registry,
        resolve_variant,
    )

    p = _write(tmp_path, _two_variant_entry())
    entries = load_registry(p)
    with pytest.raises(RegistryError, match=r"linux"):
        resolve_variant(
            entries["breeze-asr-25"], platform="linux", backend_format="ggml"
        )


def test_variant_resolution_backend_format_no_matching_variant(tmp_path):
    """BACKEND_FORMAT=<x> when the model has no variant with that format SHALL be rejected."""
    from app.services.registry import (
        RegistryError,
        load_registry,
        resolve_variant,
    )

    p = _write(
        tmp_path,
        """
        models:
          ct2-only:
            description: "ct2 only"
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: ct2-only
                default_on: [linux, darwin]
        """,
    )
    entries = load_registry(p)
    with pytest.raises(RegistryError, match=r"ggml"):
        resolve_variant(
            entries["ct2-only"], platform="darwin", backend_format="ggml"
        )


# ---------- default_model_name + resolve_model_dir ----------


def test_default_model_name_returns_flagged_entry(tmp_path):
    """default_model_name() SHALL return the name of the entry with default: true."""
    from app.services.registry import default_model_name

    p = _write(tmp_path, _two_variant_entry())
    assert default_model_name(p) == "breeze-asr-25"


def test_resolve_model_dir_returns_override_verbatim():
    """MODEL_DIR override SHALL bypass the registry entirely."""
    from app.services.registry import resolve_model_dir

    assert resolve_model_dir(None, "/opt/x") == "/opt/x"
    assert resolve_model_dir("ignored", "/opt/y") == "/opt/y"


def test_resolve_model_dir_picks_variant_local_dir(tmp_path, monkeypatch):
    """Resolution SHALL pick the platform-matched variant's local_dir."""
    from app.services.registry import DEFAULT_MODELS_ROOT, resolve_model_dir

    p = _write(tmp_path, _two_variant_entry())
    monkeypatch.setattr("app.services.registry.DEFAULT_REGISTRY_PATH", p)

    # darwin → ggml variant → breeze-asr-25-ggml
    assert resolve_model_dir(
        "breeze-asr-25", None, platform="darwin"
    ) == str(DEFAULT_MODELS_ROOT / "breeze-asr-25-ggml")

    # linux → ct2 variant → breeze-asr-25-ct2
    assert resolve_model_dir(
        "breeze-asr-25", None, platform="linux"
    ) == str(DEFAULT_MODELS_ROOT / "breeze-asr-25-ct2")


def test_resolve_model_dir_backend_format_override(tmp_path, monkeypatch):
    """BACKEND_FORMAT=ct2 on darwin SHALL pick the ct2 variant despite default_on."""
    from app.services.registry import DEFAULT_MODELS_ROOT, resolve_model_dir

    p = _write(tmp_path, _two_variant_entry())
    monkeypatch.setattr("app.services.registry.DEFAULT_REGISTRY_PATH", p)

    assert resolve_model_dir(
        "breeze-asr-25", None, platform="darwin", backend_format="ct2"
    ) == str(DEFAULT_MODELS_ROOT / "breeze-asr-25-ct2")


def test_resolve_model_dir_falls_back_to_hardcoded_when_registry_missing(
    tmp_path, monkeypatch
):
    """When registry is unreadable, resolver SHALL fall back to ./models/<name>."""
    from app.services.registry import (
        DEFAULT_MODELS_ROOT,
        HARDCODED_FALLBACK_MODEL_NAME,
        resolve_model_dir,
    )

    monkeypatch.setattr(
        "app.services.registry.DEFAULT_REGISTRY_PATH",
        tmp_path / "nope.yaml",
    )
    assert resolve_model_dir(None, None) == str(
        DEFAULT_MODELS_ROOT / HARDCODED_FALLBACK_MODEL_NAME
    )


def test_reject_missing_file(tmp_path):
    from app.services.registry import RegistryError, load_registry

    with pytest.raises(RegistryError, match="not found"):
        load_registry(tmp_path / "nope.yaml")


def test_reject_empty_models(tmp_path):
    from app.services.registry import RegistryError, load_registry

    p = _write(tmp_path, "models: {}\n")
    with pytest.raises(RegistryError, match="non-empty mapping"):
        load_registry(p)


def test_reject_no_top_level_models(tmp_path):
    from app.services.registry import RegistryError, load_registry

    p = _write(tmp_path, "other:\n  - foo\n")
    with pytest.raises(RegistryError, match="top-level 'models:'"):
        load_registry(p)
