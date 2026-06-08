"""Integration tests for POST /transcribe/meeting and GET /transcribe/meeting/{job_id}.

These tests share the `stubbed_app` pattern with test_status.py: the lifespan's
whisper backend is faked so no model loads. The meeting analyzer's `analyze()`
method is monkeypatched per test so the actual WhisperX + pyannote pipeline is
never invoked.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.meeting import MeetingAnalyzer, MeetingResult, Segment, Word

FIXTURE_WAV = Path(__file__).parent / "fixtures" / "meeting" / "two_speaker_30s.wav"


def _fake_meeting_result() -> MeetingResult:
    return MeetingResult(
        language="en",
        duration_seconds=11.2,
        speakers=["SPEAKER_00", "SPEAKER_01"],
        segments=[
            Segment(
                speaker="SPEAKER_00",
                start=0.0,
                end=5.5,
                text="First speaker says hello.",
                words=[Word(word="First", start=0.0, end=0.5)],
            ),
            Segment(
                speaker="SPEAKER_01",
                start=6.0,
                end=11.2,
                text="Second speaker replies.",
                words=[Word(word="Second", start=6.0, end=6.5)],
            ),
        ],
    )


@pytest.fixture
def stubbed_app(monkeypatch):
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (
            MagicMock(name="WhisperBackend"),
            {
                "backend": "ctranslate2",
                "format": "ct2",
                "compute_type": "default",
                "local_dir": "/fake",
            },
        ),
    )
    from app.main import app

    return app


@pytest.fixture
def meeting_available(monkeypatch):
    """Force `check_meeting_availability` to report available so the endpoint
    runs past the 503 gate. Combined with `fake_analyze` it never touches the
    real WhisperX stack."""
    monkeypatch.setattr(
        "app.api.meeting.check_meeting_availability",
        lambda cfg=None: (True, None),
    )
    # Don't actually construct a real MeetingAnalyzer.from_config (it would
    # resolve the registry helper). Patch the getter to return our fake.
    monkeypatch.setattr(
        "app.api.meeting._get_or_create_analyzer",
        lambda request: request.app.state.meeting_analyzer,
    )


def _install_fake_analyzer(app, fake_analyze) -> None:
    analyzer = MeetingAnalyzer(
        ct2_model_dir="/fake/ct2",
        hf_token="fake-token",
        diarization_pipeline="pyannote/speaker-diarization-3.1",
    )
    analyzer.analyze = fake_analyze
    app.state.meeting_analyzer = analyzer


def _post_meeting_audio(client, **query):
    with FIXTURE_WAV.open("rb") as f:
        return client.post(
            "/transcribe/meeting",
            content=f.read(),
            headers={"Content-Type": "audio/wav"},
            params=query,
        )


def test_post_meeting_returns_job_handle(stubbed_app, meeting_available):
    """A valid upload SHALL return HTTP 202 with job_id and status_url."""

    async def fake_analyze(audio_path, **kwargs):
        return _fake_meeting_result()

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, fake_analyze)
        resp = _post_meeting_audio(client)

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert "job_id" in body
    assert body["status_url"] == f"/transcribe/meeting/{body['job_id']}"


def test_post_meeting_invalid_audio_returns_400(stubbed_app, meeting_available):
    """Non-audio content SHALL be rejected with HTTP 400 and a typed reason."""
    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, lambda *a, **kw: None)
        resp = client.post(
            "/transcribe/meeting",
            content=b"this is plain text, not audio",
            headers={"Content-Type": "application/octet-stream"},
        )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_audio"


def test_post_meeting_invalid_speaker_range_returns_400(stubbed_app, meeting_available):
    """min_speakers > max_speakers SHALL produce HTTP 400 with invalid_speaker_range."""
    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, lambda *a, **kw: None)
        resp = _post_meeting_audio(client, min_speakers=5, max_speakers=2)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_speaker_range"


def test_get_meeting_status_phases(stubbed_app, meeting_available):
    """Polling SHALL surface pending → done → 404 transitions."""

    async def fake_analyze(audio_path, **kwargs):
        return _fake_meeting_result()

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, fake_analyze)
        resp = _post_meeting_audio(client)
        job_id = resp.json()["job_id"]
        # Because FastAPI BackgroundTasks runs after the response is sent and
        # TestClient blocks until both are done, by the time we poll the job
        # is already done.
        poll = client.get(f"/transcribe/meeting/{job_id}")
        assert poll.status_code == 200
        body = poll.json()
        assert body["status"] == "done"
        assert body["stage"] == "complete"
        assert body["progress"] == 1.0
        assert body["result"]["speakers"] == ["SPEAKER_00", "SPEAKER_01"]
        assert len(body["result"]["segments"]) == 2

        unknown = client.get("/transcribe/meeting/00000000000000000000000000")
        assert unknown.status_code == 404
        assert unknown.json()["detail"]["error"] == "job_not_found"


def test_get_meeting_status_reports_error_for_failed_pipeline(
    stubbed_app, meeting_available
):
    """Pipeline failures SHALL surface as status: 'error' with a typed code."""

    async def failing_analyze(audio_path, **kwargs):
        raise RuntimeError("pyannote model crashed")

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, failing_analyze)
        resp = _post_meeting_audio(client)
        job_id = resp.json()["job_id"]
        poll = client.get(f"/transcribe/meeting/{job_id}")
    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "error"
    assert body["error"]["code"] in {"asr_failed", "align_failed", "diarize_failed"}
    assert "pyannote" in body["error"]["message"]
    assert body["result"] is None


def test_post_meeting_returns_within_one_second(
    stubbed_app, meeting_available, monkeypatch
):
    """The HTTP response SHALL come back in well under 1 second even when the
    analysis pipeline is slow (proves Async background processing decision).

    TestClient blocks until BackgroundTasks complete, so we measure the
    synchronous body-build latency by stubbing `add_task` to a no-op for the
    duration of this test only (monkeypatch restores it after).
    """

    async def slow_analyze(audio_path, **kwargs):
        await asyncio.sleep(2.0)
        return _fake_meeting_result()

    from fastapi import BackgroundTasks

    monkeypatch.setattr(BackgroundTasks, "add_task", lambda self, *a, **kw: None)

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, slow_analyze)
        start = time.perf_counter()
        resp = _post_meeting_audio(client)
        elapsed = time.perf_counter() - start

    assert resp.status_code == 202
    assert elapsed < 1.0, f"endpoint took {elapsed:.2f}s (must be <1s)"


def test_meeting_result_shape(stubbed_app, meeting_available):
    """The MeetingResult JSON shape SHALL include language, duration_seconds,
    speakers, segments with speaker/start/end/text, and word lists when
    enable_word_timestamps is true (default)."""

    async def fake_analyze(audio_path, **kwargs):
        return _fake_meeting_result()

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, fake_analyze)
        resp = _post_meeting_audio(client)
        body = client.get(f"/transcribe/meeting/{resp.json()['job_id']}").json()

    result = body["result"]
    assert set(result.keys()) >= {
        "language",
        "duration_seconds",
        "speakers",
        "segments",
    }
    assert result["language"] == "en"
    assert result["duration_seconds"] == 11.2
    seg = result["segments"][0]
    assert set(seg.keys()) >= {"speaker", "start", "end", "text", "words"}
    starts = [s["start"] for s in result["segments"]]
    assert starts == sorted(starts), "segment starts must be non-decreasing"


def test_meeting_result_omits_words_when_word_timestamps_disabled(
    stubbed_app, meeting_available
):
    """When `enable_word_timestamps=false`, every Segment SHALL omit `words`."""

    async def fake_analyze(audio_path, *, enable_word_timestamps=True, **kwargs):
        result = _fake_meeting_result()
        if not enable_word_timestamps:
            for s in result.segments:
                s.words = None
        return result

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, fake_analyze)
        resp = _post_meeting_audio(client, enable_word_timestamps=False)
        body = client.get(f"/transcribe/meeting/{resp.json()['job_id']}").json()

    for seg in body["result"]["segments"]:
        assert "words" not in seg


# --- 503 gating ---


def test_503_when_extras_not_installed(stubbed_app, monkeypatch):
    monkeypatch.setattr(
        "importlib.util.find_spec",
        lambda name: (
            None if name in {"whisperx", "pyannote", "pyannote.audio"} else MagicMock()
        ),
    )
    with TestClient(stubbed_app) as client:
        resp = _post_meeting_audio(client)
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert detail == {
        "error": "meeting_unavailable",
        "reason": "meeting extras not installed",
    }


def test_503_when_hf_token_missing(stubbed_app, monkeypatch):
    monkeypatch.setattr(
        "app.api.meeting.check_meeting_availability",
        lambda cfg=None: (False, "HF_TOKEN is not configured"),
    )
    with TestClient(stubbed_app) as client:
        resp = _post_meeting_audio(client)
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert detail["reason"] == "HF_TOKEN is not configured"


def test_503_when_no_ct2_variant(stubbed_app, monkeypatch):
    monkeypatch.setattr(
        "app.api.meeting.check_meeting_availability",
        lambda cfg=None: (False, "model fake-model has no ct2 variant"),
    )
    with TestClient(stubbed_app) as client:
        resp = _post_meeting_audio(client)
    assert resp.status_code == 503
    assert "has no ct2 variant" in resp.json()["detail"]["reason"]


def test_503_when_ct2_variant_not_downloaded(stubbed_app, monkeypatch):
    monkeypatch.setattr(
        "app.api.meeting.check_meeting_availability",
        lambda cfg=None: (
            False,
            "model breeze-asr-25 ct2 variant is not downloaded; run make download-model MODEL=breeze-asr-25",
        ),
    )
    with TestClient(stubbed_app) as client:
        resp = _post_meeting_audio(client)
    assert resp.status_code == 503
    reason = resp.json()["detail"]["reason"]
    assert "not downloaded" in reason
    assert "make download-model" in reason


def test_other_endpoints_unaffected_when_meeting_unavailable(stubbed_app, monkeypatch):
    """503 on /transcribe/meeting SHALL NOT break /transcribe or /status."""
    monkeypatch.setattr(
        "app.api.meeting.check_meeting_availability",
        lambda cfg=None: (False, "HF_TOKEN is not configured"),
    )
    with TestClient(stubbed_app) as client:
        meeting_resp = _post_meeting_audio(client)
        assert meeting_resp.status_code == 503

        status_resp = client.get("/status")
        assert status_resp.status_code == 200
        assert status_resp.json()["meeting"]["available"] is False


# --- cancellation (DELETE /transcribe/meeting/{job_id}) ---


def test_delete_unknown_job_returns_404(stubbed_app, meeting_available):
    """DELETE on a job_id that the store has never seen SHALL 404."""
    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, lambda *a, **kw: None)
        resp = client.delete("/transcribe/meeting/00000000000000000000000000")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "job_not_found"


def test_delete_finished_job_returns_409(stubbed_app, meeting_available):
    """Once a job is in terminal state, DELETE SHALL 409 (not cancellable)."""

    async def fast_analyze(audio_path, **kwargs):
        return _fake_meeting_result()

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, fast_analyze)
        post = _post_meeting_audio(client)
        job_id = post.json()["job_id"]
        # Wait for completion by polling status (TestClient runs background
        # tasks during the next request).
        poll = client.get(f"/transcribe/meeting/{job_id}")
        assert poll.json()["status"] == "done"
        resp = client.delete(f"/transcribe/meeting/{job_id}")
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "job_not_cancellable"
    assert "done" in resp.json()["detail"]["reason"]


def test_delete_pending_job_marks_cancel_requested(
    stubbed_app, meeting_available, monkeypatch
):
    """DELETE on a not-yet-finished job SHALL 202 and set cancel_requested.

    We stub BackgroundTasks.add_task to a no-op so the worker never runs;
    that leaves the job in 'pending' state, perfect for testing the cancel
    flag without racing the pipeline.
    """
    from fastapi import BackgroundTasks

    monkeypatch.setattr(BackgroundTasks, "add_task", lambda self, *a, **kw: None)

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, lambda *a, **kw: None)
        post = _post_meeting_audio(client)
        job_id = post.json()["job_id"]

        resp = client.delete(f"/transcribe/meeting/{job_id}")
        assert resp.status_code == 202
        body = resp.json()
        assert body["job_id"] == job_id
        assert body["status"] == "cancel_requested"

        # The job record now carries cancel_requested=True. Verify directly
        # via the store so we don't depend on how the worker would surface it.
        job = stubbed_app.state.meeting_jobs.get(job_id)
        assert job is not None
        assert job.cancel_requested is True


def test_pre_cancelled_job_skips_analyzer(
    stubbed_app, meeting_available, monkeypatch
):
    """A job marked cancel_requested before the worker runs SHALL transition
    to 'cancelled' without ever invoking analyzer.analyze().

    We no-op BackgroundTasks so the worker doesn't auto-run on POST, then
    directly invoke _run_meeting_job after setting the cancel flag. This is
    more deterministic than racing the real background task scheduler."""
    import asyncio as _asyncio

    from fastapi import BackgroundTasks

    from app.api.meeting import _run_meeting_job

    monkeypatch.setattr(BackgroundTasks, "add_task", lambda self, *a, **kw: None)

    analyze_calls: list[dict] = []

    async def recording_analyze(audio_path, **kwargs):
        analyze_calls.append({"audio_path": audio_path, **kwargs})
        return _fake_meeting_result()

    with TestClient(stubbed_app) as client:
        _install_fake_analyzer(stubbed_app, recording_analyze)
        post = _post_meeting_audio(client)
        job_id = post.json()["job_id"]
        store = stubbed_app.state.meeting_jobs
        # Set cancel flag BEFORE running the worker, then invoke directly.
        store.mark_cancel_requested(job_id)
        _asyncio.run(
            _run_meeting_job(
                analyzer=stubbed_app.state.meeting_analyzer,
                store=store,
                job_id=job_id,
                audio_path=Path("/tmp/nonexistent.wav"),
                language=None,
                num_speakers=None,
                min_speakers=None,
                max_speakers=None,
                enable_word_timestamps=True,
            )
        )

    assert analyze_calls == [], "pre-cancelled job must skip analyze() entirely"
    job = store.get(job_id)
    assert job is not None
    assert job.status == "cancelled"
    assert job.stage == "cancelled"
