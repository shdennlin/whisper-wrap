FROM python:3.12-slim

ARG MODEL_NAME=large-v3-turbo-q8

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

# Copy dependency files and README (required by hatchling)
COPY pyproject.toml .
COPY uv.lock .
COPY README.md .

# Install Python dependencies
RUN uv sync --frozen --no-dev

# Copy whisper.cpp submodule
COPY whisper.cpp/ /app/whisper.cpp/

# Build whisper.cpp with multi-architecture support
RUN cd /app/whisper.cpp && \
    ARCH=$(uname -m) && \
    echo "Building for architecture: $ARCH" && \
    if [ "$ARCH" = "aarch64" ]; then \
        echo "Configuring for ARM64/Apple Silicon" && \
        cmake -B build \
            -DGGML_NATIVE=OFF \
            -DGGML_CPU_HBM=OFF \
            -DGGML_AVX=OFF \
            -DGGML_AVX2=OFF \
            -DGGML_F16C=OFF \
            -DGGML_FMA=OFF \
            -DCMAKE_C_FLAGS="-march=armv8-a -mtune=generic" \
            -DCMAKE_CXX_FLAGS="-march=armv8-a -mtune=generic"; \
    elif [ "$ARCH" = "x86_64" ]; then \
        echo "Configuring for x86_64 (Intel/AMD)" && \
        cmake -B build \
            -DGGML_NATIVE=OFF \
            -DGGML_CPU_HBM=OFF \
            -DGGML_AVX=ON \
            -DGGML_AVX2=ON \
            -DGGML_F16C=ON \
            -DGGML_FMA=ON \
            -DCMAKE_C_FLAGS="-march=x86-64 -mtune=generic" \
            -DCMAKE_CXX_FLAGS="-march=x86-64 -mtune=generic"; \
    else \
        echo "Configuring for generic architecture: $ARCH" && \
        cmake -B build \
            -DGGML_NATIVE=OFF \
            -DGGML_CPU_HBM=OFF; \
    fi && \
    cmake --build build -j --config Release

# Copy registry and scripts directories
COPY registry/ /app/registry/
COPY scripts/ /app/scripts/

# Create models directory and download model specified by build arg
RUN mkdir -p /app/models && \
    bash /app/scripts/model-manager.sh download "$MODEL_NAME"

# Resolve the downloaded model's filename and save for startup
RUN FILENAME=$(grep -A10 "^  ${MODEL_NAME}:" /app/registry/models.yaml \
      | grep 'filename:' | head -1 | sed 's/.*filename: *"//' | sed 's/"$//') && \
    echo "export MODEL_PATH=/app/models/${FILENAME}" > /etc/model_path.sh && \
    echo "export MODEL_NAME=${MODEL_NAME}" >> /etc/model_path.sh

# Copy application code
COPY app/ app/

# Create temp directory
RUN mkdir -p /tmp/whisper-wrap

# Create startup script — sources model path resolved at build time
RUN echo '#!/bin/bash\n\
# Load model path resolved during docker build\n\
source /etc/model_path.sh\n\
\n\
# Allow runtime override via environment variables\n\
MODEL_PATH="${MODEL_PATH}"\n\
\n\
# Start whisper-server in background\n\
cd /app/whisper.cpp && ./build/bin/whisper-server --host 0.0.0.0 --port 9000 -m ${MODEL_PATH} -l auto -tdrz &\n\
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
