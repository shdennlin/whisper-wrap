import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.transcribe import router as transcribe_router
from app.config import config
from app.services.whisper import whisper_client
from app.services.whisper_manager import whisper_manager

# Configure logging
logging.basicConfig(level=config.LOG_LEVEL)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan management."""
    # Startup
    logger.info("Starting whisper-wrap API server")
    config.ensure_temp_dir()
    logger.info(f"whisper-wrap starting with model: {config.MODEL_NAME} ({config.MODEL_PATH})")

    # Warn if model file is missing (whisper-server may host it independently)
    try:
        config.validate_model()
    except FileNotFoundError as e:
        logger.warning(str(e))

    # Log auto-restart status
    if config.WHISPER_AUTO_RESTART:
        logger.info(
            "WHISPER_AUTO_RESTART is enabled (max_retries=%d) — "
            "whisper-server will be restarted automatically on failure",
            config.WHISPER_MAX_RETRIES,
        )

        # Only start a managed whisper-server if one isn't already running
        if not await whisper_client.health_check():
            logger.info("No healthy whisper-server found — starting managed instance")
            try:
                whisper_manager.start()
                await asyncio.sleep(2)
            except FileNotFoundError as e:
                logger.error("Cannot start managed whisper-server: %s", e)
        else:
            logger.info(
                "whisper-server already running at %s — will take over on crash",
                config.whisper_server_url,
            )

    # Check whisper-server connectivity
    if not await whisper_client.health_check():
        logger.warning(
            f"Cannot connect to whisper-server at {config.whisper_server_url}"
        )
    else:
        logger.info(f"Connected to whisper-server at {config.whisper_server_url}")

    yield

    # Shutdown
    if config.WHISPER_AUTO_RESTART:
        logger.info("Stopping managed whisper-server...")
        whisper_manager.stop()
    logger.info("Shutting down whisper-wrap API server")


app = FastAPI(
    title="whisper-wrap",
    description="FastAPI wrapper for whisper.cpp with universal audio format support",
    version="1.0.0",
    lifespan=lifespan,
)

# Include API routes
app.include_router(transcribe_router)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    whisper_healthy = await whisper_client.health_check()

    return {
        "status": "healthy" if whisper_healthy else "degraded",
        "model": config.MODEL_NAME,
        "whisper_server": whisper_healthy,
        "whisper_server_url": config.whisper_server_url,
    }


@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "name": "whisper-wrap",
        "version": "1.0.0",
        "description": "FastAPI wrapper for whisper.cpp with universal audio format support",
        "endpoints": {
            "transcribe": "POST /transcribe - Upload audio file for transcription (multipart/form-data)",
            "transcribe-raw": "POST /transcribe-raw - Send raw audio data for transcription (iOS Shortcuts compatible)",
            "health": "GET /health - Service health status",
        },
    }


if __name__ == "__main__":
    import uvicorn

    # Validate port configuration on startup
    config.validate_ports()

    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT)
