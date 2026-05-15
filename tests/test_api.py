"""Integration tests for POST /transcribe (v2 unified endpoint)."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def stubbed_app(monkeypatch, tmp_path):
    """Boot app with mocked model + stubbed file pipeline so tests exercise only dispatch."""
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (MagicMock(name="WhisperBackend"), {
            "backend": "ctranslate2", "format": "ct2",
            "compute_type": "default", "local_dir": "/fake",
        }),
    )

    wav_path = tmp_path / "out.wav"
    wav_path.write_bytes(b"WAV")

    monkeypatch.setattr("app.api.transcribe.file_manager.validate_file_size", lambda *a: True)
    monkeypatch.setattr("app.api.transcribe.file_manager.is_audio_file", lambda *a: True)
    monkeypatch.setattr("app.api.transcribe.file_manager.detect_mime_type", lambda *a: "audio/wav")
    monkeypatch.setattr("app.api.transcribe.audio_converter.convert_to_wav", lambda *a: wav_path)
    monkeypatch.setattr("app.api.transcribe.file_manager.cleanup_file", lambda *a: None)

    from app.main import app

    return app


CAPTURED_KWARGS: dict = {}


@pytest.fixture
def client(stubbed_app):
    """TestClient context (runs lifespan) with a fake whisper.transcribe response."""

    from app.services._whisper_backend import TranscriptionResult

    CAPTURED_KWARGS.clear()

    async def fake_transcribe(*a, **kw):
        CAPTURED_KWARGS.update(kw)
        return TranscriptionResult(
            text="hello world", segments=[], language="en", duration_seconds=0.0
        )

    with TestClient(stubbed_app) as c:
        stubbed_app.state.whisper.transcribe = fake_transcribe
        yield c


# ---------- Task 3.1: Content-Type dispatch ----------


def test_multipart_form_upload_returns_200(client, tmp_path):
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"fake mp3 bytes")
    with audio.open("rb") as f:
        resp = client.post("/transcribe", files={"file": ("clip.mp3", f, "audio/mp3")})
    assert resp.status_code == 200
    assert resp.json()["text"] == "hello world"


def test_raw_audio_m4a_returns_200(client):
    resp = client.post(
        "/transcribe",
        headers={"Content-Type": "audio/m4a"},
        content=b"raw m4a bytes",
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "hello world"


def test_raw_octet_stream_returns_200(client):
    resp = client.post(
        "/transcribe",
        headers={"Content-Type": "application/octet-stream"},
        content=b"raw octet bytes",
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "hello world"


def test_unsupported_text_plain_returns_415(client):
    resp = client.post(
        "/transcribe",
        headers={"Content-Type": "text/plain"},
        content=b"hello",
    )
    assert resp.status_code == 415
    assert "Unsupported Content-Type" in resp.json()["detail"]


def test_multipart_missing_file_field_returns_400(client, tmp_path):
    """Multipart upload with NO `file` field SHALL fail with HTTP 400."""
    txt = tmp_path / "x.txt"
    txt.write_bytes(b"data")
    with txt.open("rb") as f:
        resp = client.post("/transcribe", files={"other": ("x.txt", f, "text/plain")})
    assert resp.status_code == 400
    assert "Missing form field 'file'" in resp.json()["detail"]


def test_raw_zero_byte_body_returns_400(client):
    resp = client.post(
        "/transcribe",
        headers={"Content-Type": "audio/wav"},
        content=b"",
    )
    assert resp.status_code == 400
    assert "Empty audio body" in resp.json()["detail"]


# ---------- Task 3.2: language and prompt params apply to every body shape ----------


def _captured_kwargs(client, **request_args) -> dict:
    """POST and return the kwargs whisper.transcribe was called with."""
    resp = client.post("/transcribe", **request_args)
    assert resp.status_code == 200, resp.text
    return dict(CAPTURED_KWARGS)


def test_language_default_is_auto_on_multipart(client, tmp_path):
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        kw = _captured_kwargs(client, files={"file": ("c.mp3", f, "audio/mp3")})
    assert kw["language"] == "auto"


def test_language_default_is_auto_on_raw_body(client):
    kw = _captured_kwargs(
        client,
        headers={"Content-Type": "audio/wav"},
        content=b"raw",
    )
    assert kw["language"] == "auto"


def test_language_query_param_overrides_default_on_multipart(client, tmp_path):
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        kw = _captured_kwargs(
            client,
            files={"file": ("c.mp3", f, "audio/mp3")},
            params={"language": "zh"},
        )
    assert kw["language"] == "zh"


def test_language_query_param_overrides_default_on_raw_body(client):
    kw = _captured_kwargs(
        client,
        headers={"Content-Type": "audio/wav"},
        content=b"raw",
        params={"language": "ja"},
    )
    assert kw["language"] == "ja"


def test_prompt_default_is_none_on_multipart(client, tmp_path):
    audio = tmp_path / "in.mp3"
    audio.write_bytes(b"fake")
    with audio.open("rb") as f:
        kw = _captured_kwargs(client, files={"file": ("c.mp3", f, "audio/mp3")})
    # Default `prompt` is None; the wrapper layer applies its own default punctuation seed.
    assert kw["initial_prompt"] is None


def test_prompt_query_param_forwarded_on_raw_body(client):
    kw = _captured_kwargs(
        client,
        headers={"Content-Type": "audio/wav"},
        content=b"raw",
        params={"prompt": "custom seed"},
    )
    assert kw["initial_prompt"] == "custom seed"


# ---------- Task 3.3: /transcribe-raw is removed ----------


def test_transcribe_raw_returns_404(client):
    resp = client.post(
        "/transcribe-raw",
        headers={"Content-Type": "audio/m4a"},
        content=b"raw",
    )
    assert resp.status_code == 404


# ---------- Sanity: pipeline error mapping ----------


def test_pipeline_error_returns_500(stubbed_app):
    async def boom(*a, **kw):
        raise RuntimeError("kaboom")

    with TestClient(stubbed_app) as c:
        stubbed_app.state.whisper.transcribe = boom
        resp = c.post(
            "/transcribe",
            headers={"Content-Type": "audio/wav"},
            content=b"raw",
        )
        assert resp.status_code == 500
        assert "kaboom" in resp.json()["detail"]
