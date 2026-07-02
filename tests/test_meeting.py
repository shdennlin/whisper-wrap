"""Tests for `app/services/meeting.py` MeetingAnalyzer.

The WhisperX and pyannote dependencies are NOT installed in the test
environment by design — the `[meeting]` extra is opt-in. These tests
monkeypatch the analyzer's per-stage methods so the orchestration and merge
logic are exercised without dragging the ML stack in.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.meeting import MeetingAnalyzer, MeetingResult, Segment, Word

FIXTURE_WAV = Path(__file__).parent / "fixtures" / "meeting" / "two_speaker_30s.wav"


def _fake_pipeline(
    speakers: list[str] = ("SPEAKER_00", "SPEAKER_01"),
    language: str = "en",
) -> tuple:
    """Build aligned + diarize outputs that mimic WhisperX shapes."""
    aligned = {
        "language": language,
        "segments": [
            {
                "start": 0.0,
                "end": 5.5,
                "text": " First speaker says hello.",
                "words": [
                    {"word": "First", "start": 0.0, "end": 0.5},
                    {"word": "speaker", "start": 0.5, "end": 1.0},
                ],
            },
            {
                "start": 6.0,
                "end": 11.2,
                "text": " Second speaker replies.",
                "words": [
                    {"word": "Second", "start": 6.0, "end": 6.5},
                    {"word": "speaker", "start": 6.5, "end": 7.0},
                ],
            },
        ],
    }
    diarize_out = (
        object()
    )  # opaque to the test; merge consumes it via assign_word_speakers

    def fake_assign(_diar, segs):
        out = {"segments": []}
        for seg, sp in zip(segs["segments"], speakers, strict=False):
            out["segments"].append({**seg, "speaker": sp})
        return out

    return aligned, diarize_out, fake_assign


def _make_analyzer() -> MeetingAnalyzer:
    return MeetingAnalyzer(
        ct2_model_dir="/nonexistent/ct2",
        hf_token="fake-token",
        diarization_pipeline="pyannote/speaker-diarization-3.1",
    )


def test_fixture_exists():
    """Sanity check: the test fixture must be on disk."""
    assert FIXTURE_WAV.exists(), f"fixture missing: {FIXTURE_WAV}"


@pytest.mark.asyncio
async def test_analyzer_runs_pipeline_on_fixture(monkeypatch):
    """End-to-end pipeline returns at least two SPEAKER_* labels for a
    two-speaker fixture (WhisperX + pyannote stages mocked)."""
    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    async def _noop_load(self):
        self._loaded = True

    async def _fake_asr(self, path, *, language=None):
        return {"language": "en", "segments": aligned["segments"]}

    async def _fake_align(self, asr_out, path):
        return aligned

    async def _fake_diarize(
        self, path, *, num_speakers=None, min_speakers=None, max_speakers=None
    ):
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)

    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", _noop_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_asr", _fake_asr)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", _fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", _fake_diarize)

    result = await analyzer.analyze(str(FIXTURE_WAV))

    assert isinstance(result, MeetingResult)
    assert len(result.speakers) >= 2
    assert all(sp.startswith("SPEAKER_") for sp in result.speakers)
    assert len(result.segments) == 2
    assert result.segments[0].speaker != result.segments[1].speaker


def test_pyannote_output_converted_to_dataframe():
    """`_pyannote_output_to_df` SHALL produce the DataFrame shape that
    WhisperX's `assign_word_speakers` consumes. Without it, the merge
    stage crashes with `TypeError: object of type 'DiarizeOutput' has
    no len()` — the regression that surfaced once Fast mode reached
    the merge stage (no path had previously gotten that far on a real
    long file)."""
    import pandas as pd

    from app.services.meeting import _pyannote_output_to_df

    # Stand-in for a pyannote Annotation: only needs `itertracks`. The
    # tuple shape `(segment, label, speaker)` matches what pyannote
    # actually yields when `yield_label=True`.
    class _Segment:
        def __init__(self, start: float, end: float) -> None:
            self.start = start
            self.end = end

    class _FakeAnnotation:
        def itertracks(self, yield_label: bool = False):
            assert yield_label is True
            yield (_Segment(0.0, 1.5), "track_0", "SPEAKER_00")
            yield (_Segment(1.5, 3.2), "track_1", "SPEAKER_01")

    # Path 1: DiarizeOutput-style wrapper with `.speaker_diarization`.
    class _DiarizeOutput:
        speaker_diarization = _FakeAnnotation()

    df = _pyannote_output_to_df(_DiarizeOutput())
    assert isinstance(df, pd.DataFrame)
    assert list(df.columns) == ["segment", "label", "speaker", "start", "end"]
    assert len(df) == 2
    assert df["speaker"].tolist() == ["SPEAKER_00", "SPEAKER_01"]
    assert df["start"].tolist() == [0.0, 1.5]
    assert df["end"].tolist() == [1.5, 3.2]

    # Path 2: bare Annotation (community-1 / older pipelines).
    df2 = _pyannote_output_to_df(_FakeAnnotation())
    assert isinstance(df2, pd.DataFrame)
    assert len(df2) == 2


def test_load_wav_for_pyannote_accepts_path_objects():
    """`_load_wav_for_pyannote` SHALL accept both `str` and `Path`. The
    upload path in `app/api/meeting.py` carries `Path` objects through
    `audio_converter.convert_to_wav`, so a str-only contract crashes
    the diarize stage with `'PosixPath' object has no attribute 'read'`
    inside Python's stdlib `wave.open` (the regression that surfaced
    after the torchcodec workaround was merged)."""
    from app.services.meeting import _load_wav_for_pyannote

    # Path object — the real upload path uses pathlib.Path everywhere.
    out_path = _load_wav_for_pyannote(FIXTURE_WAV)
    assert isinstance(out_path, dict)
    assert out_path["sample_rate"] == 16000


def test_load_wav_for_pyannote_returns_dict_shape():
    """`_load_wav_for_pyannote` SHALL return the dict format pyannote
    expects when bypassing torchcodec: `{"waveform": Tensor (1, N),
    "sample_rate": 16000}`. This contract is what unblocks the diarize
    stage when torchcodec's macOS dylib fails to load (the original
    `AudioDecoder is not defined` crash).
    """
    from app.services.meeting import _load_wav_for_pyannote

    out = _load_wav_for_pyannote(str(FIXTURE_WAV))

    assert isinstance(out, dict)
    assert set(out.keys()) == {"waveform", "sample_rate"}
    assert out["sample_rate"] == 16000
    # Shape contract: (n_channels, n_samples) — mono = 1 channel.
    assert out["waveform"].dim() == 2
    assert out["waveform"].shape[0] == 1
    # 40-second fixture → ~640000 samples at 16 kHz. Allow generous
    # bounds so a fixture re-encode doesn't break the test.
    assert 100_000 < out["waveform"].shape[1] < 1_000_000
    # Should be normalised to [-1.0, 1.0] (16-bit PCM divided by 32768).
    assert out["waveform"].abs().max().item() <= 1.0


@pytest.mark.asyncio
async def test_diarize_passes_pre_decoded_dict_to_pyannote(monkeypatch):
    """`_run_diarize` SHALL pre-decode the WAV and pass it as a dict
    (`{"waveform": Tensor, "sample_rate": int}`) instead of the raw path
    string. This is the workaround for the torchcodec dylib bug on
    macOS — without it, pyannote crashes with `NameError: AudioDecoder
    is not defined` deep inside `get_audio_metadata`.
    """
    analyzer = _make_analyzer()

    received_args: dict = {}

    def fake_pipeline_call(audio_input, **kwargs):
        received_args["audio_input"] = audio_input
        received_args["kwargs"] = kwargs
        # Return a stand-in DiarizeOutput so _pyannote_output_to_df can
        # extract `.speaker_diarization` without exploding. The conversion
        # is exercised separately by
        # `test_pyannote_output_converted_to_dataframe`; here we only
        # care about what was passed IN to the pipeline.
        class _EmptyDiarization:
            def itertracks(self, yield_label=False):
                return iter([])

        class _Out:
            speaker_diarization = _EmptyDiarization()

        return _Out()

    analyzer._diarize = fake_pipeline_call

    await analyzer._run_diarize(
        str(FIXTURE_WAV),
        num_speakers=2,
        min_speakers=None,
        max_speakers=None,
    )

    audio_input = received_args["audio_input"]
    assert isinstance(audio_input, dict), (
        "diarize SHALL be called with the pre-decoded dict, not a path "
        "string (torchcodec workaround)"
    )
    assert audio_input["sample_rate"] == 16000
    assert audio_input["waveform"].shape[0] == 1
    # num_speakers SHALL be forwarded as a pipeline kwarg.
    assert received_args["kwargs"].get("num_speakers") == 2


@pytest.mark.asyncio
async def test_analyze_with_external_asr_skips_asr(monkeypatch):
    """Fast path: `analyze_with_external_asr` SHALL run align+diarize+merge
    using caller-supplied segments WITHOUT touching the internal ASR
    stage. This is the contract that lets the meeting endpoint reuse the
    fast /transcribe backend (ggml+ANE) instead of WhisperX's CT2 ASR."""
    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    asr_called = False
    align_called_with: dict = {}
    diarize_called = False

    async def _noop_load(self):
        self._loaded = True

    async def _fake_asr(self, path, *, language=None):
        nonlocal asr_called
        asr_called = True
        return {"language": "en", "segments": []}

    async def _fake_align(self, asr_out, path):
        align_called_with.update(asr_out)
        return aligned

    async def _fake_diarize(
        self, path, *, num_speakers=None, min_speakers=None, max_speakers=None
    ):
        nonlocal diarize_called
        diarize_called = True
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)
    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", _noop_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_asr", _fake_asr)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", _fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", _fake_diarize)

    external_segments = [
        {"start": 0.0, "end": 5.5, "text": "First speaker says hello."},
        {"start": 6.0, "end": 11.2, "text": "Second speaker replies."},
    ]
    result = await analyzer.analyze_with_external_asr(
        str(FIXTURE_WAV),
        asr_segments=external_segments,
        language="zh",
    )

    assert asr_called is False, (
        "_run_asr SHALL NOT be called on the fast path"
    )
    assert diarize_called is True
    assert align_called_with["language"] == "zh"
    assert align_called_with["segments"] == external_segments
    assert isinstance(result, MeetingResult)
    assert len(result.segments) == 2


