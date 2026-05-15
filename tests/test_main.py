"""Integration tests for the v2.1 FastAPI lifespan handler (app/main.py).

These tests patch `app.main._build_backend` so the lifespan does not actually load
faster-whisper or pywhispercpp; instead it stores a fake `WhisperBackend` instance
on `app.state.whisper` and supplies the backend metadata block consumed by /status.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services._whisper_backend import WhisperLoadError


def _fake_backend_factory(metadata_override: dict | None = None):
    """Build a (backend, metadata) tuple suitable for patching _build_backend."""
    backend = MagicMock(name="WhisperBackend")
    metadata = {
        "backend": "ctranslate2",
        "format": "ct2",
        "compute_type": "default",
        "local_dir": "/fake/breeze-ct2",
    }
    if metadata_override:
        metadata.update(metadata_override)
    return backend, metadata


@pytest.fixture
def patched_lifespan(monkeypatch):
    """Patch _build_backend to skip real model load and return a deterministic fake."""
    pair = _fake_backend_factory()
    monkeypatch.setattr("app.main._build_backend", lambda **kw: pair)
    return pair


def test_lifespan_attaches_whisper_backend_to_state(patched_lifespan):
    from app.main import app

    backend, _ = patched_lifespan
    with TestClient(app):
        assert app.state.whisper is backend


def test_lifespan_records_load_time_ms(patched_lifespan):
    from app.main import app

    with TestClient(app):
        assert isinstance(app.state.load_time_ms, int)
        assert app.state.load_time_ms >= 0


def test_lifespan_records_completion_timestamp(patched_lifespan):
    import time

    from app.main import app

    before = time.time()
    with TestClient(app):
        assert app.state.lifespan_completed_at >= before


def test_lifespan_records_resolved_model_dir(patched_lifespan):
    """The lifespan SHALL stash the resolved model directory on app.state for /status."""
    from app.main import app

    with TestClient(app):
        assert app.state.model_dir == "/fake/breeze-ct2"


def test_lifespan_stores_backend_metadata(patched_lifespan):
    """The metadata dict carrying backend/format/compute_type SHALL be on app.state."""
    from app.main import app

    with TestClient(app):
        assert app.state.backend_metadata["backend"] == "ctranslate2"
        assert app.state.backend_metadata["format"] == "ct2"


def test_lifespan_fails_fast_when_build_raises(monkeypatch):
    """Startup SHALL raise (and uvicorn exit non-zero) when the backend cannot construct."""

    def boom(**kw):
        raise WhisperLoadError("model.bin missing")

    monkeypatch.setattr("app.main._build_backend", boom)

    from app.main import app

    with pytest.raises(WhisperLoadError, match="model.bin missing"):
        with TestClient(app):
            pass


def test_root_endpoint_returns_endpoint_catalogue(patched_lifespan):
    """Smoke: GET / returns a payload with an `endpoints` field."""
    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        body = resp.json()
        assert "endpoints" in body
