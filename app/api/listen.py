"""WS /listen — live captioning over WebSocket.

Accepts 16 kHz mono `pcm_s16le` binary frames; emits JSON text frames:

    {"type": "partial", "text": "...", "start_ms": <int>, "end_ms": <int>}
    {"type": "final",   "text": "...", "start_ms": <int>, "end_ms": <int>}
    {"type": "warning", "message": "buffer overflow, oldest audio dropped"}
    {"type": "error",   "message": "<reason>"}    (followed by close 1003)
"""

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.stream import StreamSession

logger = logging.getLogger(__name__)

router = APIRouter()


# Frame size guards (inclusive on both ends).
MIN_FRAME_BYTES = 200
MAX_FRAME_BYTES = 65_536  # 64 KiB

# WebSocket close code for protocol/data violations.
CLOSE_UNSUPPORTED_DATA = 1003


async def _send_error_and_close(ws: WebSocket, message: str) -> None:
    payload = json.dumps({"type": "error", "message": message}, ensure_ascii=False)
    try:
        await ws.send_text(payload)
    except Exception:
        logger.debug("Failed to send error frame before close (already closed?)")
    await ws.close(code=CLOSE_UNSUPPORTED_DATA)


@router.websocket("/listen")
async def listen(ws: WebSocket) -> None:
    await ws.accept()

    whisper = ws.app.state.whisper

    async def transcribe_fn(samples, *, beam_size: int | None = None) -> str:
        result = await whisper.transcribe_pcm(samples, beam_size=beam_size)
        return result.text

    async def send_event(event: dict[str, Any]) -> None:
        await ws.send_text(json.dumps(event, ensure_ascii=False))

    session = StreamSession(
        transcribe_fn=transcribe_fn,
        send_event=send_event,
        vad_backend=ws.app.state.vad_factory(),
    )

    try:
        while True:
            msg = await ws.receive()
            msg_type = msg.get("type")

            if msg_type == "websocket.disconnect":
                # Client disconnect — discard in-flight buffer silently.
                logger.info("WS /listen disconnected (in-flight buffer discarded)")
                return

            if msg_type != "websocket.receive":
                # Should not happen for an open connection, but be defensive.
                continue

            pcm = msg.get("bytes")
            if pcm is None:
                # Text frame on a binary channel — protocol violation.
                await _send_error_and_close(ws, "binary PCM expected")
                return

            if len(pcm) < MIN_FRAME_BYTES or len(pcm) > MAX_FRAME_BYTES:
                await _send_error_and_close(ws, "frame size out of range")
                return

            await session.feed_frame(pcm)

    except WebSocketDisconnect:
        logger.info("WS /listen client closed connection (in-flight buffer discarded)")
    except Exception as e:  # defensive — never let a session bug crash the server
        logger.exception("WS /listen error: %s", e)
        try:
            await ws.close(code=1011)
        except Exception:
            pass
