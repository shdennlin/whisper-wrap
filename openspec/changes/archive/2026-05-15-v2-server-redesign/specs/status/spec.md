## ADDED Requirements

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

### Requirement: API discovery endpoint lists every registered route

The system SHALL expose `GET /` returning a JSON document that lists every public HTTP and WebSocket route registered on the FastAPI app. Each entry SHALL include the HTTP method (or the literal string `"WS"` for WebSocket routes), the URL path, and a one-line `description`. The list SHALL be a single source of truth for clients discovering the API surface; documentation generators MAY read it. The response SHALL be reachable without authentication.

#### Scenario: Discovery payload shape

- **WHEN** a client requests `GET /`
- **THEN** the response SHALL be HTTP 200 with a JSON document of shape `{"endpoints": [{"method": "POST", "path": "/transcribe", "description": "..."}, ...]}` and SHALL include at least these entries: `POST /transcribe`, `WS /listen`, `POST /ask`, `GET /status`, `GET /`

### Requirement: Status replaces the removed health endpoint

The system SHALL NOT expose `GET /health` in v2.0 or later. The status endpoint is the sole health-style probe surface.

#### Scenario: Legacy health endpoint is absent

- **WHEN** a client sends `GET /health` to a v2.0 server
- **THEN** the server SHALL respond with HTTP 404

### Requirement: Status endpoint is designed for LAN/localhost deployment

`whisper-wrap` is designed for LAN-only or localhost deployment. `GET /status` exposes operational detail (active model path, `compute_type`, `device`, configured Gemini model name) that aids debugging but reveals internal layout to any reader. The CHANGELOG migration note and the v2 `docs/INSTALLATION.md` SHALL document this assumption explicitly and SHALL recommend placing the service behind a reverse proxy, VPN, or Tailscale boundary before exposing it to the public internet. The status payload itself does NOT include credentials (no `GEMINI_API_KEY` value, no model file SHA), so leakage on a LAN is acceptable for the operator's deployment posture.

#### Scenario: Status payload does not leak credentials

- **WHEN** a client requests `GET /status` on a server with all environment variables populated
- **THEN** the response body SHALL NOT contain the value of `GEMINI_API_KEY` or any other secret-bearing variable; only the `gemini.configured` boolean and the `gemini.model` name are exposed
