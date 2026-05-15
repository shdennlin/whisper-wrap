# whisper-wrap Makefile (v2 — in-process faster-whisper)

# Load environment variables from .env file if it exists
ifneq (,$(wildcard .env))
    include .env
    export
endif

# Configuration (overridable via env)
API_PORT ?= 8000
API_HOST ?= 0.0.0.0
MODELS_DIR := ./models
SCRIPT := ./scripts/model-manager.sh

.PHONY: help setup check-system-deps install-system-deps install \
        download-default-model models download-model set-model delete-model \
        test lint format clean run dev docker deps samples transcribe-sample

help:
	@echo "whisper-wrap (v2)"
	@echo ""
	@echo "Setup:"
	@echo "  check-system-deps  - Verify required system dependencies"
	@echo "  install-system-deps - Auto-install ffmpeg/libmagic"
	@echo "  install            - Install Python dependencies (uv sync)"
	@echo "  setup              - Full first-time setup: install + download default model"
	@echo ""
	@echo "Models:"
	@echo "  models             - List registry entries with install status"
	@echo "  download-model     - Download a model: make download-model MODEL=breeze-asr-25"
	@echo "  set-model          - Set active model: make set-model MODEL=breeze-asr-25"
	@echo "  delete-model       - Delete a model: make delete-model MODEL=large-v3-turbo"
	@echo "  download-default-model - Download the registry entry marked default: true"
	@echo ""
	@echo "Development:"
	@echo "  run                - Start FastAPI server"
	@echo "  dev                - Start FastAPI server with --reload"
	@echo "  test               - Run pytest suite"
	@echo "  lint               - Run ruff check"
	@echo "  format             - Run ruff format"
	@echo "  clean              - Remove caches and build artefacts"
	@echo ""
	@echo "Docker:"
	@echo "  docker             - Build and start via docker-compose"

# ── Setup ────────────────────────────────────────────────────────────────────

setup: install download-default-model build-frontend
	@echo ""
	@echo "Setup complete. Start with: make dev"

build-frontend:
	@echo "Building PWA bundle into app/static/app/..."
	@which node >/dev/null || (echo "  node: missing — install Node 20+ from https://nodejs.org" && exit 1)
	@cd frontend && npm install --silent && npm run build
	@echo "PWA bundle ready at app/static/app/. Visit http://localhost:8000/app/ after 'make dev'."

dev-https:
	@test -n "$$WHISPER_CERT" || (echo "ERROR: WHISPER_CERT env var is unset; run 'tailscale cert <host>.<tailnet>.ts.net' first" && exit 1)
	@test -n "$$WHISPER_KEY" || (echo "ERROR: WHISPER_KEY env var is unset" && exit 1)
	@test -f "$$WHISPER_CERT" || (echo "ERROR: WHISPER_CERT path does not exist: $$WHISPER_CERT" && exit 1)
	@test -f "$$WHISPER_KEY" || (echo "ERROR: WHISPER_KEY path does not exist: $$WHISPER_KEY" && exit 1)
	uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 \
		--ssl-certfile $$WHISPER_CERT --ssl-keyfile $$WHISPER_KEY

check-system-deps:
	@echo "Checking required system dependencies..."
	@which uv >/dev/null && echo "  uv: found" || (echo "  uv: missing — install from https://github.com/astral-sh/uv" && exit 1)
	@which ffmpeg >/dev/null && echo "  ffmpeg: found" || (echo "  ffmpeg: missing — run 'make install-system-deps' or 'brew install ffmpeg'" && exit 1)
	@which hf >/dev/null || which huggingface-cli >/dev/null && echo "  hf/huggingface-cli: found" || (echo "  hf/huggingface-cli: missing — install via pip install huggingface_hub" && exit 1)
	@python3 -c "import magic" 2>/dev/null && echo "  libmagic: importable" || (echo "  libmagic: missing — run 'make install-system-deps' or 'brew install libmagic'" && exit 1)
	@echo "OK: all system dependencies present"

install-system-deps:
	@OS=$$(uname -s); \
	if [ "$$OS" = "Darwin" ]; then \
		which brew >/dev/null || { echo "Homebrew required: https://brew.sh"; exit 1; }; \
		brew install ffmpeg libmagic; \
	elif [ "$$OS" = "Linux" ]; then \
		if which apt-get >/dev/null; then \
			sudo apt-get update && sudo apt-get install -y ffmpeg libmagic1 libmagic-dev; \
		elif which yum >/dev/null; then \
			sudo yum install -y ffmpeg file-devel; \
		elif which pacman >/dev/null; then \
			sudo pacman -S --noconfirm ffmpeg file; \
		else \
			echo "Unsupported Linux distro — install ffmpeg + libmagic manually."; exit 1; \
		fi; \
	else \
		echo "Unsupported OS: $$OS — install ffmpeg + libmagic manually."; exit 1; \
	fi
	@echo "OK: system dependencies installed"

install:
	@echo "Installing Python dependencies..."
	uv sync

# ── Models ───────────────────────────────────────────────────────────────────

download-default-model:
	@DEFAULT_NAME=$$(bash $(SCRIPT) default); \
	echo "Downloading default model: $$DEFAULT_NAME"; \
	bash $(SCRIPT) download "$$DEFAULT_NAME"

models:
	@bash $(SCRIPT) list

download-model:
	@bash $(SCRIPT) download $(MODEL)

set-model:
	@bash $(SCRIPT) set $(MODEL)

delete-model:
	@bash $(SCRIPT) delete $(MODEL)

# ── Local samples for testing ────────────────────────────────────────────────

samples:
	@bash scripts/fetch-samples.sh

transcribe-sample:
	@if [ -z "$(SAMPLE)" ]; then echo "usage: make transcribe-sample SAMPLE=<filename>"; exit 1; fi
	@curl -s -X POST -H 'Content-Type: audio/wav' \
		--data-binary @samples/$(SAMPLE) \
		"http://$(API_HOST):$(API_PORT)/transcribe?language=zh" | jq

# ── Development ──────────────────────────────────────────────────────────────

run:
	@echo "Starting whisper-wrap on http://$(API_HOST):$(API_PORT)"
	uv run uvicorn app.main:app --host $(API_HOST) --port $(API_PORT)

dev:
	@echo "Starting whisper-wrap (reload mode) on http://$(API_HOST):$(API_PORT)"
	uv run uvicorn app.main:app --reload --host $(API_HOST) --port $(API_PORT)

test:
	uv run pytest -v

lint:
	uv run ruff check app/ tests/

format:
	uv run ruff format app/ tests/

clean:
	rm -rf .pytest_cache
	find . -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

# ── Docker ───────────────────────────────────────────────────────────────────

docker:
	docker-compose up --build

deps:
	@which uv >/dev/null || { echo "uv missing"; exit 1; }
	@which ffmpeg >/dev/null || { echo "ffmpeg missing"; exit 1; }
	@echo "OK"