@pytest.mark.asyncio
async def test_analyze_with_external_asr_skips_align_when_word_ts_off(
    monkeypatch,
):
    """`enable_word_timestamps=False` SHALL skip align entirely on the fast
    path — the merge then runs with caller-supplied segments directly,
    same as on the slow path."""
    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    align_called = False

    async def _noop_load(self):
        self._loaded = True

    async def _fake_align(self, asr_out, path):
        nonlocal align_called
        align_called = True
        return aligned

    async def _fake_diarize(
        self, path, *, num_speakers=None, min_speakers=None, max_speakers=None
    ):
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)
    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", _noop_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", _fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", _fake_diarize)

    external_segments = [
        {"start": 0.0, "end": 5.5, "text": "A."},
        {"start": 6.0, "end": 11.2, "text": "B."},
    ]
    result = await analyzer.analyze_with_external_asr(
        str(FIXTURE_WAV),
        asr_segments=external_segments,
        language="en",
        enable_word_timestamps=False,
    )

    assert align_called is False
    assert all(seg.words is None for seg in result.segments)


@pytest.mark.asyncio
async def test_analyze_with_external_asr_progress_cancellation(monkeypatch):
    """Progress callback raising CancelledError SHALL abort the fast
    pipeline cleanly — diarize MUST NOT run after a cancel raised in the
    asr_external progress checkpoint."""
    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    diarize_called = False

    async def _noop_load(self):
        self._loaded = True

    async def _fake_align(self, asr_out, path):
        return aligned

    async def _fake_diarize(
        self, path, *, num_speakers=None, min_speakers=None, max_speakers=None
    ):
        nonlocal diarize_called
        diarize_called = True
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)
    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", _noop_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", _fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", _fake_diarize)

    def aborting_progress(stage: str, progress: float) -> None:
        # Cancellation kicked in at the asr_external checkpoint — same
        # contract the meeting endpoint relies on for DELETE-during-job.
        if stage == "asr_external":
            raise asyncio.CancelledError("user cancelled")

    import asyncio

    with pytest.raises(asyncio.CancelledError):
        await analyzer.analyze_with_external_asr(
            str(FIXTURE_WAV),
            asr_segments=[{"start": 0.0, "end": 1.0, "text": "x"}],
            language="en",
            progress_callback=aborting_progress,
        )
    assert diarize_called is False


