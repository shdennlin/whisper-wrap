<!-- SPECTRA:START v1.0.2 -->

# Spectra Instructions

This project uses Spectra for Spec-Driven Development(SDD). Specs live in `openspec/specs/`, change proposals in `openspec/changes/`.

## Use `/spectra-*` skills when:

- A discussion needs structure before coding → `/spectra-discuss`
- User wants to plan, propose, or design a change → `/spectra-propose`
- Tasks are ready to implement → `/spectra-apply`
- There's an in-progress change to continue → `/spectra-ingest`
- User asks about specs or how something works → `/spectra-ask`
- Implementation is done → `/spectra-archive`
- Commit only files related to a specific change → `/spectra-commit`

## Workflow

discuss? → propose → apply ⇄ ingest → archive

- `discuss` is optional — skip if requirements are clear
- Requirements change mid-work? Plan mode → `ingest` → resume `apply`

## Parked Changes

Changes can be parked（暫存）— temporarily moved out of `openspec/changes/`. Parked changes won't appear in `spectra list` but can be found with `spectra list --parked`. To restore: `spectra unpark <name>`. The `/spectra-apply` and `/spectra-ingest` skills handle parked changes automatically.

<!-- SPECTRA:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

whisper-wrap is a single-process FastAPI server for audio transcription, live
captioning, and Gemini-backed Q&A. The v2 backend loads a CTranslate2 Whisper
model (via `faster-whisper`) directly in the FastAPI process — no subprocess,
no second port.

1. **Universal audio input**: `POST /transcribe` accepts multipart uploads,
   raw `audio/*` bodies, and `application/octet-stream` (Content-Type dispatch).
2. **Voice or text Q&A**: `POST /ask` runs the transcript through Gemini.
   Optional `?stream=true` returns Server-Sent Events.
3. **Live captioning**: `WS /listen` consumes 16 kHz mono `pcm_s16le` frames
   and emits timestamped `partial`/`final` events.
4. **Rich `/status`**: loaded model, runtime device, compute type, Gemini
   configuration, uptime.

## Architecture

```
┌──────────────────┐         ┌────────────────────────────────────┐
│   Client App     │───────▶ │  whisper-wrap (FastAPI, port 8000) │
│  (iOS/Web/CLI)   │         │  ├── /transcribe (Content-Type)    │
│                  │         │  ├── /ask  → Gemini API            │
│                  │         │  ├── /listen (WebSocket, PCM)      │
│                  │         │  ├── /status, /                    │
│                  │         │  └── in-process faster-whisper     │
└──────────────────┘         └────────────────────────────────────┘
```

**Data Flow** (transcribe): Upload → Validate (libmagic) → Convert
(ffmpeg → 16 kHz mono WAV) → Transcribe (faster-whisper) → Post-process
(punctuation join + normalisation) → Cleanup temp files.

**Core Components:**

- **FastAPI Application** (`app/main.py`): Lifespan handler loads the
  `WhisperModel` and constructs `LLMClient`; both are exposed on `app.state`.
- **API Endpoints**:
  - `app/api/transcribe.py` — unified `/transcribe`
  - `app/api/ask.py` — `/ask` (blocking + SSE streaming)
  - `app/api/status.py` — `/status` + `/` discovery
  - `app/api/listen.py` — `WS /listen` (task group 5)
- **Whisper Wrapper** (`app/services/whisper.py`): Async wrapper around
  `faster_whisper.WhisperModel`. Inference runs in a thread via
  `asyncio.to_thread` so the event loop is not blocked.
- **LLM Client** (`app/services/llm.py`): Gemini wrapper with unset-silent
  vs empty-warn fallback policy for `GEMINI_MODEL` and `GEMINI_SYSTEM_PROMPT`.
- **Streaming wrapper** (`app/services/stream.py`): Embedded sliding-window
  VAD + re-transcription for `WS /listen` (task group 5).
- **Model Registry** (`app/services/registry.py`): Parses
  `registry/models.yaml`; resolves the active model via `MODEL_DIR` override
  or `MODEL_NAME` lookup (hard-coded `breeze-asr-25` fallback).
- **File Services** (`app/services/files.py`): MIME detection, validation,
  temp file lifecycle.
- **Audio Converter** (`app/services/converter.py`): ffmpeg integration.
- **Configuration** (`app/config.py`): Env-driven Config; env reading
  happens in `__init__` (not at class definition) so tests can construct
  fresh instances without `importlib.reload`.

## Development Workflow

**First-Time Setup:**

