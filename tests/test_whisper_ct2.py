"""Tests for CTranslate2Backend (app/services/whisper_ct2.py).

Replaces the legacy tests/test_whisper.py mock surface with one that exercises
the WhisperBackend Protocol contract. Per Decision 9: Test mock refactor to
backend Protocol surface, tests that target behaviour shared across backends
exercise the Protocol; CT2-specific behaviour stays here.
"""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


def _fake_segments(*texts: str) -> list:
    return [SimpleNamespace(start=0.0, end=1.0, text=t) for t in texts]


def _fake_info(language: str = "zh", duration: float = 1.0):
    return SimpleNamespace(language=language, duration=duration)


@pytest.fixture
def tmp_wav(tmp_path: Path) -> Path:
    p = tmp_path / "audio.wav"
    p.write_bytes(b"RIFF....WAVE")
    return p


@pytest.fixture
def mock_model():
    """A MagicMock standing in for faster_whisper.WhisperModel."""
    m = MagicMock()
    m.transcribe.return_value = (iter(_fake_segments("hello world")), _fake_info("en"))
    return m


def test_satisfies_protocol(mock_model):
    """CTranslate2Backend SHALL satisfy the WhisperBackend Protocol."""
    from app.services._whisper_backend import WhisperBackend
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    assert isinstance(backend, WhisperBackend), (
        "CTranslate2Backend must conform to WhisperBackend Protocol"
    )


async def test_transcribe_returns_transcription_result(tmp_wav, mock_model):
    """transcribe() SHALL return a TranscriptionResult dataclass, not a dict."""
    from app.services._whisper_backend import TranscriptionResult
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    result = await backend.transcribe(tmp_wav, language="auto", initial_prompt=None)

    assert isinstance(result, TranscriptionResult)
    assert result.text == "hello world"
    assert result.language == "en"
    assert len(result.segments) == 1
    assert result.segments[0].text == "hello world"
    assert result.duration_seconds == 1.0


async def test_transcribe_auto_language_mapped_to_none(tmp_wav, mock_model):
    """The 'auto' sentinel SHALL map to None for faster-whisper's auto-detect."""
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    await backend.transcribe(tmp_wav, language="auto", initial_prompt=None)
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] is None


async def test_transcribe_explicit_language_forwarded(tmp_wav, mock_model):
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    await backend.transcribe(tmp_wav, language="zh", initial_prompt=None)
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] == "zh"


async def test_transcribe_initial_prompt_forwarded(tmp_wav, mock_model):
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    await backend.transcribe(tmp_wav, language="auto", initial_prompt="seed")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["initial_prompt"] == "seed"


async def test_transcribe_missing_file_raises_filenotfound(tmp_path, mock_model):
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    missing = tmp_path / "nope.wav"
    with pytest.raises(FileNotFoundError, match="WAV file not found"):
        await backend.transcribe(missing, language="auto", initial_prompt=None)


async def test_transcribe_model_exception_mapped_to_transcription_error(tmp_wav):
    """Underlying faster-whisper exceptions SHALL be wrapped in WhisperTranscriptionError."""
    from app.services._whisper_backend import WhisperTranscriptionError
    from app.services.whisper_ct2 import CTranslate2Backend

    model = MagicMock()
    model.transcribe.side_effect = RuntimeError("ct2 crashed")
    backend = CTranslate2Backend(model=model)
    with pytest.raises(WhisperTranscriptionError, match="ct2 crashed"):
        await backend.transcribe(tmp_wav, language="auto", initial_prompt=None)


async def test_transcribe_pcm_returns_transcription_result(mock_model):
    """transcribe_pcm() SHALL return a TranscriptionResult, not a bare str."""
    import numpy as np

    from app.services._whisper_backend import TranscriptionResult
    from app.services.whisper_ct2 import CTranslate2Backend

    backend = CTranslate2Backend(model=mock_model)
    samples = np.zeros(16000, dtype=np.float32)
    result = await backend.transcribe_pcm(samples, language="auto")
    assert isinstance(result, TranscriptionResult)
    assert result.text == "hello world"


def test_construct_from_directory_raises_whisper_load_error_on_missing_model(tmp_path):
    """CTranslate2Backend(model_dir=...) SHALL raise WhisperLoadError when model.bin is absent."""
    from app.services._whisper_backend import WhisperLoadError
    from app.services.whisper_ct2 import CTranslate2Backend

    empty_dir = tmp_path / "empty-ct2"
    empty_dir.mkdir()
    with pytest.raises(WhisperLoadError, match="model.bin"):
        CTranslate2Backend(model_dir=str(empty_dir))


def test_construct_from_directory_wraps_faster_whisper_error(tmp_path, monkeypatch):
    """faster_whisper construction errors SHALL surface as WhisperLoadError."""
    from app.services import whisper_ct2

    # Build a directory that has model.bin so the pre-check passes
    model_dir = tmp_path / "fake-ct2"
    model_dir.mkdir()
    (model_dir / "model.bin").write_bytes(b"")
    (model_dir / "tokenizer.json").write_text("{}")

    def boom(*args, **kwargs):
        raise FileNotFoundError("CT2 internals: shared lib missing")

    monkeypatch.setattr(whisper_ct2, "WhisperModel", boom)
    from app.services._whisper_backend import WhisperLoadError

    with pytest.raises(WhisperLoadError, match="shared lib missing"):
        whisper_ct2.CTranslate2Backend(model_dir=str(model_dir))
