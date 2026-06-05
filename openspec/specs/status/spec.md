# status Specification

## Purpose

TBD - created by archiving change 'v2-server-redesign'. Update Purpose after archive.

## Requirements

### Requirement: Status endpoint reports service, model, and LLM configuration

The system SHALL expose `GET /status` returning a JSON document with the following fields, all required and non-nullable unless noted:

- `status` (string): always `"ok"` — see the field semantics block below for why a separate "starting" state does not exist in v2.0.
- `version` (string): the value of `whisper_wrap.__version__` declared in `app/__init__.py`. This is the single source of truth; the same constant SHALL feed `pyproject.toml` (or be exposed through it) so release tooling reads the same value.
- `uptime_seconds` (integer ≥ 0): wall-clock seconds elapsed since FastAPI's lifespan startup function returned (i.e. since the app began accepting connections). Computed from `time.monotonic()` at request time minus a startup timestamp recorded in `app.state`.
- `model` (object):
  - `name` (string): the active registry key, or the literal `"<MODEL_DIR>"` when `MODEL_DIR` overrides registry lookup.
  - `path` (string): the **project-relative** CT2 directory path passed to `WhisperModel(...)` when the resolved path is inside the project root (e.g. `./models/breeze-asr-25-ct2-int8_float16`); otherwise (when `MODEL_DIR` points outside the project root) the absolute path. The example block uses the relative form because the default registry-driven resolution always lives under `./models/`.
  - `compute_type` (string): the value passed to `WhisperModel` (`int8_float16`, `float16`, `int8`, etc.).
  - `device` (string): the resolved device name (`cpu`, `cuda`, `metal` — whichever string `faster-whisper` reports).
  - `loaded` (boolean): SHALL always be `true` for any successful `/status` response in v2.0, because FastAPI's lifespan completes synchronously before the app accepts connections. The field is preserved in the response shape so external consumers have a stable schema.
  - `load_time_ms` (integer ≥ 0): milliseconds spent in the most recent successful `WhisperModel(...)` construction during startup. Measured with `time.monotonic_ns()` start/end timestamps inside the lifespan handler; rounded down to integer milliseconds.
- `gemini` (object):
  - `configured` (boolean): `true` if `GEMINI_API_KEY` was a non-empty string at startup, otherwise `false`.
  - `model` (string): the value of `GEMINI_MODEL`. If `GEMINI_MODEL` is unset OR set to the empty string, the system SHALL fall back to the default `"gemini-2.5-flash"` and SHALL report that default in this field (the empty-string case also emits a one-line startup WARNING naming the variable, mirroring the `GEMINI_SYSTEM_PROMPT` fallback policy).

The response SHALL be reachable without authentication and SHALL never block on external dependencies (it MUST NOT make a network call to Gemini or to Hugging Face). The endpoint is intentionally informative for operators; see the deployment threat model note below.

#### Scenario: Status when fully warm

- **WHEN** the server has finished loading the active ASR model and `GEMINI_API_KEY` is configured
- **THEN** `GET /status` SHALL return HTTP 200 with `status="ok"`, `model.loaded=true`, the active model identifier in `model.name`, the resolved `compute_type` and `device`, `load_time_ms` as a non-negative integer (typically positive on real hardware; the field MAY be `0` only on artificially fast in-memory mocks used by tests), and `gemini.configured=true`

##### Example: response shape when warm

- **GIVEN** active model `breeze-asr-25` loaded on CUDA with `int8_float16`, server uptime 12 345 s, `GEMINI_API_KEY` set, `GEMINI_MODEL=gemini-2.5-flash`, `whisper_wrap.__version__ = "2.0.0"`
- **WHEN** a client requests `GET /status`
- **THEN** the response body SHALL be a JSON document equivalent to:

```json
{
  "status": "ok",
  "version": "2.0.0",
  "uptime_seconds": 12345,
  "model": {
    "name": "breeze-asr-25",
    "path": "./models/breeze-asr-25-ct2-int8_float16",
    "compute_type": "int8_float16",
    "device": "cuda",
    "loaded": true,
    "load_time_ms": 1240
  },
  "gemini": {
    "configured": true,
    "model": "gemini-2.5-flash"
  }
}
```

#### Scenario: Status when Gemini is not configured

- **WHEN** `GEMINI_API_KEY` is unset at startup
- **THEN** `GET /status` SHALL return `gemini.configured=false` while leaving the rest of the response unchanged

#### Scenario: Empty GEMINI_MODEL falls back to default with warning

- **WHEN** the server starts with `GEMINI_MODEL=""` (empty string) and `GEMINI_API_KEY` set
- **THEN** the server SHALL emit a one-line WARNING at startup naming `GEMINI_MODEL`, and `GET /status` SHALL return `gemini.model="gemini-2.5-flash"` (the default) with `gemini.configured=true`

