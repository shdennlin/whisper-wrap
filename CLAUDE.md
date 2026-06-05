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

Spec changes go through `/spectra-propose` → `/spectra-apply` → `/spectra-archive` (see the SPECTRA block above). Do not hand-edit `openspec/specs/*/spec.md` — the archive step rebuilds them from the change deltas.

## Project Overview

whisper-wrap is a single-process FastAPI server for audio transcription, live captioning, and Gemini-backed Q&A. The PWA at `/app/` is the reference client.

v2.1+ ships **two Whisper backends in one process** and picks one at startup:

| Platform | Default backend | Format | Acceleration |
| - | - | - | - |
| macOS | `pywhispercpp` | `ggml` | Apple Neural Engine via bundled Core ML encoder |
| Linux | `faster-whisper` | `ct2` | CPU or CUDA via CTranslate2 |

Both backends implement the `WhisperBackend` Protocol in `app/services/_whisper_backend.py`; the endpoints never touch the backend type directly. Override with `BACKEND_FORMAT=ct2|ggml` in `.env`.

## Architecture

```
┌──────────────────┐         ┌──────────────────────────────────────────┐
│   Client App     │───────▶ │  whisper-wrap (FastAPI, port 8000)       │
│  (iOS/PWA/CLI)   │         │  ├── /transcribe      (multipart + raw)  │
│                  │         │  ├── /ask             (blocking + SSE)   │
│                  │         │  ├── /listen          (WebSocket, PCM)   │
│                  │         │  ├── /v1/audio/transcriptions (OpenAI)   │
│                  │         │  ├── /v1/audio/translations   (OpenAI)   │
│                  │         │  ├── /v1/models               (OpenAI)   │
│                  │         │  ├── /actions         (prompt templates) │
│                  │         │  ├── /app/            (PWA static bundle)│
│                  │         │  ├── /status, /                          │
│                  │         │  └── in-process WhisperBackend           │
└──────────────────┘         └──────────────────────────────────────────┘
```

**Data flow** (`/transcribe`): upload → libmagic validation → ffmpeg → 16 kHz mono WAV → backend → punctuation post-process → temp cleanup.

**Data flow** (`/listen`): 16 kHz PCM frames → silero-VAD endpointing → sliding-window re-transcription with partial-consensus filter → JSON `partial`/`final` events.

## Core Components

- **`app/main.py`** — lifespan handler: resolves variant from `registry/models.yaml`, constructs the matching backend, builds `LLMClient`, loads VAD factory, loads action templates, mounts `/app/` static files. Everything is on `app.state`.
- **`app/services/_whisper_backend.py`** — `WhisperBackend` Protocol (`transcribe`, `language_detect`) with `task: str = "transcribe"` for translation routing.
- **`app/services/whisper_ct2.py`** — `CTranslate2Backend` (faster-whisper). Inference in `asyncio.to_thread`.
- **`app/services/whisper_cpp.py`** — `PyWhisperCppBackend` (pywhispercpp + Core ML).
- **`app/services/registry.py`** — parses `registry/models.yaml`'s `variants:` list; resolves the active variant by `MODEL_DIR` override, `MODEL_NAME` + platform, or hard-coded fallback `breeze-asr-25`.
- **`app/services/stream.py`** — sliding-window VAD + re-transcription pipeline for `WS /listen`; consensus filter so partials don't thrash.
- **`app/services/vad.py`** — silero-vad with RMS fallback (`VAD_BACKEND=silero|rms`, unset = try silero then fall back).
- **`app/services/llm.py`** — Gemini wrapper. Missing `GEMINI_API_KEY` → `/ask` returns 502 (blocking) or `event: error` (SSE).
- **`app/services/actions.py`** — loads `registry/actions.yaml`; missing/malformed → WARN + empty list (server starts), duplicate id or missing `{transcript}` placeholder → raises (server refuses to start).
- **`app/config.py`** — env-driven `Config`. Env reading happens in `__init__` so tests build fresh instances without `importlib.reload`.

## Frontend (PWA, v2.4)

Source: `frontend/` (Vite + vanilla TypeScript + vite-plugin-pwa).

```
frontend/src/
  capture/      mic-pipeline, AudioWorklet downsampler, listen-socket WS client
  storage/      localStorage rolling history (20 sessions)
  export/       SRT/VTT/TXT subtitle generators
  ui/           transcript view, action chips, settings, history panel
  types/        ambient declarations
  main.ts       shell wiring + service-worker registration
```

`make build-frontend` runs `bun install && bun run build` and emits to `app/static/app/`. If that directory doesn't exist, `app/main.py` silently skips the `/app/` mount — the rest of the API still works. Run `make build-frontend` first or `/app/` returns 404.

## Common Commands

```bash
make help                    # source of truth — lists every target
make setup                   # first-time: install + download default model + build-frontend
make dev                     # uvicorn --reload (HTTP)
make dev-https               # uvicorn over TLS; requires WHISPER_CERT + WHISPER_KEY (see docs/HTTPS-TAILSCALE.md)
make build-frontend          # rebuild PWA bundle (Bun 1.1+)
make test                    # full pytest suite
make lint                    # ruff check
make format                  # ruff format
make models                  # list registry entries + install status
make download-model MODEL=<name>
make set-model MODEL=<name>  # refuses unless model is downloaded
```

