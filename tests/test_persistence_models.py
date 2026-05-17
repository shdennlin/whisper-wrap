"""Tests for the persistence package (engine + models + sessions_repo)."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.services.persistence import (
    SessionLocal,
    SessionModel,
    build_engine,
    sessions_repo,
)
from app.services.persistence.models import ActionRun, Base, Final


@pytest.fixture()
def db_session():
    """Fresh in-memory SQLite + schema per test."""
    engine = build_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal.configure(bind=engine)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_engine_connect_round_trip():
    """build_engine returns a working Engine for the in-memory URL."""
    engine = build_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        result = conn.exec_driver_sql("SELECT 1").scalar()
    assert result == 1
    engine.dispose()


def test_schema_shape(db_session):
    """All three tables + named indexes exist after metadata.create_all."""
    bind = db_session.get_bind()
    insp_tables = sorted(
        bind.dialect.get_table_names(bind.connect())  # type: ignore[arg-type]
    )
    assert "sessions" in insp_tables
    assert "finals" in insp_tables
    assert "action_runs" in insp_tables

    with bind.connect() as conn:
        # SQLite stores indexes in sqlite_master
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).all()
    index_names = {r[0] for r in rows}
    for expected in (
        "idx_sessions_started",
        "idx_action_runs_session",
        "idx_action_runs_action",
    ):
        assert expected in index_names, f"missing {expected}"


def test_create_get_session_round_trip(db_session):
    created = sessions_repo.create_session(
        db_session, id="s1", started_at=1000, mode="batch"
    )
    db_session.commit()
    assert created.id == "s1"

    fetched = sessions_repo.get_session(db_session, "s1")
    assert fetched is not None
    assert fetched.mode == "batch"
    assert fetched.finals == []
    assert fetched.action_runs == []


def test_duplicate_session_id_raises_integrity_error(db_session):
    sessions_repo.create_session(db_session, id="dup", started_at=1, mode="batch")
    db_session.commit()
    with pytest.raises(IntegrityError):
        sessions_repo.create_session(
            db_session, id="dup", started_at=2, mode="live"
        )
        db_session.commit()


def test_mode_check_constraint_rejects_unknown(db_session):
    with pytest.raises(IntegrityError):
        sessions_repo.create_session(
            db_session, id="bad-mode", started_at=1, mode="garbage"
        )
        db_session.commit()


def test_list_sessions_order_and_cursor(db_session):
    for i in range(5):
        sessions_repo.create_session(
            db_session, id=f"s{i}", started_at=i * 100, mode="batch"
        )
    db_session.commit()

    # Default: 20 rows, started_at DESC
    listed = sessions_repo.list_sessions(db_session, limit=20)
    assert [s.id for s in listed] == ["s4", "s3", "s2", "s1", "s0"]

    # Cursor: only rows with started_at < 200 → s1, s0
    cursored = sessions_repo.list_sessions(db_session, limit=20, before_ms=200)
    assert [s.id for s in cursored] == ["s1", "s0"]


def test_update_session_partial(db_session):
    sessions_repo.create_session(db_session, id="u", started_at=10, mode="batch")
    db_session.commit()

    updated = sessions_repo.update_session(
        db_session, "u", ended_at=20, duration_ms=10
    )
    assert updated is not None
    assert updated.ended_at == 20
    assert updated.duration_ms == 10
    assert updated.audio_path is None  # untouched


def test_update_session_missing_returns_none(db_session):
    assert sessions_repo.update_session(db_session, "ghost", ended_at=5) is None


def test_append_final_ord_monotonic_per_session(db_session):
    sessions_repo.create_session(db_session, id="s", started_at=0, mode="live")
    db_session.commit()

    a = sessions_repo.append_final(
        db_session, "s", text="alpha", start_ms=0, end_ms=100
    )
    b = sessions_repo.append_final(
        db_session, "s", text="beta", start_ms=100, end_ms=200
    )
    c = sessions_repo.append_final(
        db_session, "s", text="gamma", start_ms=200, end_ms=300
    )
    db_session.commit()
    assert (a.ord, b.ord, c.ord) == (0, 1, 2)

    fetched = sessions_repo.get_session(db_session, "s")
    assert fetched is not None
    assert [f.text for f in fetched.finals] == ["alpha", "beta", "gamma"]


def test_append_action_run(db_session):
    sessions_repo.create_session(db_session, id="s", started_at=0, mode="batch")
    db_session.commit()

    run = sessions_repo.append_action_run(
        db_session,
        "s",
        action_id="polish",
        prompt="polish:\n hello",
        answer="hello.",
        ran_at=42,
        model_used="gemini-2.5-flash",
    )
    db_session.commit()
    assert run.id is not None
    assert run.succeeded is True


def test_delete_session_cascades_to_finals_and_runs(db_session):
    sessions_repo.create_session(db_session, id="s", started_at=0, mode="batch")
    sessions_repo.append_final(db_session, "s", text="x", start_ms=0, end_ms=1)
    sessions_repo.append_action_run(
        db_session, "s", action_id="a", prompt="p", answer="r", ran_at=1
    )
    db_session.commit()

    # Sanity: rows exist
    assert db_session.query(Final).count() == 1
    assert db_session.query(ActionRun).count() == 1

    assert sessions_repo.delete_session(db_session, "s") is True
    db_session.commit()

    assert db_session.query(SessionModel).count() == 0
    assert db_session.query(Final).count() == 0
    assert db_session.query(ActionRun).count() == 0


def test_delete_session_missing_returns_false(db_session):
    assert sessions_repo.delete_session(db_session, "ghost") is False


def test_wipe_all_audio_paths_clears_and_returns_paths(db_session):
    sessions_repo.create_session(db_session, id="s1", started_at=0, mode="batch")
    sessions_repo.create_session(db_session, id="s2", started_at=1, mode="batch")
    sessions_repo.update_session(
        db_session,
        "s1",
        audio_path="data/audio/s1.webm",
        audio_mime_type="audio/webm",
        audio_size_bytes=100,
    )
    sessions_repo.update_session(
        db_session,
        "s2",
        audio_path="data/audio/s2.webm",
        audio_mime_type="audio/webm",
        audio_size_bytes=200,
    )
    db_session.commit()

    cleared = sessions_repo.wipe_all_audio_paths(db_session)
    db_session.commit()
    assert sorted(cleared) == ["data/audio/s1.webm", "data/audio/s2.webm"]

    for sid in ("s1", "s2"):
        s = sessions_repo.get_session(db_session, sid)
        assert s is not None
        assert s.audio_path is None
        assert s.audio_mime_type is None
        assert s.audio_size_bytes is None
