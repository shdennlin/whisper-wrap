"""Integration tests for GET /status, GET /, and the removed GET /health."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.llm import LLMClient


@pytest.fixture
def stubbed_app(monkeypatch):
    monkeypatch.setattr(
        "app.main.load_model", lambda *a, **kw: MagicMock(name="WhisperModel")
    )
    from app.main import app

    return app


# ---------- Task 6.1: /status payload ----------


def test_status_returns_full_payload(stubbed_app):
    with TestClient(stubbed_app) as c:
        resp = c.get("/status")
        assert resp.status_code == 200
        body = resp.json()

        assert body["status"] == "ok"
        assert body["version"] == "2.0.0"
        assert isinstance(body["uptime_seconds"], int)
        assert body["uptime_seconds"] >= 0

        m = body["model"]
        assert isinstance(m["name"], str) and m["name"]
        assert isinstance(m["path"], str)
        assert isinstance(m["compute_type"], str)
        assert isinstance(m["device"], str)
        assert m["loaded"] is True
        assert isinstance(m["load_time_ms"], int)

        g = body["gemini"]
        assert "configured" in g
        assert isinstance(g["model"], str) and g["model"]


def test_status_model_name_is_path_when_model_dir_override(monkeypatch, stubbed_app):
    """When MODEL_DIR is set, model.name SHALL be the resolved path (not MODEL_NAME)."""
    monkeypatch.setattr(
        "app.main.resolve_model_dir", lambda *a, **kw: "/opt/breeze-ct2"
    )
    monkeypatch.setattr("app.config.config.MODEL_DIR", "/opt/breeze-ct2")
    with TestClient(stubbed_app) as c:
        resp = c.get("/status")
        assert resp.json()["model"]["name"] == "/opt/breeze-ct2"


def test_status_gemini_configured_false_when_key_unset(monkeypatch, stubbed_app):
    """gemini.configured SHALL be False when GEMINI_API_KEY is unset."""
    monkeypatch.setattr("app.config.config.GEMINI_API_KEY", None)
    with TestClient(stubbed_app) as c:
        resp = c.get("/status")
        body = resp.json()
        assert body["gemini"]["configured"] is False
        # gemini.model is still non-empty (default applied via LLMClient resolution)
        assert body["gemini"]["model"]


def test_status_gemini_configured_true_when_key_set(monkeypatch, stubbed_app):
    monkeypatch.setattr("app.config.config.GEMINI_API_KEY", "sk-test")
    with TestClient(stubbed_app) as c:
        resp = c.get("/status")
        assert resp.json()["gemini"]["configured"] is True


# ---------- Task 6.2: /health is removed ----------


def test_health_endpoint_returns_404(stubbed_app):
    with TestClient(stubbed_app) as c:
        resp = c.get("/health")
        assert resp.status_code == 404


# ---------- Task 6.3: GET / API discovery ----------


def test_root_lists_all_v2_endpoints(stubbed_app):
    with TestClient(stubbed_app) as c:
        resp = c.get("/")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        assert "endpoints" in body
        entries = body["endpoints"]
        assert isinstance(entries, list)
        # Five endpoints expected: /transcribe, /listen, /ask, /status, /
        paths = {(e["method"], e["path"]) for e in entries}
        assert ("POST", "/transcribe") in paths
        assert ("WS", "/listen") in paths
        assert ("POST", "/ask") in paths
        assert ("GET", "/status") in paths
        assert ("GET", "/") in paths
        # Each entry has a description
        for e in entries:
            assert isinstance(e["description"], str) and e["description"]
