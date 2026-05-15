"""Tests for PyWhisperCppBackend (app/services/whisper_cpp.py).

Mocks `pywhispercpp.model.Model` for unit-level coverage so tests run on any host.
A separate hardware-dependent test_lifespan_integration.py covers real ANE loading.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def fake_segments():
    """Build pywhispercpp.model.Segment-shaped objects (t0/t1 in centiseconds)."""

    def _make(*chunks: tuple[int, int, str]) -> list:
        return [
            SimpleNamespace(t0=t0, t1=t1, text=text, probability=1.0)
            for t0, t1, text in chunks
        ]

    return _make


@pytest.fixture
def ggml_model_dir(tmp_path: Path) -> Path:
    """A fake ggml model directory laid out the way pywhispercpp expects."""
    d = tmp_path / "breeze-asr-25-ggml"
    d.mkdir()
    (d / "ggml-breeze-asr-25-q6_k.bin").write_bytes(b"GGML")
    encoder = d / "ggml-breeze-asr-25-encoder.mlmodelc"
    encoder.mkdir()
    (encoder / "coremldata.bin").write_bytes(b"coreml")
    return d


@pytest.fixture
def tmp_wav(tmp_path: Path) -> Path:
    p = tmp_path / "audio.wav"
    p.write_bytes(b"RIFF....WAVE")
    return p


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
def test_satisfies_protocol(ggml_model_dir, fake_segments):
    """PyWhisperCppBackend SHALL satisfy the WhisperBackend Protocol on macOS."""
    from app.services._whisper_backend import WhisperBackend

    with patch("app.services.whisper_cpp.Model") as MockModel:
        instance = MagicMock()
        instance.transcribe.return_value = fake_segments((0, 100, "hello"))
        MockModel.return_value = instance

        from app.services.whisper_cpp import PyWhisperCppBackend

        backend = PyWhisperCppBackend(
            model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
            coreml_encoder=str(ggml_model_dir / "ggml-breeze-asr-25-encoder.mlmodelc"),
            n_threads=4,
        )
        assert isinstance(backend, WhisperBackend)


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
async def test_transcribe_returns_transcription_result(
    ggml_model_dir, tmp_wav, fake_segments
):
    """transcribe() SHALL return a TranscriptionResult dataclass."""
    from app.services._whisper_backend import TranscriptionResult

    with patch("app.services.whisper_cpp.Model") as MockModel:
        instance = MagicMock()
        instance.transcribe.return_value = fake_segments((0, 150, "hello world"))
        MockModel.return_value = instance

        from app.services.whisper_cpp import PyWhisperCppBackend

        backend = PyWhisperCppBackend(
            model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
            coreml_encoder=str(ggml_model_dir / "ggml-breeze-asr-25-encoder.mlmodelc"),
            n_threads=4,
        )

        result = await backend.transcribe(tmp_wav, language="auto", initial_prompt=None)
        assert isinstance(result, TranscriptionResult)
        assert result.text == "hello world"
        # t0=0, t1=150 centiseconds → seconds 0.0, 1.5
        assert result.segments[0].start == 0.0
        assert result.segments[0].end == 1.5
        # duration = t1 of last segment / 100
        assert result.duration_seconds == 1.5


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
async def test_transcribe_pcm_returns_transcription_result(
    ggml_model_dir, fake_segments
):
    import numpy as np

    from app.services._whisper_backend import TranscriptionResult

    with patch("app.services.whisper_cpp.Model") as MockModel:
        instance = MagicMock()
        instance.transcribe.return_value = fake_segments((0, 100, "hi"))
        MockModel.return_value = instance

        from app.services.whisper_cpp import PyWhisperCppBackend

        backend = PyWhisperCppBackend(
            model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
            coreml_encoder=str(ggml_model_dir / "ggml-breeze-asr-25-encoder.mlmodelc"),
            n_threads=4,
        )
        samples = np.zeros(16000, dtype=np.float32)
        result = await backend.transcribe_pcm(samples, language="auto")
        assert isinstance(result, TranscriptionResult)
        assert result.text == "hi"


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
def test_raises_load_error_when_coreml_encoder_missing(ggml_model_dir):
    """A non-existent coreml_encoder path SHALL raise WhisperLoadError naming the path."""
    from app.services._whisper_backend import WhisperLoadError

    missing_encoder = ggml_model_dir / "does-not-exist.mlmodelc"

    with patch("app.services.whisper_cpp.Model"):
        from app.services.whisper_cpp import PyWhisperCppBackend

        with pytest.raises(WhisperLoadError, match=r"does-not-exist\.mlmodelc"):
            PyWhisperCppBackend(
                model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
                coreml_encoder=str(missing_encoder),
                n_threads=4,
            )


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
def test_raises_load_error_when_model_path_missing(tmp_path):
    """A non-existent ggml model_path SHALL raise WhisperLoadError naming the path."""
    from app.services._whisper_backend import WhisperLoadError

    missing = tmp_path / "nope.bin"
    with patch("app.services.whisper_cpp.Model"):
        from app.services.whisper_cpp import PyWhisperCppBackend

        with pytest.raises(WhisperLoadError, match=r"nope\.bin"):
            PyWhisperCppBackend(
                model_path=str(missing), coreml_encoder=None, n_threads=4
            )


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
def test_load_error_message_suggests_download_command(ggml_model_dir):
    """Missing encoder error SHALL mention `make download-model` hint."""
    from app.services._whisper_backend import WhisperLoadError

    missing_encoder = ggml_model_dir / "does-not-exist.mlmodelc"
    with patch("app.services.whisper_cpp.Model"):
        from app.services.whisper_cpp import PyWhisperCppBackend

        with pytest.raises(WhisperLoadError, match=r"make download-model"):
            PyWhisperCppBackend(
                model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
                coreml_encoder=str(missing_encoder),
                n_threads=4,
            )


@pytest.mark.skipif(sys.platform != "darwin", reason="pywhispercpp is macOS-only")
async def test_transcribe_wraps_underlying_errors(
    ggml_model_dir, tmp_wav, fake_segments
):
    """Underlying pywhispercpp errors SHALL surface as WhisperTranscriptionError."""
    from app.services._whisper_backend import WhisperTranscriptionError

    with patch("app.services.whisper_cpp.Model") as MockModel:
        instance = MagicMock()
        instance.transcribe.side_effect = RuntimeError("ggml decode crashed")
        MockModel.return_value = instance

        from app.services.whisper_cpp import PyWhisperCppBackend

        backend = PyWhisperCppBackend(
            model_path=str(ggml_model_dir / "ggml-breeze-asr-25-q6_k.bin"),
            coreml_encoder=str(ggml_model_dir / "ggml-breeze-asr-25-encoder.mlmodelc"),
            n_threads=4,
        )
        with pytest.raises(WhisperTranscriptionError, match="ggml decode crashed"):
            await backend.transcribe(tmp_wav, language="auto", initial_prompt=None)


@pytest.mark.skipif(
    sys.platform == "darwin", reason="Tests the non-darwin platform guard"
)
def test_import_raises_load_error_on_non_darwin():
    """Importing the module on Linux SHALL raise WhisperLoadError instead of ImportError."""
    from app.services._whisper_backend import WhisperLoadError

    # Force a fresh import — the guard fires at module-import time
    sys.modules.pop("app.services.whisper_cpp", None)
    with pytest.raises(WhisperLoadError, match=r"pywhispercpp is not available"):
        import app.services.whisper_cpp  # noqa: F401
