FROM python:3.12-slim

ARG MODEL_NAME=breeze-asr-25

# Runtime-only dependencies. v2 drops cmake/g++/make/pkg-config/git because we no
# longer build whisper.cpp from source — the CT2 model is downloaded via `hf`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libmagic1 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./

# Install Python deps (faster-whisper, google-genai, etc.). --no-dev keeps the
# image small; tests are not shipped.
RUN uv sync --frozen --no-dev

# Registry + model manager — needed to download the model at build time.
COPY registry/ /app/registry/
COPY scripts/ /app/scripts/
COPY app/ /app/app/

# Pre-download the configured model variant via the v2 manager (uses `hf download`
# under the hood, honouring the registry's `subfolder` and `revision` fields).
RUN mkdir -p /app/models && \
    WHISPER_WRAP_PYTHONPATH=/app PYTHON_BIN=/app/.venv/bin/python \
    bash /app/scripts/model-manager.sh download "$MODEL_NAME"

# Persist the chosen model name into the runtime env file consulted by Config.
RUN printf "MODEL_NAME=%s\n" "$MODEL_NAME" > /app/.env

RUN mkdir -p /tmp/whisper-wrap

EXPOSE 8000

# Single in-process FastAPI server — lifespan eagerly loads the WhisperModel.
# No whisper-server subprocess, no startup sleep.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8000/status || exit 1

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
