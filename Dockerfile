FROM python:3.12-slim

# Install system dependencies including build tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libmagic1 \
    git \
    cmake \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# Set working directory
WORKDIR /app

# Copy dependency files
COPY pyproject.toml .
COPY uv.lock .

# Install Python dependencies
RUN uv sync --frozen --no-dev

# Clone and build whisper.cpp
RUN git clone https://github.com/ggml-org/whisper.cpp.git /whisper.cpp && \
    cd /whisper.cpp && \
    cmake -B build && \
    cmake --build build -j --config Release

# Download whisper model
RUN cd /whisper.cpp && \
    bash ./models/download-ggml-model.sh large-v3-turbo-q8_0

# Copy application code
COPY app/ app/

# Create temp directory
RUN mkdir -p /tmp/whisper-wrap

# Create startup script
RUN echo '#!/bin/bash\n\
# Start whisper-server in background\n\
cd /whisper.cpp && ./build/bin/whisper-server --host 0.0.0.0 --port 9000 -m ./models/ggml-large-v3-turbo-q8_0.bin -l auto -tdrz &\n\
\n\
# Wait for whisper-server to start\n\
sleep 5\n\
\n\
# Start FastAPI application\n\
cd /app && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000\n\
' > /start.sh && chmod +x /start.sh

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the startup script
CMD ["/start.sh"]