"""OpenAI Whisper REST API compatibility layer.

Routes:
  - POST /v1/audio/transcriptions
  - POST /v1/audio/translations
  - GET  /v1/models

Wraps the in-process `WhisperBackend` exposed on `app.state.whisper` with the
request and response shapes documented at
<https://platform.openai.com/docs/api-reference/audio>. The underlying model is
the same one `/transcribe` uses; this module is a thin compatibility shim, not
a separate inference path.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.datastructures import UploadFile

from app.config import config
from app.services.converter import audio_converter
from app.services.files import file_manager
from app.services.postprocess import Drop, Keep, filter_empty_transcription
from app.services.subtitle_format import format_srt, format_vtt

logger = logging.getLogger(__name__)

router = APIRouter()

ACCEPTED_RESPONSE_FORMATS = ("json", "text", "srt", "verbose_json", "vtt")

# OpenAI model IDs clients commonly hardcode. Accepting these silently keeps
# the SDK quiet; any other non-empty value logs one WARNING per request.
RESERVED_MODEL_ALIASES = frozenset(
    {"whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"}
)


def _resolve_active_model_name(state) -> str:
    """Mirror of `app.api.status._resolve_model_name` — when MODEL_DIR overrides
    the registry lookup we report the override path; otherwise the registry
    key (which is what /status surfaces too)."""
    if config.MODEL_DIR:
        return getattr(state, "model_dir", "") or ""
    return config.MODEL_NAME


def _openai_error(
    *,
    status_code: int,
    message: str,
    param: str | None,
    error_type: str = "invalid_request_error",
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "message": message,
                "type": error_type,
                "param": param,
                "code": None,
            }
        },
    )


def _segments_to_verbose_json(segments) -> list[dict]:
    """Build the OpenAI verbose_json segment shape. Fields whisper-wrap cannot
    supply (`tokens`, `avg_logprob`, `compression_ratio`, `no_speech_prob`)
    are present with falsy values rather than omitted, so SDK clients can
    rely on the keys existing."""
    return [
        {
            "id": idx,
            "seek": 0,
            "start": float(seg.start),
            "end": float(seg.end),
            "text": seg.text,
            "tokens": [],
            "temperature": 0.0,
            "avg_logprob": None,
            "compression_ratio": None,
            "no_speech_prob": None,
        }
        for idx, seg in enumerate(segments)
    ]


def _empty_response_for_format(
    response_format: str,
    *,
    task: str,
    language: str,
    duration: float,
) -> Response:
    """Build the OpenAI-shaped empty-content response for a filtered transcription.

    Per spec: NO custom fields. Each format returns the same shape an empty
    transcription would naturally yield, so SDK clients keep parsing.
    """
    if response_format == "json":
        return JSONResponse(content={"text": ""})
    if response_format == "text":
        return PlainTextResponse(content="", media_type="text/plain; charset=utf-8")
    if response_format == "srt":
        return PlainTextResponse(content="", media_type="text/plain; charset=utf-8")
    if response_format == "vtt":
        return Response(content="WEBVTT\n\n", media_type="text/vtt; charset=utf-8")
    # verbose_json — preserve metadata so clients keying off language/duration
    # still get accurate values; segments is empty per OpenAI's silent-audio shape.
    return JSONResponse(
        content={
            "task": task,
            "language": language,
            "duration": duration,
            "text": "",
            "segments": [],
        }
    )


def _log_model_field(received: str, active: str) -> None:
    """Emit one WARNING when a client requested a model name that is neither
    a reserved OpenAI alias nor equal to the active whisper-wrap model name.
    Reserved aliases and matches stay silent."""
    if received in RESERVED_MODEL_ALIASES or received == active:
        return
    logger.warning(
        "openai-compat: client requested model=%r; serving with active model=%r",
        received,
        active,
    )


async def _read_multipart_fields(request: Request) -> dict:
    """Pull file + form fields from a multipart body. Returns a dict shaped
    `{"file": UploadFile|None, "model": str|None, "language": str|None,
       "prompt": str|None, "response_format": str|None, "temperature": str|None}`.

    Returns None for fields the client omitted. Raises ValueError if the body
    is not multipart at all (caller maps to 400)."""
    try:
        form = await request.form()
    except Exception as e:  # noqa: BLE001 — surface a clean error to the caller
        raise ValueError(f"expected multipart/form-data body: {e}") from e
    upload = form.get("file")
    return {
        "file": upload if isinstance(upload, UploadFile) else None,
        "model": form.get("model"),
        "language": form.get("language"),
        "prompt": form.get("prompt"),
        "response_format": form.get("response_format"),
        "temperature": form.get("temperature"),
    }


async def _transcribe_or_translate(
    request: Request,
    *,
    task: str,
) -> Response:
    """Shared handler for /v1/audio/transcriptions and /v1/audio/translations.

    `task` is `"transcribe"` or `"translate"`. The translations branch rejects
    the `language` field (per OpenAI documented behaviour — output is always
    English) and invokes the backend with the translate task.
    """
    try:
        fields = await _read_multipart_fields(request)
    except ValueError as e:
        return _openai_error(status_code=400, message=str(e), param=None)

    upload = fields["file"]
    if upload is None:
        return _openai_error(
            status_code=400,
            message="Missing required form field 'file'",
            param="file",
        )

    model = fields["model"]
    if not model:
        return _openai_error(
            status_code=400,
            message="Missing required form field 'model'",
            param="model",
        )

    response_format = fields["response_format"] or "json"
    if response_format not in ACCEPTED_RESPONSE_FORMATS:
        accepted = ", ".join(ACCEPTED_RESPONSE_FORMATS)
        return _openai_error(
            status_code=400,
            message=(
                f"Invalid response_format {response_format!r}. "
                f"Accepted values: {accepted}."
            ),
            param="response_format",
        )

    if task == "translate" and fields["language"] is not None:
        return _openai_error(
            status_code=400,
            message=(
                "Translations always output English; the 'language' form field "
                "is not accepted on /v1/audio/translations."
            ),
            param="language",
        )

    state = request.app.state
    active_model = _resolve_active_model_name(state)
    _log_model_field(model, active_model)

    body = await upload.read()
    if not body:
        return _openai_error(
            status_code=400,
            message="Uploaded file is empty",
            param="file",
        )

    filename = upload.filename or "audio.unknown"
    suffix = Path(filename).suffix or ".audio"

    temp_input = file_manager.create_temp_file(suffix=suffix)
    temp_wav = None
    try:
        with open(temp_input, "wb") as f:
            f.write(body)

        if not file_manager.validate_file_size(temp_input):
            return _openai_error(
                status_code=413,
                message=f"File too large. Maximum size: {config.MAX_FILE_SIZE_MB}MB",
                param="file",
            )

        if not file_manager.is_audio_file(temp_input):
            detected_mime = file_manager.detect_mime_type(temp_input)
            return _openai_error(
                status_code=415,
                message=f"Unsupported file format. Detected: {detected_mime}",
                param="file",
            )

        temp_wav = audio_converter.convert_to_wav(temp_input)

        whisper = state.whisper
        language = fields["language"] if task == "transcribe" else None
        transcribe_kwargs: dict = {
            "language": language or "auto",
            "initial_prompt": fields["prompt"],
        }
        if task == "translate":
            transcribe_kwargs["task"] = "translate"
        result = await whisper.transcribe(temp_wav, **transcribe_kwargs)

        if task == "translate":
            language_field = "en"
        else:
            language_field = language if language else getattr(result, "language", "en")

        # Post-process filter: collapse to per-format empty shapes when the
        # backend produces noise. The OpenAI response schema is preserved
        # exactly (no custom fields) so third-party clients keep parsing.
        decision = filter_empty_transcription(
            text=result.text,
            duration_ms=None,
            enabled=config.FILTER_EMPTY_ENABLED,
            min_duration_ms=config.FILTER_MIN_DURATION_MS,
        )
        if isinstance(decision, Drop):
            endpoint_path = f"/v1/audio/{'translations' if task == 'translate' else 'transcriptions'}"
            logger.info(
                "transcription_filtered",
                extra={
                    "endpoint": endpoint_path,
                    "reason": decision.reason,
                    "response_format": response_format,
                    "raw_text_len": len(result.text),
                },
            )
            return _empty_response_for_format(
                response_format,
                task=task,
                language=language_field,
                duration=float(getattr(result, "duration_seconds", 0.0)),
            )
        assert isinstance(decision, Keep)
        result_text = decision.text

        if response_format == "json":
            return JSONResponse(content={"text": result_text})

        if response_format == "text":
            return PlainTextResponse(
                content=result_text,
                media_type="text/plain; charset=utf-8",
            )

        if response_format == "srt":
            srt_segments = [
                (float(s.start), float(s.end), s.text) for s in result.segments
            ]
            return PlainTextResponse(
                content=format_srt(srt_segments),
                media_type="text/plain; charset=utf-8",
            )

        if response_format == "vtt":
            vtt_segments = [
                (float(s.start), float(s.end), s.text) for s in result.segments
            ]
            return Response(
                content=format_vtt(vtt_segments),
                media_type="text/vtt; charset=utf-8",
            )

        # verbose_json
        return JSONResponse(
            content={
                "task": task,
                "language": language_field,
                "duration": float(getattr(result, "duration_seconds", 0.0)),
                "text": result_text,
                "segments": _segments_to_verbose_json(result.segments),
            }
        )

    except Exception:  # noqa: BLE001
        logger.exception("openai-compat: backend failure during %s", task)
        return _openai_error(
            status_code=500,
            message="Internal server error during audio inference",
            param=None,
            error_type="server_error",
        )
    finally:
        if temp_input:
            file_manager.cleanup_file(temp_input)
        if temp_wav:
            file_manager.cleanup_file(temp_wav)


@router.post("/v1/audio/transcriptions")
async def transcriptions(request: Request) -> Response:
    return await _transcribe_or_translate(request, task="transcribe")


@router.post("/v1/audio/translations")
async def translations(request: Request) -> Response:
    return await _transcribe_or_translate(request, task="translate")


@router.get("/v1/models")
async def models(request: Request) -> Response:
    state = request.app.state
    return JSONResponse(
        content={
            "object": "list",
            "data": [
                {
                    "id": _resolve_active_model_name(state),
                    "object": "model",
                    "created": int(getattr(state, "lifespan_completed_at", 0.0)),
                    "owned_by": "whisper-wrap",
                }
            ],
        }
    )
