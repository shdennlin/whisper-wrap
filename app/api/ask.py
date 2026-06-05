"""POST /ask — audio or text question, Gemini answer, optional SSE streaming.

Reuses the `/transcribe` Content-Type dispatch matrix and adds an `application/json`
branch (`{"text": "..."}`) that skips STT. Optional `?stream=true` returns a
`text/event-stream` response where every `data:` line is a single JSON document.

Event order (streaming success path):
  1. `event: transcript` with `data: {"text": <string or null>}`
  2. zero or more `event: token`  with `data: {"text": "<delta>"}`
  3. terminating `event: done`    with `data: {"finish_reason": "stop"}`

Failure paths:
  - STT failure BEFORE LLM call → terminating `event: error` (no `transcript`)
  - LLM failure AFTER `transcript` event → terminating `event: error`
  - GEMINI_API_KEY unset           → terminating `event: error` (no `transcript`)
"""

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.datastructures import UploadFile

from app.api.transcribe import (
    _RAW_BODY_EXTENSION_MAP,
    _is_supported_dispatch_type,
    _normalize_content_type,
)
from app.config import config
from app.services import auto_session_logger
from app.services.converter import audio_converter
from app.services.files import file_manager
from app.services.llm import LLMConfigError, LLMUpstreamError
from app.services.postprocess import Drop, Keep, filter_empty_transcription
from app.services.whisper import WhisperTranscriptionError

logger = logging.getLogger(__name__)

router = APIRouter()

CT_JSON = "application/json"


def _is_supported_ask_content_type(ct: str) -> bool:
    return _is_supported_dispatch_type(ct) or ct == CT_JSON


def _sse_event(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _read_text_body(request: Request) -> str:
    """Read & validate an `application/json {"text": "..."}` body.

    Raises HTTPException 400 for missing / empty / malformed payloads.
    """
    try:
        raw = await request.body()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read body: {e}") from e
    if not raw:
        raise HTTPException(status_code=400, detail="Empty JSON body")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Malformed JSON: {e.msg}") from e
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="Missing or empty 'text' field")
    return text


async def _extract_audio_body(
    request: Request, content_type: str
) -> tuple[bytes, str, str]:
    """Cheap validation phase for audio paths — runs before any SSE framing begins.

    Returns (body, suffix, mime). The mime hint is used by the auto-session
    logger to pick the right extension when persisting the blob for history.
    """
    if content_type == "multipart/form-data":
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=400, detail="Missing form field 'file'")
        body = await upload.read()
        suffix = Path(upload.filename or "audio.unknown").suffix or ".audio"
        mime = upload.content_type or "application/octet-stream"
    else:
        body = await request.body()
        suffix = _RAW_BODY_EXTENSION_MAP.get(content_type, ".audio")
        mime = content_type or "application/octet-stream"
    if not body:
        raise HTTPException(status_code=400, detail="Empty audio body")
    return body, suffix, mime


async def _run_audio_pipeline(
    request: Request,
    body: bytes,
    suffix: str,
    language: str,
    prompt: str | None,
) -> tuple[str, float]:
    """Write to disk, validate format/size, convert to WAV, transcribe.

    Returns (text, duration_seconds). Duration is forwarded to the
    auto-session-logger so PWA history detail can show a real elapsed
    time (and let the waveform player scrub) instead of 0.0s.
    """
    temp_input = file_manager.create_temp_file(suffix=suffix)
    temp_wav = None
    try:
        with open(temp_input, "wb") as f:
            f.write(body)

        if not file_manager.validate_file_size(temp_input):
            raise HTTPException(
                status_code=413,
                detail=f"File too large (max {config.MAX_FILE_SIZE_MB}MB)",
            )
        if not file_manager.is_audio_file(temp_input):
            mime = file_manager.detect_mime_type(temp_input)
            raise HTTPException(
                status_code=415, detail=f"Unsupported file format. Detected: {mime}"
            )

        temp_wav = audio_converter.convert_to_wav(temp_input)
        whisper = request.app.state.whisper
        result = await whisper.transcribe(
            temp_wav, language=language, initial_prompt=prompt
        )
        return result.text, result.duration_seconds or 0.0
    finally:
        if temp_input:
            file_manager.cleanup_file(temp_input)
        if temp_wav:
            file_manager.cleanup_file(temp_wav)


