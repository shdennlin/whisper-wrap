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
        # inference at int8_float16 rather than the float32 default).
        return {
            "format": "ct2",
            "local_dir": f"{name}-ct2",
            "compute_type": "int8_float16",
        }

    monkeypatch.setattr(registry, "resolve_ct2_variant_info", fake_resolve_info)
    # MeetingAnalyzer.from_config does `from app.services.registry import …`
    # at call time, so patching the attribute on the module suffices.

    monkeypatch.setenv("MEETING_MODEL_NAME", "some-other-model")
    monkeypatch.setenv("HF_TOKEN", "abc")
    cfg = Config()

    analyzer = MeetingAnalyzer.from_config(cfg)

    assert captured["name"] == "some-other-model"
    assert analyzer.ct2_model_dir.endswith("some-other-model-ct2")
    assert analyzer.hf_token == "abc"
    assert analyzer.diarization_pipeline_name == "pyannote/speaker-diarization-3.1"
    # The compute_type from the registry SHALL flow through; without this
    # WhisperX would default to float32 on CPU (~4x slower).
    assert analyzer.compute_type == "int8_float16"


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
