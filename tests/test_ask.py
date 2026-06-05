"""Integration tests for POST /ask (tasks 4.2-4.5)."""

import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.llm import LLMClient, LLMUpstreamError


@pytest.fixture
def stubbed_app(monkeypatch, tmp_path):
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

    wav_path = tmp_path / "out.wav"
    wav_path.write_bytes(b"WAV")

    # Stub file/converter pipeline shared with /transcribe.
    monkeypatch.setattr("app.api.ask.file_manager.validate_file_size", lambda *a: True)
    monkeypatch.setattr("app.api.ask.file_manager.is_audio_file", lambda *a: True)
    monkeypatch.setattr(
        "app.api.ask.file_manager.detect_mime_type", lambda *a: "audio/wav"
    )
    monkeypatch.setattr(
        "app.api.ask.audio_converter.convert_to_wav", lambda *a: wav_path
    )
    monkeypatch.setattr("app.api.ask.file_manager.cleanup_file", lambda *a: None)

    from app.main import app

    return app


def _install_llm(
    app,
    *,
    configured=True,
    ask_text="answer",
    stream_chunks=None,
    stream_error=None,
    ask_error=None,
):
    """Inject a stubbed LLMClient onto app.state, returning it for assertions."""

    async def fake_ask(text):
        if ask_error:
            raise ask_error
        return ask_text

    async def fake_stream(text):
        if stream_error:
            raise stream_error
            yield  # pragma: no cover
        for c in stream_chunks or []:
            yield c

    fake = MagicMock(spec=LLMClient)
    fake.configured = configured
    fake.ask = fake_ask
    fake.ask_stream = fake_stream
    app.state.llm_client = fake
    return fake


def _install_whisper(app, *, transcript="hello world", error=None):
    async def fake_transcribe(*a, **kw):
        if error:
            raise error
        from app.services._whisper_backend import TranscriptionResult

        return TranscriptionResult(
            text=transcript, segments=[], language="en", duration_seconds=0.0
        )

    app.state.whisper.transcribe = fake_transcribe


# =========================================================================
# Task 4.2: Content-Type dispatch + audio/text inputs + JSON path
# =========================================================================


def test_blocking_json_text_returns_transcript_null_and_answer(stubbed_app):
    # log=false isolates this test from the auto-session-logger side effect;
    # the auto-log behavior has its own coverage below.
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, ask_text="42")
        _install_whisper(stubbed_app)
        resp = c.post("/ask?log=false", json={"text": "what is the answer?"})
        assert resp.status_code == 200
        assert resp.json() == {"transcript": None, "answer": "42"}


def test_blocking_multipart_audio_transcribes_then_asks(stubbed_app, tmp_path):
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"fake mp3")
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, ask_text="hi")
        _install_whisper(stubbed_app, transcript="who are you")
        with audio.open("rb") as f:
            resp = c.post(
                "/ask?log=false", files={"file": ("clip.mp3", f, "audio/mp3")}
            )
        assert resp.status_code == 200
        assert resp.json() == {"transcript": "who are you", "answer": "hi"}


def test_blocking_raw_audio_octet_stream(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, ask_text="ok")
        _install_whisper(stubbed_app, transcript="raw audio text")
        resp = c.post(
            "/ask?log=false",
            headers={"Content-Type": "application/octet-stream"},
            content=b"raw bytes",
        )
        assert resp.status_code == 200
        assert resp.json() == {"transcript": "raw audio text", "answer": "ok"}