```bash
make check-system-deps    # Verify ffmpeg, libmagic, uv, hf
make install-system-deps  # Auto-install via brew / apt / yum / pacman
make setup                # uv sync + download default model (Breeze ASR 25)
```

**Development:**

```bash
make dev                 # uvicorn --reload
make test                # pytest (full suite)
make lint                # ruff check
```

**Docker:**

```bash
make docker              # docker compose build + up
```

## API Endpoints

### POST /transcribe
Unified handler with Content-Type dispatch:

- `multipart/form-data` — reads the `file` form field
- `audio/*` or `application/octet-stream` — reads the raw request body
- anything else — HTTP 415

Query params: `language` (default `"auto"`), `prompt` (initial seed; defaults
to a built-in bilingual punctuation prompt).

### POST /ask
Audio or text question; Gemini answer.

- Body: same Content-Types as `/transcribe`, plus `application/json {"text": "..."}` to skip STT.
- Blocking response: `{"transcript": <string|null>, "answer": "..."}`.
- `?stream=true` returns `text/event-stream`: one `event: transcript` (text
  may be null for the JSON path), zero or more `event: token`, terminating
  `event: done` (or `event: error`).
- Missing `GEMINI_API_KEY`: blocking → HTTP 502; streaming → single
  `event: error` then close.

### WS /listen
Binary frames: 16 kHz mono `pcm_s16le`, size 200 B – 64 KiB. Emits JSON text
frames: `{"type": "partial"|"final", "text", "start_ms", "end_ms"}`. One
connection may carry multiple utterances. Disconnect mid-utterance discards
the in-flight buffer.

### GET /status
Service health, loaded model details, LLM configuration. Always returns
`status="ok"` and `model.loaded=true` (the lifespan blocks startup until the
model is loaded).

### GET /
Endpoint catalogue: each entry has `method`, `path`, `description`.

### POST /v1/audio/transcriptions  (v2.3, OpenAI-compat)

OpenAI-Whisper-compatible transcription endpoint. Multipart `file`, `model`
(required, non-empty), and optional `language`, `prompt`, `response_format`,
`temperature` form fields. Reuses the in-process `WhisperBackend` — no extra
model is loaded.

- `response_format` (default `json`): one of `json`, `text`, `srt`,
  `verbose_json`, `vtt`. Anything else returns HTTP 400 with the OpenAI error
  envelope (`{"error": {"message", "type", "param", "code"}}`).
- `model` is advisory. Reserved OpenAI aliases (`whisper-1`, `gpt-4o-transcribe`,
  `gpt-4o-mini-transcribe`) and the active whisper-wrap model name pass
  silently. Other non-empty values are accepted with a single WARNING log line
  naming the requested and active model. Empty/missing `model` → 400 with
  `param="model"`.
- `Authorization` header is accepted (so the OpenAI SDK is quiet) but ignored
  — whisper-wrap does not enforce bearer-token auth.
- `verbose_json` always includes `tokens=[]`, `avg_logprob=null`,
  `compression_ratio=null`, `no_speech_prob=null` because whisper.cpp does not
  expose those values; the keys exist so SDK clients can rely on the shape.

### POST /v1/audio/translations  (v2.3, OpenAI-compat)

Same shape as `/v1/audio/transcriptions` except the `language` form field is
rejected with HTTP 400 (output is always English per OpenAI's documented
behaviour) and the underlying backend is invoked with the translate task.
`verbose_json` responses carry `task="translate"` and `language="en"`.

### GET /v1/models  (v2.3, OpenAI-compat)

Returns the OpenAI list shape `{"object": "list", "data": [...]}` containing
exactly one entry — the active whisper-wrap model. `id` matches the
`/status` `model.name` field (the registry key when `MODEL_NAME` resolves it;
the resolved path when `MODEL_DIR` overrides). `owned_by` is the literal
string `"whisper-wrap"`; `created` is the server's startup unix-timestamp.

## Configuration

Environment variables (`.env` file; see `.env.example` for the full list):

```env
# API server
API_PORT=8000
API_HOST=0.0.0.0

# Model
MODEL_NAME=breeze-asr-25         # Registry key → variants resolved by platform
# MODEL_DIR=/abs/path            # Bypass registry; layout inferred (CT2 vs ggml)

# VAD selection (v2.2)
# VAD_BACKEND=                   # silero | rms; unset = try silero with rms fallback

# Backend selection (v2.1)
# BACKEND_FORMAT=                # ct2 | ggml; unset = platform default (darwin→ggml, linux→ct2)

# CTranslate2 runtime (applies when active variant is `ct2`)
COMPUTE_TYPE=default             # On Apple Silicon CPU this MUST be "default"
DEVICE=auto                      # "cuda" forces GPU; "cpu" forces CPU

# Gemini (for /ask)
GEMINI_API_KEY=                  # Required for /ask
GEMINI_MODEL=gemini-2.5-flash
# GEMINI_SYSTEM_PROMPT=          # Falls back to a Taiwan-friendly persona

# File handling
MAX_FILE_SIZE_MB=100
TEMP_DIR=/tmp/whisper-wrap
LOG_LEVEL=INFO
UPLOAD_TIMEOUT_SECONDS=30
```

