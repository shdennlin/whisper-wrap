"""REST endpoints for persisted sessions, finals, action runs, and audio."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as SASession

from app.api.schemas.sessions import (
    ActionRunIn,
    ActionRunOut,
    AudioMetaOut,
    BulkAudioClearResponse,
    FinalIn,
    FinalOut,
    SessionCreate,
    SessionDigest,
    SessionFull,
    SessionListResponse,
    SessionPatch,
)
from app.config import config
from app.services.persistence import get_db, sessions_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])


# audio/webm → .webm rather than mimetypes.guess_extension's ".weba"; hardcoded
# to match the existing frontend `mimeToExt` helper so server-side filenames
# and client-side download names stay consistent.
MIME_TO_EXT: dict[str, str] = {
    "audio/webm": ".webm",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
}


def _ext_for_mime(mime_type: str) -> str:
    ext = MIME_TO_EXT.get(mime_type.lower())
    if ext is None:
        logger.warning("Unknown audio mime type %s, defaulting to .bin", mime_type)
        return ".bin"
    return ext


# --- Bulk audio endpoint must precede /{session_id}/audio so FastAPI's path
# matcher doesn't treat "audio" as a session_id. -------------------------------


@router.delete("/audio", response_model=BulkAudioClearResponse)
def bulk_clear_audio(db: SASession = Depends(get_db)) -> BulkAudioClearResponse:
    """Unlink every audio file referenced by a session and null the columns."""
    cleared = sessions_repo.wipe_all_audio_paths(db)
    db.commit()
    count = 0
    for rel in cleared:
        path = Path(rel)
        try:
            path.unlink(missing_ok=True)
            count += 1
        except OSError as e:
            logger.warning("Failed to unlink %s: %s", path, e)
    return BulkAudioClearResponse(deleted_count=count)


# --- Sessions CRUD ------------------------------------------------------------


@router.get("", response_model=SessionListResponse)
def list_sessions(
    limit: int = Query(20, ge=1, le=100),
    before_ms: int | None = Query(None, ge=0),
    db: SASession = Depends(get_db),
) -> SessionListResponse:
    rows = sessions_repo.list_sessions(db, limit=limit, before_ms=before_ms)
    next_cursor = rows[-1].started_at if len(rows) == limit else None
    return SessionListResponse(
        sessions=[SessionDigest.model_validate(r) for r in rows],
        next_before_ms=next_cursor,
    )


@router.get("/{session_id}", response_model=SessionFull)
def get_session(
    session_id: str, db: SASession = Depends(get_db)
) -> SessionFull:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")
    return SessionFull.model_validate(sess)


@router.post("", response_model=SessionFull, status_code=201)
def create_session(
    body: SessionCreate, db: SASession = Depends(get_db)
) -> SessionFull:
    try:
        sess = sessions_repo.create_session(
            db, id=body.id, started_at=body.started_at, mode=body.mode
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="session id already exists")
    # Refresh to include the empty finals / action_runs collections.
    fresh = sessions_repo.get_session(db, sess.id)
    assert fresh is not None
    return SessionFull.model_validate(fresh)


@router.patch("/{session_id}", response_model=SessionFull)
def patch_session(
    session_id: str,
    body: SessionPatch,
    db: SASession = Depends(get_db),
) -> SessionFull:
    updated = sessions_repo.update_session(
        db,
        session_id,
        ended_at=body.ended_at,
        duration_ms=body.duration_ms,
        audio_path=body.audio_path,
        audio_mime_type=body.audio_mime_type,
        audio_size_bytes=body.audio_size_bytes,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="session not found")
    db.commit()
    fresh = sessions_repo.get_session(db, session_id)
    assert fresh is not None
    return SessionFull.model_validate(fresh)


@router.delete("/{session_id}", status_code=204)
def delete_session(
    session_id: str, db: SASession = Depends(get_db)
) -> Response:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")
    audio_path = sess.audio_path
    deleted = sessions_repo.delete_session(db, session_id)
    if not deleted:
        # Race: another caller deleted between fetch + delete. Treat as 404.
        raise HTTPException(status_code=404, detail="session not found")
    db.commit()
    if audio_path:
        try:
            Path(audio_path).unlink(missing_ok=True)
        except OSError as e:
            logger.warning("Failed to unlink %s: %s", audio_path, e)
    return Response(status_code=204)


# --- Finals + action_runs (append-only) ---------------------------------------


@router.post(
    "/{session_id}/finals", response_model=FinalOut, status_code=201
)
def append_final(
    session_id: str, body: FinalIn, db: SASession = Depends(get_db)
) -> FinalOut:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")
    final = sessions_repo.append_final(
        db,
        session_id,
        text=body.text,
        start_ms=body.start_ms,
        end_ms=body.end_ms,
        kind=body.kind,
    )
    db.commit()
    return FinalOut.model_validate(final)


@router.post(
    "/{session_id}/runs", response_model=ActionRunOut, status_code=201
)
def append_action_run(
    session_id: str, body: ActionRunIn, db: SASession = Depends(get_db)
) -> ActionRunOut:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")
    run = sessions_repo.append_action_run(
        db,
        session_id,
        action_id=body.action_id,
        prompt=body.prompt,
        answer=body.answer,
        ran_at=body.ran_at,
        model_used=body.model_used,
        succeeded=body.succeeded,
    )
    db.commit()
    return ActionRunOut.model_validate(run)


# --- Audio upload + stream ----------------------------------------------------


@router.post("/{session_id}/audio", response_model=AudioMetaOut)
async def upload_audio(
    session_id: str,
    file: UploadFile = File(...),
    db: SASession = Depends(get_db),
) -> AudioMetaOut:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")

    mime = file.content_type or "application/octet-stream"
    ext = _ext_for_mime(mime)

    # Replacement: unlink the previous file first so we don't accumulate
    # `<id>.webm` + `<id>.m4a` orphans when the client re-uploads with a
    # different mime.
    if sess.audio_path:
        try:
            Path(sess.audio_path).unlink(missing_ok=True)
        except OSError:
            pass

    config.ensure_data_dirs()
    target = config.audio_dir / f"{session_id}{ext}"
    body = await file.read()
    target.write_bytes(body)

    rel_path = str(target)
    updated = sessions_repo.update_session(
        db,
        session_id,
        audio_path=rel_path,
        audio_mime_type=mime,
        audio_size_bytes=len(body),
    )
    db.commit()
    assert updated is not None
    return AudioMetaOut(
        audio_path=rel_path,
        audio_size_bytes=len(body),
        audio_mime_type=mime,
    )


@router.get("/{session_id}/audio")
def stream_audio(
    session_id: str, db: SASession = Depends(get_db)
) -> FileResponse:
    sess = sessions_repo.get_session(db, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")
    if not sess.audio_path or not Path(sess.audio_path).exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(
        sess.audio_path,
        media_type=sess.audio_mime_type or "application/octet-stream",
        filename=os.path.basename(sess.audio_path),
    )