def test_blocking_unsupported_content_type_returns_415(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        resp = c.post(
            "/ask",
            headers={"Content-Type": "text/plain"},
            content=b"hello",
        )
        assert resp.status_code == 415


# =========================================================================
# Task 4.3: Validation 400 in BOTH blocking and streaming modes
# =========================================================================


@pytest.mark.parametrize("stream_param", [{}, {"stream": "true"}])
def test_validation_empty_json_body(stubbed_app, stream_param):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        resp = c.post(
            "/ask",
            params=stream_param,
            headers={"Content-Type": "application/json"},
            content=b"",
        )
        assert resp.status_code == 400


@pytest.mark.parametrize("stream_param", [{}, {"stream": "true"}])
def test_validation_malformed_json(stubbed_app, stream_param):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        resp = c.post(
            "/ask",
            params=stream_param,
            headers={"Content-Type": "application/json"},
            content=b"{not-json",
        )
        assert resp.status_code == 400


@pytest.mark.parametrize("stream_param", [{}, {"stream": "true"}])
def test_validation_missing_text_field(stubbed_app, stream_param):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        resp = c.post(
            "/ask",
            params=stream_param,
            json={"not_text": "x"},
        )
        assert resp.status_code == 400


@pytest.mark.parametrize("stream_param", [{}, {"stream": "true"}])
def test_validation_multipart_missing_file_field(stubbed_app, stream_param, tmp_path):
    """Multipart with no `file` field SHALL fail HTTP 400 in both modes."""
    txt = tmp_path / "x.txt"
    txt.write_bytes(b"data")
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        with txt.open("rb") as f:
            resp = c.post(
                "/ask",
                params=stream_param,
                files={"other": ("x.txt", f, "text/plain")},
            )
        assert resp.status_code == 400


@pytest.mark.parametrize("stream_param", [{}, {"stream": "true"}])
def test_validation_zero_byte_raw_audio(stubbed_app, stream_param):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app)
        resp = c.post(
            "/ask",
            params=stream_param,
            headers={"Content-Type": "audio/wav"},
            content=b"",
        )
        assert resp.status_code == 400


# =========================================================================
# Task 4.4: SSE streaming contract
# =========================================================================


def _parse_sse_events(body: str) -> list[dict]:
    """Parse a `text/event-stream` body into a list of {event, data} dicts."""
    events = []
    current = {}
    for line in body.split("\n"):
        if not line.strip():
            if current:
                events.append(current)
                current = {}
            continue
        if line.startswith("event:"):
            current["event"] = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_str = line[len("data:") :].strip()
            current["data"] = json.loads(data_str)
    if current:
        events.append(current)
    return events