@pytest.mark.asyncio
async def test_analyzer_omits_words_when_word_timestamps_disabled(monkeypatch):
    """`enable_word_timestamps=False` skips the alignment stage and emits no
    `words` field per segment."""
    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    align_called = False

    async def _noop_load(self):
        self._loaded = True

    async def _fake_asr(self, path, *, language=None):
        return {"language": "en", "segments": aligned["segments"]}

    async def _fake_align(self, asr_out, path):
        nonlocal align_called
        align_called = True
        return aligned

    async def _fake_diarize(
        self, path, *, num_speakers=None, min_speakers=None, max_speakers=None
    ):
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)

    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", _noop_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_asr", _fake_asr)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", _fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", _fake_diarize)

    result = await analyzer.analyze(str(FIXTURE_WAV), enable_word_timestamps=False)

    assert align_called is False, "alignment must NOT run when word timestamps disabled"
    assert all(seg.words is None for seg in result.segments)


def test_analyzer_uses_registry_ct2_path(monkeypatch):
    """`MeetingAnalyzer.from_config()` SHALL resolve the ASR model directory
    through `app.services.registry.resolve_ct2_variant` so the meeting endpoint
    shares the same model storage layout as the rest of the server."""
    from app.config import Config
    from app.services import registry

    captured: dict[str, str] = {}

    def fake_resolve_info(name):
        captured["name"] = name
        # Mirror the registry shape: every CT2 variant SHALL have
        # `local_dir` and SHOULD have `compute_type` (used to keep CPU
        # inference quantised rather than falling back to the float32 default).
        return {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8_float16",
        }

    monkeypatch.setattr(registry, "resolve_ct2_variant_info", fake_resolve_info)
    # MeetingAnalyzer.from_config does `from app.services.registry import …`
    # at call time, so patching the attribute on the module suffices.
    monkeypatch.setattr("sys.platform", "linux")

    monkeypatch.setenv("MEETING_MODEL_NAME", "some-other-model")
    monkeypatch.setenv("HF_TOKEN", "abc")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)

    assert captured["name"] == "some-other-model"
    assert analyzer.ct2_model_dir.endswith("some-other-model-ct2")
    assert analyzer.hf_token == "abc"
    assert analyzer.diarization_pipeline_name == "pyannote/speaker-diarization-3.1"
    # The meeting ct2 ASR runs on CPU on every platform (device is never wired
    # to CUDA in from_config), so the registry's int8_float16 is downgraded to
    # int8 here too — CPU has no float16 SIMD path. Regression guard for the
    # Linux-CPU crash "target device or backend do not support int8_float16".
    assert analyzer.compute_type == "int8"


