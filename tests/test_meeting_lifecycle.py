"""Lifecycle tests for MeetingAnalyzer's lazy-loading guarantee.

The whole point of separating the meeting pipeline from the FastAPI lifespan
is that servers that never call /transcribe/meeting pay zero startup cost
for the WhisperX + pyannote model load. These tests pin that contract.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from app.services.meeting import MeetingAnalyzer

# Lifecycle test uses the real fixture path because `_run_diarize` now
# pre-decodes the WAV via `wave.open()` (torchcodec workaround), so a
# made-up `/tmp/anything.wav` would fail with FileNotFoundError before
# the actual lifecycle assertions run.
FIXTURE_WAV = Path(__file__).parent / "fixtures" / "meeting" / "two_speaker_30s.wav"


def _fresh_analyzer() -> MeetingAnalyzer:
    return MeetingAnalyzer(
        ct2_model_dir="/nonexistent/ct2",
        hf_token="fake-token",
        diarization_pipeline="pyannote/speaker-diarization-3.1",
    )


def test_constructor_does_not_import_whisperx_or_pyannote(monkeypatch):
    """Instantiating MeetingAnalyzer SHALL NOT import whisperx or pyannote.audio."""
    monkeypatch.delitem(sys.modules, "whisperx", raising=False)
    monkeypatch.delitem(sys.modules, "pyannote.audio", raising=False)

    _fresh_analyzer()

    assert "whisperx" not in sys.modules, "constructor must not import whisperx"
    assert "pyannote.audio" not in sys.modules, (
        "constructor must not import pyannote.audio"
    )


@pytest.mark.asyncio
async def test_lifespan_does_not_load_meeting_models(monkeypatch):
    """Booting the FastAPI app SHALL NOT trigger the meeting pipeline load.

    We assert this by running the actual app lifespan and confirming that
    whisperx + pyannote.audio remain absent from sys.modules afterwards.
    """
    monkeypatch.delitem(sys.modules, "whisperx", raising=False)
    monkeypatch.delitem(sys.modules, "pyannote.audio", raising=False)

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as _client:
        # Lifespan startup ran (model + persistence + actions loaded). Make
        # sure no meeting-mode load was triggered as a side effect.
        assert "whisperx" not in sys.modules
        assert "pyannote.audio" not in sys.modules


@pytest.mark.asyncio
async def test_first_analyze_loads_models_second_call_reuses_them(monkeypatch):
    """First analyze() loads the underlying models exactly once; the second
    analyze() SHALL reuse them (no second whisperx.load_model / pyannote
    Pipeline.from_pretrained call)."""
    asr_load_calls = 0
    pipeline_load_calls = 0

    class _FakeASR:
        def transcribe(self, audio, language=None, batch_size=None):
            return {"language": "en", "segments": []}

    def fake_load_model(model_dir, device=None, compute_type=None, threads=None):
        nonlocal asr_load_calls
        asr_load_calls += 1
        return _FakeASR()

    def fake_load_audio(_path):
        return b"audio"

    def fake_assign_word_speakers(_diar, segs):
        return {
            "segments": [
                {**s, "speaker": "SPEAKER_00"} for s in segs.get("segments", [])
            ]
        }

    fake_wx = types.ModuleType("whisperx")
    fake_wx.load_model = fake_load_model
    fake_wx.load_audio = fake_load_audio
    fake_wx.assign_word_speakers = fake_assign_word_speakers
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)

    class _FakePipeline:
        @classmethod
        def from_pretrained(cls, _name, token=None):
            nonlocal pipeline_load_calls
            pipeline_load_calls += 1
            return cls()

        def __call__(self, _audio_path, **_kwargs):
            return object()

    fake_pa_audio = types.ModuleType("pyannote.audio")
    fake_pa_audio.Pipeline = _FakePipeline
    fake_pa = types.ModuleType("pyannote")
    fake_pa.audio = fake_pa_audio
    monkeypatch.setitem(sys.modules, "pyannote", fake_pa)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_pa_audio)

    analyzer = _fresh_analyzer()
    assert asr_load_calls == 0, "constructor must not load ASR model"
    assert pipeline_load_calls == 0, "constructor must not load diarization pipeline"

    await analyzer.analyze(str(FIXTURE_WAV), enable_word_timestamps=False)
    assert asr_load_calls == 1, "first analyze() must load ASR model exactly once"
    assert pipeline_load_calls == 1, (
        "first analyze() must load diarization pipeline exactly once"
    )
    assert analyzer.loaded is True

    await analyzer.analyze(str(FIXTURE_WAV), enable_word_timestamps=False)
    assert asr_load_calls == 1, "second analyze() must reuse the ASR model"
    assert pipeline_load_calls == 1, (
        "second analyze() must reuse the diarization pipeline"
    )
