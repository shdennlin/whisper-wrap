"""Subprocess tests for scripts/model-manager.sh (tasks 7.3, 7.5, 7.6)."""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = PROJECT_ROOT / "scripts" / "model-manager.sh"


def _write_registry(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "models.yaml"
    p.write_text(textwrap.dedent(body).lstrip("\n"))
    return p


def _run(tmp_path: Path, *args, env_file: Path | None = None, registry: Path | None = None):
    env = os.environ.copy()
    env["WHISPER_WRAP_PYTHONPATH"] = str(PROJECT_ROOT)
    env["PYTHON_BIN"] = sys.executable
    env["WHISPER_WRAP_MODELS_DIR"] = str(tmp_path / "models")
    env["WHISPER_WRAP_ENV_FILE"] = str(env_file) if env_file else str(tmp_path / ".env")
    env["WHISPER_WRAP_REGISTRY"] = str(registry) if registry else str(PROJECT_ROOT / "registry" / "models.yaml")
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=PROJECT_ROOT,
    )


def _ct2_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        """
        models:
          breeze:
            default: true
            repo_id: shdennlin/breeze-asr-25-ct2
            format: ct2
            subfolder: int8_float16
            compute_type: int8_float16
            local_dir: breeze-asr-25
            size: 1.5GB
            languages: [zh-TW, en]
            description: Breeze CT2
          backup:
            repo_id: Systran/faster-whisper-large-v3-turbo
            format: ct2
            compute_type: int8_float16
            local_dir: large-v3-turbo
            size: 1.6GB
            languages: [multilingual]
            description: Whisper fallback
        """,
    )


# ---------- list / default ----------


def test_list_prints_both_built_in_entries(tmp_path):
    result = _run(tmp_path, "list", registry=_ct2_registry(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "breeze" in result.stdout
    assert "backup" in result.stdout


def test_default_prints_default_entry_name(tmp_path):
    result = _run(tmp_path, "default", registry=_ct2_registry(tmp_path))
    assert result.returncode == 0
    assert result.stdout.strip() == "breeze"


# ---------- download rejection paths ----------


def test_download_url_rejected_with_clear_error(tmp_path):
    result = _run(
        tmp_path,
        "download",
        "https://huggingface.co/some/repo/blob/main/model.bin",
        registry=_ct2_registry(tmp_path),
    )
    assert result.returncode != 0
    assert "URL-based downloads were removed" in result.stderr


def test_download_unknown_name_exits_nonzero(tmp_path):
    result = _run(tmp_path, "download", "no-such-entry", registry=_ct2_registry(tmp_path))
    assert result.returncode != 0
    assert "Unknown model" in result.stderr


# ---------- set: refuses uninstalled ----------


def test_set_refuses_when_model_not_installed(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\n")
    result = _run(tmp_path, "set", "backup", registry=_ct2_registry(tmp_path), env_file=env_file)
    assert result.returncode != 0
    assert "not installed" in result.stderr


def test_set_updates_env_when_installed(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\nAPI_PORT=8000\n")
    # Pre-populate the local_dir with a fake model.bin to simulate an installed entry.
    models_dir = tmp_path / "models"
    (models_dir / "large-v3-turbo").mkdir(parents=True)
    (models_dir / "large-v3-turbo" / "model.bin").write_bytes(b"x")
    (models_dir / "large-v3-turbo" / "tokenizer.json").write_text("{}")
    result = _run(tmp_path, "set", "backup", registry=_ct2_registry(tmp_path), env_file=env_file)
    assert result.returncode == 0, result.stderr
    body = env_file.read_text()
    assert "MODEL_NAME=backup" in body
    assert "API_PORT=8000" in body  # other lines preserved


# ---------- delete: refuses active ----------


def test_delete_refuses_active_model(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\n")
    models_dir = tmp_path / "models"
    (models_dir / "breeze-asr-25").mkdir(parents=True)
    result = _run(tmp_path, "delete", "breeze", registry=_ct2_registry(tmp_path), env_file=env_file)
    assert result.returncode != 0
    assert "active model" in result.stderr
    assert (models_dir / "breeze-asr-25").exists()


def test_delete_removes_inactive_model(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\n")
    models_dir = tmp_path / "models"
    (models_dir / "large-v3-turbo").mkdir(parents=True)
    result = _run(tmp_path, "delete", "backup", registry=_ct2_registry(tmp_path), env_file=env_file)
    assert result.returncode == 0
    assert not (models_dir / "large-v3-turbo").exists()


# ---------- registry validation rejection ----------


def test_list_rejects_format_other_than_ct2(tmp_path):
    bad = _write_registry(
        tmp_path,
        """
        models:
          x:
            default: true
            repo_id: a/b
            format: ggml
            compute_type: q8_0
            local_dir: x
            size: 1GB
            languages: [en]
            description: bad
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert "format='ggml'" in result.stderr


def test_list_rejects_zero_defaults(tmp_path):
    bad = _write_registry(
        tmp_path,
        """
        models:
          x:
            repo_id: a/b
            format: ct2
            compute_type: int8_float16
            local_dir: x
            size: 1GB
            languages: [en]
            description: no-default
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert "no default entry" in result.stderr


def test_list_rejects_multiple_defaults(tmp_path):
    bad = _write_registry(
        tmp_path,
        """
        models:
          a:
            default: true
            repo_id: a/b
            format: ct2
            compute_type: int8_float16
            local_dir: a
            size: 1GB
            languages: [en]
            description: a
          b:
            default: true
            repo_id: a/b2
            format: ct2
            compute_type: int8_float16
            local_dir: b
            size: 1GB
            languages: [en]
            description: b
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert "multiple default" in result.stderr