def test_analyzer_downgrades_int8_float16_on_macos_cpu(monkeypatch):
    """Apple Silicon CPU has no float16 SIMD path, so CTranslate2 rejects
    int8_float16 with `ValueError: target device or backend do not support`.
    `from_config` SHALL transparently downgrade to int8 (which IS supported
    on CPU and gives the same ~3x speedup over float32) so the meeting
    endpoint just works."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8_float16",
        },
    )
    monkeypatch.setattr("sys.platform", "darwin")
    monkeypatch.setenv("MEETING_MODEL_NAME", "breeze-asr-25")
    monkeypatch.setenv("HF_TOKEN", "x")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.compute_type == "int8"


def test_analyzer_downgrades_int8_float16_on_linux_cpu(monkeypatch):
    """Linux CPU also lacks the float16 SIMD path — the meeting ct2 ASR runs
    on CPU on Linux too (device is never wired to CUDA in from_config), so
    int8_float16 SHALL downgrade to int8 here as well. Without this the
    endpoint crashes with "target device or backend do not support efficient
    int8_float16 computation" (the original Linux-deployment bug)."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8_float16",
        },
    )
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setenv("MEETING_MODEL_NAME", "breeze-asr-25")
    monkeypatch.setenv("HF_TOKEN", "x")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.compute_type == "int8"


