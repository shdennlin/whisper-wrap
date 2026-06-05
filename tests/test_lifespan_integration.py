"""Integration tests for app.main._build_backend() — variant resolution + MODEL_DIR.

Covers the "Lifespan selects backend based on resolved variant format" requirement
in the whisper-backend spec. Tests target `_build_backend()` directly so they
don't depend on starting an actual FastAPI TestClient or loading a real model.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _make_ggml_dir(tmp_path: Path) -> Path:
    """Lay down a ggml-format model directory (with adjacent .mlmodelc)."""
    d = tmp_path / "breeze-asr-25-ggml"
    d.mkdir(parents=True)
    (d / "ggml-breeze-asr-25-q6_k.bin").write_bytes(b"GGML")
    encoder = d / "ggml-breeze-asr-25-encoder.mlmodelc"
    encoder.mkdir()
    (encoder / "coremldata.bin").write_bytes(b"coreml")
    return d


def _make_ct2_dir(tmp_path: Path) -> Path:
    """Lay down a ct2-format model directory."""
    d = tmp_path / "breeze-asr-25-ct2"
    d.mkdir(parents=True)
    (d / "model.bin").write_bytes(b"x")
    (d / "tokenizer.json").write_text("{}")
    return d


# ---------- MODEL_DIR layout inspection ----------


@pytest.mark.skipif(
    sys.platform != "darwin", reason="ggml branch requires pywhispercpp (macOS)"
)
def test_model_dir_override_ggml(tmp_path):
    """MODEL_DIR pointing at a directory with ggml-*.bin SHALL instantiate the pywhispercpp backend."""
    ggml_dir = _make_ggml_dir(tmp_path)

    with patch("app.services.whisper_cpp.Model") as MockModel:  # noqa: N806
        MockModel.return_value = MagicMock()
        from app.main import _build_backend

        backend, metadata = _build_backend(
            model_dir_override=str(ggml_dir),
            model_name=None,
            backend_format_override=None,
            compute_type="default",
            device="auto",
        )

    assert metadata["backend"] == "pywhispercpp"
    assert metadata["format"] == "ggml"
    assert metadata["local_dir"] == str(ggml_dir)
    # quant inferred from filename suffix
    assert metadata["quant"] == "q6_k"


def test_model_dir_override_ct2(tmp_path):
    """MODEL_DIR pointing at a directory with model.bin SHALL instantiate the CT2 backend."""
    ct2_dir = _make_ct2_dir(tmp_path)

    with patch("app.services.whisper_ct2.WhisperModel") as MockModel:  # noqa: N806
        MockModel.return_value = MagicMock()
        from app.main import _build_backend

        backend, metadata = _build_backend(
            model_dir_override=str(ct2_dir),
            model_name=None,
            backend_format_override=None,
            compute_type="int8_float16",
            device="cpu",
        )

    assert metadata["backend"] == "ctranslate2"
    assert metadata["format"] == "ct2"
    assert metadata["compute_type"] == "int8_float16"
    assert metadata["local_dir"] == str(ct2_dir)


def test_model_dir_override_unrecognised_layout_raises(tmp_path):
    """A MODEL_DIR with neither model.bin nor ggml-*.bin SHALL fail with WhisperLoadError."""
    empty = tmp_path / "garbage"
    empty.mkdir()
    (empty / "readme.txt").write_text("not a model")

    from app.main import _build_backend
    from app.services._whisper_backend import WhisperLoadError

    with pytest.raises(WhisperLoadError, match=r"model\.bin or a ggml"):
        _build_backend(
            model_dir_override=str(empty),
            model_name=None,
            backend_format_override=None,
            compute_type="default",
            device="auto",
        )


# ---------- Registry path: unknown model + missing variant ----------


def test_default_model_unknown_in_registry_raises(monkeypatch, tmp_path):
    """MODEL_NAME not declared in the registry SHALL fail at startup with a clear error."""
    from app.main import _build_backend
    from app.services._whisper_backend import WhisperLoadError

    with pytest.raises(WhisperLoadError, match=r"not declared in registry"):
        _build_backend(
            model_dir_override=None,
            model_name="no-such-model",
            backend_format_override=None,
            compute_type="default",
            device="auto",
        )


@pytest.mark.skipif(
    sys.platform != "darwin", reason="ggml branch requires pywhispercpp (macOS)"
)
def test_macos_default_loads_pywhispercpp(monkeypatch, tmp_path):
    """On darwin with the default registry, MODEL_NAME=breeze-asr-25 SHALL resolve to ggml."""
    # Point models root at a tmp_path so we can pre-install only the ggml variant.
    monkeypatch.chdir(tmp_path)
    # Symlink registry into tmp_path so resolve_variant() finds it
    registry_src = Path(__file__).resolve().parent.parent / "registry"
    (tmp_path / "registry").symlink_to(registry_src)
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    _make_ggml_dir(models_dir)  # creates models/breeze-asr-25-ggml/...

    with patch("app.services.whisper_cpp.Model") as MockModel:  # noqa: N806
        MockModel.return_value = MagicMock()
        from app.main import _build_backend

        backend, metadata = _build_backend(
            model_dir_override=None,
            model_name="breeze-asr-25",
            backend_format_override=None,
            compute_type="default",
            device="auto",
        )

    assert metadata["backend"] == "pywhispercpp"
    assert metadata["format"] == "ggml"
    assert metadata["quant"] == "q6_k"


def test_backend_format_override_picks_explicit_variant(monkeypatch, tmp_path):
    """BACKEND_FORMAT=ct2 SHALL pick the ct2 variant regardless of platform default_on."""
    monkeypatch.chdir(tmp_path)
    registry_src = Path(__file__).resolve().parent.parent / "registry"
    (tmp_path / "registry").symlink_to(registry_src)
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    _make_ct2_dir(models_dir)  # creates models/breeze-asr-25-ct2/...

    with patch("app.services.whisper_ct2.WhisperModel") as MockModel:  # noqa: N806
        MockModel.return_value = MagicMock()
        from app.main import _build_backend

        backend, metadata = _build_backend(
            model_dir_override=None,
            model_name="breeze-asr-25",
            backend_format_override="ct2",
            compute_type="int8_float16",
            device="auto",
        )

    assert metadata["backend"] == "ctranslate2"
    assert metadata["format"] == "ct2"


def test_backend_format_ggml_on_linux_fails_at_resolve(monkeypatch, tmp_path):
    """BACKEND_FORMAT=ggml on a non-darwin platform SHALL be rejected by resolve_variant.

    Since we're on darwin here, we simulate by patching `sys.platform` inside the
    registry module. (The lifespan reads `sys.platform` directly.)
    """
    monkeypatch.chdir(tmp_path)
    registry_src = Path(__file__).resolve().parent.parent / "registry"
    (tmp_path / "registry").symlink_to(registry_src)

    monkeypatch.setattr("app.main.sys.platform", "linux")

    from app.main import _build_backend
    from app.services._whisper_backend import WhisperLoadError
    from app.services.registry import RegistryError

    # On linux, BACKEND_FORMAT=ggml is rejected by resolve_variant which raises
    # RegistryError; _build_backend doesn't wrap that into WhisperLoadError so we
    # accept either.
    with pytest.raises((WhisperLoadError, RegistryError), match=r"(ggml|linux)"):
        _build_backend(
            model_dir_override=None,
            model_name="breeze-asr-25",
            backend_format_override="ggml",
            compute_type="default",
            device="auto",
        )