### v2.1 development workflow (Phase 1 / Phase 2)

The `v2-1-whisper-cpp-backend` change is structured as two phases inside one
Spectra change (Decision 7: Phase 1 / Phase 2 boundary inside one change).
Phase 1 swaps the backend (dual-backend + Protocol abstraction + variants
schema); Phase 2 adds the partial-consensus filter on top. Tasks 1.x-11.x
are Phase 1; tasks 12.x-15.x are Phase 2.

The registry now uses a `variants:` list per model (Decision 3: variants
schema). Each variant declares `format: ct2|ggml`, format-specific fields,
and optional `default_on: [darwin|linux]` for per-platform routing.

### Deprecated env vars (v1)

v2.1 silently ignores any v1-era env vars that may still be in `.env`. The
v1 → v2 warning shim was removed because v2 was never released externally.
Affected keys (safe to delete from `.env`):
`WHISPER_SERVER_HOST/PORT/URL`, `WHISPER_AUTO_RESTART`,
`WHISPER_BINARY_PATH`, `WHISPER_MAX_RETRIES`, `MODEL_PATH`.

## Model Management

Models live in `./models/<entry.local_dir>/` as CTranslate2 directories. The
v2 manager wraps `hf download` against `registry/models.yaml`:

```bash
make models                           # List entries with install status
make download-model MODEL=breeze-asr-25
make set-model MODEL=large-v3-turbo   # Refuses unless model is downloaded
make delete-model MODEL=large-v3-turbo # Refuses to delete the active model
```

**Registry schema** (`registry/models.yaml`):

Required: `repo_id`, `format: ct2`, `compute_type`, `local_dir`, `size`,
`languages`, `description`. Optional: `subfolder`, `revision`, `default`.
Exactly one entry SHALL set `default: true`.

## Development Guidelines

**Code Quality:**
- Use `uv` for package management (fast, reliable)
- Follow existing patterns in `app/` directory structure
- Maintain comprehensive error handling with debug logging
- All changes should pass: `make lint && make test`

**Testing:**
- Pytest suite spans config, whisper, llm, transcribe, ask, status, registry,
  model-manager, and lifespan integration; ~140+ tests after v2.
- New endpoints (`/ask`, `/listen`) and the registry rewrite each ship dedicated
  test modules.
- Include error conditions and edge cases (validation 400s, 415s, SSE error events).

**Documentation:**
- Update README.md for user-facing changes
- Update CLAUDE.md for development guidance
- Maintain inline docstrings for complex logic

**Security:**
- Never log sensitive information or file contents
- All file uploads validated with libmagic MIME detection
- Automatic cleanup prevents disk exhaustion
- Configurable file size limits and timeouts

## Common Operations

**Troubleshooting:**
```bash
make check-system-deps              # Verify ffmpeg, libmagic, uv, hf
make test                           # Run pytest
curl http://localhost:8000/status   # Check service health and loaded model
```

**Performance:**
- **Memory**: 2–4 GB during transcription; 8 GB recommended for production
  (model resident, ffmpeg conversion, request buffers).
- **Timing**: 1 min of audio ≈ 10–25 s on Mac mini with Breeze CT2 int8_float16.
- **Concurrency**: Single in-process model — requests queue if many arrive
  simultaneously. Use a reverse proxy with concurrency limits for production.

**Docker:**
- **Build Time**: ~1–3 minutes (no whisper.cpp build step in v2).
- **Image Size**: ~1.5 GB (Python deps + model artefacts).
- **Volumes**: Models persisted via the `whisper-models` named volume; temp
  files are ephemeral (container `tmpfs`).
- **Restart policy**: `restart: unless-stopped` — the supervisor recovers
  from crashes (v1 in-app auto-restart was removed).

> [!WARNING]
> **ARM Docker Limitation**: Docker containers on ARM systems (Mac/Apple
> Silicon) cannot access GPU acceleration. v2 uses CT2's CPU paths
> automatically; performance remains good with `COMPUTE_TYPE=default`.