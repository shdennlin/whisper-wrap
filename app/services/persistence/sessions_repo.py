"""Pure data-access functions for sessions, finals, action_runs.

Functions take a SQLAlchemy `Session` first, returning ORM instances or `None`
on miss. Caller decides commit boundaries (API handlers commit per request
via a context manager; tests may batch). The repo only handles the "what to
write" — never "when to commit" or "how to enable FKs" (that lives in engine).
"""

from __future__ import annotations

from sqlalchemy import event, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session as SASession, selectinload

from app.services.persistence.models import ActionRun, Final, Session


# SQLite needs PRAGMA foreign_keys=ON per-connection for ON DELETE CASCADE
# to take effect. Registering at engine level keeps the API layer ignorant
# of the pragma; production lifespan and tests both benefit.
@event.listens_for(Engine, "connect")
def _sqlite_enable_fk(dbapi_connection, _connection_record):
    cur = dbapi_connection.cursor()
    try:
        cur.execute("PRAGMA foreign_keys=ON")
    except Exception:
        # Non-SQLite drivers will fail — that's fine; pragma is SQLite-only.
        pass
    finally:
        cur.close()


def list_sessions(
    db: SASession,
    *,
    limit: int = 20,
    before_ms: int | None = None,
) -> list[Session]:
    """Sessions ordered by `started_at DESC`, paginated via `before_ms` cursor."""
    stmt = select(Session).order_by(Session.started_at.desc())
    if before_ms is not None:
        stmt = stmt.where(Session.started_at < before_ms)
    stmt = stmt.limit(limit)
    return list(db.scalars(stmt))


def get_session(db: SASession, session_id: str) -> Session | None:
    """Single session with finals + action_runs eagerly loaded."""
    stmt = (
        select(Session)
        .where(Session.id == session_id)
        .options(selectinload(Session.finals), selectinload(Session.action_runs))
    )
    return db.scalars(stmt).one_or_none()


def create_session(
    db: SASession,
    *,
    id: str,
    started_at: int,
    mode: str,
) -> Session:
    """Insert a new session. Caller catches `IntegrityError` for duplicate IDs."""
    sess = Session(id=id, started_at=started_at, mode=mode)
    db.add(sess)
    db.flush()
    return sess


def update_session(
    db: SASession,
    session_id: str,
    *,
    ended_at: int | None = None,
    duration_ms: int | None = None,
    audio_path: str | None = None,
    audio_mime_type: str | None = None,
    audio_size_bytes: int | None = None,
) -> Session | None:
    """Partial update — only sets fields that are not None.

    To explicitly NULL a field (e.g. clearing audio_path during bulk wipe),
    callers should use `wipe_all_audio_paths` rather than passing None here;
    None here means "leave alone".
    """
    sess = db.get(Session, session_id)
    if sess is None:
        return None
    if ended_at is not None:
        sess.ended_at = ended_at
    if duration_ms is not None:
        sess.duration_ms = duration_ms
    if audio_path is not None:
        sess.audio_path = audio_path
    if audio_mime_type is not None:
        sess.audio_mime_type = audio_mime_type
    if audio_size_bytes is not None:
        sess.audio_size_bytes = audio_size_bytes
    db.flush()
    return sess


def delete_session(db: SASession, session_id: str) -> bool:
    """Returns True if a row was deleted (cascade clears finals + runs)."""
    sess = db.get(Session, session_id)
    if sess is None:
        return False
    db.delete(sess)
    db.flush()
    return True


def append_final(
    db: SASession,
    session_id: str,
    *,
    text: str,
    start_ms: int | None,
    end_ms: int | None,
    kind: str | None = None,
) -> Final:
    """Append a final with monotonic `ord` (= max existing + 1, or 0 if first)."""
    max_ord_stmt = select(func.max(Final.ord)).where(Final.session_id == session_id)
    current_max = db.scalar(max_ord_stmt)
    next_ord = 0 if current_max is None else current_max + 1

    final = Final(
        session_id=session_id,
        ord=next_ord,
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        kind=kind,
    )
    db.add(final)
    db.flush()
    return final


def append_action_run(
    db: SASession,
    session_id: str,
    *,
    action_id: str,
    prompt: str,
    answer: str,
    ran_at: int,
    model_used: str | None = None,
    succeeded: bool = True,
) -> ActionRun:
    run = ActionRun(
        session_id=session_id,
        action_id=action_id,
        prompt=prompt,
        answer=answer,
        ran_at=ran_at,
        model_used=model_used,
        succeeded=succeeded,
    )
    db.add(run)
    db.flush()
    return run


def wipe_all_audio_paths(db: SASession) -> list[str]:
    """Null `audio_path` / `audio_mime_type` / `audio_size_bytes` on every row.

    Returns the list of paths that were cleared so the API handler can unlink
    the files from disk. Bulk update keeps this one round-trip.
    """
    stmt = select(Session).where(Session.audio_path.is_not(None))
    cleared: list[str] = []
    for sess in db.scalars(stmt):
        if sess.audio_path:
            cleared.append(sess.audio_path)
        sess.audio_path = None
        sess.audio_mime_type = None
        sess.audio_size_bytes = None
    db.flush()
    return cleared
