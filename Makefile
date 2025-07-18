# whisper-wrap Makefile
# Builds and manages the whisper-wrap FastAPI service and whisper.cpp dependencies

# Configuration variables
WHISPER_DIR := ../whisper.cpp
WHISPER_BINARY := $(WHISPER_DIR)/build/bin/whisper-server
WHISPER_MODEL := $(WHISPER_DIR)/models/ggml-large-v3-turbo-q8_0.bin
WHISPER_CMD := ./build/bin/whisper-server --host 0.0.0.0 --port 9000 -m ./models/ggml-large-v3-turbo-q8_0.bin -l 'auto' -tdrz

.PHONY: help setup clone-whisper build-whisper download-model install test lint format clean run dev docker deps

# Default target
help:
	@echo "whisper-wrap - FastAPI wrapper for whisper.cpp"
	@echo ""
	@echo "Available targets:"
	@echo "  setup          - Complete setup (clone + install deps + build whisper + download model)"
	@echo "  install        - Install Python dependencies with uv"
	@echo "  clone-whisper  - Clone whisper.cpp repository to parent directory"
	@echo "  build-whisper  - Build whisper.cpp using cmake"
	@echo "  download-model - Download whisper model"
	@echo "  test           - Run test suite"
	@echo "  lint           - Run code linting"
	@echo "  format         - Format code"
	@echo "  run            - Start the FastAPI server"
	@echo "  run-whisper    - Start whisper-server"
	@echo "  dev            - Start both whisper-server and FastAPI (development)"
	@echo "  clean          - Clean build artifacts"
	@echo "  docker         - Build and run with Docker Compose"
	@echo ""

# Complete setup
setup: install clone-whisper build-whisper download-model
	@echo "Setup complete! You can now run 'make dev' to start both services."

# Install Python dependencies
install:
	@echo "Installing Python dependencies..."
	uv sync

# Clone whisper.cpp repository
clone-whisper:
	@echo "Cloning whisper.cpp repository..."
	@if [ ! -d "$(WHISPER_DIR)" ]; then \
		echo "Cloning whisper.cpp to $(WHISPER_DIR)..."; \
		git clone https://github.com/ggml-org/whisper.cpp.git $(WHISPER_DIR); \
	else \
		echo "whisper.cpp already exists at $(WHISPER_DIR)"; \
	fi

# Build whisper.cpp
build-whisper:
	@echo "Building whisper.cpp..."
	@if [ ! -d "$(WHISPER_DIR)" ]; then \
		echo "Error: whisper.cpp not found. Run 'make clone-whisper' first."; \
		exit 1; \
	fi
	cd $(WHISPER_DIR) && cmake -B build
	cd $(WHISPER_DIR) && cmake --build build -j --config Release

# Download whisper model
download-model:
	@echo "Downloading whisper model..."
	@if [ ! -d "$(WHISPER_DIR)" ]; then \
		echo "Error: whisper.cpp not found. Run 'make clone-whisper' first."; \
		exit 1; \
	fi
	@if [ ! -f "$(WHISPER_MODEL)" ]; then \
		cd $(WHISPER_DIR) && bash ./models/download-ggml-model.sh large-v3-turbo-q8_0; \
	else \
		echo "Model already exists: $(WHISPER_MODEL)"; \
	fi

# Run tests
test:
	@echo "Running test suite..."
	uv run pytest -v

# Run linting
lint:
	@echo "Running code linting..."
	uv run ruff check app/ tests/

# Format code
format:
	@echo "Formatting code..."
	uv run ruff format app/ tests/

# Start FastAPI server
run:
	@echo "Starting whisper-wrap API server..."
	@echo "Server will be available at http://localhost:8000"
	uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

# Start whisper-server
run-whisper:
	@echo "Starting whisper-server..."
	@if [ ! -f "$(WHISPER_BINARY)" ]; then \
		echo "Error: whisper-server not built. Run 'make build-whisper' first."; \
		exit 1; \
	fi
	@if [ ! -f "$(WHISPER_MODEL)" ]; then \
		echo "Error: Model not found. Run 'make download-model' first."; \
		exit 1; \
	fi
	@echo "Server will be available at http://localhost:9000"
	@echo "Press Ctrl+C to stop the server"
	cd $(WHISPER_DIR) && $(WHISPER_CMD)

# Development mode - start both services
dev:
	@echo "Starting development environment..."
	@echo "This will start both whisper-server and the FastAPI server"
	@echo "Press Ctrl+C to stop both services"
	@if [ ! -f "$(WHISPER_BINARY)" ]; then \
		echo "Error: whisper-server not built. Run 'make setup' first."; \
		exit 1; \
	fi
	@if [ ! -f "$(WHISPER_MODEL)" ]; then \
		echo "Error: Model not found. Run 'make setup' first."; \
		exit 1; \
	fi
	@# Start whisper-server in background
	cd $(WHISPER_DIR) && $(WHISPER_CMD) & \
	WHISPER_PID=$$!; \
	echo "Whisper-server started with PID $$WHISPER_PID"; \
	sleep 2; \
	echo "Starting FastAPI server..."; \
	trap "echo 'Stopping services...'; kill $$WHISPER_PID 2>/dev/null || true; exit" INT TERM; \
	uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(WHISPER_DIR)/build
	rm -rf .pytest_cache
	rm -rf __pycache__
	find . -name "*.pyc" -delete
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Docker setup
docker:
	@echo "Building and starting with Docker Compose..."
	docker-compose up --build

# Check dependencies
deps:
	@echo "Checking dependencies..."
	@which uv >/dev/null || (echo "Error: uv not found. Install from https://github.com/astral-sh/uv" && exit 1)
	@which cmake >/dev/null || (echo "Error: cmake not found. Install cmake." && exit 1)
	@which make >/dev/null || (echo "Error: make not found. Install build tools." && exit 1)
	@which ffmpeg >/dev/null || (echo "Warning: ffmpeg not found. Install with 'brew install ffmpeg' on macOS")
	@echo "Dependencies check complete."