#### Scenario: Unset GEMINI_MODEL silently uses default

- **WHEN** the server starts with `GEMINI_MODEL` unset in the environment
- **THEN** `GET /status` SHALL return `gemini.model="gemini-2.5-flash"` with no startup warning (mirroring the unset-`GEMINI_SYSTEM_PROMPT` behaviour in the `ask` capability)

#### Scenario: Status when MODEL_DIR overrides MODEL_NAME

- **WHEN** the server is started with `MODEL_DIR=/tmp/my-experiment-model` (which exists and contains a CT2 directory) and `MODEL_NAME=breeze-asr-25` both set
- **THEN** `GET /status` SHALL return `model.name="<MODEL_DIR>"` and `model.path="/tmp/my-experiment-model"`; the registry entry SHALL NOT be consulted


<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: API discovery endpoint lists every registered route

The system SHALL expose `GET /` returning a JSON document that lists every public HTTP and WebSocket route registered on the FastAPI app. Each entry SHALL include the HTTP method (or the literal string `"WS"` for WebSocket routes), the URL path, and a one-line `description`. The list SHALL be a single source of truth for clients discovering the API surface; documentation generators MAY read it. The response SHALL be reachable without authentication.

The catalogue SHALL include the OpenAI-compatibility surface introduced by the `openai-compat` capability and the PWA surface introduced by the `pwa-listen-client` and `prompt-actions` capabilities so operators can confirm at a glance that every layer is mounted.

#### Scenario: Discovery payload shape

- **WHEN** a client requests `GET /`
- **THEN** the response SHALL be HTTP 200 with a JSON document of shape `{"endpoints": [{"method": "POST", "path": "/transcribe", "description": "..."}, ...]}` and SHALL include at least these entries: `POST /transcribe`, `WS /listen`, `POST /ask`, `GET /status`, `GET /`, `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, `GET /v1/models`, `GET /actions`, `GET /app/`

##### Example: catalogue rows for v2.4 surfaces

| method | path        | description (illustrative; exact wording is implementation-defined) |
| ------ | ----------- | --- |
| GET    | /actions    | Prompt action templates registry (consumed by the PWA) |
| GET    | /app/       | PWA live-captioning client |


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Status replaces the removed health endpoint

The system SHALL NOT expose `GET /health` in v2.0 or later. The status endpoint is the sole health-style probe surface.

#### Scenario: Legacy health endpoint is absent

- **WHEN** a client sends `GET /health` to a v2.0 server
- **THEN** the server SHALL respond with HTTP 404


<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: Status endpoint is designed for LAN/localhost deployment

`whisper-wrap` is designed for LAN-only or localhost deployment. `GET /status` exposes operational detail (active model path, `compute_type`, `device`, configured Gemini model name) that aids debugging but reveals internal layout to any reader. The CHANGELOG migration note and the v2 `docs/INSTALLATION.md` SHALL document this assumption explicitly and SHALL recommend placing the service behind a reverse proxy, VPN, or Tailscale boundary before exposing it to the public internet. The status payload itself does NOT include credentials (no `GEMINI_API_KEY` value, no model file SHA), so leakage on a LAN is acceptable for the operator's deployment posture.

#### Scenario: Status payload does not leak credentials

- **WHEN** a client requests `GET /status` on a server with all environment variables populated
- **THEN** the response body SHALL NOT contain the value of `GEMINI_API_KEY` or any other secret-bearing variable; only the `gemini.configured` boolean and the `gemini.model` name are exposed

<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: /status surfaces the active VAD backend

`GET /status` SHALL include a top-level `vad` object naming the active voice-activity-detection backend. The object SHALL contain the field `backend: "silero" | "rms"`. The object SHALL always be present (never null and never missing) so monitoring clients can write defensive code that does not need null-checks per response.

The field SHALL reflect the runtime resolution per the `VAD_BACKEND` env var rules in the `transcribe-stream` capability: if `VAD_BACKEND` was unset and silero-vad was importable, the field SHALL be `"silero"`; if silero-vad fell back to RMS at startup, the field SHALL be `"rms"`.

#### Scenario: silero-vad active on macOS default config

- **WHEN** a client sends `GET /status` after the server started with `silero-vad` installed and no `VAD_BACKEND` env var set
- **THEN** the response SHALL include `"vad": {"backend": "silero"}` alongside the existing `/status` fields

#### Scenario: rms-vad active under explicit opt-out

- **WHEN** a client sends `GET /status` after the server started with `VAD_BACKEND=rms` set in the environment
- **THEN** the response SHALL include `"vad": {"backend": "rms"}`

#### Scenario: rms-vad active under auto-fallback

- **WHEN** a client sends `GET /status` after the server started with `VAD_BACKEND` unset on a host where `import silero_vad` failed
- **THEN** the response SHALL include `"vad": {"backend": "rms"}`, indistinguishable from the explicit opt-out case