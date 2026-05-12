"""Tests for app/services/registry.py (task 7.1 happy-path + rejection cases)."""

import textwrap

import pytest

from app.services.registry import (
    DEFAULT_MODELS_ROOT,
    HARDCODED_FALLBACK_MODEL_NAME,
    RegistryError,
    default_model_name,
    load_registry,
    resolve_model_dir,
)


def _write(tmp_path, body: str):
    p = tmp_path / "models.yaml"
    p.write_text(textwrap.dedent(body).lstrip("\n"))
    return p


# ---------- Happy paths ----------


def test_load_happy_path_with_subfolder_and_revision(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          breeze:
            default: true
            repo_id: shdennlin/breeze-asr-25-ct2
            format: ct2
            subfolder: int8_float16
            revision: main
            compute_type: int8_float16
            local_dir: breeze-asr-25
            size: 1.5GB
            languages: [zh-TW, en]
            description: "Breeze CT2 int8_float16"
        """,
    )
    entries = load_registry(p)
    assert "breeze" in entries
    assert entries["breeze"]["subfolder"] == "int8_float16"
    assert entries["breeze"]["revision"] == "main"


def test_load_happy_path_minimum_required_fields(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          only:
            default: true
            repo_id: a/b
            format: ct2
            compute_type: int8_float16
            local_dir: only
            size: 1GB
            languages: [en]
            description: minimal
        """,
    )
    entries = load_registry(p)
    assert entries["only"]["repo_id"] == "a/b"


def test_default_model_name_returns_flagged_entry(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          a:
            repo_id: x/a
            format: ct2
            compute_type: int8_float16
            local_dir: a
            size: 1GB
            languages: [en]
            description: a
          b:
            default: true
            repo_id: x/b
            format: ct2
            compute_type: int8_float16
            local_dir: b
            size: 1GB
            languages: [en]
            description: b
        """,
    )
    assert default_model_name(p) == "b"


# ---------- Rejection cases (task 7.1 scenarios) ----------


def test_reject_format_other_than_ct2(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          bad:
            default: true
            repo_id: x/y
            format: ggml
            compute_type: q8_0
            local_dir: bad
            size: 1GB
            languages: [en]
            description: wrong format
        """,
    )
    with pytest.raises(RegistryError, match="format='ggml'"):
        load_registry(p)


def test_reject_missing_default(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          a:
            repo_id: x/a
            format: ct2
            compute_type: int8_float16
            local_dir: a
            size: 1GB
            languages: [en]
            description: a
        """,
    )
    with pytest.raises(RegistryError, match="no default entry"):
        load_registry(p)


def test_reject_multiple_defaults(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          a:
            default: true
            repo_id: x/a
            format: ct2
            compute_type: int8_float16
            local_dir: a
            size: 1GB
            languages: [en]
            description: a
          b:
            default: true
            repo_id: x/b
            format: ct2
            compute_type: int8_float16
            local_dir: b
            size: 1GB
            languages: [en]
            description: b
        """,
    )
    with pytest.raises(RegistryError, match="multiple default entries"):
        load_registry(p)


def test_reject_missing_required_field(tmp_path):
    p = _write(
        tmp_path,
        """
        models:
          a:
            default: true
            repo_id: x/a
            format: ct2
            local_dir: a
            size: 1GB
            languages: [en]
            description: a
        """,
    )  # missing compute_type
    with pytest.raises(RegistryError, match="missing required field"):
        load_registry(p)


def test_reject_missing_file(tmp_path):
    with pytest.raises(RegistryError, match="not found"):
        load_registry(tmp_path / "nope.yaml")


def test_reject_empty_models(tmp_path):
    p = _write(tmp_path, "models: {}\n")
    with pytest.raises(RegistryError, match="non-empty mapping"):
        load_registry(p)


def test_reject_no_top_level_models(tmp_path):
    p = _write(tmp_path, "other:\n  - foo\n")
    with pytest.raises(RegistryError, match="top-level 'models:'"):
        load_registry(p)


# ---------- resolve_model_dir() ----------


def test_resolve_model_dir_returns_override_verbatim():
    assert resolve_model_dir(None, "/opt/x") == "/opt/x"
    assert resolve_model_dir("ignored", "/opt/y") == "/opt/y"


def test_resolve_model_dir_falls_back_to_hardcoded_when_name_unset(tmp_path, monkeypatch):
    # Point the registry resolver at a missing path so it falls through.
    monkeypatch.setattr(
        "app.services.registry.DEFAULT_REGISTRY_PATH",
        tmp_path / "missing.yaml",
    )
    assert resolve_model_dir(None, None) == str(
        DEFAULT_MODELS_ROOT / HARDCODED_FALLBACK_MODEL_NAME
    )
