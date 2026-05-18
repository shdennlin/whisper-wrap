"""POST /transcribe — unified audio transcription endpoint.

v2 unifies the v1 `/transcribe` (multipart) and `/transcribe-raw` (raw body) routes
into a single endpoint that dispatches on Content-Type per the design decision
"Unify POST /transcribe-raw into POST /transcribe via Content-Type dispatch".
"""

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.datastructures import UploadFile

from app.config import config
from app.services import auto_session_logger
from app.services.converter import audio_converter
from app.services.files import file_manager
from app.services.postprocess import Drop, Keep, filter_empty_transcription

logger = logging.getLogger(__name__)

router = APIRouter()


# Maps a Content-Type seen on a raw audio body to the suffix used for the
# temp input file (so libmagic / ffmpeg can pick the right decoder).
_RAW_BODY_EXTENSION_MAP = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/m4a": ".m4a",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "application/octet-stream": ".audio",
}


def _normalize_content_type(raw: str | None) -> str:
    """Strip parameters (e.g. ;boundary=...) and lowercase the base type."""
    if not raw:
        return ""
    return raw.split(";", 1)[0].strip().lower()


def _is_supported_dispatch_type(content_type: str) -> bool:
    if content_type == "multipart/form-data":
        return True
    if content_type.startswith("audio/"):
        return True
    if content_type == "application/octet-stream":
        return True
    return False


async def _read_multipart_audio(request: Request) -> tuple[bytes, str]:
    """Return (body_bytes, suffix) from a multipart form upload."""
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise HTTPException(status_code=400, detail="Missing form field 'file'")
    body = await upload.read()
    filename = upload.filename or "audio.unknown"
    suffix = Path(filename).suffix or ".audio"
    return body, suffix


async def _read_raw_audio(request: Request, content_type: str) -> tuple[bytes, str]:
    body = await request.body()
    suffix = _RAW_BODY_EXTENSION_MAP.get(content_type, ".audio")
    return body, suffix


@router.post("/transcribe")
async def transcribe(
    request: Request,
    language: str = Query(
        "auto",
        description="Spoken language code (e.g. 'en', 'zh') or 'auto' for detection",
    ),
    prompt: str | None = Query(
        None,
        description="Initial prompt seed forwarded to the model to bias punctuation and style",
    ),
    log: bool = Query(
        True,
        description=(
            "If true (default), persist this call as a one-shot session so it "
            "appears in the PWA history. The PWA itself sends log=false because "
            "it manages its own session lifecycle via /v1/sessions."
        ),
    ),
) -> dict[str, Any]:
    """Transcribe an audio body.

    Dispatches on `Content-Type`:
      - `multipart/form-data` → reads the `file` field
      - `audio/*` or `application/octet-stream` → reads `request.body()` as raw audio
      - anything else → HTTP 415

    The `language` and `prompt` query parameters apply to every supported body shape.
    """
    content_type = _normalize_content_type(request.headers.get("content-type"))

    if not _is_supported_dispatch_type(content_type):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported Content-Type: {content_type or '<missing>'}",
        )

    if content_type == "multipart/form-data":
        body, suffix = await _read_multipart_audio(request)
    else:
        body, suffix = await _read_raw_audio(request, content_type)

    if not body:
        raise HTTPException(status_code=400, detail="Empty audio body")

    temp_input = file_manager.create_temp_file(suffix=suffix)
    temp_wav = None
    try:
        with open(temp_input, "wb") as f:
            f.write(body)

        if not file_manager.validate_file_size(temp_input):
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {config.MAX_FILE_SIZE_MB}MB",
            )

        detected_mime = file_manager.detect_mime_type(temp_input)
        logger.info(
            "Transcribe: ct=%s, detected_mime=%s, bytes=%d",
            content_type,
            detected_mime,
            len(body),
        )

        if not file_manager.is_audio_file(temp_input):
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported file format. Detected: {detected_mime}",
            )

        temp_wav = audio_converter.convert_to_wav(temp_input)

        whisper = request.app.state.whisper
        result = await whisper.transcribe(
            temp_wav, language=language, initial_prompt=prompt
        )
        # Post-process filter: collapse pure-noise results to `{"text": ""}`
        # so downstream consumers can ignore them uniformly.
        decision = filter_empty_transcription(
            text=result.text,
            duration_ms=None,
            enabled=config.FILTER_EMPTY_ENABLED,
            min_duration_ms=config.FILTER_MIN_DURATION_MS,
        )
        if isinstance(decision, Drop):
            logger.info(
                "transcription_filtered",
                extra={
                    "endpoint": "/transcribe",
                    "reason": decision.reason,
                    "duration_ms": None,
                    "raw_text_len": len(result.text),
                },
            )
            return {"text": ""}
        assert isinstance(decision, Keep)
        response: dict[str, Any] = {
            "text": decision.text,
            "language": result.language,
            "segments": [
                {"text": s.text, "start": s.start, "end": s.end}
                for s in result.segments
            ],
        }
        if log:
            sid = auto_session_logger.log_transcribe_session(
                transcript=decision.text
            )
            if sid is not None:
                response["session_id"] = sid
        return response

    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Internal server error: {e}"
        ) from e
    finally:
        if temp_input:
            file_manager.cleanup_file(temp_input)
        if temp_wav:
            file_manager.cleanup_file(temp_wav)
