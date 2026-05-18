"""Tests for the auto-session-logger that persists /transcribe + /ask calls.

The logger is a side-effect helper used by stateless API endpoints; failures
must NEVER bubble (a DB hiccup can't break a transcribe response). These
tests verify both the happy path (row written, ids returned) and the
failure path (logged-and-swallowed, caller proceeds).
"""

from __future__ import annotations

import logging
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