def test_analyzer_keeps_int8_on_macos(monkeypatch):
    """The downgrade SHALL only trigger when the registry asks for the
    unsupported int8_float16. Plain int8 SHALL pass through untouched."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8",
        },
    )
    monkeypatch.setattr("sys.platform", "darwin")
    monkeypatch.setenv("MEETING_MODEL_NAME", "any-model")
    monkeypatch.setenv("HF_TOKEN", "x")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.compute_type == "int8"


def test_analyzer_passes_cpu_threads_from_config(monkeypatch):
    """CPU_THREADS env var SHALL flow through from_config → analyzer →
    eventually `cpu_threads` kwarg on faster_whisper.WhisperModel. Without
    this knob, CT2 picks 4 regardless of host core count — Apple Silicon
    M2 leaves 4 cores idle by default."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8",
        },
    )
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setenv("MEETING_MODEL_NAME", "any-model")
    monkeypatch.setenv("HF_TOKEN", "x")
    monkeypatch.setenv("CPU_THREADS", "8")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.cpu_threads == 8


def test_analyzer_cpu_threads_unset_passes_none(monkeypatch):
    """Unset CPU_THREADS SHALL leave analyzer.cpu_threads=None so the
    library default is preserved (we don't impose a value)."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8",
        },
    )
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setenv("MEETING_MODEL_NAME", "any-model")
    monkeypatch.setenv("HF_TOKEN", "x")
    monkeypatch.delenv("CPU_THREADS", raising=False)
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.cpu_threads is None


def test_analyzer_batch_size_defaults_to_32(monkeypatch):
    """Unset MEETING_BATCH_SIZE SHALL pass 32 through to the analyzer so
    the WhisperX transcribe step uses the documented sweet spot for CPU
    batched inference instead of the library default of 16."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8",
        },
    )
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setenv("MEETING_MODEL_NAME", "any-model")
    monkeypatch.setenv("HF_TOKEN", "x")
    monkeypatch.delenv("MEETING_BATCH_SIZE", raising=False)
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.batch_size == 32


def test_analyzer_batch_size_override(monkeypatch):
    """Explicit MEETING_BATCH_SIZE SHALL flow through to the analyzer."""
    from app.config import Config
    from app.services import registry

    monkeypatch.setattr(
        registry,
        "resolve_ct2_variant_info",
        lambda name: {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8",
        },
    )
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setenv("MEETING_MODEL_NAME", "any-model")
    monkeypatch.setenv("HF_TOKEN", "x")
    monkeypatch.setenv("MEETING_BATCH_SIZE", "64")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)
    assert analyzer.batch_size == 64


def test_torch_device_auto_falls_back_to_cpu_when_no_accelerator(monkeypatch):
    """`MEETING_TORCH_DEVICE=auto` SHALL resolve to 'cpu' when neither MPS
    nor CUDA is available — this is the safe default for headless Linux
    boxes without a GPU."""
    from app.services.meeting import _resolve_torch_device

    class _FakeMpsBackend:
        @staticmethod
        def is_available() -> bool:
            return False

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _FakeTorch:
        backends = type("X", (), {"mps": _FakeMpsBackend})()
        cuda = _FakeCuda()

    monkeypatch.setitem(__import__("sys").modules, "torch", _FakeTorch)
    monkeypatch.setattr("sys.platform", "linux")
    assert _resolve_torch_device("auto") == "cpu"


