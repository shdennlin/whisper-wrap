"""POST /transcribe/meeting and GET /transcribe/meeting/{job_id}.

The meeting endpoint is intentionally separate from /transcribe: it returns a
job handle for asynchronous polling instead of blocking the HTTP connection
for the 8-15 minutes a full pipeline run takes, and it has different 503
preconditions (HF_TOKEN, optional `[meeting]` extras, CT2 variant on disk).
"""

from __future__ import annotations

import importlib.util
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request

from app.api.transcribe import (
    _is_supported_dispatch_type,
    _normalize_content_type,
    _read_multipart_audio,
    _read_raw_audio,
)
from app.config import config
from app.services.converter import audio_converter
from app.services.files import file_manager
from app.services.meeting import MeetingAnalyzer, MeetingResult
from app.services.meeting_jobs import JobStore
from app.services.registry import MeetingModelMissingError, resolve_ct2_variant

logger = logging.getLogger(__name__)

router = APIRouter()


def check_meeting_availability(cfg=config) -> tuple[bool, str | None]:
    """Return `(available, reason)` for the meeting endpoint preconditions.

    Used by both /status and the POST endpoint so the two stay consistent.
    `reason` is None when available is True.
    """
    if importlib.util.find_spec("whisperx") is None:
        return False, "meeting extras not installed"
    if importlib.util.find_spec("pyannote") is None:
        return False, "meeting extras not installed"
    if importlib.util.find_spec("pyannote.audio") is None:
        return False, "meeting extras not installed"
    if not (cfg.HF_TOKEN or "").strip():
        return False, "HF_TOKEN is not configured"
    try:
        ct2_dir = resolve_ct2_variant(cfg.MEETING_MODEL_NAME)
    except MeetingModelMissingError as e:
        return False, str(e)
    if not Path(ct2_dir).exists():
        return False, (
            f"model {cfg.MEETING_MODEL_NAME} ct2 variant is not downloaded; "
            f"run make download-model MODEL={cfg.MEETING_MODEL_NAME}"
        )
    return True, None


def _resolve_ct2_dir_for_status(cfg=config) -> str | None:
    """Return the absolute ct2 variant path when downloaded, else None."""
    try:
        path = resolve_ct2_variant(cfg.MEETING_MODEL_NAME)
    except MeetingModelMissingError:
        return None
    p = Path(path).resolve()
    return str(p) if p.exists() else None


def _extras_installed() -> bool:
    return (
        importlib.util.find_spec("whisperx") is not None
        and importlib.util.find_spec("pyannote") is not None
        and importlib.util.find_spec("pyannote.audio") is not None
    )


def _serialise_result(result: MeetingResult) -> dict[str, Any]:
    """Convert a MeetingResult dataclass tree to the JSON shape from the spec.

    Segments with `words=None` omit the `words` key entirely (per the
    `enable_word_timestamps=false` contract). Word lists otherwise emit one
    object per word.
    """
    segments_json = []
    for seg in result.segments:
        seg_dict: dict[str, Any] = {
            "speaker": seg.speaker,
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
        }
        if seg.words is not None:
            seg_dict["words"] = [asdict(w) for w in seg.words]
        segments_json.append(seg_dict)
    return {
        "language": result.language,
        "duration_seconds": result.duration_seconds,
        "speakers": result.speakers,
        "segments": segments_json,
    }


def _job_to_json(job) -> dict[str, Any]:
    """Serialise a Job for the GET endpoint."""
    payload: dict[str, Any] = {
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "result": _serialise_result(job.result) if job.result is not None else None,
    }
    if job.error is not None:
        payload["error"] = {"code": job.error.code, "message": job.error.message}
    return payload


def _get_store(request: Request) -> JobStore:
    return request.app.state.meeting_jobs


def _get_or_create_analyzer(request: Request) -> MeetingAnalyzer:
    """Lazy-construct the analyzer on first call. Caller MUST ensure the
    ct2 variant is downloaded (via check_meeting_availability) — from_config
    raises MeetingModelMissingError otherwise."""
    state = request.app.state
    if state.meeting_analyzer is None:
        state.meeting_analyzer = MeetingAnalyzer.from_config(config)
    return state.meeting_analyzer


async def _read_meeting_audio(request: Request) -> tuple[bytes, str]:
    """Mirror `/transcribe`'s dispatch logic: multipart, raw audio/*, or octet-stream."""
    content_type = _normalize_content_type(request.headers.get("content-type"))
    if not _is_supported_dispatch_type(content_type):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported Content-Type: {content_type or '<missing>'}",
        )
    if content_type == "multipart/form-data":
        return await _read_multipart_audio(request)
    return await _read_raw_audio(request, content_type)