@router.post("/ask")
async def ask(
    request: Request,
    stream: bool = Query(
        False, description="If true, return text/event-stream with token deltas"
    ),
    language: str = Query("auto", description="Spoken language hint for audio inputs"),
    prompt: str | None = Query(
        None, description="Initial prompt seed for audio transcription"
    ),
    log: bool = Query(
        True,
        description=(
            "If true (default), persist this call as a one-shot session + "
            "passthrough action_run so it appears in the PWA history. The PWA "
            "sends log=false because it manages its own session lifecycle."
        ),
    ),
) -> Any:
    content_type = _normalize_content_type(request.headers.get("content-type"))

    if not _is_supported_ask_content_type(content_type):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported Content-Type: {content_type or '<missing>'}",
        )

    # ---- Validation phase: runs BEFORE any SSE framing begins (task 4.3) ----
    if content_type == CT_JSON:
        user_text = await _read_text_body(request)
        audio_body: bytes | None = None
        audio_suffix: str | None = None
        audio_mime: str | None = None
    else:
        audio_body, audio_suffix, audio_mime = await _extract_audio_body(
            request, content_type
        )
        user_text = None

    llm_client = request.app.state.llm_client

    # Audio duration (seconds) lazily filled by the audio pipeline so the
    # auto-session-logger can stamp it on the session row. Stays None when
    # the call is JSON-text mode (no audio to measure).
    audio_duration_s: float | None = None

    # ---- Blocking mode ----
    if not stream:
        if user_text is None:
            transcript, audio_duration_s = await _run_audio_pipeline(
                request, audio_body, audio_suffix, language, prompt
            )
            # Post-process: skip the LLM (and the Gemini bill) when STT yields
            # pure noise. Return 400 with a stable error code.
            decision = filter_empty_transcription(
                text=transcript,
                duration_ms=None,
                enabled=config.FILTER_EMPTY_ENABLED,
                min_duration_ms=config.FILTER_MIN_DURATION_MS,
            )
            if isinstance(decision, Drop):
                logger.info(
                    "transcription_filtered",
                    extra={
                        "endpoint": "/ask",
                        "reason": decision.reason,
                        "stream": False,
                        "raw_text_len": len(transcript),
                    },
                )
                return JSONResponse({"error": "no_speech_detected"}, status_code=400)
            assert isinstance(decision, Keep)
            llm_input = decision.text
            transcript_for_response: str | None = decision.text
        else:
            llm_input = user_text
            transcript_for_response = None

        try:
            answer = await llm_client.ask(llm_input)
        except LLMConfigError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        except LLMUpstreamError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        response: dict[str, Any] = {
            "transcript": transcript_for_response,
            "answer": answer,
        }
        if log:
            # Audio path → final.text = transcript; JSON text path → final.text
            # = user_text (so the row shows the question, not blank).
            final_text = (
                transcript_for_response
                if transcript_for_response is not None
                else (user_text or "")
            )
            sid = auto_session_logger.log_ask_session(
                transcript=final_text,
                answer=answer,
                duration_ms=(
                    int(audio_duration_s * 1000)
                    if audio_duration_s
                    else None
                ),
                audio_blob=audio_body,
                audio_mime_type=audio_mime,
            )
            if sid is not None:
                response["session_id"] = sid
        return response

    # ---- Streaming mode ----
    async def event_stream():
        if not llm_client.configured:
            # Missing credentials: single event:error, no transcript event (task 4.5).
            yield _sse_event("error", {"error": "GEMINI_API_KEY is not configured"})
            return

        if user_text is not None:
            # JSON text path: transcript event with null text, then proceed to LLM.
            yield _sse_event("transcript", {"text": None})
            llm_input = user_text
        else:
            # Audio path: run pipeline. STT failure → event:error WITHOUT transcript.
            try:
                transcript_text, audio_duration_s = await _run_audio_pipeline(
                    request, audio_body, audio_suffix, language, prompt
                )
            except HTTPException as he:
                yield _sse_event("error", {"error": he.detail})
                return
            except WhisperTranscriptionError as e:
                yield _sse_event("error", {"error": str(e)})
                return
            except Exception as e:  # defensive: don't crash the stream
                yield _sse_event("error", {"error": f"Transcription failed: {e}"})
                return
            # Apply empty-filter BEFORE emitting transcript event so the client
            # sees a single error frame rather than transcript-then-llm-call.
            stream_decision = filter_empty_transcription(
                text=transcript_text,
                duration_ms=None,
                enabled=config.FILTER_EMPTY_ENABLED,
                min_duration_ms=config.FILTER_MIN_DURATION_MS,
            )
            if isinstance(stream_decision, Drop):
                logger.info(
                    "transcription_filtered",
                    extra={
                        "endpoint": "/ask",
                        "reason": stream_decision.reason,
                        "stream": True,
                        "raw_text_len": len(transcript_text),
                    },
                )
                yield _sse_event("error", {"error": "no_speech_detected"})
                return
            assert isinstance(stream_decision, Keep)
            yield _sse_event("transcript", {"text": stream_decision.text})
            llm_input = stream_decision.text

        full_answer_parts: list[str] = []
        try:
            async for delta in llm_client.ask_stream(llm_input):
                full_answer_parts.append(delta)
                yield _sse_event("token", {"text": delta})
        except LLMConfigError as e:
            yield _sse_event("error", {"error": str(e)})
            return
        except LLMUpstreamError as e:
            yield _sse_event("error", {"error": str(e)})
            return
        except Exception as e:  # defensive
            yield _sse_event("error", {"error": f"LLM stream failed: {e}"})
            return

        # Auto-log AFTER the stream completes successfully. Emit a `session`
        # event before `done` so clients can capture the id without waiting
        # on `done` parsing semantics. Failures are swallowed by the logger.
        if log:
            full_answer = "".join(full_answer_parts)
            # Audio path → final.text = transcript; JSON text path → user_text.
            final_text = llm_input  # already equals transcript or user_text
            sid = auto_session_logger.log_ask_session(
                transcript=final_text,
                answer=full_answer,
                duration_ms=(
                    int(audio_duration_s * 1000)
                    if audio_duration_s
                    else None
                ),
                audio_blob=audio_body,
                audio_mime_type=audio_mime,
            )
            if sid is not None:
                yield _sse_event("session", {"session_id": sid})
        yield _sse_event("done", {"finish_reason": "stop"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")
