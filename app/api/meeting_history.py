"""REST endpoints for persisted meeting analyses (/v1/meetings).

Lifecycle: rows are created either by `_run_meeting_job` on successful
completion (the common case) or by the PWA's one-shot migration from
localStorage on first load after this feature ships. Updates are
limited to `speaker_names` (the only post-write user input). Reads
serve the PWA history sidebar so it survives the in-memory JobStore
TTL (default 1h), server restarts, and cross-device access.

Shape mirrors `/v1/sessions` — same pagination cursor (`before_ms`),
same Depends(get_db), same commit-per-handler discipline.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as SASession

from app.api.schemas.meeting_history import (
    MeetingAudioMetaOut,
    MeetingCreate,
    MeetingFull,
    MeetingListResponse,
    MeetingPatch,
)
from app.config import config
from app.services.persistence import get_db
from app.services.persistence import meeting_analyses_repo as repo
from app.services.persistence.models import MeetingAnalysisRow

# audio/webm → .webm rather than mimetypes.guess_extension's ".weba".
# Mirrors `app/api/sessions.py:MIME_TO_EXT`.
_MIME_TO_EXT: dict[str, str] = {
    "audio/webm": ".webm",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/opus": ".opus",
}


def _ext_for_mime(mime_type: str) -> str:
    ext = _MIME_TO_EXT.get(mime_type.lower())
    if ext is None:
        logger.warning(
            "Unknown audio mime type %s; defaulting to .bin", mime_type
        )
        return ".bin"
    return ext

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/meetings", tags=["meetings"])


def _row_to_full(row: MeetingAnalysisRow) -> MeetingFull:
    """Hydrate the JSON Text columns into typed dicts for the response."""
    try:
        result = json.loads(row.result_json)
    except (json.JSONDecodeError, TypeError):
        # Corrupted persisted JSON shouldn't take down the whole list
        # endpoint — surface an empty result so the row still appears
        # in the sidebar with a "—" placeholder.
        logger.exception("Corrupt result_json on meeting_analyses.id=%s", row.id)
        result = {}
    try:
        speaker_names = json.loads(row.speaker_names_json)
        if not isinstance(speaker_names, dict):
            speaker_names = {}
    except (json.JSONDecodeError, TypeError):
        speaker_names = {}
    return MeetingFull(
        id=row.id,
        created_at=row.created_at,
        filename=row.filename,
        duration_seconds=row.duration_seconds,
        language=row.language,
        speakers_count=row.speakers_count,
        result=result,
        speaker_names=speaker_names,
        status=row.status,
        audio_path=row.audio_path,
        audio_mime_type=row.audio_mime_type,
        audio_size_bytes=row.audio_size_bytes,
    )


@router.get("", response_model=MeetingListResponse)
def list_meetings(
    limit: int = Query(20, ge=1, le=100),
    before_ms: int | None = Query(None, ge=0),
    db: SASession = Depends(get_db),
) -> MeetingListResponse:
    rows = repo.list_meeting_analyses(db, limit=limit, before_ms=before_ms)
    next_cursor = rows[-1].created_at if len(rows) == limit else None
    return MeetingListResponse(
        meetings=[_row_to_full(r) for r in rows],
        next_before_ms=next_cursor,
    )


@router.get("/{meeting_id}", response_model=MeetingFull)
def get_meeting(
    meeting_id: str, db: SASession = Depends(get_db)
) -> MeetingFull:
    row = repo.get_meeting_analysis(db, meeting_id)
    if row is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    return _row_to_full(row)


@router.post("", response_model=MeetingFull, status_code=201)
def create_meeting(
    body: MeetingCreate, db: SASession = Depends(get_db)
) -> MeetingFull:
    try:
        row = repo.create_meeting_analysis(
            db,
            id=body.id,
            filename=body.filename,
            duration_seconds=body.duration_seconds,
            language=body.language,
            speakers_count=body.speakers_count,
            result_json=json.dumps(body.result),
            speaker_names_json=json.dumps(body.speaker_names),
            status=body.status,
            created_at_ms=body.created_at,
        )
        db.commit()
    except IntegrityError as err:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="meeting id already exists"
        ) from err
    return _row_to_full(row)


@router.patch("/{meeting_id}", response_model=MeetingFull)
def patch_meeting(
    meeting_id: str,
    body: MeetingPatch,
    db: SASession = Depends(get_db),
) -> MeetingFull:
    row = repo.update_speaker_names(
        db, meeting_id, json.dumps(body.speaker_names)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    db.commit()
    return _row_to_full(row)


@router.delete("/{meeting_id}", status_code=204)
def delete_meeting(
    meeting_id: str, db: SASession = Depends(get_db)
) -> Response:
    # Capture the audio path BEFORE the DB delete so we can clean up
    # the orphan file. Database delete cascades nothing here (audio
    # is a sidecar file, not an FK).
    row = repo.get_meeting_analysis(db, meeting_id)
    audio_path = row.audio_path if row is not None else None
    if not repo.delete_meeting_analysis(db, meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    db.commit()
    if audio_path:
        try:
            Path(audio_path).unlink(missing_ok=True)
        except OSError as e:
            logger.warning("Failed to unlink %s: %s", audio_path, e)
    return Response(status_code=204)


@router.post("/{meeting_id}/audio", response_model=MeetingAudioMetaOut)
async def upload_meeting_audio(
    meeting_id: str,
    file: UploadFile = File(...),
    db: SASession = Depends(get_db),
) -> MeetingAudioMetaOut:
    """Attach the original audio recording to a finished analysis.

    Called by the PWA after `_run_meeting_job` completes (the
    server-side temp WAV was already cleaned up at that point).
    Re-upload replaces the existing file. Storage path follows
    `app.config.audio_dir` with `meeting-{id}{ext}` to avoid
    colliding with `/v1/sessions` audio.
    """
    row = repo.get_meeting_analysis(db, meeting_id)
    if row is None:
        raise HTTPException(status_code=404, detail="meeting not found")

    mime = file.content_type or "application/octet-stream"
    ext = _ext_for_mime(mime)

    # Replacement: unlink any previous file so we don't accumulate
    # `meeting-<id>.m4a` + `meeting-<id>.wav` orphans on re-upload
    # with a different mime.
    if row.audio_path:
        try:
            Path(row.audio_path).unlink(missing_ok=True)
        except OSError:
            pass

    config.ensure_data_dirs()
    target = config.audio_dir / f"meeting-{meeting_id}{ext}"
    body = await file.read()
    target.write_bytes(body)

    rel_path = str(target)
    updated = repo.set_audio(
        db,
        meeting_id,
        audio_path=rel_path,
        audio_mime_type=mime,
        audio_size_bytes=len(body),
    )
    db.commit()
    assert updated is not None
    return MeetingAudioMetaOut(
        audio_path=rel_path,
        audio_mime_type=mime,
        audio_size_bytes=len(body),
    )


@router.get("/{meeting_id}/audio")
def stream_meeting_audio(
    meeting_id: str, db: SASession = Depends(get_db)
) -> FileResponse:
    row = repo.get_meeting_analysis(db, meeting_id)
    if row is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    if not row.audio_path or not Path(row.audio_path).exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(
        row.audio_path,
        media_type=row.audio_mime_type or "application/octet-stream",
        filename=os.path.basename(row.audio_path),
    )


def _persist_completed_job(
    *,
    job_id: str,
    filename: str,
    result_obj: dict[str, Any],
    duration_seconds: float | None,
    language: str | None,
    speakers_count: int | None,
) -> None:
    """Worker-side helper called from `_run_meeting_job` after success.

    Best-effort: persistence failure does NOT propagate to the client;
    the in-memory JobStore still has the result for the next poll.
    Lives here so `app/api/meeting.py` doesn't have to import the DB
    layer directly (matches the imports-at-callsite pattern in
    sessions.py).
    """
    from app.services.persistence.engine import SessionLocal

    try:
        with SessionLocal() as db:
            repo.create_meeting_analysis(
                db,
                id=job_id,
                filename=filename,
                result_json=json.dumps(result_obj),
                duration_seconds=duration_seconds,
                language=language,
                speakers_count=speakers_count,
            )
            db.commit()
    except IntegrityError:
        # Same job_id persisted twice — should not happen in practice
        # (each meeting submission gets a fresh ULID), but treat as a
        # silent no-op rather than letting the worker crash.
        logger.warning("meeting_analyses row already exists for %s", job_id)
    except Exception:  # noqa: BLE001 — best-effort persistence
        logger.exception("Failed to persist meeting_analyses row %s", job_id)
