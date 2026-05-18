"""Endpoint tests for /v1/sessions (CRUD + finals + runs + audio)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    """TestClient with the model loader stubbed out so lifespan focuses on persistence."""
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

    with TestClient(app) as c:
        yield c


def _create(client, sid="s1", started_at=1000, mode="batch"):
    r = client.post(
        "/v1/sessions",
        json={"id": sid, "started_at": started_at, "mode": mode},
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- Schema round-trip --------------------------------------------------------


def test_schemas_roundtrip():
    """SessionFull serialises a SessionCreate body cleanly."""
    from app.api.schemas.sessions import SessionCreate, SessionFull

    create = SessionCreate(id="x", started_at=10, mode="batch")
    sample = SessionFull(
        id=create.id,
        started_at=create.started_at,
        ended_at=20,
        mode=create.mode,
        audio_path=None,
        audio_mime_type=None,
        audio_size_bytes=None,
        duration_ms=10,
    )
    dumped = sample.model_dump()
    assert dumped["mode"] == "batch"
    assert dumped["finals"] == []
    assert dumped["action_runs"] == []


# --- CRUD ---------------------------------------------------------------------


def test_create_then_get(client):
    body = _create(client, "s-cg")
    assert body["id"] == "s-cg"
    assert body["mode"] == "batch"
    assert body["finals"] == []
    assert body["action_runs"] == []

    r = client.get("/v1/sessions/s-cg")
    assert r.status_code == 200
    assert r.json()["id"] == "s-cg"


def test_create_duplicate_returns_409(client):
    _create(client, "dup")
    r = client.post("/v1/sessions", json={"id": "dup", "started_at": 0, "mode": "live"})
    assert r.status_code == 409


def test_get_missing_returns_404(client):
    r = client.get("/v1/sessions/ghost")
    assert r.status_code == 404


def test_list_ordered_desc_with_cursor(client):
    for i in range(5):
        _create(client, f"o{i}", started_at=i * 100)
    r = client.get("/v1/sessions?limit=3")
    assert r.status_code == 200
    body = r.json()
    assert [s["id"] for s in body["sessions"]] == ["o4", "o3", "o2"]
    assert body["next_before_ms"] == 200  # cursor for next page

    r2 = client.get(f"/v1/sessions?limit=3&before_ms={body['next_before_ms']}")
    assert [s["id"] for s in r2.json()["sessions"]] == ["o1", "o0"]


def test_patch_partial(client):
    _create(client, "p")
    r = client.patch("/v1/sessions/p", json={"ended_at": 500, "duration_ms": 500})
    assert r.status_code == 200
    body = r.json()
    assert body["ended_at"] == 500
    assert body["duration_ms"] == 500


def test_patch_missing_returns_404(client):
    r = client.patch("/v1/sessions/nope", json={"ended_at": 1})
    assert r.status_code == 404


def test_delete_cascades_and_204(client):
    _create(client, "d")
    client.post(
        "/v1/sessions/d/finals", json={"text": "hi", "start_ms": 0, "end_ms": 1}
    )
    r = client.delete("/v1/sessions/d")
    assert r.status_code == 204
    assert client.get("/v1/sessions/d").status_code == 404


def test_delete_missing_returns_404(client):
    r = client.delete("/v1/sessions/missing")
    assert r.status_code == 404


# --- Finals + runs ------------------------------------------------------------


def test_append_finals_monotonic_ord(client):
    _create(client, "f")
    for i, txt in enumerate(("a", "b", "c")):
        r = client.post(
            "/v1/sessions/f/finals",
            json={"text": txt, "start_ms": i * 10, "end_ms": (i + 1) * 10},
        )
        assert r.status_code == 201
        assert r.json()["ord"] == i

    detail = client.get("/v1/sessions/f").json()
    assert [f["text"] for f in detail["finals"]] == ["a", "b", "c"]


def test_finals_on_missing_session_returns_404(client):
    r = client.post(
        "/v1/sessions/missing/finals", json={"text": "x", "start_ms": 0, "end_ms": 1}
    )
    assert r.status_code == 404


def test_append_action_run_and_get(client):
    _create(client, "r")
    r = client.post(
        "/v1/sessions/r/runs",
        json={
            "action_id": "polish",
            "prompt": "polish:\n hi",
            "answer": "hi.",
            "ran_at": 99,
            "model_used": "gemini-test",
        },
    )
    assert r.status_code == 201
    assert r.json()["action_id"] == "polish"
    assert r.json()["succeeded"] is True

    detail = client.get("/v1/sessions/r").json()
    assert len(detail["action_runs"]) == 1


def test_runs_on_missing_session_returns_404(client):
    r = client.post(
        "/v1/sessions/missing/runs",
        json={
            "action_id": "polish",
            "prompt": "p",
            "answer": "a",
            "ran_at": 1,
        },
    )
    assert r.status_code == 404


# --- Audio --------------------------------------------------------------------


def test_audio_upload_get_byte_equal(client):
    _create(client, "a-eq")
    payload = b"\x1a\x45\xdf\xa3" + b"random-bytes" * 32  # ~256 bytes
    r = client.post(
        "/v1/sessions/a-eq/audio",
        files={"file": ("clip.webm", payload, "audio/webm")},
    )
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["audio_size_bytes"] == len(payload)
    assert meta["audio_mime_type"] == "audio/webm"
    assert meta["audio_path"].endswith("a-eq.webm")

    r2 = client.get("/v1/sessions/a-eq/audio")
    assert r2.status_code == 200
    assert r2.content == payload


def test_audio_replacement_unlinks_old_extension(client):
    _create(client, "a-rep")
    client.post(
        "/v1/sessions/a-rep/audio",
        files={"file": ("clip.webm", b"first", "audio/webm")},
    )
    first_path = Path(client.get("/v1/sessions/a-rep").json()["audio_path"])
    assert first_path.exists()

    client.post(
        "/v1/sessions/a-rep/audio",
        files={"file": ("clip.wav", b"second-bigger-data", "audio/wav")},
    )
    second_path = Path(client.get("/v1/sessions/a-rep").json()["audio_path"])
    assert second_path.exists()
    assert second_path != first_path
    assert not first_path.exists(), "old file should be unlinked on replacement"


def test_audio_unknown_mime_falls_back_to_bin(client):
    _create(client, "a-bin")
    r = client.post(
        "/v1/sessions/a-bin/audio",
        files={"file": ("x.weird", b"abc", "audio/totally-unknown")},
    )
    assert r.status_code == 200
    assert r.json()["audio_path"].endswith("a-bin.bin")


def test_audio_get_missing_returns_404(client):
    _create(client, "a-404")
    r = client.get("/v1/sessions/a-404/audio")
    assert r.status_code == 404


def test_audio_upload_to_missing_session_returns_404(client):
    r = client.post(
        "/v1/sessions/ghost/audio",
        files={"file": ("c.webm", b"abc", "audio/webm")},
    )
    assert r.status_code == 404


def test_delete_session_unlinks_audio_file(client):
    _create(client, "del-audio")
    client.post(
        "/v1/sessions/del-audio/audio",
        files={"file": ("c.webm", b"bytes", "audio/webm")},
    )
    path = Path(client.get("/v1/sessions/del-audio").json()["audio_path"])
    assert path.exists()

    r = client.delete("/v1/sessions/del-audio")
    assert r.status_code == 204
    assert not path.exists(), "audio file should be unlinked on session delete"


def test_audio_bulk_clear_removes_files_and_nulls_columns(client):
    for sid in ("bc1", "bc2", "bc3"):
        _create(client, sid)
        client.post(
            f"/v1/sessions/{sid}/audio",
            files={"file": (f"{sid}.webm", b"data", "audio/webm")},
        )
    paths = [
        Path(client.get(f"/v1/sessions/{sid}").json()["audio_path"])
        for sid in ("bc1", "bc2", "bc3")
    ]
    for p in paths:
        assert p.exists()

    r = client.delete("/v1/sessions/audio")
    assert r.status_code == 200
    assert r.json()["deleted_count"] == 3
    for p in paths:
        assert not p.exists()

    for sid in ("bc1", "bc2", "bc3"):
        body = client.get(f"/v1/sessions/{sid}").json()
        assert body["audio_path"] is None
        assert body["audio_mime_type"] is None
        assert body["audio_size_bytes"] is None


# ===========================================================================
# DELETE /v1/sessions/{session_id}/runs/{run_id}
# ===========================================================================


def _append_run(client, sid, action_id="summarize", prompt="p", answer="a", ran_at=1):
    r = client.post(
        f"/v1/sessions/{sid}/runs",
        json={
            "action_id": action_id,
            "prompt": prompt,
            "answer": answer,
            "ran_at": ran_at,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_delete_run_happy_path_returns_204_and_removes_row(client):
    """Deleting one run leaves sibling runs intact in /v1/sessions/<id>."""
    _create(client, "del-run-1")
    r1 = _append_run(client, "del-run-1", ran_at=1)
    r2 = _append_run(client, "del-run-1", ran_at=2)
    r3 = _append_run(client, "del-run-1", ran_at=3)

    resp = client.delete(f"/v1/sessions/del-run-1/runs/{r2['id']}")
    assert resp.status_code == 204
    assert resp.content == b""

    body = client.get("/v1/sessions/del-run-1").json()
    remaining_ids = [r["id"] for r in body["action_runs"]]
    assert remaining_ids == [r1["id"], r3["id"]]


def test_delete_run_unknown_run_id_returns_404_run_not_found(client):
    _create(client, "del-run-2")
    resp = client.delete("/v1/sessions/del-run-2/runs/9999")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "run not found"}


def test_delete_run_unknown_session_id_returns_404_session_not_found(client):
    resp = client.delete("/v1/sessions/no-such-session/runs/1")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "session not found"}


def test_delete_run_from_wrong_session_returns_404_run_not_found(client):
    """A run id whose row exists under session A SHALL NOT be deleted under session B."""
    _create(client, "owner")
    _create(client, "stranger")
    owned_run = _append_run(client, "owner", ran_at=1)

    resp = client.delete(f"/v1/sessions/stranger/runs/{owned_run['id']}")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "run not found"}

    # The row SHALL still exist under the original owner.
    body = client.get("/v1/sessions/owner").json()
    assert [r["id"] for r in body["action_runs"]] == [owned_run["id"]]


def test_delete_run_idempotency_second_delete_returns_404(client):
    _create(client, "del-run-3")
    run = _append_run(client, "del-run-3", ran_at=1)

    first = client.delete(f"/v1/sessions/del-run-3/runs/{run['id']}")
    assert first.status_code == 204

    second = client.delete(f"/v1/sessions/del-run-3/runs/{run['id']}")
    assert second.status_code == 404
    assert second.json() == {"detail": "run not found"}
