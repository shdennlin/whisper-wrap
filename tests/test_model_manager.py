"""Subprocess tests for scripts/model-manager.sh against the v2.1 variants schema.

Covers Group 9 of v2-1-whisper-cpp-backend: per-variant download / list /
set / delete behaviour and the registry validation surface.

Tests invoke the bash script with isolated `WHISPER_WRAP_*` env vars so each
test run is sandboxed to its own tmp_path. The actual network call (`hf download`)
is avoided by making sure no test reaches that branch.
"""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = PROJECT_ROOT / "scripts" / "model-manager.sh"


def _write_registry(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "models.yaml"
    p.write_text(textwrap.dedent(body).lstrip("\n"))
    return p


def _run(
    tmp_path: Path,
    *args,
    env_file: Path | None = None,
    registry: Path | None = None,
):
    env = os.environ.copy()
    env["WHISPER_WRAP_PYTHONPATH"] = str(PROJECT_ROOT)
    env["PYTHON_BIN"] = sys.executable
    env["WHISPER_WRAP_MODELS_DIR"] = str(tmp_path / "models")
    env["WHISPER_WRAP_ENV_FILE"] = (
        str(env_file) if env_file else str(tmp_path / ".env")
    )
    env["WHISPER_WRAP_REGISTRY"] = (
        str(registry) if registry else str(PROJECT_ROOT / "registry" / "models.yaml")
    )
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=PROJECT_ROOT,
    )


def _variants_registry(tmp_path: Path) -> Path:
    """A two-model registry: breeze (multi-variant default) + backup (ct2 only)."""
    return _write_registry(
        tmp_path,
        """
        models:
          breeze:
            description: "Breeze ASR 25"
            languages: [zh-TW, en]
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
          backup:
            description: "Whisper fallback"
            languages: [multilingual]
            variants:
              - format: ct2
                repo_id: Systran/faster-whisper-large-v3-turbo
                compute_type: int8_float16
                local_dir: large-v3-turbo
        """,
    )


def _install_ct2_variant(models_dir: Path, local_dir: str) -> Path:
    """Lay down the on-disk artefacts that mark a ct2 variant as installed."""
    base = models_dir / local_dir
    base.mkdir(parents=True, exist_ok=True)
    (base / "model.bin").write_bytes(b"x")
    (base / "tokenizer.json").write_text("{}")
    return base


def _install_ggml_variant(
    models_dir: Path, local_dir: str, filename: str, coreml: str
) -> Path:
    """Lay down the on-disk artefacts that mark a ggml variant as installed."""
    base = models_dir / local_dir
    base.mkdir(parents=True, exist_ok=True)
    (base / filename).write_bytes(b"ggml")
    encoder = base / coreml
    encoder.mkdir(exist_ok=True)
    (encoder / "coremldata.bin").write_bytes(b"coreml")
    return base


# ---------- list / default ----------


