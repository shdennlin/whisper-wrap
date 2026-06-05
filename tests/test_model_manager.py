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
    env["WHISPER_WRAP_ENV_FILE"] = str(env_file) if env_file else str(tmp_path / ".env")
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
                subfolder: int8_float16
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
    # The ggml ROW (not the header line) SHALL be marked installed; ct2 SHALL NOT.
    # The "Active model" header also mentions "ggml" — discriminate by table
    # rows always carrying the HF repo string.
    ggml_line = next(
        line
        for line in result.stdout.splitlines()
        if "ggml (q6_k)" in line and "shdennlin" in line
    )
    assert "yes" in ggml_line
    ct2_line = next(
        line
        for line in result.stdout.splitlines()
        if "ct2 (int8_float16)" in line and "breeze" in line and "shdennlin" in line
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


def _run_with_env(tmp_path: Path, *args, extra_env: dict, registry: Path | None = None):
    """Like _run but lets a test override env vars (BACKEND_FORMAT, ALL flag)."""
    env = os.environ.copy()
    env["WHISPER_WRAP_PYTHONPATH"] = str(PROJECT_ROOT)
    env["PYTHON_BIN"] = sys.executable
    env["WHISPER_WRAP_MODELS_DIR"] = str(tmp_path / "models")
    env["WHISPER_WRAP_ENV_FILE"] = str(tmp_path / ".env")
    env["WHISPER_WRAP_REGISTRY"] = (
        str(registry) if registry else str(PROJECT_ROOT / "registry" / "models.yaml")
    )
    env.update(extra_env)
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=PROJECT_ROOT,
    )


def test_download_default_fetches_only_active_variant(tmp_path):
    """Without ALL=1, download SHALL only touch the variant matching the current
    platform/BACKEND_FORMAT. Verified by installing only the active variant and
    confirming the script reports success without trying to fetch the other one."""
    registry = _variants_registry(tmp_path)
    models_dir = tmp_path / "models"
    # Install only the ggml variant; pin BACKEND_FORMAT=ggml so the test is
    # platform-independent (CI is Linux, this Mac would also work without pin).
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run_with_env(
        tmp_path,
        "download",
        "breeze",
        extra_env={"BACKEND_FORMAT": "ggml"},
        registry=registry,
    )
    assert result.returncode == 0, result.stderr
    # Single-variant mode: log mentions ggml, NOT ct2 (ct2 would have triggered
    # a real `hf download` because the ct2 dir doesn't exist).
    assert "variant #0 (ggml)" in result.stdout
    assert "(ct2)" not in result.stdout
    # Hint about ALL=1 SHOULD appear since this model has >1 variant.
    assert "ALL=1" in result.stdout


def _make_fake_hf(tmp_path: Path) -> Path:
    """Return a tmpdir containing a fake `hf` script that records its args.

    The fake also creates the artefacts the script expects post-download
    (model.bin / tokenizer.json for ct2; the .bin and encoder dir for ggml)
    so cmd_download's variant_installed() check passes.
    """
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir(exist_ok=True)
    hf = bin_dir / "hf"
    hf.write_text(
        """#!/bin/bash
# Append every argv as one line so the test can assert on includes.
echo "$@" >> "$LOGFILE"

# Synthesise the on-disk artefacts the script's installed-check expects.
# Parse --local-dir and walk back to figure out what to lay down.
dest=""
includes=()
while [ $# -gt 0 ]; do
    case "$1" in
        --local-dir) dest="$2"; shift 2;;
        --include) includes+=("$2"); shift 2;;
        *) shift;;
    esac
done

mkdir -p "$dest"
for inc in "${includes[@]}"; do
    # `q6_k.bin` → file; `encoder.mlmodelc/*` → dir + sentinel file;
    # `int8_float16/*` → ct2 subfolder layout.
    if [[ "$inc" == */* ]]; then
        sub="${inc%/*}"
        mkdir -p "$dest/$sub"
        if [[ "$sub" == *.mlmodelc ]]; then
            : > "$dest/$sub/coremldata.bin"
        else
            : > "$dest/$sub/model.bin"
            echo '{}' > "$dest/$sub/tokenizer.json"
        fi
    else
        : > "$dest/$inc"
    fi
done
"""
    )
    hf.chmod(0o755)
    return bin_dir


