"""Tests for the auto-session-logger that persists /transcribe + /ask calls.

The logger is a side-effect helper used by stateless API endpoints; failures
must NEVER bubble (a DB hiccup can't break a transcribe response). These
tests verify both the happy path (row written, ids returned) and the
failure path (logged-and-swallowed, caller proceeds).
"""

from __future__ import annotations

import logging
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import auto_session_logger
from app.services.persistence import Base, SessionLocal, build_engine, sessions_repo


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path):
    """Bind SessionLocal to a per-test SQLite engine with a fresh schema.

    The autouse conftest `_isolate_persistence` already sets DATABASE_URL +
    DATA_DIR for the test; here we additionally build the engine and bind
    the global SessionLocal so the logger's `SessionLocal()` call lands on
    a usable bound factory. Bypassing alembic (using `create_all`) keeps
    these unit tests fast — they only exercise the logger module.
    """
    engine = build_engine(f"sqlite:///{tmp_path}/logger-test.db")
    Base.metadata.create_all(engine)
    SessionLocal.configure(bind=engine)
    yield
    SessionLocal.configure(bind=None)
    engine.dispose()


def _read_back(session_id: str):
    db = SessionLocal()
    try:
        return sessions_repo.get_session(db, session_id)
    finally:
        db.close()


# ============ log_transcribe_session ============


