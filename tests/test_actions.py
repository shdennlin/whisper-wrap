"""Tests for the prompt-actions YAML loader and GET /actions endpoint.

Covers the `Prompt action templates loaded from registry/actions.yaml` and
`GET /actions endpoint exposes loaded templates` requirements in
openspec/specs/prompt-actions/spec.md.
"""

from __future__ import annotations

import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

# ---------- Task 1.1: YAML loader validation rules ----------


def test_loader_happy_path(tmp_path: Path):
    """A valid YAML with three entries loads to three ActionTemplate instances
    in declaration order."""
    from app.services.actions import ActionTemplate, load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: first
    label: First action
    template: "wrap {transcript} here"
  - id: second
    label: Second action
    template: "another {transcript}"
  - id: third
    label: Third action
    template: "{transcript}"
""",
        encoding="utf-8",
    )

    result = load_actions(yaml_file)
    assert len(result) == 3
    assert all(isinstance(a, ActionTemplate) for a in result)
    assert [a.id for a in result] == ["first", "second", "third"]
    assert result[0].label == "First action"
    assert result[2].template == "{transcript}"


def test_loader_missing_file_warns_and_returns_empty(tmp_path: Path, caplog):
    """Missing file → one-line WARNING + empty list. Server SHALL still start."""
    from app.services.actions import load_actions

    missing = tmp_path / "does-not-exist.yaml"
    with caplog.at_level(logging.WARNING, logger="app.services.actions"):
        result = load_actions(missing)
    assert result == []
    warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warns) == 1
    assert str(missing) in warns[0].getMessage()


def test_loader_malformed_yaml_warns_and_returns_empty(tmp_path: Path, caplog):
    """Malformed YAML → one-line WARNING + empty list. Server SHALL still start."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "broken.yaml"
    yaml_file.write_text("actions: [{id: foo, label: 'unterminated", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="app.services.actions"):
        result = load_actions(yaml_file)
    assert result == []
    warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warns) == 1


def test_loader_duplicate_id_raises(tmp_path: Path):
    """Duplicate `id` SHALL raise so the operator notices the misconfiguration."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "dup.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: same
    label: A
    template: "{transcript}"
  - id: same
    label: B
    template: "x {transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "same" in str(exc_info.value)


def test_loader_missing_transcript_placeholder_raises(tmp_path: Path):
    """A template without the literal `{transcript}` substring SHALL raise."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "no_placeholder.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: broken
    label: Broken
    template: "this has no placeholder"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "broken" in str(exc_info.value)
    assert "transcript" in str(exc_info.value)


def test_loader_missing_required_field_raises(tmp_path: Path):
    """Missing `id`, `label`, or `template` SHALL raise naming the offending entry."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "missing_field.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: ok
    label: OK
    template: "{transcript}"
  - id: missing-label
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    msg = str(exc_info.value)
    assert "label" in msg or "missing-label" in msg


def test_loader_ignores_unrecognised_top_level_keys(tmp_path: Path):
    """Unknown top-level YAML keys SHALL be silently ignored so future
    extensions do not break older deployments."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "with_extra.yaml"
    yaml_file.write_text(
        """\
version: 2
future_extension: { foo: bar }
actions:
  - id: only
    label: Only
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert len(result) == 1
    assert result[0].id == "only"


# ---------- Task 1.2: shipped registry/actions.yaml has 5 built-ins ----------


def test_shipped_yaml_has_five_builtins():
    """The repository SHALL ship `registry/actions.yaml` with five built-in
    entries: passthrough, cleanup, summarize, translate-en, formalize."""
    from app.services.actions import load_actions

    shipped = Path(__file__).resolve().parent.parent / "registry" / "actions.yaml"
    result = load_actions(shipped)
    assert [a.id for a in result] == [
        "passthrough",
        "cleanup",
        "summarize",
        "translate-en",
        "formalize",
    ]
    passthrough = result[0]
    assert passthrough.template.strip() == "{transcript}"
    for a in result:
        assert a.label, f"{a.id} has empty label"
        assert "{transcript}" in a.template, f"{a.id} missing {{transcript}}"


# ---------- Task 1.3: GET /actions HTTP contract ----------


@pytest.fixture
def stubbed_app(monkeypatch):
    """Boot the FastAPI app with a stubbed Whisper backend so we exercise only the
    actions surface; the lifespan loads the shipped registry/actions.yaml."""
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


def test_get_actions_http_contract_populated(stubbed_app):
    """GET /actions returns the loaded templates in registry order."""
    with TestClient(stubbed_app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        body = resp.json()
        assert "actions" in body
        ids = [a["id"] for a in body["actions"]]
        assert ids == ["passthrough", "cleanup", "summarize", "translate-en", "formalize"]
        for a in body["actions"]:
            assert set(a.keys()) >= {"id", "label", "template"}
            assert "{transcript}" in a["template"]


def test_get_actions_http_contract_empty_when_missing(monkeypatch):
    """When the registry file is missing at lifespan time, GET /actions SHALL
    return HTTP 200 with an empty list (NOT 404 or 500)."""
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
    monkeypatch.setattr(
        "app.services.actions.DEFAULT_REGISTRY_PATH",
        Path("/nonexistent/actions.yaml"),
    )
    from app.main import app

    with TestClient(app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200
        assert resp.json() == {"actions": []}


def test_get_actions_no_auth_required(stubbed_app):
    """The endpoint SHALL be reachable without an Authorization header."""
    with TestClient(stubbed_app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200
