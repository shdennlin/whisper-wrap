"""Integration tests for /v1/meetings (the persisted meeting history).

Mirrors the `/v1/sessions` test pattern: stub the WhisperBackend
loader so lifespan runs only the persistence init (Alembic + engine),
then drive HTTP requests through TestClient.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
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


def _sample_meeting(mid: str = "m1", **overrides):
    body = {
        "id": mid,
        "filename": "meeting.m4a",
        "result": {
            "language": "en",
            "duration_seconds": 12.0,
            "speakers": ["SPEAKER_00", "SPEAKER_01"],
            "segments": [
                {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0, "text": "Hello."},
                {"speaker": "SPEAKER_01", "start": 5.0, "end": 12.0, "text": "Hi back."},
            ],
        },
        "duration_seconds": 12.0,
        "language": "en",
        "speakers_count": 2,
    }
    body.update(overrides)
    return body


def test_empty_list_on_fresh_db(client):
    r = client.get("/v1/meetings")
    assert r.status_code == 200
    body = r.json()
    assert body["meetings"] == []
    assert body["next_before_ms"] is None


def test_create_and_get_roundtrip(client):
    r = client.post("/v1/meetings", json=_sample_meeting())
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"] == "m1"
    assert created["filename"] == "meeting.m4a"
    assert created["speakers_count"] == 2
    assert created["result"]["language"] == "en"
    assert created["speaker_names"] == {}
    assert created["status"] == "done"

    r = client.get("/v1/meetings/m1")
    assert r.status_code == 200
    fetched = r.json()
    assert fetched["id"] == "m1"
    assert fetched["result"]["segments"][0]["text"] == "Hello."


def test_get_unknown_returns_404(client):
    r = client.get("/v1/meetings/nope")
    assert r.status_code == 404


def test_duplicate_id_returns_409(client):
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.post("/v1/meetings", json=_sample_meeting())
    assert r.status_code == 409


def test_patch_speaker_names_only(client):
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.patch(
        "/v1/meetings/m1",
        json={"speaker_names": {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["speaker_names"] == {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}
    # Result content unchanged — speaker labels still in raw form.
    assert body["result"]["segments"][0]["speaker"] == "SPEAKER_00"


def test_patch_unknown_returns_404(client):
    r = client.patch(
        "/v1/meetings/missing", json={"speaker_names": {}}
    )
    assert r.status_code == 404


def test_delete_idempotent(client):
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.delete("/v1/meetings/m1")
    assert r.status_code == 204
    r = client.delete("/v1/meetings/m1")
    assert r.status_code == 404  # 404 on subsequent delete


def test_list_orders_newest_first(client):
    # created_at supplied explicitly so we can assert ordering deterministically.
    client.post("/v1/meetings", json=_sample_meeting("a", created_at=1000))
    client.post("/v1/meetings", json=_sample_meeting("b", created_at=3000))
    client.post("/v1/meetings", json=_sample_meeting("c", created_at=2000))
    r = client.get("/v1/meetings")
    ids = [m["id"] for m in r.json()["meetings"]]
    assert ids == ["b", "c", "a"]


def test_pagination_via_before_ms(client):
    # Insert 5 rows, list with limit=2, follow the cursor to drain.
    for i in range(5):
        client.post(
            "/v1/meetings", json=_sample_meeting(f"m{i}", created_at=1000 + i)
        )
    r = client.get("/v1/meetings?limit=2")
    body = r.json()
    assert len(body["meetings"]) == 2
    # Newest two first (created_at 1004, 1003).
    assert [m["id"] for m in body["meetings"]] == ["m4", "m3"]
    # next_before_ms is the OLDEST created_at in the current page.
    cursor = body["next_before_ms"]
    assert cursor == 1003

    r = client.get(f"/v1/meetings?limit=2&before_ms={cursor}")
    body = r.json()
    assert [m["id"] for m in body["meetings"]] == ["m2", "m1"]