def test_torch_device_auto_picks_mps_on_darwin(monkeypatch):
    """On macOS with MPS available, `auto` SHALL resolve to 'mps' so the
    align + diarize stages get the Metal GPU instead of running on CPU."""
    from app.services.meeting import _resolve_torch_device

    class _FakeMpsBackend:
        @staticmethod
        def is_available() -> bool:
            return True

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _FakeTorch:
        backends = type("X", (), {"mps": _FakeMpsBackend})()
        cuda = _FakeCuda()

    monkeypatch.setitem(__import__("sys").modules, "torch", _FakeTorch)
    monkeypatch.setattr("sys.platform", "darwin")
    assert _resolve_torch_device("auto") == "mps"


def test_torch_device_forced_mps_falls_back_when_unavailable(monkeypatch, caplog):
    """Forcing `mps` on a system without MPS SHALL log a warning and fall
    back to cpu instead of raising — we want the meeting endpoint to keep
    serving even when an env var is misconfigured for the deploy target."""
    import logging

    from app.services.meeting import _resolve_torch_device

    class _FakeMpsBackend:
        @staticmethod
        def is_available() -> bool:
            return False

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _FakeTorch:
        backends = type("X", (), {"mps": _FakeMpsBackend})()
        cuda = _FakeCuda()

    monkeypatch.setitem(__import__("sys").modules, "torch", _FakeTorch)
    with caplog.at_level(logging.WARNING, logger="app.services.meeting"):
        assert _resolve_torch_device("mps") == "cpu"
    assert any("MPS not available" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_concurrent_jobs_serialise(monkeypatch):
    """Two analyze() calls submitted back-to-back SHALL execute one at a time:
    the second only enters the pipeline after the first finishes (asyncio.Lock)."""
    import asyncio

    aligned, diar_out, fake_assign = _fake_pipeline()
    analyzer = _make_analyzer()

    gate = asyncio.Event()
    inside = []  # records "enter" / "exit" of the first call's ASR stage

    async def slow_load(self):
        self._loaded = True

    async def gated_asr(self, path, *, language=None):
        inside.append("enter")
        await gate.wait()
        inside.append("exit")
        return {"language": "en", "segments": aligned["segments"]}

    async def fast_asr(self, path, *, language=None):
        return {"language": "en", "segments": aligned["segments"]}

    async def fake_align(self, asr_out, path):
        return aligned

    async def fake_diarize(self, path, **kwargs):
        return diar_out

    import sys
    import types

    fake_wx = types.ModuleType("whisperx")
    fake_wx.assign_word_speakers = fake_assign
    monkeypatch.setitem(sys.modules, "whisperx", fake_wx)

    monkeypatch.setattr(MeetingAnalyzer, "_load_pipeline", slow_load)
    monkeypatch.setattr(MeetingAnalyzer, "_run_asr", gated_asr)
    monkeypatch.setattr(MeetingAnalyzer, "_run_align", fake_align)
    monkeypatch.setattr(MeetingAnalyzer, "_run_diarize", fake_diarize)

    # Launch first job; it will block inside gated_asr until gate.set().
    job_a = asyncio.create_task(analyzer.analyze("/tmp/a.wav"))
    # Let job_a actually enter the ASR stage.
    while not inside:
        await asyncio.sleep(0.01)

    # Launch second job while first is still inside the lock.
    # Swap in a fast ASR so it would complete immediately if it could.
    monkeypatch.setattr(MeetingAnalyzer, "_run_asr", fast_asr)
    job_b = asyncio.create_task(analyzer.analyze("/tmp/b.wav"))

    # Give job_b a chance to run; assert it has NOT progressed.
    await asyncio.sleep(0.05)
    assert not job_b.done(), "second job must wait for the lock"
    assert inside == ["enter"], "first job's ASR must still be in flight"

    # Release first job, both should complete.
    gate.set()
    await asyncio.gather(job_a, job_b)
    assert inside == ["enter", "exit"]


def test_generate_job_id_is_sortable_by_time():
    """Two job IDs generated 1 ms apart SHALL be lexicographically ordered
    (ULID-style time prefix)."""
    from app.services.meeting_jobs import generate_job_id

    a = generate_job_id(now_ms=1_700_000_000_000)
    b = generate_job_id(now_ms=1_700_000_000_001)
    assert a < b
    assert len(a) == 26
    assert len(b) == 26


def test_job_store_lifecycle():
    """JobStore SHALL track a job through pending → running → done with the
    documented fields populated at each step."""
    from app.services.meeting_jobs import Job, JobStore

    store = JobStore()

    job = store.create()
    assert isinstance(job, Job)
    assert job.status == "pending"
    assert job.progress == 0.0
    assert job.result is None
    assert job.error is None
    assert store.get(job.job_id) is job

    store.mark_running(job.job_id, stage="asr")
    assert store.get(job.job_id).status == "running"
    assert store.get(job.job_id).stage == "asr"

    store.update_progress(job.job_id, stage="align", progress=0.4)
    assert store.get(job.job_id).stage == "align"
    assert store.get(job.job_id).progress == 0.4

    result = MeetingResult(
        language="en", duration_seconds=10.0, speakers=["SPEAKER_00"], segments=[]
    )
    store.mark_done(job.job_id, result)
    assert store.get(job.job_id).status == "done"
    assert store.get(job.job_id).stage == "complete"
    assert store.get(job.job_id).progress == 1.0
    assert store.get(job.job_id).result is result


def test_job_store_unknown_id_returns_none():
    from app.services.meeting_jobs import JobStore

    store = JobStore()
    assert store.get("nonexistent") is None


def test_job_store_evicts_expired_jobs_by_ttl():
    """Jobs older than `ttl_seconds` SHALL be evicted on the next prune (i.e.
    on the next create or get) and the get SHALL return None for the evicted id."""
    from app.services.meeting_jobs import JobStore

    now = [1000.0]
    store = JobStore(ttl_seconds=1, max_jobs=100, clock=lambda: now[0])
    job = store.create()
    assert store.get(job.job_id) is not None

    now[0] = 1002.5  # advance 2.5 s past the 1 s TTL
    assert store.get(job.job_id) is None


def test_job_store_capacity_overflow_evicts_oldest_first():
    """When the store would exceed `max_jobs`, the oldest jobs SHALL be evicted
    first (ULID-style IDs sort oldest-first)."""
    from app.services.meeting_jobs import JobStore

    now = [1000.0]
    store = JobStore(ttl_seconds=None, max_jobs=3, clock=lambda: now[0])

    ids: list[str] = []
    for _ in range(4):
        job = store.create()
        ids.append(job.job_id)
        now[0] += 0.01  # spread creation times for stable sort

    assert store.get(ids[0]) is None, "oldest job must be evicted"
    for i in range(1, 4):
        assert store.get(ids[i]) is not None, f"newer job ids[{i}] must remain"


def test_job_store_count_by_status():
    from app.services.meeting_jobs import JobStore

    store = JobStore()
    a = store.create()
    store.create()  # second pending job — included in the count below
    store.mark_running(a.job_id)

    assert store.count_by_status("pending") == 1
    assert store.count_by_status("running") == 1
    assert store.count_by_status("done") == 0


def test_word_segment_dataclass_shapes():
    """Word/Segment/MeetingResult dataclass shapes match the documented contract."""
    w = Word(word="hi", start=0.0, end=0.5)
    s = Segment(speaker="SPEAKER_00", start=0.0, end=0.5, text="hi", words=[w])
    r = MeetingResult(
        language="en", duration_seconds=0.5, speakers=["SPEAKER_00"], segments=[s]
    )
    assert r.segments[0].words[0].word == "hi"
    assert r.speakers == ["SPEAKER_00"]
