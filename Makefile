# whisper-wrap Makefile
# Builds and manages the whisper-wrap FastAPI service and whisper.cpp dependencies

# Load environment variables from .env file if it exists
ifneq (,$(wildcard .env))
    include .env
    export
endif

# Configuration variables
WHISPER_DIR := ./whisper.cpp
WHISPER_BINARY := $(WHISPER_DIR)/build/bin/whisper-server
MODELS_DIR := ./models

# Model configuration (can be overridden by .env or environment variables)
MODEL_NAME ?= large-v3-turbo-q8
MODEL_PATH ?= $(MODELS_DIR)/ggml-large-v3-turbo-q8_0.bin

# Port configuration (can be overridden by environment variables)
API_PORT ?= 8000
API_HOST ?= 0.0.0.0
WHISPER_SERVER_PORT ?= 9000
WHISPER_SERVER_HOST ?= 0.0.0.0

WHISPER_CMD := $(WHISPER_BINARY) --host $(WHISPER_SERVER_HOST) --port $(WHISPER_SERVER_PORT) -m $(MODEL_PATH) -l 'auto' -tdrz

.PHONY: help setup check-system-deps install-system-deps init-submodule build-whisper download-model download-default-model install test lint format clean run dev docker deps models set-model delete-model

# Default target
help:
	@echo "whisper-wrap - FastAPI wrapper for whisper.cpp"
	@echo ""
	@echo "Available targets:"
	@echo "  setup              - Complete setup (deps + install + build + download default model)"
	@echo "  check-system-deps  - Check required system dependencies"
	@echo "  install-system-deps- Install system dependencies (macOS/Linux)"
	@echo "  install            - Install Python dependencies with uv"
	@echo "  init-submodule     - Initialize whisper.cpp git submodule"
	@echo "  build-whisper      - Build whisper.cpp using cmake"
	@echo "  test               - Run test suite"
	@echo "  lint               - Run code linting"
	@echo "  format             - Format code"
	@echo "  run                - Start the FastAPI server"
	@echo "  run-whisper        - Start whisper-server"
	@echo "  dev                - Start both whisper-server and FastAPI (development)"
	@echo "  clean              - Clean build artifacts"
	@echo "  docker             - Build and run with Docker Compose"
	@echo ""
	@echo "Model management:"
	@echo "  models             - List all models (registry + installed + active)"
	@echo "  download-model     - Download a model: make download-model MODEL=breeze-asr-25"
	@echo "  set-model          - Set active model: make set-model MODEL=breeze-asr-25"
	@echo "  delete-model       - Delete a model: make delete-model MODEL=breeze-asr-25"
	@echo ""

# Complete setup
setup: check-system-deps install init-submodule build-whisper download-default-model
	@echo ""
	@echo "Setup complete! Run 'make models' to see available models."
	@echo "Start with: make dev"

# Check system dependencies
check-system-deps:
	@echo "Checking required system dependencies..."
	@echo "======================================"
	@# Check operating system
	@OS=$$(uname -s); \
	echo "Operating System: $$OS"; \
	echo ""
	@# Check essential tools
	@echo "Essential tools:"
	@which uv >/dev/null && echo "✅ uv found" || (echo "❌ uv not found. Install from https://github.com/astral-sh/uv" && exit 1)
	@which cmake >/dev/null && echo "✅ cmake found" || (echo "❌ cmake not found. Install cmake." && exit 1)
	@which make >/dev/null && echo "✅ make found" || (echo "❌ make not found. Install build tools." && exit 1)
	@which git >/dev/null && echo "✅ git found" || (echo "❌ git not found. Install git." && exit 1)
	@echo ""
	@# Check audio processing dependencies
	@echo "Audio processing dependencies:"
	@if which ffmpeg >/dev/null; then \
		echo "✅ ffmpeg found"; \
		ffmpeg -version | head -1; \
	else \
		echo "❌ ffmpeg not found"; \
		echo "   Install with: make install-system-deps"; \
		echo "   Or manually: brew install ffmpeg (macOS) / apt install ffmpeg (Ubuntu)"; \
		exit 1; \
	fi
	@# Check libmagic (try different ways to detect it)
	@if python3 -c "import magic; print('✅ python-magic can import libmagic')" 2>/dev/null; then \
		echo "✅ libmagic accessible via Python"; \
	elif [ -f /usr/lib/libmagic.so ] || [ -f /usr/local/lib/libmagic.dylib ] || [ -f /opt/homebrew/lib/libmagic.dylib ]; then \
		echo "✅ libmagic library found on system"; \
	else \
		echo "❌ libmagic not found or not accessible"; \
		echo "   Install with: make install-system-deps"; \
		echo "   Or manually: brew install libmagic (macOS) / apt install libmagic1 (Ubuntu)"; \
		exit 1; \
	fi
	@echo ""
	@echo "✅ All system dependencies are available!"
	@echo "   You can proceed with: make install"

