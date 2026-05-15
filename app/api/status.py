"""GET /status and GET / — service introspection.

`/status` reports rich server + model + LLM configuration so operators can
distinguish multiple deployments (Mac mini vs GPU server) at a glance. Because
the lifespan blocks app startup until the model is loaded, `/status` always
returns `status="ok"` with `model.loaded=true`.

`/` returns a tiny endpoint catalogue for API discovery.
"""

import time
from typing import Any

from fastapi import APIRouter, Request

from app import __version__
from app.config import config

router = APIRouter()


def _resolve_model_name(model_dir: str) -> str:
    """Display name shown on /status.

    For MODEL_DIR overrides we surface the full path so operators can see exactly
    what was loaded; for MODEL_NAME registry entries we surface the registry key.
    """
    if config.MODEL_DIR:
        return model_dir
    return config.MODEL_NAME


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    state = request.app.state
    model_dir = getattr(state, "model_dir", None) or ""
    metadata = getattr(state, "backend_metadata", {}) or {}

    backend_block: dict[str, Any] = {
        "backend": metadata.get("backend", "ctranslate2"),
        "format": metadata.get("format", "ct2"),
    }
    if metadata.get("format") == "ct2":
        backend_block["compute_type"] = metadata.get(
            "compute_type", config.COMPUTE_TYPE
        )
    if metadata.get("format") == "ggml":
        if "quant" in metadata:
            backend_block["quant"] = metadata["quant"]
        backend_block["coreml_encoder_compiled"] = metadata.get(
            "coreml_encoder_compiled", False
        )

    return {
        "status": "ok",
        "version": __version__,
        "uptime_seconds": int(time.time() - state.lifespan_completed_at),
        "model": {
            "name": _resolve_model_name(model_dir),
            "path": model_dir,
            "compute_type": config.COMPUTE_TYPE,
            "device": config.DEVICE,
            "loaded": True,
            "load_time_ms": getattr(state, "load_time_ms", 0),
        },
        "backend": backend_block,
        "vad": {"backend": getattr(state, "vad_backend_name", "rms")},
        "gemini": {
            "configured": state.llm_client.configured,
            "model": state.llm_client.model,
        },
    }


@router.get("/")
async def root() -> dict[str, Any]:
    return {
        "endpoints": [
            {
                "method": "POST",
                "path": "/transcribe",
                "description": "Transcribe audio (multipart form, audio/*, or application/octet-stream)",
            },
            {
                "method": "WS",
                "path": "/listen",
                "description": "Live captioning over WebSocket — 16 kHz mono pcm_s16le frames",
            },
            {
                "method": "POST",
                "path": "/ask",
                "description": "Audio or text question, Gemini answer (optional ?stream=true for SSE)",
            },
            {
                "method": "GET",
                "path": "/status",
                "description": "Service health, loaded model details, and LLM configuration",
            },
            {
                "method": "GET",
                "path": "/",
                "description": "This endpoint catalogue",
            },
            {
                "method": "POST",
                "path": "/v1/audio/transcriptions",
                "description": "OpenAI-compatible audio transcription endpoint",
            },
            {
                "method": "POST",
                "path": "/v1/audio/translations",
                "description": "OpenAI-compatible audio translation endpoint (output: English)",
            },
            {
                "method": "GET",
                "path": "/v1/models",
                "description": "OpenAI-compatible model catalogue (lists the active whisper-wrap model)",
            },
        ]
    }
