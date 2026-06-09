# whisper-wrap Makefile (v2 — in-process faster-whisper)

# Load environment variables from .env file if it exists
ifneq (,$(wildcard .env))
    include .env
    export
endif

# Strip surrounding double quotes from values picked up by `include .env`.
# Make's include parses .env as Makefile syntax, so shell-style `VAR="value"`
# leaves the quotes embedded in the value. We trim them so `test -f` works.
WHISPER_CERT := $(patsubst "%",%,$(WHISPER_CERT))
WHISPER_KEY := $(patsubst "%",%,$(WHISPER_KEY))

# Configuration (overridable via env)
API_PORT ?= 8000
API_HOST ?= 0.0.0.0
MODELS_DIR := ./models
SCRIPT := ./scripts/model-manager.sh

.PHONY: help setup check-system-deps install-system-deps install \
        download-default-model models download-model set-model delete-model \
        test lint format clean run dev dev-https run-https docker deps \
        samples transcribe-sample \
        install-launchd uninstall-launchd launchd-status launchd-logs

help:
	@echo "whisper-wrap (v2)"
	@echo ""
	@echo "Setup:"
	@echo "  check-system-deps  - Verify required system dependencies"
	@echo "  install-system-deps - Auto-install ffmpeg/libmagic"
	@echo "  install            - Install Python dependencies (uv sync)"
	@echo "  build-frontend     - Build the PWA bundle into app/static/app/ (requires Bun 1.1+)"
	@echo "  setup              - Full first-time setup: install + download default model + build-frontend"
	@echo ""
	@echo "Models:"
	@echo "  models             - List registry entries with install status"
	@echo "  download-model     - Download active variant: make download-model MODEL=breeze-asr-25"
	@echo "                       (add ALL=1 to fetch every variant of the model)"
	@echo "  set-model          - Set active model: make set-model MODEL=breeze-asr-25"
	@echo "  delete-model       - Delete a model: make delete-model MODEL=large-v3-turbo"
	@echo "  download-default-model - Download the registry entry marked default: true"
	@echo ""
	@echo "Development:"
	@echo "  run                - Start FastAPI server (HTTP, production)"
	@echo "  run-https          - Start FastAPI server (HTTPS, production; requires WHISPER_CERT + WHISPER_KEY)"
	@echo "  dev                - Start FastAPI server (HTTP, --reload for code changes)"
	@echo "  dev-https          - Start FastAPI server (HTTPS, --reload; requires WHISPER_CERT + WHISPER_KEY)"
	@echo "  test               - Run pytest suite"
	@echo "  lint               - Run ruff check"
	@echo "  format             - Run ruff format"
	@echo "  clean              - Remove caches and build artefacts"
	@echo ""
	@echo "Docker:"
	@echo "  docker             - Build and start via docker-compose"
	@echo ""
	@echo "Autostart (macOS launchd):"
	@echo "  install-launchd    - Install ~/Library/LaunchAgents/com.whisper-wrap.plist + load"
	@echo "  uninstall-launchd  - Unload and remove the launchd agent"
	@echo "  launchd-status     - Print the agent's launchctl status"
	@echo "  launchd-logs       - Tail stdout + stderr from ~/Library/Logs/whisper-wrap/"

# ── Setup ────────────────────────────────────────────────────────────────────

setup: install download-default-model build-frontend
	@echo ""
	@echo "Setup complete. Start with: make dev"

build-frontend:
	@echo "Building PWA bundle into app/static/app/..."
	@which bun >/dev/null || (echo "  bun: missing — install Bun 1.1+ from https://bun.sh (curl -fsSL https://bun.sh/install | bash)" && exit 1)
	@cd frontend && bun install --silent && bun run build
	@echo "PWA bundle ready at app/static/app/. Visit http://localhost:8000/app/ after 'make dev'."