def test_download_ggml_passes_filename_and_encoder_includes(tmp_path):
    """ggml repos host many quantizations side-by-side; the download MUST pass
    --include filters so we only fetch the .bin we declared + the Core ML
    encoder directory — not every q-level (~11 GB for breeze-asr-25-ggml)."""
    bin_dir = _make_fake_hf(tmp_path)
    log = tmp_path / "hf-args.log"
    registry = _variants_registry(tmp_path)

    env = os.environ.copy()
    env["WHISPER_WRAP_PYTHONPATH"] = str(PROJECT_ROOT)
    env["PYTHON_BIN"] = sys.executable
    env["WHISPER_WRAP_MODELS_DIR"] = str(tmp_path / "models")
    env["WHISPER_WRAP_ENV_FILE"] = str(tmp_path / ".env")
    env["WHISPER_WRAP_REGISTRY"] = str(registry)
    env["LOGFILE"] = str(log)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["BACKEND_FORMAT"] = "ggml"   # pin so the test is platform-independent

    result = subprocess.run(
        ["bash", str(SCRIPT), "download", "breeze"],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    assert result.returncode == 0, result.stderr
    assert log.exists(), "fake hf was not invoked"
    args = log.read_text()
    # Both filters MUST appear; without them we'd fetch every quantization.
    assert "--include ggml-breeze-asr-25-q6_k.bin" in args
    assert "--include ggml-breeze-asr-25-encoder.mlmodelc/*" in args


def test_download_ct2_passes_subfolder_include(tmp_path):
    """Sanity: existing ct2-with-subfolder filter still works."""
    bin_dir = _make_fake_hf(tmp_path)
    log = tmp_path / "hf-args.log"
    registry = _variants_registry(tmp_path)

    env = os.environ.copy()
    env["WHISPER_WRAP_PYTHONPATH"] = str(PROJECT_ROOT)
    env["PYTHON_BIN"] = sys.executable
    env["WHISPER_WRAP_MODELS_DIR"] = str(tmp_path / "models")
    env["WHISPER_WRAP_ENV_FILE"] = str(tmp_path / ".env")
    env["WHISPER_WRAP_REGISTRY"] = str(registry)
    env["LOGFILE"] = str(log)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["BACKEND_FORMAT"] = "ct2"

    result = subprocess.run(
        ["bash", str(SCRIPT), "download", "breeze"],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    assert result.returncode == 0, result.stderr
    args = log.read_text()
    assert "--include int8_float16/*" in args


def test_download_all_flag_fetches_every_variant(tmp_path):
    """WHISPER_WRAP_ALL_VARIANTS=1 (set by `ALL=1 make download-model`) SHALL
    restore the legacy behavior of fetching every variant."""
    registry = _variants_registry(tmp_path)
    models_dir = tmp_path / "models"
    # Pre-install both variants so the script can succeed without hitting the
    # network in either case.
    _install_ct2_variant(models_dir, "breeze-asr-25-ct2")
    _install_ggml_variant(
        models_dir,
        "breeze-asr-25-ggml",
        "ggml-breeze-asr-25-q6_k.bin",
        "ggml-breeze-asr-25-encoder.mlmodelc",
    )
    result = _run_with_env(
        tmp_path,
        "download",
        "breeze",
        extra_env={"WHISPER_WRAP_ALL_VARIANTS": "1"},
        registry=registry,
    )
    assert result.returncode == 0, result.stderr
    # All-variants mode: log mentions both formats and both rows say
    # "already installed".
    assert "(ALL=1)" in result.stdout
    assert "variant #0 (ct2)" in result.stdout
    assert "variant #1 (ggml)" in result.stdout
    # Skip messages for both
    assert result.stdout.count("already installed") == 2


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
    assert "no default entry" in result.stderr or "exactly one" in result.stderr


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
    assert "multiple default" in result.stderr or "exactly one" in result.stderr


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