def test_streaming_success_emits_transcript_tokens_done(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_chunks=["hel", "lo"])
        _install_whisper(stubbed_app, transcript="say hi")
        resp = c.post(
            "/ask",
            params={"stream": "true", "log": "false"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")

        events = _parse_sse_events(resp.text)
        types = [e["event"] for e in events]
        assert types == ["transcript", "token", "token", "done"]
        assert events[0]["data"] == {"text": "say hi"}
        assert events[1]["data"] == {"text": "hel"}
        assert events[2]["data"] == {"text": "lo"}
        assert events[3]["data"]["finish_reason"] == "stop"


def test_streaming_empty_llm_response_emits_transcript_then_done(stubbed_app):
    """Streaming-with-empty-LLM-response: zero token events, terminating done."""
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_chunks=[])  # no tokens
        _install_whisper(stubbed_app, transcript="silent")
        resp = c.post(
            "/ask",
            params={"stream": "true"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        events = _parse_sse_events(resp.text)
        types = [e["event"] for e in events]
        assert types == ["transcript", "done"]


def test_streaming_llm_error_after_transcript(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_error=LLMUpstreamError("rate limited"))
        _install_whisper(stubbed_app, transcript="hi")
        resp = c.post(
            "/ask",
            params={"stream": "true"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        events = _parse_sse_events(resp.text)
        types = [e["event"] for e in events]
        assert types == ["transcript", "error"]
        assert "rate limited" in events[1]["data"]["error"]


def test_streaming_stt_failure_before_transcript(stubbed_app):
    from app.services.whisper import WhisperTranscriptionError

    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_chunks=["never"])
        _install_whisper(stubbed_app, error=WhisperTranscriptionError("ct2 crashed"))
        resp = c.post(
            "/ask",
            params={"stream": "true"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        events = _parse_sse_events(resp.text)
        types = [e["event"] for e in events]
        assert types == ["error"]
        assert "ct2 crashed" in events[0]["data"]["error"]


def test_streaming_json_text_path_emits_transcript_null(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_chunks=["ok"])
        resp = c.post(
            "/ask",
            params={"stream": "true", "log": "false"},
            json={"text": "ping"},
        )
        events = _parse_sse_events(resp.text)
        assert events[0] == {"event": "transcript", "data": {"text": None}}
        assert events[1] == {"event": "token", "data": {"text": "ok"}}
        assert events[2]["event"] == "done"


# =========================================================================
# Task 4.5: Missing credentials behaviour
# =========================================================================


def test_blocking_missing_gemini_key_returns_502(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(
            stubbed_app,
            configured=False,
            ask_error=__import__(
                "app.services.llm", fromlist=["LLMConfigError"]
            ).LLMConfigError("GEMINI_API_KEY is not configured"),
        )
        resp = c.post("/ask", json={"text": "ping"})
        assert resp.status_code == 502
        assert "GEMINI_API_KEY" in resp.json()["detail"]


def test_streaming_missing_gemini_key_emits_single_event_error(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, configured=False)
        resp = c.post(
            "/ask",
            params={"stream": "true"},
            json={"text": "ping"},
        )
        events = _parse_sse_events(resp.text)
        # Exactly one event:error and nothing else (no transcript).
        types = [e["event"] for e in events]
        assert types == ["error"]
        assert "GEMINI_API_KEY" in events[0]["data"]["error"]


# =========================================================================
# transcription-empty-filter integration
# =========================================================================


def _arm_caplog_post_lifespan(caplog):
    import logging as _logging

    _logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(_logging.INFO)


def test_blocking_audio_empty_transcript_returns_400_and_skips_llm(
    stubbed_app, monkeypatch, caplog
):
    from app.config import config as app_cfg

    monkeypatch.setattr(app_cfg, "FILTER_EMPTY_ENABLED", True)

    with TestClient(stubbed_app) as c:
        _arm_caplog_post_lifespan(caplog)
        llm = _install_llm(stubbed_app, ask_text="should-not-be-called")
        _install_whisper(stubbed_app, transcript="。")
        # Wrap fake_ask to detect any invocation
        original_ask = llm.ask
        call_count = {"n": 0}

        async def counted_ask(text):
            call_count["n"] += 1
            return await original_ask(text)

        llm.ask = counted_ask

        resp = c.post(
            "/ask",
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )

    assert resp.status_code == 400
    assert resp.json() == {"error": "no_speech_detected"}
    assert call_count["n"] == 0, "LLM SHALL NOT be invoked when STT filtered"

    drops = [r for r in caplog.records if r.getMessage() == "transcription_filtered"]
    assert len(drops) == 1
    assert drops[0].endpoint == "/ask"
    assert drops[0].stream is False


def test_streaming_audio_empty_transcript_emits_error_only_and_skips_llm(
    stubbed_app, monkeypatch, caplog
):
    from app.config import config as app_cfg

    monkeypatch.setattr(app_cfg, "FILTER_EMPTY_ENABLED", True)

    with TestClient(stubbed_app) as c:
        _arm_caplog_post_lifespan(caplog)
        llm = _install_llm(stubbed_app, stream_chunks=["should", "not", "stream"])
        _install_whisper(stubbed_app, transcript="   ")

        stream_calls = {"n": 0}
        orig_stream = llm.ask_stream

        async def counted_stream(text):
            stream_calls["n"] += 1
            async for chunk in orig_stream(text):
                yield chunk

        llm.ask_stream = counted_stream

        resp = c.post(
            "/ask",
            params={"stream": "true"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )

    events = _parse_sse_events(resp.text)
    types = [e["event"] for e in events]
    assert types == ["error"], f"Expected only event:error, got {types}"
    assert events[0]["data"] == {"error": "no_speech_detected"}
    assert stream_calls["n"] == 0, "LLM stream SHALL NOT be invoked"

    drops = [r for r in caplog.records if r.getMessage() == "transcription_filtered"]
    assert len(drops) == 1
    assert drops[0].endpoint == "/ask"
    assert drops[0].stream is True


def test_json_text_input_unaffected_by_filter(stubbed_app, monkeypatch, caplog):
    """JSON text path SHALL bypass the filter entirely."""
    from app.config import config as app_cfg

    monkeypatch.setattr(app_cfg, "FILTER_EMPTY_ENABLED", True)

    with TestClient(stubbed_app) as c:
        _arm_caplog_post_lifespan(caplog)
        llm = _install_llm(stubbed_app, ask_text="hi back")
        _install_whisper(stubbed_app)
        call_count = {"n": 0}
        original_ask = llm.ask

        async def counted_ask(text):
            call_count["n"] += 1
            return await original_ask(text)

        llm.ask = counted_ask
        resp = c.post("/ask?log=false", json={"text": "hello"})

    assert resp.status_code == 200
    assert resp.json() == {"transcript": None, "answer": "hi back"}
    assert call_count["n"] == 1
    assert not any(r.getMessage() == "transcription_filtered" for r in caplog.records)


def test_disabled_filter_forwards_empty_audio_transcript_to_llm(
    stubbed_app, monkeypatch, caplog
):
    from app.config import config as app_cfg

    monkeypatch.setattr(app_cfg, "FILTER_EMPTY_ENABLED", False)

    with TestClient(stubbed_app) as c:
        _arm_caplog_post_lifespan(caplog)
        llm = _install_llm(stubbed_app, ask_text="answer")
        _install_whisper(stubbed_app, transcript="。")
        call_count = {"n": 0}
        original_ask = llm.ask

        async def counted_ask(text):
            call_count["n"] += 1
            return await original_ask(text)

        llm.ask = counted_ask
        resp = c.post(
            "/ask?log=false",
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )

    assert resp.status_code == 200
    assert resp.json() == {"transcript": "。", "answer": "answer"}
    assert call_count["n"] == 1, "With filter off, LLM SHALL be invoked"
    assert not any(r.getMessage() == "transcription_filtered" for r in caplog.records)


# =========================================================================
# Auto-session-logger integration (default on, opt-out via ?log=false)
# =========================================================================


def test_blocking_ask_auto_logs_by_default_and_returns_session_id(stubbed_app):
    """Default behavior: external clients (Shortcut, curl) get a session id
    back AND a row in the PWA history. The PWA itself sends `log=false`."""
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, ask_text="42")
        _install_whisper(stubbed_app, transcript="what is the answer?")
        resp = c.post(
            "/ask",
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["transcript"] == "what is the answer?"
        assert body["answer"] == "42"
        assert "session_id" in body
        sid = body["session_id"]
        # The id SHALL appear in the PWA's /v1/sessions list
        listing = c.get("/v1/sessions").json()
        assert any(s["id"] == sid for s in listing["sessions"])
        # Look up the session and verify the answer landed as a passthrough run.
        full = c.get(f"/v1/sessions/{sid}").json()
        assert any(
            r["action_id"] == "passthrough" and r["answer"] == "42"
            for r in full["action_runs"]
        )


def test_blocking_ask_log_false_suppresses_session_creation(stubbed_app):
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, ask_text="hi")
        _install_whisper(stubbed_app, transcript="who are you")
        resp = c.post(
            "/ask?log=false",
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        body = resp.json()
        assert "session_id" not in body
        listing = c.get("/v1/sessions").json()
        assert listing["sessions"] == []


def test_streaming_ask_emits_session_event_before_done_when_logged(stubbed_app):
    """Default behavior (log=true): a `session` event SHALL fire between the
    last `token` and the terminating `done`, carrying the auto-logged id."""
    with TestClient(stubbed_app) as c:
        _install_llm(stubbed_app, stream_chunks=["hel", "lo"])
        _install_whisper(stubbed_app, transcript="say hi")
        resp = c.post(
            "/ask",
            params={"stream": "true"},
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        events = _parse_sse_events(resp.text)
        types = [e["event"] for e in events]
        assert types == ["transcript", "token", "token", "session", "done"]
        session_event = events[3]
        assert "session_id" in session_event["data"]
        sid = session_event["data"]["session_id"]
        # Verify the row landed and the answer is fully captured.
        full = c.get(f"/v1/sessions/{sid}").json()
        assert full["action_runs"][0]["answer"] == "hello"
