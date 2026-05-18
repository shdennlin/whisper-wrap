"""One-shot session logging for stateless API endpoints.

Lets `/transcribe`, `/ask`, and the OpenAI-compat endpoints persist their
input + output to the same `sessions` / `finals` / `action_runs` tables
the PWA writes to via `/v1/sessions/*`. Result: external clients (iPhone
Shortcuts, curl, third-party tools) appear in the PWA history view
automatically — no client-side state machine required.

Failure policy: **every persistence error is caught and logged**. The
caller (a transcription endpoint) MUST NOT raise on an audit-log hiccup —
the user's response path is too critical to break for a side effect.
"""

from __future__ import annotations

import logging
import secrets
import string
import time

from app.services.persistence import SessionLocal, sessions_repo

logger = logging.getLogger(__name__)

_BASE36 = string.digits + string.ascii_lowercase


def _to_base36(n: int) -> str:
    if n == 0:
        return "0"
    digits: list[str] = []
    while n > 0:
        digits.append(_BASE36[n % 36])
        n //= 36
    return "".join(reversed(digits))


def _generate_session_id() -> str:
    """Generate an id visually compatible with the PWA's `generateId()`.

    Shape: `<base36(timestamp_ms)>-<5-char-random-base36>`. Sortable by
    time, cheap to read in logs, and renders identically to PWA-created
    sessions in the master-detail view.
    """
    ts = _to_base36(int(time.time() * 1000))
    rand = "".join(secrets.choice(_BASE36) for _ in range(5))
    return f"{ts}-{rand}"


def log_transcribe_session(
    *,
    transcript: str,
    duration_ms: int | None = None,
) -> str | None:
    """Persist a `/transcribe` call as a one-shot batch session.

    Returns the new session id, or `None` if the transcript was blank
    (filtered noise — don't pollute history) or a DB write failed.
    """
    if not transcript.strip():
        return None

    sid = _generate_session_id()
    started_at = int(time.time() * 1000)

    db = SessionLocal()
    try:
        sessions_repo.create_session(
            db, id=sid, started_at=started_at, mode="batch"
        )
        sessions_repo.append_final(
            db,
            sid,
            text=transcript,
            start_ms=0,
            end_ms=duration_ms if duration_ms is not None else 0,
            kind=None,
        )
        sessions_repo.update_session(
            db,
            sid,
            ended_at=started_at,
            duration_ms=duration_ms,
        )
        db.commit()
        return sid
    except Exception:
        db.rollback()
        logger.exception("auto-session: failed to log /transcribe call")
        return None
    finally:
        db.close()


def log_ask_session(
    *,
    transcript: str,
    answer: str,
    duration_ms: int | None = None,
) -> str | None:
    """Persist an `/ask` call: a final (the transcript or user_text) plus a
    `passthrough` action_run carrying the answer.

    The `passthrough` action_id matches the registry's "send as-is" chip so
    history rendering is consistent between PWA-driven and auto-logged
    runs. Returns the new session id, or `None` on blank inputs / DB error.
    """
    if not answer.strip():
        return None

    sid = _generate_session_id()
    started_at = int(time.time() * 1000)

    db = SessionLocal()
    try:
        sessions_repo.create_session(
            db, id=sid, started_at=started_at, mode="batch"
        )
        if transcript and transcript.strip():
            sessions_repo.append_final(
                db,
                sid,
                text=transcript,
                start_ms=0,
                end_ms=duration_ms if duration_ms is not None else 0,
                kind=None,
            )
        sessions_repo.append_action_run(
            db,
            sid,
            action_id="passthrough",
            prompt=transcript or "",
            answer=answer,
            ran_at=started_at,
            model_used=None,
            succeeded=True,
        )
        sessions_repo.update_session(
            db,
            sid,
            ended_at=started_at,
            duration_ms=duration_ms,
        )
        db.commit()
        return sid
    except Exception:
        db.rollback()
        logger.exception("auto-session: failed to log /ask call")
        return None
    finally:
        db.close()
