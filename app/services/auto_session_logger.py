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
from pathlib import Path

from app.config import config
from app.services.persistence import SessionLocal, sessions_repo

logger = logging.getLogger(__name__)


# Mirror the mime → extension mapping that the PWA-driven upload endpoint
# uses (app/api/sessions.py::_ext_for_mime). Keeping a small local copy
# avoids reaching into the API layer from a service module, and the set is
# stable: these are the codecs whisper-wrap accepts on /transcribe.
_AUDIO_EXTENSIONS: dict[str, str] = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
}


def _persist_audio(sid: str, audio_blob: bytes, mime: str) -> tuple[str, str, int] | None:
    """Write the raw audio bytes to disk and return (path, mime, size).

    Returns ``None`` if the write fails. Caller is responsible for invoking
    ``sessions_repo.update_session`` with the returned tuple — we keep that
    out of here so the same DB transaction owns both the session create and
    the audio metadata update.
    """
    if not audio_blob:
        return None
    ext = _AUDIO_EXTENSIONS.get(mime, ".bin")
    try:
        config.ensure_data_dirs()
        target = Path(config.audio_dir) / f"{sid}{ext}"
        target.write_bytes(audio_blob)
        return (str(target), mime, len(audio_blob))
    except OSError:
        # Disk full / permission denied — don't take down the response path.
        logger.exception("auto-session: failed to write audio blob for %s", sid)
        return None

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
    audio_blob: bytes | None = None,
    audio_mime_type: str | None = None,
) -> str | None:
    """Persist a `/transcribe` call as a one-shot batch session.

    When ``audio_blob`` is supplied, the raw bytes are also written to the
    audio store so the PWA history detail can show a waveform + Re-transcribe
    button for Shortcut / curl / OpenAI-compat clients that previously had
    transcript-only records. Audio persistence failures are non-fatal — the
    session still gets created with just the transcript.

    Returns the new session id, or ``None`` if the transcript was blank
    (filtered noise — don't pollute history) or a DB write failed.
    """
    if not transcript.strip():
        return None

    sid = _generate_session_id()
    started_at = int(time.time() * 1000)

    audio_meta: tuple[str, str, int] | None = None
    if audio_blob and audio_mime_type:
        audio_meta = _persist_audio(sid, audio_blob, audio_mime_type)

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
        update_kwargs: dict[str, object] = {
            "ended_at": started_at,
            "duration_ms": duration_ms,
        }
        if audio_meta is not None:
            update_kwargs["audio_path"] = audio_meta[0]
            update_kwargs["audio_mime_type"] = audio_meta[1]
            update_kwargs["audio_size_bytes"] = audio_meta[2]
        sessions_repo.update_session(db, sid, **update_kwargs)
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
    audio_blob: bytes | None = None,
    audio_mime_type: str | None = None,
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

    audio_meta: tuple[str, str, int] | None = None
    if audio_blob and audio_mime_type:
        audio_meta = _persist_audio(sid, audio_blob, audio_mime_type)

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
        update_kwargs: dict[str, object] = {
            "ended_at": started_at,
            "duration_ms": duration_ms,
        }
        if audio_meta is not None:
            update_kwargs["audio_path"] = audio_meta[0]
            update_kwargs["audio_mime_type"] = audio_meta[1]
            update_kwargs["audio_size_bytes"] = audio_meta[2]
        sessions_repo.update_session(db, sid, **update_kwargs)
        db.commit()
        return sid
    except Exception:
        db.rollback()
        logger.exception("auto-session: failed to log /ask call")
        return None
    finally:
        db.close()