def test_log_transcribe_creates_session_final_with_duration():
    sid = auto_session_logger.log_transcribe_session(
        transcript="Hello world", duration_ms=4_200
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.mode == "batch"
    assert sess.ended_at is not None
    assert sess.duration_ms == 4_200
    assert len(sess.finals) == 1
    assert sess.finals[0].text == "Hello world"
    assert sess.finals[0].end_ms == 4_200


def test_log_transcribe_without_duration_uses_zero():
    sid = auto_session_logger.log_transcribe_session(transcript="hi")
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    # No duration provided: still log session, end_ms = 0 is fine.
    assert sess.duration_ms is None
    assert sess.finals[0].end_ms == 0


def test_log_transcribe_skips_blank_input():
    """Filter-dropped or whitespace-only transcripts MUST NOT clutter history."""
    assert auto_session_logger.log_transcribe_session(transcript="") is None
    assert auto_session_logger.log_transcribe_session(transcript="   ") is None


def test_log_transcribe_returns_pwa_compatible_id():
    """Backend-generated ids SHALL match the PWA's `<base36-ts>-<rand>` shape so
    the history view doesn't render two distinct id formats."""
    sid = auto_session_logger.log_transcribe_session(transcript="hi")
    assert sid is not None
    assert "-" in sid
    ts_part, rand_part = sid.split("-", 1)
    # Both parts must be valid base36 (lowercase digits + a-z).
    assert all(c in "0123456789abcdefghijklmnopqrstuvwxyz" for c in ts_part)
    assert all(c in "0123456789abcdefghijklmnopqrstuvwxyz" for c in rand_part)


def test_log_transcribe_db_failure_returns_none(caplog):
    """A DB failure MUST be logged but never raised — the caller's response
    path is too critical to break for a side-effect."""
    with patch.object(
        sessions_repo, "create_session", side_effect=RuntimeError("db down")
    ):
        with caplog.at_level(logging.ERROR):
            result = auto_session_logger.log_transcribe_session(transcript="hi")
    assert result is None
    assert any("auto-session" in r.message for r in caplog.records)


# ============ log_ask_session ============


def test_log_ask_creates_session_final_and_action_run():
    sid = auto_session_logger.log_ask_session(
        transcript="What's the weather?",
        answer="Sunny and 25C.",
        duration_ms=3_000,
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.mode == "batch"
    assert len(sess.finals) == 1
    assert sess.finals[0].text == "What's the weather?"
    assert len(sess.action_runs) == 1
    run = sess.action_runs[0]
    assert run.action_id == "passthrough"  # the "send as-is" id from registry
    assert run.answer == "Sunny and 25C."
    assert run.prompt == "What's the weather?"
    assert run.succeeded is True


def test_log_ask_text_only_path_still_logs_final():
    """JSON `{"text": "..."}` /ask path has no audio but the user_text IS the
    transcript — log it as a final so the history row has content."""
    sid = auto_session_logger.log_ask_session(
        transcript="hi", answer="hello back"
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert len(sess.finals) == 1
    assert sess.finals[0].text == "hi"


def test_log_ask_skips_when_answer_blank():
    """If Gemini returned nothing useful, don't pollute history."""
    assert auto_session_logger.log_ask_session(transcript="hi", answer="") is None
    assert (
        auto_session_logger.log_ask_session(transcript="hi", answer="   ") is None
    )


def test_log_ask_db_failure_returns_none(caplog):
    with patch.object(
        sessions_repo, "create_session", side_effect=RuntimeError("db down")
    ):
        with caplog.at_level(logging.ERROR):
            result = auto_session_logger.log_ask_session(
                transcript="hi", answer="hello"
            )
    assert result is None
    assert any("auto-session" in r.message for r in caplog.records)


# ============ audio persistence (Shortcut + curl + OpenAI-compat) ============


def test_log_transcribe_persists_audio_blob_when_provided():
    """When audio bytes accompany the call (Shortcut, curl, OpenAI-compat),
    the logger SHALL write the blob to disk and stamp audio_path/mime/size on
    the session so the PWA's getAudio() can stream it later."""
    blob = b"RIFF\x00\x00\x00\x00WAVEfmt fake-audio-bytes"
    sid = auto_session_logger.log_transcribe_session(
        transcript="hi",
        audio_blob=blob,
        audio_mime_type="audio/wav",
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is not None
    assert sess.audio_path.endswith(".wav")
    assert sess.audio_mime_type == "audio/wav"
    assert sess.audio_size_bytes == len(blob)
    # The file MUST actually be on disk at the recorded path.
    assert Path(sess.audio_path).read_bytes() == blob


def test_log_transcribe_without_audio_leaves_audio_columns_null():
    """Backwards-compatible: callers that don't pass audio (text-only paths,
    or environments that prefer not to persist) must still create a session
    with NULL audio columns — same shape as PWA-driven text logging."""
    sid = auto_session_logger.log_transcribe_session(transcript="hi")
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is None
    assert sess.audio_mime_type is None


def test_log_transcribe_audio_with_unknown_mime_falls_back_to_bin():
    """A Shortcut sending application/octet-stream still gets its bytes
    persisted — they're just saved with a .bin extension. The PWA's player
    decodes from the bytes directly so extension is cosmetic."""
    sid = auto_session_logger.log_transcribe_session(
        transcript="hi",
        audio_blob=b"raw",
        audio_mime_type="application/octet-stream",
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is not None
    assert sess.audio_path.endswith(".bin")


def test_log_ask_audio_path_persists_audio():
    """For /ask audio-mode (Shortcut sends audio → STT → Gemini), the same
    persistence should land so history detail shows the waveform."""
    blob = b"OggS\x00fake-ogg-bytes"
    sid = auto_session_logger.log_ask_session(
        transcript="hi",
        answer="hello",
        audio_blob=blob,
        audio_mime_type="audio/ogg",
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is not None
    assert sess.audio_path.endswith(".ogg")
    assert sess.audio_size_bytes == len(blob)


def test_log_ask_text_path_no_audio_persisted():
    """JSON `{"text": "..."}` /ask has no audio_blob — must NOT persist
    anything to audio_dir."""
    sid = auto_session_logger.log_ask_session(
        transcript="hi", answer="hello"
    )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is None


def test_log_transcribe_audio_write_failure_still_creates_session(caplog):
    """If disk write fails (full disk, permissions), the session row should
    still be created so the response path stays clean — just without the
    audio_path column populated. Caller gets a working session id."""
    with patch(
        "app.services.auto_session_logger.Path.write_bytes",
        side_effect=OSError("disk full"),
    ):
        with caplog.at_level(logging.ERROR):
            sid = auto_session_logger.log_transcribe_session(
                transcript="hi",
                audio_blob=b"bytes",
                audio_mime_type="audio/wav",
            )
    assert sid is not None
    sess = _read_back(sid)
    assert sess is not None
    assert sess.audio_path is None
    assert any("failed to write audio" in r.message for r in caplog.records)