# Shared cert-presence guard for HTTPS targets. Defined as a Make function so
# both dev-https (with --reload) and run-https (production) can call it
# without duplicating the four `test` lines.
define require_tls_env
@test -n "$$WHISPER_CERT" || (echo "ERROR: WHISPER_CERT env var is unset; run 'tailscale cert <host>.<tailnet>.ts.net' first" && exit 1)
@test -n "$$WHISPER_KEY" || (echo "ERROR: WHISPER_KEY env var is unset" && exit 1)
@test -f "$$WHISPER_CERT" || (echo "ERROR: WHISPER_CERT path does not exist: $$WHISPER_CERT" && exit 1)
@test -f "$$WHISPER_KEY" || (echo "ERROR: WHISPER_KEY path does not exist: $$WHISPER_KEY" && exit 1)
@test -r "$$WHISPER_CERT" || (echo "ERROR: WHISPER_CERT exists but is not readable by $$(id -un) (likely root-owned from 'sudo tailscale cert'); run: sudo chown $$(id -un):staff $$WHISPER_CERT && chmod 644 $$WHISPER_CERT" && exit 1)
@test -r "$$WHISPER_KEY" || (echo "ERROR: WHISPER_KEY exists but is not readable by $$(id -un); run: sudo chown $$(id -un):staff $$WHISPER_KEY && chmod 600 $$WHISPER_KEY" && exit 1)
endef

dev-https:
	$(call require_tls_env)
	uv run uvicorn app.main:app --reload --host $(API_HOST) --port $(API_PORT) \
		--ssl-certfile $$WHISPER_CERT --ssl-keyfile $$WHISPER_KEY

run-https:
	$(call require_tls_env)
	uv run uvicorn app.main:app --host $(API_HOST) --port $(API_PORT) \
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
	WHISPER_WRAP_ALL_VARIANTS=$(if $(ALL),1,) bash $(SCRIPT) download "$$DEFAULT_NAME"

models:
	@bash $(SCRIPT) list

# Default: fetch only the variant that matches the current platform.
# Use `ALL=1 make download-model MODEL=<name>` to fetch every variant of the
# model (handy for cross-platform / benchmark setups).
# Use `DIARIZE=1 make download-model MODEL=<name>` to also pre-fetch the
# pyannote diarization models for /transcribe/meeting (requires HF_TOKEN).
download-model:
	@WHISPER_WRAP_ALL_VARIANTS=$(if $(ALL),1,) bash $(SCRIPT) download $(MODEL) $(if $(DIARIZE),--with-diarization,)

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

# ── Autostart (macOS launchd) ────────────────────────────────────────────────
#
# Generates ~/Library/LaunchAgents/com.whisper-wrap.plist from
# scripts/com.whisper-wrap.plist.template by substituting the current
# WORKDIR + HOME + PATH. Loading registers the agent so it starts on login,
# restarts on crash, and writes logs to ~/Library/Logs/whisper-wrap/.

LAUNCHD_PLIST := $$HOME/Library/LaunchAgents/com.whisper-wrap.plist
LAUNCHD_LOGDIR := $$HOME/Library/Logs/whisper-wrap

install-launchd:
	@test "$$(uname -s)" = "Darwin" || { echo "install-launchd is macOS-only"; exit 1; }
	@mkdir -p "$$HOME/Library/LaunchAgents" "$(LAUNCHD_LOGDIR)"
	@sed -e "s|__WORKDIR__|$(CURDIR)|g" \
	     -e "s|__HOME__|$$HOME|g" \
	     -e "s|__PATH__|$$PATH|g" \
	     scripts/com.whisper-wrap.plist.template > "$(LAUNCHD_PLIST)"
	@launchctl unload "$(LAUNCHD_PLIST)" 2>/dev/null || true
	@launchctl load "$(LAUNCHD_PLIST)"
	@echo "Loaded: $(LAUNCHD_PLIST)"
	@echo "Tail logs: make launchd-logs"

uninstall-launchd:
	@test "$$(uname -s)" = "Darwin" || { echo "uninstall-launchd is macOS-only"; exit 1; }
	@launchctl unload "$(LAUNCHD_PLIST)" 2>/dev/null || true
	@rm -f "$(LAUNCHD_PLIST)"
	@echo "Removed: $(LAUNCHD_PLIST) (logs in $(LAUNCHD_LOGDIR) kept)"

launchd-status:
	@launchctl list | grep com.whisper-wrap || echo "Not loaded. Run: make install-launchd"

launchd-logs:
	@test -d "$(LAUNCHD_LOGDIR)" || { echo "No log dir yet: $(LAUNCHD_LOGDIR)"; exit 1; }
	@tail -n 50 -F "$(LAUNCHD_LOGDIR)/stdout.log" "$(LAUNCHD_LOGDIR)/stderr.log"
