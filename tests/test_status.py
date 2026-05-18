"""Integration tests for GET /status, GET /, and the removed GET /health."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


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
        "app.main._build_backend",
        lambda **kw: (
            MagicMock(name="WhisperBackend"),
            {
                "backend": "ctranslate2",
                "format": "ct2",
                "compute_type": "default",
                "local_dir": "/opt/breeze-ct2",
            },
        ),
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


# ---------- v2.3 Task 5.1: catalogue advertises OpenAI-compat routes ----------


def test_discovery_lists_openai_compat_routes(stubbed_app):
    """API discovery endpoint lists every registered route — the catalogue
    SHALL include the three OpenAI-compatibility routes with non-empty
    descriptions so operators can see at a glance that the compat layer is mounted.
    """
    with TestClient(stubbed_app) as c:
        body = c.get("/").json()
        entries = body["endpoints"]
        by_route = {(e["method"], e["path"]): e for e in entries}
        for method, path in (
            ("POST", "/v1/audio/transcriptions"),
            ("POST", "/v1/audio/translations"),
            ("GET", "/v1/models"),
        ):
            assert (method, path) in by_route, f"missing entry for {method} {path}"
            entry = by_route[(method, path)]
            assert isinstance(entry["description"], str) and entry["description"], (
                f"entry for {method} {path} has empty description"
            )


# ---------- v2.4 Task 2.1: catalogue advertises /actions and /app/ ----------


def test_discovery_lists_v24_routes(stubbed_app):
    """API discovery endpoint lists every registered route — the catalogue
    SHALL include the prompt-actions registry endpoint and the PWA mount with
    non-empty descriptions."""
    with TestClient(stubbed_app) as c:
        body = c.get("/").json()
        entries = body["endpoints"]
        by_route = {(e["method"], e["path"]): e for e in entries}
        for method, path in (
            ("GET", "/actions"),
            ("GET", "/app/"),
        ):
            assert (method, path) in by_route, f"missing entry for {method} {path}"
            entry = by_route[(method, path)]
            assert isinstance(entry["description"], str) and entry["description"], (
                f"entry for {method} {path} has empty description"
            )


# ---------- v2.1: backend metadata block ----------


def test_status_includes_backend_block_ct2(stubbed_app):
    """Per `/status surfaces backend metadata`: a `backend` object SHALL be present."""
    with TestClient(stubbed_app) as c:
        body = c.get("/status").json()
        assert "backend" in body
        assert body["backend"]["backend"] == "ctranslate2"
        assert body["backend"]["format"] == "ct2"
        assert body["backend"]["compute_type"] == "default"
        # ct2 variant SHALL NOT carry quant / coreml_encoder_compiled fields
        assert "quant" not in body["backend"]
        assert "coreml_encoder_compiled" not in body["backend"]


def test_status_includes_backend_block_ggml(monkeypatch, stubbed_app):
    """When the active variant is ggml, the backend block SHALL carry quant + coreml_encoder_compiled."""
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (
            MagicMock(name="WhisperBackend"),
            {
                "backend": "pywhispercpp",
                "format": "ggml",
                "quant": "q6_k",
                "coreml_encoder_compiled": True,
                "local_dir": "models/breeze-asr-25-ggml",
            },
        ),
    )
    with TestClient(stubbed_app) as c:
        body = c.get("/status").json()
        assert body["backend"]["backend"] == "pywhispercpp"
        assert body["backend"]["format"] == "ggml"
        assert body["backend"]["quant"] == "q6_k"
        assert body["backend"]["coreml_encoder_compiled"] is True
        assert "compute_type" not in body["backend"]


# ---------- v2.2: /status vad block ----------


def test_status_includes_vad_block_silero(monkeypatch, stubbed_app):
    """When the lifespan resolved a SileroVad backend, /status reports it."""
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

    # Force the lifespan to pick silero
    class FakeSilero:
        pass

    FakeSilero.__name__ = "SileroVad"
    monkeypatch.setattr(
        "app.services.vad.make_vad_backend",
        lambda name: FakeSilero(),
    )
    with TestClient(stubbed_app) as c:
        body = c.get("/status").json()
        assert body["vad"] == {"backend": "silero"}


def test_status_includes_vad_block_rms(monkeypatch, stubbed_app):
    """Auto-fallback or explicit opt-out → /status reports rms."""
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

    class FakeRms:
        pass

    FakeRms.__name__ = "RmsVad"
    monkeypatch.setattr(
        "app.services.vad.make_vad_backend",
        lambda name: FakeRms(),
    )
    with TestClient(stubbed_app) as c:
        body = c.get("/status").json()
        assert body["vad"] == {"backend": "rms"}