**Run a single pytest test:**

```bash
uv run pytest tests/test_listen.py::test_partial_consensus_filter -v
```

**Run frontend tests:**

```bash
cd frontend && bun run test           # 38 vitest tests
cd frontend && bun run test path/to/file.test.ts
```

## API Endpoints (quick reference)

Full schemas in README.md and `docs/API.md`. Highlights only:

| Endpoint | Notes |
| - | - |
| `POST /transcribe` | Content-Type dispatch: multipart, raw `audio/*`, `application/octet-stream`. Query: `language`, `prompt`. |
| `POST /transcribe/meeting` | Long-form meeting analysis (speaker diarization + word timestamps). Async: returns 202 + `job_id`; client polls. Opt-in `[meeting]` extras + `HF_TOKEN` required (503 otherwise). |
| `GET /transcribe/meeting/{job_id}` | Poll a meeting job. Status `pending` → `running` → `done`/`error`; eviction after `MEETING_JOB_TTL_SECONDS` (default 3600). |
| `POST /ask` | Audio/text in, Gemini answer out. `?stream=true` → SSE `transcript` → `token*` → `done`/`error`. JSON body `{"text": "..."}` skips STT. |
| `WS /listen` | 16 kHz mono `pcm_s16le` binary frames in; JSON `partial`/`final` events out. Disconnect mid-utterance discards in-flight buffer. |
| `POST /v1/audio/transcriptions` | OpenAI-Whisper-compat. `model` is advisory (reserved aliases + active model silent; others log WARN). `response_format`: json/text/srt/verbose_json/vtt. `Authorization` header accepted but ignored. |
| `POST /v1/audio/translations` | Same as above, output always English; `language` field rejected with 400. |
| `GET /v1/models` | Returns OpenAI list shape with exactly one entry (the active model). |
| `GET /actions` | Prompt-action templates from `registry/actions.yaml`. PWA substitutes `{transcript}` client-side. |
| `GET /app/` | Static PWA bundle (404 if `make build-frontend` hasn't run). |
| `GET /status`, `GET /` | Health/discovery. Lifespan blocks startup until model is loaded, so `model.loaded=true` is always true. |

## Meeting Mode (architecture)

The meeting endpoint is **architecturally isolated** from the rest of the
server — every existing endpoint (`/transcribe`, `/listen`, `/ask`, `/v1/*`)
continues unchanged. Key facts a future Claude session needs:

- **Separate endpoint, separate code path.** `app/api/meeting.py` mounts
  `POST /transcribe/meeting` + `GET /transcribe/meeting/{id}`. It reuses
  `app.api.transcribe`'s libmagic+ffmpeg upload helpers but never goes
  through the `WhisperBackend` Protocol.
- **`MeetingAnalyzer` is NOT a `WhisperBackend`.** Defined in
  `app/services/meeting.py`. Owns three sub-models: faster-whisper CT2
  ASR, wav2vec2 alignment, pyannote diarization. Constructed lazily
  (`from_config()`) the first time the endpoint passes its 503 gate.
- **Lazy load, never at lifespan startup.** `app.state.meeting_analyzer`
  starts as `None`. Server boot does not import `whisperx`,
  `pyannote.audio`, or `torch`. Pinned by `tests/test_meeting_lifecycle.py`.
- **macOS dual-variant requirement.** WhisperX requires `format: ct2`
  regardless of platform — so on macOS the user must download **both** the
  ggml (Core ML) variant (for `/transcribe`) and the ct2 variant (for
  `/transcribe/meeting`). The 503 with reason `model <name> ct2 variant
  is not downloaded` surfaces this.
- **HF token gated at endpoint level.** `HF_TOKEN` missing or empty →
  503 on meeting endpoints only. Server starts normally. Same for the
  `[meeting]` optional dependency group (`uv sync --extra meeting`).
- **In-memory job store** (`app/services/meeting_jobs.py`). ULID-style
  sortable IDs, TTL+capacity eviction on every poll/accept, NOT persisted.
  Jobs gone after restart — client must re-upload.
- **Single-job concurrency.** `asyncio.Lock` inside the analyzer. Second
  job submitted while first is running stays `pending`.
- **FastAPI `BackgroundTasks`** runs the pipeline so the HTTP response
  returns in <1s. Polling-based status updates.
- **PWA Meeting Mode** at `/app/#/meeting` (`frontend/src/meeting/`).
  Speaker-coloured transcript with click-to-seek, speaker-aware
  SRT/VTT/TXT export (`frontend/src/export/speaker-{srt,vtt,txt}.ts`).
- **Pre-stage models** with `DIARIZE=1 make download-model MODEL=<name>` —
  fetches both the model variants AND the pyannote diarization +
  segmentation snapshots into the HF cache.

## Configuration

Env vars (`.env`; see `.env.example`). Most-touched:

```env
API_PORT=8000                # overridden in local .env on this repo — match URLs accordingly
API_HOST=0.0.0.0
MODEL_NAME=breeze-asr-25     # registry key; variants resolved by platform
# MODEL_DIR=/abs/path        # bypasses registry; layout inferred (CT2 vs ggml)
# BACKEND_FORMAT=ct2|ggml    # unset = platform default (darwin→ggml, linux→ct2)
# VAD_BACKEND=silero|rms     # unset = try silero, fall back to rms
COMPUTE_TYPE=default         # ct2 only; on Apple Silicon CPU MUST be "default"
DEVICE=auto                  # ct2 only
GEMINI_API_KEY=              # required for /ask
GEMINI_MODEL=gemini-3.1-flash-lite
```

v1-era env vars (`WHISPER_SERVER_*`, `WHISPER_AUTO_RESTART`, `WHISPER_BINARY_PATH`, `WHISPER_MAX_RETRIES`, `MODEL_PATH`) are silently ignored — v2 was never released externally so no migration shim was kept.

## Model Management

Models live in `./models/<variant.local_dir>/`. The manager wraps `hf download` against `registry/models.yaml`. `make download-model MODEL=<name>` fetches **every variant** declared for that model (CT2 and ggml + Core ML encoder if present).

`registry/models.yaml` uses a `variants:` list per model:

```yaml
breeze-asr-25:
  description: ...
  size: ...
  languages: [...]
  variants:
    - format: ct2
      repo_id: shdennlin/breeze-asr-25-ct2
      compute_type: int8_float16
      local_dir: breeze-asr-25-ct2
      default_on: [linux]
    - format: ggml
      repo_id: ...
      filename: ggml-breeze-asr-25-q6_k.bin
      coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
      local_dir: breeze-asr-25-ggml
      default_on: [darwin]
```

Required at root: `description`, `size`, `languages`, `variants`. Per-variant: `format`, `repo_id`, `local_dir` + format-specific fields (`compute_type` for ct2; `filename`, `coreml_encoder` for ggml). Optional: `default_on`, `subfolder`, `revision`. Exactly one model SHALL set `default: true`.

## Non-Obvious Gotchas

These have bitten this codebase before — surface them when working in the relevant area.

- **AudioWorklet files MUST be `.js`, not `.ts`.** Vite's MIME map treats `.ts` as `video/mp2t` (MPEG transport stream); `AudioWorklet.addModule()` then rejects the inlined `data:` URL. `frontend/src/capture/audio-worklet.js` is plain JS with the downsample math inlined (don't import from `downsample.ts` — `?url` doesn't bundle).
- **First Core ML compile takes 10-30 s on macOS.** The lifespan blocks startup while `.mlmodelc` compiles to ANE-optimised form. INFO log emits elapsed seconds. Subsequent starts on the same host are fast.
- **`API_PORT` in `.env` overrides the docs' hard-coded `8000`.** This dev environment uses `12000`. URL examples in CLAUDE.md / README use `8000` for clarity — substitute your `API_PORT` mentally.
- **Background-session policy forces worktrees for any `Edit`/`Write`.** If a Claude Code job complains about `This background session hasn't isolated its changes`, call `EnterWorktree` first, edit, then ff-merge back. Foreground/interactive Claude Code has no such restriction.
- **`MODEL_NAME=` cannot be empty.** Unset → falls back to hard-coded `breeze-asr-25`. Empty string → registry lookup fails. (Same for OpenAI compat `model` field on `/v1/audio/transcriptions`.)
- **`/listen` discards in-flight buffer on disconnect.** The client must finish an utterance before closing if it wants the final. The PWA's `ListenSocket` handles reconnect-with-backoff but does not replay partials.

## Testing

- **Pytest**: 217 test functions across 20 files under `tests/`. Covers config, both whisper backends, llm, transcribe, ask, status, registry+variants, model-manager, stream consensus, VAD, OpenAI compat, prompt actions, lifespan integration.
- **Vitest**: 38 tests under `frontend/src/**/*.test.ts`. Run with `cd frontend && bun run test` — uses happy-dom environment.
- Cover validation 400s, 415s, SSE error events, registry edge cases.

## Performance & Deployment

- **Memory**: 2-4 GB during transcription; 8 GB recommended for production.
- **Timing**: 1 min of audio ≈ 10-25 s on Mac mini (ggml + Core ML); ct2 CPU is 2-3× slower without ANE.
- **Concurrency**: Single in-process model — requests queue. Use a reverse proxy with concurrency limits for production.
- **Docker**: ~1.5 GB image; `whisper-models` named volume persists model artefacts; restart policy `unless-stopped`.

> [!WARNING]
> **ARM Docker has no GPU access.** Docker containers on Apple Silicon cannot reach the Metal/Neural Engine. CT2 falls back to CPU paths automatically; ggml does not work in container. For ANE acceleration on Mac mini, run on the host, not in Docker.