def _validate_speaker_range(
    num_speakers: int | None,
    min_speakers: int | None,
    max_speakers: int | None,
) -> None:
    if num_speakers is not None and num_speakers < 1:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_speaker_range",
                "reason": "num_speakers must be >= 1",
            },
        )
    if min_speakers is not None and min_speakers < 1:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_speaker_range",
                "reason": "min_speakers must be >= 1",
            },
        )
    if (
        min_speakers is not None
        and max_speakers is not None
        and max_speakers < min_speakers
    ):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_speaker_range",
                "reason": "max_speakers must be >= min_speakers",
            },
        )


async def _run_meeting_job(
    *,
    analyzer: MeetingAnalyzer,
    store: JobStore,
    job_id: str,
    audio_path: str,
    language: str | None,
    num_speakers: int | None,
    min_speakers: int | None,
    max_speakers: int | None,
    enable_word_timestamps: bool,
) -> None:
    """Background entrypoint — runs the pipeline and updates the job record.

    Wraps every failure in a typed error code so the GET endpoint can surface
    a stable `error.code` to the client.
    """
    store.mark_running(job_id, stage="asr")
    try:

        def progress(stage: str, progress: float) -> None:
            store.update_progress(job_id, stage=stage, progress=progress)

        result = await analyzer.analyze(
            audio_path,
            language=language if language and language != "auto" else None,
            num_speakers=num_speakers,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
            enable_word_timestamps=enable_word_timestamps,
            progress_callback=progress,
        )
        store.mark_done(job_id, result)
    except Exception as exc:  # noqa: BLE001 — surface every failure as job.error
        stage = store.get(job_id).stage if store.get(job_id) else "unknown"
        code_map = {
            "asr": "asr_failed",
            "align": "align_failed",
            "diarize": "diarize_failed",
        }
        code = code_map.get(stage, "pipeline_failed")
        logger.exception("Meeting job %s failed in stage %s", job_id, stage)
        store.mark_error(job_id, code=code, message=str(exc))
    finally:
        file_manager.cleanup_file(audio_path)


@router.post("/transcribe/meeting", status_code=202)
async def post_meeting(
    request: Request,
    background_tasks: BackgroundTasks,
    language: str | None = Query(
        None,
        description="Spoken language code (ISO 639-1). Omit for auto-detection.",
    ),
    num_speakers: int | None = Query(
        None, description="Exact speaker count when known (skips clustering search)"
    ),
    min_speakers: int | None = Query(None, description="Lower bound on speaker count"),
    max_speakers: int | None = Query(None, description="Upper bound on speaker count"),
    enable_word_timestamps: bool = Query(
        True, description="Include per-word timestamps (alignment stage)"
    ),
) -> dict[str, Any]:
    """Accept a meeting audio upload and return a job handle.

    The response (HTTP 202) carries `job_id` + `status_url`; the client polls
    GET `/transcribe/meeting/{job_id}` until `status == "done"`.
    """
    available, reason = check_meeting_availability(config)
    if not available:
        raise HTTPException(
            status_code=503,
            detail={"error": "meeting_unavailable", "reason": reason},
        )

    _validate_speaker_range(num_speakers, min_speakers, max_speakers)

    body, suffix = await _read_meeting_audio(request)
    if not body:
        raise HTTPException(status_code=400, detail="Empty audio body")

    temp_input = file_manager.create_temp_file(suffix=suffix)
    try:
        with open(temp_input, "wb") as f:
            f.write(body)
        if not file_manager.validate_file_size(temp_input):
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {config.MAX_FILE_SIZE_MB}MB",
            )
        if not file_manager.is_audio_file(temp_input):
            detected = file_manager.detect_mime_type(temp_input)
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "invalid_audio",
                    "reason": f"unsupported file format (detected: {detected})",
                },
            )
        temp_wav = audio_converter.convert_to_wav(temp_input)
    finally:
        file_manager.cleanup_file(temp_input)

    store = _get_store(request)
    analyzer = _get_or_create_analyzer(request)
    job = store.create()
    background_tasks.add_task(
        _run_meeting_job,
        analyzer=analyzer,
        store=store,
        job_id=job.job_id,
        audio_path=temp_wav,
        language=language,
        num_speakers=num_speakers,
        min_speakers=min_speakers,
        max_speakers=max_speakers,
        enable_word_timestamps=enable_word_timestamps,
    )
    return {
        "job_id": job.job_id,
        "status_url": f"/transcribe/meeting/{job.job_id}",
    }


@router.get("/transcribe/meeting/{job_id}")
async def get_meeting_status(job_id: str, request: Request) -> dict[str, Any]:
    """Return the current state of a previously created meeting job."""
    available, reason = check_meeting_availability(config)
    if not available:
        raise HTTPException(
            status_code=503,
            detail={"error": "meeting_unavailable", "reason": reason},
        )
    store = _get_store(request)
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"error": "job_not_found"})
    return _job_to_json(job)


