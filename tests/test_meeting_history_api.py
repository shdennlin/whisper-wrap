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


def test_patch_filename(client):
    """PATCH `filename` SHALL rename the meeting title without touching
    the result content or any other field. Used by the page-header
    rename ✏️ in the PWA."""
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.patch(
        "/v1/meetings/m1",
        json={"filename": "Q3 OKR review"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "Q3 OKR review"
    # Result + speaker_names untouched.
    assert body["result"]["segments"][0]["text"] == "Hello."
    assert body["speaker_names"] == {}


def test_patch_empty_body_returns_400(client):
    """A PATCH with neither field SHALL be rejected so the endpoint
    never silently no-ops."""
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.patch("/v1/meetings/m1", json={})
    assert r.status_code == 400


def test_patch_filename_strips_whitespace(client):
    client.post("/v1/meetings", json=_sample_meeting())
    r = client.patch(
        "/v1/meetings/m1", json={"filename": "  My Title  "}
    )
    assert r.status_code == 200
    assert r.json()["filename"] == "My Title"


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


# --- Audio endpoints ---------------------------------------------------------


def test_audio_upload_and_download_roundtrip(client, tmp_path, monkeypatch):
    # Redirect audio_dir into a temp path so the test doesn't pollute
    # the project's `data/audio/` directory.
    from app import config as config_module

    # audio_dir is a derived property of DATA_DIR; redirect the
    # source so audio writes land in tmp_path instead of the real
    # data/audio/ directory.
    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)

    client.post("/v1/meetings", json=_sample_meeting("m-audio"))

    # Upload
    audio_bytes = b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 100
    r = client.post(
        "/v1/meetings/m-audio/audio",
        files={"file": ("clip.wav", audio_bytes, "audio/wav")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["audio_mime_type"] == "audio/wav"
    assert body["audio_size_bytes"] == len(audio_bytes)
    assert body["audio_path"].endswith(".wav")

    # The row now carries audio metadata.
    r = client.get("/v1/meetings/m-audio")
    detail = r.json()
    assert detail["audio_mime_type"] == "audio/wav"
    assert detail["audio_size_bytes"] == len(audio_bytes)

    # Download — should return the exact bytes we uploaded.
    r = client.get("/v1/meetings/m-audio/audio")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/wav")
    assert r.content == audio_bytes


def test_audio_upload_to_unknown_meeting_returns_404(client, tmp_path, monkeypatch):
    from app import config as config_module

    # audio_dir is a derived property of DATA_DIR; redirect the
    # source so audio writes land in tmp_path instead of the real
    # data/audio/ directory.
    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    r = client.post(
        "/v1/meetings/missing/audio",
        files={"file": ("x.wav", b"data", "audio/wav")},
    )
    assert r.status_code == 404


def test_audio_download_before_upload_returns_404(client):
    client.post("/v1/meetings", json=_sample_meeting("m-no-audio"))
    r = client.get("/v1/meetings/m-no-audio/audio")
    assert r.status_code == 404


def test_audio_replace_unlinks_previous_file(client, tmp_path, monkeypatch):
    """Uploading twice with different mime types SHALL NOT leave an
    orphan from the first upload."""
    from pathlib import Path as _Path

    from app import config as config_module

    # audio_dir is a derived property of DATA_DIR; redirect the
    # source so audio writes land in tmp_path instead of the real
    # data/audio/ directory.
    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    client.post("/v1/meetings", json=_sample_meeting("m-replace"))

    audio_dir = tmp_path / "audio"

    client.post(
        "/v1/meetings/m-replace/audio",
        files={"file": ("a.m4a", b"first", "audio/mp4")},
    )
    first = audio_dir / "meeting-m-replace.m4a"
    assert first.exists()

    client.post(
        "/v1/meetings/m-replace/audio",
        files={"file": ("a.wav", b"second", "audio/wav")},
    )
    second = audio_dir / "meeting-m-replace.wav"
    assert second.exists()
    # First file is gone — replacement unlinks it.
    assert not first.exists()
    # Listing audio_dir: only the .wav remains.
    leftovers = sorted(p.name for p in _Path(audio_dir).iterdir())
    assert leftovers == ["meeting-m-replace.wav"]


def test_delete_meeting_unlinks_audio(client, tmp_path, monkeypatch):
    from app import config as config_module

    # audio_dir is a derived property of DATA_DIR; redirect the
    # source so audio writes land in tmp_path instead of the real
    # data/audio/ directory.
    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    client.post("/v1/meetings", json=_sample_meeting("m-del-audio"))
    client.post(
        "/v1/meetings/m-del-audio/audio",
        files={"file": ("x.wav", b"abcd", "audio/wav")},
    )
    target = tmp_path / "audio" / "meeting-m-del-audio.wav"
    assert target.exists()

    r = client.delete("/v1/meetings/m-del-audio")
    assert r.status_code == 204
    assert not target.exists(), "audio file SHALL be unlinked with the row"


# --- Security: path traversal + MIME smuggling -----------------------------


def test_create_rejects_path_traversal_in_id(client):
    """`POST /v1/meetings` SHALL reject ids that don't match the safe
    alphabet — Pydantic regex blocks `..`, `/`, NUL, etc. before they
    reach `config.audio_dir / f'meeting-{id}{ext}'`."""
    for bad_id in ("../etc", "..%2Ffoo", "a/b", "a\\b", "a b", "a.b"):
        body = _sample_meeting(bad_id)
        r = client.post("/v1/meetings", json=body)
        assert r.status_code == 422, (
            f"id {bad_id!r} SHALL be rejected by schema validation"
        )


def test_audio_upload_rejects_traversal_in_path_param(client, tmp_path, monkeypatch):
    """The `{meeting_id}` path param is re-validated at the endpoint
    level (Pydantic Field pattern doesn't apply to path params)."""
    from app import config as config_module

    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    # `..foo` has a dot — not in the alphabet → 400 from validator.
    r = client.post(
        "/v1/meetings/..foo/audio",
        files={"file": ("x.wav", b"data", "audio/wav")},
    )
    assert r.status_code == 400


def test_audio_upload_rejects_non_audio_mime(client, tmp_path, monkeypatch):
    """Stored XSS defense — the GET endpoint returns the stored
    audio_mime_type, so uploads that smuggle `text/html` could trigger
    XSS. MIME is allowlist-validated to block this at upload."""
    from app import config as config_module

    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    client.post("/v1/meetings", json=_sample_meeting("m-xss"))
    r = client.post(
        "/v1/meetings/m-xss/audio",
        files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")},
    )
    assert r.status_code == 400
    assert "unsupported audio mime type" in r.text


def test_audio_download_sets_no_sniff_header(client, tmp_path, monkeypatch):
    """`X-Content-Type-Options: nosniff` SHALL be on the audio GET so
    the browser MUST trust the Content-Type header. Defense in depth
    against historical/legacy bad audio_mime_type values."""
    from app import config as config_module

    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    client.post("/v1/meetings", json=_sample_meeting("m-headers"))
    client.post(
        "/v1/meetings/m-headers/audio",
        files={"file": ("a.wav", b"RIFFdata", "audio/wav")},
    )
    r = client.get("/v1/meetings/m-headers/audio")
    assert r.status_code == 200
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers["content-type"].startswith("audio/wav")


def test_audio_download_coerces_legacy_bad_mime(client, tmp_path, monkeypatch):
    """If a row carries a stored mime that isn't in the allowlist
    (e.g. written before the MIME allowlist landed), the GET response
    SHALL coerce to application/octet-stream rather than echoing it
    back. Belt-and-braces with the upload-side allowlist."""
    from pathlib import Path as _Path

    from app import config as config_module
    from app.services.persistence import meeting_analyses_repo as repo
    from app.services.persistence.engine import SessionLocal

    monkeypatch.setattr(config_module.config, "DATA_DIR", tmp_path)
    client.post("/v1/meetings", json=_sample_meeting("m-legacy"))
    # First do a legitimate upload so the file exists on disk.
    client.post(
        "/v1/meetings/m-legacy/audio",
        files={"file": ("a.wav", b"audio data", "audio/wav")},
    )
    # Then directly mutate the row to simulate a legacy entry with a
    # bad mime; bypasses the upload validation.
    audio_file = _Path(tmp_path) / "audio" / "meeting-m-legacy.wav"
    assert audio_file.exists()
    with SessionLocal() as db:
        repo.set_audio(
            db,
            "m-legacy",
            audio_path=str(audio_file),
            audio_mime_type="text/html",
            audio_size_bytes=audio_file.stat().st_size,
        )
        db.commit()

    r = client.get("/v1/meetings/m-legacy/audio")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")
