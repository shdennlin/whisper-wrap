"""Integration tests for the v2 FastAPI lifespan handler (app/main.py)."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.whisper import WhisperClient, WhisperLoadError


@pytest.fixture
def patched_loader(monkeypatch):
    """Patch app.main.load_model with a no-op that returns a MagicMock model."""
    fake = MagicMock(name="WhisperModel")
    monkeypatch.setattr("app.main.load_model", lambda *a, **kw: fake)
    return fake


def test_lifespan_attaches_whisper_model_to_state(patched_loader):
    from app.main import app

    with TestClient(app):
        assert app.state.whisper_model is patched_loader
        assert isinstance(app.state.whisper_client, WhisperClient)


def test_lifespan_records_load_time_ms(patched_loader):
    from app.main import app

    with TestClient(app):
        assert isinstance(app.state.load_time_ms, int)
        assert app.state.load_time_ms >= 0


def test_lifespan_records_completion_timestamp(patched_loader):
    import time

    from app.main import app

    before = time.time()
    with TestClient(app):
        assert app.state.lifespan_completed_at >= before


def test_lifespan_records_resolved_model_dir(patched_loader, monkeypatch):
    """The lifespan SHALL stash the resolved CT2 directory on app.state for /status."""
    monkeypatch.setattr(
        "app.main.resolve_model_dir", lambda *a, **kw: "/fake/breeze-ct2"
    )
    from app.main import app

    with TestClient(app):
        assert app.state.model_dir == "/fake/breeze-ct2"


def test_lifespan_fails_fast_when_load_raises(monkeypatch):
    """Startup SHALL raise (and uvicorn exit non-zero) when the model can't be loaded."""

    def boom(*a, **kw):
        raise WhisperLoadError("model.bin missing")

    monkeypatch.setattr("app.main.load_model", boom)

    from app.main import app

    with pytest.raises(WhisperLoadError, match="model.bin missing"):
        with TestClient(app):
            pass


def test_root_endpoint_returns_endpoint_catalogue(patched_loader):
    """Smoke: GET / returns a payload with an `endpoints` field. Detailed schema
    assertions live in tests/test_status.py."""
    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        body = resp.json()
        assert "endpoints" in body
