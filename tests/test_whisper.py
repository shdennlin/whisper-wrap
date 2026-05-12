"""Tests for the v2 in-process faster-whisper wrapper (app/services/whisper.py)."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.whisper import (
    WhisperClient,
    WhisperLoadError,
    WhisperTranscriptionError,
)


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


async def test_transcribe_success(tmp_wav, mock_model):
    client = WhisperClient(model=mock_model)
    result = await client.transcribe(tmp_wav)
    assert "text" in result
    assert result["text"] == "hello world"
    assert result["language"] == "en"
    assert isinstance(result["segments"], list)
    assert result["segments"][0]["text"] == "hello world"


async def test_transcribe_language_forwarded(tmp_wav, mock_model):
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, language="zh")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] == "zh"


async def test_transcribe_auto_language_mapped_to_none(tmp_wav, mock_model):
    """The 'auto' sentinel SHALL map to None for faster-whisper's auto-detect."""
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, language="auto")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] is None


async def test_transcribe_initial_prompt_forwarded(tmp_wav, mock_model):
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, initial_prompt="custom prompt seed")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["initial_prompt"] == "custom prompt seed"


async def test_transcribe_no_prompt_passes_through(tmp_wav, mock_model):
    """When initial_prompt is None, the wrapper SHALL forward None (no seed)."""
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, initial_prompt=None)
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["initial_prompt"] is None


async def test_transcribe_both_language_and_prompt_forwarded(tmp_wav, mock_model):
    """Both kwargs SHALL flow into the underlying WhisperModel.transcribe call."""
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, language="zh", initial_prompt="seed")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] == "zh"
    assert kwargs["initial_prompt"] == "seed"


async def test_transcribe_only_language_forwarded_no_prompt(tmp_wav, mock_model):
    """When only `language` is set, initial_prompt forwards None (no default seed)."""
    client = WhisperClient(model=mock_model)
    await client.transcribe(tmp_wav, language="en")
    kwargs = mock_model.transcribe.call_args.kwargs
    assert kwargs["language"] == "en"
    assert kwargs["initial_prompt"] is None


async def test_postprocessing_joins_newlines_and_normalizes(tmp_wav):
    """Raw segments with newlines + zh punctuation SHALL be joined and normalised."""
    model = MagicMock()
    # Two zh-punctuation segments separated by newline; English mode maps zh punct → en.
    model.transcribe.return_value = (
        iter(_fake_segments("hello world，", "\n", "more text.")),
        _fake_info("en"),
    )
    client = WhisperClient(model=model)
    result = await client.transcribe(tmp_wav)
    # zh comma normalised to en comma (target language = "en" from info)
    assert "，" not in result["text"]
    assert "," in result["text"]
    # No standalone newline survives the join step
    assert "\n" not in result["text"]


async def test_transcribe_missing_file_raises_filenotfound(tmp_path, mock_model):
    client = WhisperClient(model=mock_model)
    missing = tmp_path / "nope.wav"
    with pytest.raises(FileNotFoundError, match="WAV file not found"):
        await client.transcribe(missing)


async def test_transcribe_model_exception_mapped_to_transcription_error(tmp_wav):
    model = MagicMock()
    model.transcribe.side_effect = RuntimeError("ct2 crashed")
    client = WhisperClient(model=model)
    with pytest.raises(WhisperTranscriptionError, match="ct2 crashed"):
        await client.transcribe(tmp_wav)


def test_load_model_failure_raises_typed_error(monkeypatch):
    """load_model() SHALL wrap WhisperModel construction errors in WhisperLoadError."""
    from app.services import whisper as whisper_module

    def boom(*args, **kwargs):
        raise FileNotFoundError("model.bin missing")

    monkeypatch.setattr(whisper_module, "WhisperModel", boom)
    with pytest.raises(WhisperLoadError, match="model.bin missing"):
        whisper_module.load_model("/nope/dir")
