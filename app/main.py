"""FastAPI entry point for the v2 in-process whisper-wrap server.

The lifespan handler eagerly loads the shared `WhisperModel` at startup so every
endpoint sees a fully-loaded model on the first request and `/status` can always
report `model.loaded=true`.
"""

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.transcribe import router as transcribe_router
from app.config import config, load_env_file, warn_obsolete_env_vars
from app.services.registry import resolve_model_dir
from app.services.whisper import WhisperClient, load_model

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Surface .env first so subsequent reads see the developer's overrides,
    # then warn on any v1 keys still hanging around in the environment.
    load_env_file()
    logging.basicConfig(level=config.LOG_LEVEL)
    logger.info("Starting whisper-wrap API server")
    config.ensure_temp_dir()
    warn_obsolete_env_vars()

    model_dir = resolve_model_dir(config.MODEL_NAME, config.MODEL_DIR)
    logger.info(
        "Loading WhisperModel from %s (compute_type=%s, device=%s)",
        model_dir,
        config.COMPUTE_TYPE,
        config.DEVICE,
    )

    load_start = time.perf_counter()
    model = load_model(
        model_dir, compute_type=config.COMPUTE_TYPE, device=config.DEVICE
    )
    load_time_ms = int((time.perf_counter() - load_start) * 1000)

    app.state.whisper_model = model
    app.state.whisper_client = WhisperClient(model=model)
    app.state.model_dir = model_dir
    app.state.load_time_ms = load_time_ms
    app.state.lifespan_completed_at = time.time()

    logger.info("WhisperModel loaded in %d ms", load_time_ms)

    yield

    logger.info("Shutting down whisper-wrap API server")


app = FastAPI(
    title="whisper-wrap",
    description="In-process FastAPI server for faster-whisper transcription, Gemini Q&A, and live PCM streaming",
    version="2.0.0",
    lifespan=lifespan,
)

app.include_router(transcribe_router)


@app.get("/")
async def root():
    return {
        "name": "whisper-wrap",
        "version": "2.0.0",
        "endpoints": {
            "transcribe": "POST /transcribe - audio transcription (multipart, raw audio/*, or application/octet-stream)",
            "status": "GET /status - service + model + LLM configuration",
        },
    }


if __name__ == "__main__":
    import uvicorn

    config.validate_port()
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT)
