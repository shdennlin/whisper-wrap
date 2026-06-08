"""Data-access functions for the meeting_analyses table.

Mirrors `sessions_repo.py`: pure functions that take a SQLAlchemy
`Session` first, return ORM instances or `None` on miss, and never
commit (the API handler owns commit boundaries).

Used by `/v1/meetings` REST endpoints AND by `_run_meeting_job` which
auto-persists on job completion so the PWA history sidebar can read
results even after the in-memory JobStore TTL evicts the job.
"""

from __future__ import annotations

import time

from sqlalchemy import select
from sqlalchemy.orm import Session as SASession

from app.services.persistence.models import MeetingAnalysisRow


def list_meeting_analyses(
    db: SASession,
    *,
    limit: int = 20,
    before_ms: int | None = None,
) -> list[MeetingAnalysisRow]:
    """Analyses ordered by `created_at DESC`, paginated via `before_ms`.

    No eager-loads needed — the row already contains the full result
    JSON, so list-vs-detail use the same query shape.
    """
    stmt = select(MeetingAnalysisRow).order_by(
        MeetingAnalysisRow.created_at.desc()
    )
    if before_ms is not None:
        stmt = stmt.where(MeetingAnalysisRow.created_at < before_ms)
    stmt = stmt.limit(limit)
    return list(db.scalars(stmt))


def get_meeting_analysis(
    db: SASession, id: str
) -> MeetingAnalysisRow | None:
    """Single analysis by primary-key id (== originating job_id)."""
    return db.get(MeetingAnalysisRow, id)


def create_meeting_analysis(
    db: SASession,
    *,
    id: str,
    filename: str,
    result_json: str,
    duration_seconds: float | None = None,
    language: str | None = None,
    speakers_count: int | None = None,
    speaker_names_json: str = "{}",
    status: str = "done",
    created_at_ms: int | None = None,
) -> MeetingAnalysisRow:
    """Insert a new analysis row. Caller catches `IntegrityError` on
    duplicate id (the job_id collides only if the same job_id is
    submitted twice, which the upstream meeting pipeline doesn't do)."""
    row = MeetingAnalysisRow(
        id=id,
        created_at=created_at_ms if created_at_ms is not None else int(time.time() * 1000),
        filename=filename,
        duration_seconds=duration_seconds,
        language=language,
        speakers_count=speakers_count,
        result_json=result_json,
        speaker_names_json=speaker_names_json,
        status=status,
    )
    db.add(row)
    db.flush()
    return row


def update_speaker_names(
    db: SASession, id: str, speaker_names_json: str
) -> MeetingAnalysisRow | None:
    """Patch the speaker_names map for an analysis. Returns None if
    the id is unknown so the API can map to 404."""
    row = db.get(MeetingAnalysisRow, id)
    if row is None:
        return None
    row.speaker_names_json = speaker_names_json
    db.flush()
    return row


def delete_meeting_analysis(db: SASession, id: str) -> bool:
    """Idempotent delete — returns True if a row was removed, False
    if the id was unknown."""
    row = db.get(MeetingAnalysisRow, id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True


def set_audio(
    db: SASession,
    id: str,
    *,
    audio_path: str,
    audio_mime_type: str,
    audio_size_bytes: int,
) -> MeetingAnalysisRow | None:
    """Attach an audio file reference to an existing analysis row.

    Called by POST /v1/meetings/{id}/audio after the PWA finishes
    uploading the original meeting recording. Returns None if the id
    is unknown so the endpoint can map to 404.
    """
    row = db.get(MeetingAnalysisRow, id)
    if row is None:
        return None
    row.audio_path = audio_path
    row.audio_mime_type = audio_mime_type
    row.audio_size_bytes = audio_size_bytes
    db.flush()
    return row