def test_list_prints_both_built_in_entries(tmp_path):
    result = _run(tmp_path, "list", registry=_variants_registry(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "breeze" in result.stdout
    assert "backup" in result.stdout


def test_list_shows_variants_per_model(tmp_path):
    """Each variant SHALL appear on its own line with its format label."""
    result = _run(tmp_path, "list", registry=_variants_registry(tmp_path))
    assert result.returncode == 0, result.stderr
    # breeze has two variants — both labels should show up
    assert "ct2 (int8_float16)" in result.stdout
    assert "ggml (q6_k)" in result.stdout


def test_list_marks_installed_variants(tmp_path):
    """A variant whose on-disk artefacts are present SHALL be marked installed."""
    registry = _variants_registry(tmp_path)
    models_dir = tmp_path / "models"
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run(tmp_path, "list", registry=registry)
    assert result.returncode == 0, result.stderr
    # The ggml row SHALL be marked installed; the ct2 row SHALL NOT.
    ggml_line = next(line for line in result.stdout.splitlines() if "ggml" in line)
    assert "yes" in ggml_line
    ct2_line = next(
        line for line in result.stdout.splitlines()
        if "ct2 (int8_float16)" in line and "breeze" in line
    )
    # ct2 not installed → no "yes" flag
    assert "yes" not in ct2_line


def test_default_prints_default_entry_name(tmp_path):
    result = _run(tmp_path, "default", registry=_variants_registry(tmp_path))
    assert result.returncode == 0
    assert result.stdout.strip() == "breeze"


# ---------- download rejection paths ----------


def test_download_url_rejected_with_clear_error(tmp_path):
    result = _run(
        tmp_path,
        "download",
        "https://huggingface.co/some/repo/blob/main/model.bin",
        registry=_variants_registry(tmp_path),
    )
    assert result.returncode != 0
    assert "URL-based downloads were removed" in result.stderr


def test_download_unknown_name_exits_nonzero(tmp_path):
    result = _run(
        tmp_path,
        "download",
        "no-such-entry",
        registry=_variants_registry(tmp_path),
    )
    assert result.returncode != 0
    assert "Unknown model" in result.stderr


def test_download_already_installed_skips(tmp_path):
    """If every variant is already on disk, download SHALL skip the network call."""
    registry = _variants_registry(tmp_path)
    models_dir = tmp_path / "models"
    _install_ct2_variant(models_dir, "breeze-asr-25-ct2")
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run(tmp_path, "download", "breeze", registry=registry)
    assert result.returncode == 0, result.stderr
    assert "already installed" in result.stdout


# ---------- set: ≥1 variant installed ----------


def test_set_refuses_when_no_variants_installed(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\n")
    result = _run(
        tmp_path,
        "set",
        "backup",
        registry=_variants_registry(tmp_path),
        env_file=env_file,
    )
    assert result.returncode != 0
    assert "no installed variants" in result.stderr


def test_set_succeeds_when_at_least_one_variant_installed(tmp_path):
    """Set SHALL succeed if the ggml variant is installed even if ct2 is not."""
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=other\nAPI_PORT=8000\n")
    models_dir = tmp_path / "models"
    # Install only the ggml variant of breeze
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run(
        tmp_path,
        "set",
        "breeze",
        registry=_variants_registry(tmp_path),
        env_file=env_file,
    )
    assert result.returncode == 0, result.stderr
    body = env_file.read_text()
    assert "MODEL_NAME=breeze" in body
    assert "API_PORT=8000" in body


# ---------- delete: removes every variant ----------


def test_delete_refuses_active_model(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=breeze\n")
    models_dir = tmp_path / "models"
    _install_ct2_variant(models_dir, "breeze-asr-25-ct2")
    result = _run(
        tmp_path,
        "delete",
        "breeze",
        registry=_variants_registry(tmp_path),
        env_file=env_file,
    )
    assert result.returncode != 0
    assert "active model" in result.stderr
    assert (models_dir / "breeze-asr-25-ct2").exists()


def test_delete_removes_every_variant_directory(tmp_path):
    """Delete SHALL remove every variant's local_dir for the named model."""
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=backup\n")
    models_dir = tmp_path / "models"
    _install_ct2_variant(models_dir, "breeze-asr-25-ct2")
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run(
        tmp_path,
        "delete",
        "breeze",
        registry=_variants_registry(tmp_path),
        env_file=env_file,
    )
    assert result.returncode == 0, result.stderr
    assert not (models_dir / "breeze-asr-25-ct2").exists()
    assert not (models_dir / "breeze-asr-25-ggml").exists()


def test_delete_handles_missing_directories_gracefully(tmp_path):
    """Delete SHALL succeed even when some variant directories are missing."""
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL_NAME=backup\n")
    models_dir = tmp_path / "models"
    # Only ct2 is on disk; ggml directory doesn't exist
    _install_ct2_variant(models_dir, "breeze-asr-25-ct2")
    result = _run(
        tmp_path,
        "delete",
        "breeze",
        registry=_variants_registry(tmp_path),
        env_file=env_file,
    )
    assert result.returncode == 0, result.stderr
    assert not (models_dir / "breeze-asr-25-ct2").exists()


# ---------- registry validation rejection ----------


def test_list_rejects_unknown_variant_format(tmp_path):
    """A variant with format='mlx' SHALL be rejected with the offending value named."""
    bad = _write_registry(
        tmp_path,
        """
        models:
          x:
            description: "MLX not supported"
            languages: [en]
            default: true
            variants:
              - format: mlx
                local_dir: x
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert "format=" in result.stderr
    assert "mlx" in result.stderr


def test_list_rejects_zero_defaults(tmp_path):
    bad = _write_registry(
        tmp_path,
        """
        models:
          x:
            description: x
            languages: [en]
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: x
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    # Spec wording: "Registry has no default entry" or "exactly one entry"
    assert (
        "no default entry" in result.stderr
        or "exactly one" in result.stderr
    )


def test_list_rejects_multiple_defaults(tmp_path):
    bad = _write_registry(
        tmp_path,
        """
        models:
          a:
            description: a
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: a
          b:
            description: b
            languages: [en]
            default: true
            variants:
              - format: ct2
                compute_type: int8_float16
                local_dir: b
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert (
        "multiple default" in result.stderr
        or "exactly one" in result.stderr
    )


def test_list_rejects_empty_variants_list(tmp_path):
    """Per registry spec: an entry with `variants: []` SHALL be rejected."""
    bad = _write_registry(
        tmp_path,
        """
        models:
          x:
            description: x
            languages: [en]
            default: true
            variants: []
        """,
    )
    result = _run(tmp_path, "list", registry=bad)
    assert result.returncode != 0
    assert "at least one variant" in result.stderr
