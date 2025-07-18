import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.transcribe import router as transcribe_router
from app.config import config
from app.services.whisper import whisper_client

# Configure logging
logging.basicConfig(level=config.LOG_LEVEL)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan management."""
    # Startup
    logger.info("Starting whisper-wrap API server")
    config.ensure_temp_dir()

    # Check whisper-server connectivity
    if not await whisper_client.health_check():
        logger.warning(
            f"Cannot connect to whisper-server at {config.WHISPER_SERVER_URL}"
        )
    else:
        logger.info(f"Connected to whisper-server at {config.WHISPER_SERVER_URL}")

    yield

    # Shutdown
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
        "whisper_server": whisper_healthy,
        "whisper_server_url": config.WHISPER_SERVER_URL,
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

    uvicorn.run(app, host="0.0.0.0", port=8000)