# Install system dependencies automatically
install-system-deps:
	@echo "Installing system dependencies..."
	@OS=$$(uname -s); \
	if [ "$$OS" = "Darwin" ]; then \
		echo "Detected macOS - using Homebrew"; \
		if ! which brew >/dev/null; then \
			echo "❌ Homebrew not found. Please install Homebrew first:"; \
			echo "   /bin/bash -c \"\$$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""; \
			exit 1; \
		fi; \
		echo "Installing ffmpeg and libmagic..."; \
		brew install ffmpeg libmagic; \
	elif [ "$$OS" = "Linux" ]; then \
		echo "Detected Linux"; \
		if which apt-get >/dev/null; then \
			echo "Using apt (Ubuntu/Debian)"; \
			echo "Installing ffmpeg and libmagic..."; \
			sudo apt-get update && sudo apt-get install -y ffmpeg libmagic1 libmagic-dev; \
		elif which yum >/dev/null; then \
			echo "Using yum (RHEL/CentOS)"; \
			echo "Installing ffmpeg and libmagic..."; \
			sudo yum install -y ffmpeg file-devel; \
		elif which pacman >/dev/null; then \
			echo "Using pacman (Arch Linux)"; \
			echo "Installing ffmpeg and libmagic..."; \
			sudo pacman -S --noconfirm ffmpeg file; \
		else \
			echo "❌ Unsupported Linux distribution. Please install manually:"; \
			echo "   - ffmpeg"; \
			echo "   - libmagic (libmagic1/file-devel/file)"; \
			exit 1; \
		fi; \
	else \
		echo "❌ Unsupported operating system: $$OS"; \
		echo "Please install manually:"; \
		echo "   - ffmpeg"; \
		echo "   - libmagic"; \
		exit 1; \
	fi
	@echo "✅ System dependencies installed successfully!"
	@echo "   Run 'make check-system-deps' to verify installation"

# Install Python dependencies
install:
	@echo "Installing Python dependencies..."
	uv sync

# Initialize whisper.cpp submodule
init-submodule:
	@echo "Initializing whisper.cpp submodule..."
	@if [ ! -d "$(WHISPER_DIR)/.git" ] && [ ! -f "$(WHISPER_DIR)/.git" ]; then \
		git submodule update --init --recursive; \
	else \
		echo "whisper.cpp submodule already initialized."; \
	fi

# Build whisper.cpp
build-whisper:
	@echo "Building whisper.cpp..."
	@if [ ! -d "$(WHISPER_DIR)" ] || { [ ! -d "$(WHISPER_DIR)/.git" ] && [ ! -f "$(WHISPER_DIR)/.git" ]; }; then \
		echo "Error: whisper.cpp not found. Run 'make init-submodule' first."; \
		exit 1; \
	fi
	cd $(WHISPER_DIR) && cmake -B build
	cd $(WHISPER_DIR) && cmake --build build -j --config Release

# Download default model from registry
download-default-model:
	@bash scripts/model-manager.sh download-default

# ── Model management ─────────────────────────────────────────────────────────

# List all models (registry + installed + active)
models:
	@bash scripts/model-manager.sh list

# Download a model: make download-model MODEL=breeze-asr-25
download-model:
	@bash scripts/model-manager.sh download $(MODEL)

# Set active model: make set-model MODEL=breeze-asr-25
set-model:
	@bash scripts/model-manager.sh set $(MODEL)

# Delete a model: make delete-model MODEL=breeze-asr-25
delete-model:
	@bash scripts/model-manager.sh delete $(MODEL)

# ── Development ───────────────────────────────────────────────────────────────

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
	@echo "Server will be available at http://$(API_HOST):$(API_PORT)"
	uv run uvicorn app.main:app --host $(API_HOST) --port $(API_PORT)

# Start whisper-server
run-whisper:
	@echo "Starting whisper-server..."
	@if [ ! -f "$(WHISPER_BINARY)" ]; then \
		echo "Error: whisper-server not built. Run 'make build-whisper' first."; \
		exit 1; \
	fi
	@if [ ! -f "$(MODEL_PATH)" ]; then \
		echo "Error: Model not found at $(MODEL_PATH)."; \
		echo "Run 'make download-model MODEL=$(MODEL_NAME)' first."; \
		exit 1; \
	fi
	@echo "Model: $(MODEL_NAME) ($(MODEL_PATH))"
	@echo "Server will be available at http://$(WHISPER_SERVER_HOST):$(WHISPER_SERVER_PORT)"
	@echo "Press Ctrl+C to stop the server"
	$(WHISPER_CMD)

# Development mode - start both services
dev:
	@echo "Starting development environment..."
	@echo "This will start both whisper-server and the FastAPI server"
	@echo "Press Ctrl+C to stop both services"
	@if [ ! -f "$(WHISPER_BINARY)" ]; then \
		echo "Error: whisper-server not built. Run 'make setup' first."; \
		exit 1; \
	fi
	@if [ ! -f "$(MODEL_PATH)" ]; then \
		echo "Error: Model not found at $(MODEL_PATH)."; \
		echo "Run 'make download-model MODEL=$(MODEL_NAME)' or 'make setup' first."; \
		exit 1; \
	fi
	@echo "Model: $(MODEL_NAME) ($(MODEL_PATH))"
	@# Start whisper-server in background
	$(WHISPER_CMD) & \
	WHISPER_PID=$$!; \
	echo "Whisper-server started with PID $$WHISPER_PID"; \
	sleep 2; \
	echo "Starting FastAPI server..."; \
	trap "echo 'Stopping services...'; kill $$WHISPER_PID 2>/dev/null || true; exit" INT TERM; \
	uv run uvicorn app.main:app --reload --host $(API_HOST) --port $(API_PORT)

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
