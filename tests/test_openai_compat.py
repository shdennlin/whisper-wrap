"""Integration tests for the OpenAI Whisper REST API compatibility layer.

Covers all requirements in `openspec/specs/openai-compat/spec.md`:
  - `POST /v1/audio/transcriptions` (response_format json/text/srt/verbose_json/vtt,
    model aliasing, validation errors)
  - `POST /v1/audio/translations` (English-only, `language` rejected, task field)
  - `GET /v1/models` (single-entry list, MODEL_DIR override)
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services._whisper_backend import Segment, TranscriptionResult


@pytest.fixture
def stubbed_app(monkeypatch, tmp_path):
    """Boot app with a stubbed backend + file pipeline so tests exercise only the compat layer."""
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

    # The OpenAI compat layer reuses the same file pipeline helpers as /transcribe.
    monkeypatch.setattr(
        "app.api.openai_compat.file_manager.validate_file_size", lambda *a: True
    )
    monkeypatch.setattr(
        "app.api.openai_compat.file_manager.is_audio_file", lambda *a: True
    )
    monkeypatch.setattr(
        "app.api.openai_compat.file_manager.detect_mime_type",
        lambda *a: "audio/wav",
    )
    monkeypatch.setattr(
        "app.api.openai_compat.audio_converter.convert_to_wav", lambda *a: wav_path
    )
    monkeypatch.setattr(
        "app.api.openai_compat.file_manager.cleanup_file", lambda *a: None
    )

    from app.main import app

    return app


CAPTURED_CALLS: list[dict] = []


@pytest.fixture
def transcript_segments():
    """The two-segment spec example used in srt/vtt/verbose_json scenarios."""
    return [
        Segment(text="hello world.", start=0.0, end=2.5),
        Segment(text=" how are you.", start=2.5, end=6.0),
    ]


@pytest.fixture
def client(stubbed_app, transcript_segments):
    """TestClient with a fake whisper.transcribe returning the spec example transcript."""
    CAPTURED_CALLS.clear()

    async def fake_transcribe(*a, **kw):
        CAPTURED_CALLS.append({"args": a, "kwargs": dict(kw)})
        return TranscriptionResult(
            text="hello world. how are you.",
            segments=transcript_segments,
            language=kw.get("language", "en") if kw.get("language") != "auto" else "en",
            duration_seconds=6.0,
        )

    with TestClient(stubbed_app) as c:
        stubbed_app.state.whisper.transcribe = fake_transcribe
        yield c


# ---------- Task 2.1: default json response ----------


def _post_transcribe(client, tmp_path, **data):
    """Helper: POST a one-byte wav with the given form fields."""
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        return client.post(
            "/v1/audio/transcriptions",
            files={"file": ("clip.wav", f, "audio/wav")},
            data=data,
        )


def test_transcribe_default_json(client, tmp_path):
    """POST /v1/audio/transcriptions with model=whisper-1, no response_format → {"text": "..."}."""
    resp = _post_transcribe(client, tmp_path, model="whisper-1")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == {"text": "hello world. how are you."}


# ---------- Task 2.2: non-default response_format values ----------


def test_transcribe_text_plain(client, tmp_path):
    """response_format=text returns text/plain body equal to the raw transcript."""
    resp = _post_transcribe(client, tmp_path, model="whisper-1", response_format="text")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/plain")
    assert "charset=utf-8" in resp.headers["content-type"].lower()
    assert resp.text == "hello world. how are you."


def test_transcribe_srt(client, tmp_path):
    """response_format=srt returns the SRT body exactly matching the spec example."""
    resp = _post_transcribe(client, tmp_path, model="whisper-1", response_format="srt")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/plain")
    assert "charset=utf-8" in resp.headers["content-type"].lower()
    assert resp.text == (
        "1\n"
        "00:00:00,000 --> 00:00:02,500\n"
        "hello world.\n"
        "\n"
        "2\n"
        "00:00:02,500 --> 00:00:06,000\n"
        " how are you.\n"
        "\n"
    )


def test_transcribe_vtt(client, tmp_path):
    """response_format=vtt returns text/vtt body equal to the spec example."""
    resp = _post_transcribe(client, tmp_path, model="whisper-1", response_format="vtt")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/vtt")
    assert "charset=utf-8" in resp.headers["content-type"].lower()
    assert resp.text == (
        "WEBVTT\n"
        "\n"
        "00:00:00.000 --> 00:00:02.500\n"
        "hello world.\n"
        "\n"
        "00:00:02.500 --> 00:00:06.000\n"
        " how are you.\n"
        "\n"
    )


def test_transcribe_verbose_json(client, tmp_path):
    """response_format=verbose_json includes task/language/duration/text/segments
    with every documented field present (null/[] for those whisper-wrap cannot supply)."""
    resp = _post_transcribe(
        client,
        tmp_path,
        model="whisper-1",
        response_format="verbose_json",
        language="en",
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["task"] == "transcribe"
    assert body["language"] == "en"
    assert body["duration"] == 6.0
    assert body["text"] == "hello world. how are you."
    assert isinstance(body["segments"], list)
    assert len(body["segments"]) == 2
    expected_segments = [
        {
            "id": 0,
            "seek": 0,
            "start": 0.0,
            "end": 2.5,
            "text": "hello world.",
            "tokens": [],
            "temperature": 0.0,
            "avg_logprob": None,
            "compression_ratio": None,
            "no_speech_prob": None,
        },
        {
            "id": 1,
            "seek": 0,
            "start": 2.5,
            "end": 6.0,
            "text": " how are you.",
            "tokens": [],
            "temperature": 0.0,
            "avg_logprob": None,
            "compression_ratio": None,
            "no_speech_prob": None,
        },
    ]
    assert body["segments"] == expected_segments


# ---------- Task 2.3: `model` field aliasing ----------


@pytest.mark.parametrize("alias", ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"])
def test_model_alias_silent(client, tmp_path, caplog, alias):
    """The three reserved OpenAI model IDs are accepted with no WARNING log."""
    with caplog.at_level(logging.WARNING, logger="app.api.openai_compat"):
        resp = _post_transcribe(client, tmp_path, model=alias)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"text": "hello world. how are you."}
    compat_warnings = [r for r in caplog.records if r.name == "app.api.openai_compat" and r.levelno >= logging.WARNING]
    assert compat_warnings == [], f"expected no WARNING, got {[r.message for r in compat_warnings]}"


def test_model_unknown_logs_warning(client, tmp_path, caplog):
    """Unknown non-empty model is accepted but logs a single WARNING naming
    the received value AND the active model."""
    with caplog.at_level(logging.WARNING, logger="app.api.openai_compat"):
        resp = _post_transcribe(client, tmp_path, model="some-other-model")
    assert resp.status_code == 200
    compat_warnings = [r for r in caplog.records if r.name == "app.api.openai_compat" and r.levelno >= logging.WARNING]
    assert len(compat_warnings) == 1, f"expected exactly 1 WARNING, got {[r.message for r in compat_warnings]}"
    msg = compat_warnings[0].getMessage()
    assert "some-other-model" in msg
    # Active model name is the registry key when MODEL_NAME is set; the stubbed
    # config defaults expose `breeze-asr-25` (HARDCODED_FALLBACK_MODEL_NAME).
    assert "breeze-asr-25" in msg


def test_model_empty_returns_400(client, tmp_path):
    """Empty `model` form field returns OpenAI-shaped 400 with param='model'."""
    resp = _post_transcribe(client, tmp_path, model="")
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    err = body["error"]
    assert set(err.keys()) >= {"message", "type", "param", "code"}
    assert err["type"] == "invalid_request_error"
    assert err["param"] == "model"


def test_model_missing_returns_400(client, tmp_path):
    """No `model` form field at all returns OpenAI-shaped 400 with param='model'."""
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        resp = client.post(
            "/v1/audio/transcriptions",
            files={"file": ("clip.wav", f, "audio/wav")},
        )
    assert resp.status_code == 400
    err = resp.json()["error"]
    assert err["type"] == "invalid_request_error"
    assert err["param"] == "model"


# ---------- Task 2.4: OpenAI-shaped error responses ----------


def test_missing_file_400(client):
    """No `file` part in multipart → 400 with OpenAI error envelope, param='file'."""
    resp = client.post(
        "/v1/audio/transcriptions",
        data={"model": "whisper-1"},
    )
    assert resp.status_code == 400
    err = resp.json()["error"]
    assert set(err.keys()) >= {"message", "type", "param", "code"}
    assert err["type"] == "invalid_request_error"
    assert err["param"] == "file"


def test_invalid_response_format_400(client, tmp_path):
    """response_format outside {json,text,srt,verbose_json,vtt} → 400 with
    error.param='response_format' and message listing accepted values."""
    resp = _post_transcribe(client, tmp_path, model="whisper-1", response_format="xml")
    assert resp.status_code == 400
    err = resp.json()["error"]
    assert err["type"] == "invalid_request_error"
    assert err["param"] == "response_format"
    msg = err["message"]
    for accepted in ("json", "text", "srt", "verbose_json", "vtt"):
        assert accepted in msg, f"expected accepted format {accepted!r} mentioned in error message, got {msg!r}"


# ---------- Task 3.1: /v1/audio/translations ----------


def _post_translate(client, tmp_path, **data):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        return client.post(
            "/v1/audio/translations",
            files={"file": ("clip.wav", f, "audio/wav")},
            data=data,
        )


def test_translate_default_json(client, tmp_path):
    """POST /v1/audio/translations → body {"text": "..."} and the underlying
    backend invoked with task='translate' (not the default transcribe task)."""
    resp = _post_translate(client, tmp_path, model="whisper-1")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == {"text": "hello world. how are you."}
    assert CAPTURED_CALLS, "expected the backend to have been called"
    last_kwargs = CAPTURED_CALLS[-1]["kwargs"]
    assert last_kwargs.get("task") == "translate", (
        f"expected backend invoked with task='translate', got kwargs={last_kwargs}"
    )


def test_translate_rejects_language_field(client, tmp_path):
    """POST /v1/audio/translations with language=fr → 400 OpenAI error, param='language'."""
    resp = _post_translate(client, tmp_path, model="whisper-1", language="fr")
    assert resp.status_code == 400
    err = resp.json()["error"]
    assert err["type"] == "invalid_request_error"
    assert err["param"] == "language"


def test_translate_verbose_json_task_field(client, tmp_path):
    """response_format=verbose_json on translations → task='translate', language='en'."""
    resp = _post_translate(
        client, tmp_path, model="whisper-1", response_format="verbose_json"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["task"] == "translate"
    assert body["language"] == "en"


# ---------- Task 4.1: GET /v1/models ----------


def test_models_single_entry(client):
    """GET /v1/models returns the documented OpenAI list shape with exactly
    one entry: the active model (id matches /status `model.name`)."""
    resp = client.get("/v1/models")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["object"] == "list"
    assert isinstance(body["data"], list) and len(body["data"]) == 1
    entry = body["data"][0]
    # In the stubbed app MODEL_DIR is unset, so id == MODEL_NAME (breeze-asr-25 by default).
    assert entry["id"] == "breeze-asr-25"
    assert entry["object"] == "model"
    assert isinstance(entry["created"], int) and entry["created"] > 0
    assert entry["owned_by"] == "whisper-wrap"

    # Cross-check that /status reports the same name field.
    status_resp = client.get("/status")
    assert status_resp.json()["model"]["name"] == entry["id"]


def test_models_modeldir_override(stubbed_app, monkeypatch):
    """With MODEL_DIR set, data[0].id equals the resolved MODEL_DIR path —
    matching the /status `model.name` field exactly."""
    monkeypatch.setattr("app.config.config.MODEL_DIR", "/opt/custom-model")
    with TestClient(stubbed_app) as c:
        resp = c.get("/v1/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"][0]["id"] == c.get("/status").json()["model"]["name"]


def test_backend_failure_500_openai_shape(stubbed_app, tmp_path):
    """When the backend raises, the response is HTTP 500 with the OpenAI error
    envelope, type='server_error'. The message must not include stack traces,
    file paths, or secret-bearing values."""

    async def boom(*a, **kw):
        raise RuntimeError("inference exploded")

    audio = tmp_path / "in.wav"
    audio.write_bytes(b"fake")

    with TestClient(stubbed_app) as c:
        stubbed_app.state.whisper.transcribe = boom
        with audio.open("rb") as f:
            resp = c.post(
                "/v1/audio/transcriptions",
                files={"file": ("clip.wav", f, "audio/wav")},
                data={"model": "whisper-1"},
            )
        assert resp.status_code == 500
        err = resp.json()["error"]
        assert set(err.keys()) >= {"message", "type", "param", "code"}
        assert err["type"] == "server_error"
        msg = err["message"]
        assert "/Users/" not in msg
        assert "Traceback" not in msg
        assert "File \"" not in msg
