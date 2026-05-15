## Context

`whisper-wrap` today is a FastAPI service that fronts a `whisper.cpp` `whisper-server` subprocess. The wrapper launches and supervises that subprocess (~188 lines of `app/services/whisper_manager.py`), proxies HTTP requests to it, and exposes two transcription endpoints (`POST /transcribe`, `POST /transcribe-raw`) plus `GET /health` and `GET /`. The default model is `large-v3-turbo` q8_0 GGML; `breeze-asr-25` (Whisper-large-v2 fine-tune for Taiwanese Mandarin) is the preferred model for the operator's actual use case. The repository tracks `whisper.cpp` as a git submodule and the Docker image compiles it at build time (~10–15 minutes).

Three forces motivate v2.0:

1. **Architecture drift** — every recent bug touched `whisper_manager.py` (auto-restart, retries, lifecycle); the subprocess pattern keeps growing complexity that the project does not need.
2. **Missing UX surface** — there is no streaming endpoint, so the upcoming Personal Web App cannot show partial transcripts and the Apple Shortcut has no way to indicate progress.
3. **Twin deployments coming** — the operator runs the service on a Mac mini today and plans to add a Proxmox VE host with an RTX 3070 Ti; maintaining two backends (one optimised per OS) is not worth the gain when one backend (faster-whisper + CTranslate2) runs well on both.

The full motivation, version matrix (GGML vs CT2 vs Core ML), memory/speed/WER trade-offs, and Apple Shortcut UX critique live in `docs/PRD-roadmap.md`. This design document records the v2.0 implementation decisions and contract.

Out of scope for this design: the PWA front-end (separate Spectra change `add-pwa-frontend`); publishing Breeze ASR 25 in multiple quantisations to Hugging Face (separate change `publish-breeze-asr-25-models`).

## Goals / Non-Goals

**Goals:**

- Collapse the runtime from two processes to one by loading CTranslate2 models in-process via `faster-whisper`.
- Provide a single transcription endpoint (`POST /transcribe`) that accepts both multipart form uploads and raw audio bodies (iOS Shortcut compatible) via Content-Type dispatch.
- Ship `WS /listen` for live partial transcripts with millisecond timestamps and `POST /ask` for voice/text question-answering through Gemini 2.5 Flash.
- Replace `GET /health` with `GET /status` carrying enough detail to disambiguate which deployment (Mac mini vs GPU server) the response came from.
- Maintain the existing `make models / download-model / set-model / delete-model` operator commands while migrating the underlying model artefacts from GGML files to CTranslate2 directories.
- Cut Docker build time from ~10–15 minutes to ~1–3 minutes by deleting the `whisper.cpp` compilation step.

**Non-Goals:**

- Native iOS application — superseded by the planned PWA in a follow-up change.
- Real-time streaming below ~500 ms total latency — accept a sliding-window pseudo-streaming approach via the embedded wrapper described in the Decisions section rather than chase a streaming-native ASR architecture in v2.0.
- Multi-turn conversation memory in `/ask` — single round-trip only; conversation state lives in the PWA, not the server.
- Built-in Text-To-Speech — iOS and the PWA both have system TTS; do not add `/tts`.
- Switching to WhisperKit / mlx-whisper for the Mac mini deployment — kept as a v2.1 escape hatch with a `BACKEND_TYPE` env var if profiling shows latency is unacceptable. Recorded as Open Question.
- Rewriting the service in Rust — the inference compute is already native (C++ inside CTranslate2); a language rewrite would not move latency.

## Decisions

### Use faster-whisper with CTranslate2 int8_float16 as the single inference backend

Replace `whisper.cpp` + `whisper-server` subprocess with `faster-whisper` (Python package wrapping CTranslate2). Default `compute_type` is `int8_float16` and `device` is `"auto"` so the same code path runs on Apple Silicon (CPU + Accelerate) and on the RTX 3070 Ti host (CUDA + Tensor Cores). The default model becomes `breeze-asr-25` in CTranslate2 form; `large-v3-turbo` stays as a registry entry that the operator downloads explicitly via `make download-model MODEL=large-v3-turbo` before switching to it with `make set-model`. The runtime itself does not lazy-download missing models — startup requires the resolved `local_dir` to already contain CT2 artefacts, per the "Resolve the active model …" decision below.

Alternatives considered:

- **whisper.cpp + Core ML encoder on Mac mini**: ~15–25 % faster than faster-whisper on M-series via the Apple Neural Engine, but forks the architecture into a Mac branch and a Linux branch, and the upstream streaming example is not production-grade. The performance gap is below the perception threshold for the operator's single-user workload.
- **WhisperKit (Swift) on Mac mini**: produces the best Mac latency, but reintroduces a subprocess (or a second service) and is Mac-only. Kept available as a future `BACKEND_TYPE=external` integration but not adopted now.
- **mlx-whisper**: Apple Silicon only; would not work on the Linux GPU host.
- **Pure GGML with `whisper.cpp` Python bindings**: still requires shipping the compiled binary; does not have a mature streaming counterpart; would also force the embedded streaming wrapper to bridge two different ASR runtimes inside one process.

### Load the WhisperModel eagerly at FastAPI startup and share it across all endpoints

`app/main.py` lifespan opens a single `WhisperModel(MODEL_DIR, compute_type=COMPUTE_TYPE, device=DEVICE)` during startup. FastAPI's lifespan is synchronous from the request-router's perspective: the app **does not accept connections** until the lifespan startup function returns. `POST /transcribe`, `WS /listen`, and `POST /ask` all read the loaded instance through `app.state.whisper_model`. Eager loading exposes failures (missing model, bad compute_type for current hardware) at process startup rather than on first request — the process exits with a clear error before any client traffic lands.

Because the lifespan blocks app startup until loading finishes, **`GET /status` cannot observe `model.loaded=false` in normal operation**. The `loaded` field still exists in the response shape (so external orchestrators have a stable schema), but it SHALL always be `true` for any successful request to `/status`. The historical "starting" state is removed from the contract: `status` is either `"ok"` (server is up and serving) or the request itself fails because the process is not yet listening.

`load_time_ms` is captured by wrapping the `WhisperModel(...)` constructor call with `time.monotonic_ns()` start/end timestamps inside the lifespan handler. It is reported as a non-negative integer (milliseconds, rounded down) on every `/status` response. `uptime_seconds` is reported as an integer count of seconds since the lifespan startup function returned (i.e. since the app began accepting connections).

Alternatives considered: lazy load on first transcription (removed — turns the first user request into a 5–30 s cold start); model pool per endpoint (removed — no benefit because faster-whisper holds the GIL during inference anyway and the operator's workload is single-flight); background-thread load with a `status="starting"` state (removed — adds race-condition complexity without solving a real problem for a single-user deployment).

### Resolve the active model via MODEL_DIR override and MODEL_NAME registry lookup

The active CTranslate2 model directory is resolved at startup using two environment variables with a defined precedence:

1. If `MODEL_DIR` is set to a non-empty value, the server SHALL pass that path directly to `WhisperModel(MODEL_DIR, ...)`. The registry is not consulted. This is the **ad-hoc / advanced override path** for running against an unregistered local model directory (for example during conversion experiments).
2. Otherwise, the server SHALL read `MODEL_NAME`, look it up in `registry/models.yaml`, and pass the entry's resolved `local_dir` to `WhisperModel`. This is the **default registry-driven path** that `make set-model MODEL=<name>` and `make download-model MODEL=<name>` work against. If `MODEL_NAME` is unset OR set to the empty string, it SHALL fall back to the hard-coded default `"breeze-asr-25"` (declared as a constant in `app/config.py`); this matches the `.env.example` ship value and keeps fresh installs working without manual configuration.
3. If `MODEL_NAME` (after applying the fallback above) does not exist in the registry, OR the resolved `local_dir` does not contain a CT2 `model.bin` plus tokenizer per the `model-management` "installed" definition, the server SHALL exit with a clear error naming the missing input (registry entry name / directory path). Note: it is impossible for *both* `MODEL_DIR` and `MODEL_NAME` to be "unset" by the time resolution runs, because `MODEL_NAME` has the hard-coded fallback above.

`make set-model` only ever touches `MODEL_NAME`. `MODEL_DIR` is intentionally not modified by tooling — it is operator-controlled. This separation keeps the registry as the single source of truth for "named models" while still allowing one-off paths.

### Embed a sliding-window streaming wrapper instead of depending on an upstream `whisper-streaming` package

v2.0 SHALL ship its own small streaming wrapper in `app/services/stream.py` (~150 LOC) rather than depending on the upstream `whisper-streaming` (ufal/whisper_streaming) project. The wrapper SHALL:

- Accept binary PCM frames over WebSocket, normalise them to `float32` mono at 16 kHz internally (input wire format defined in the `transcribe-stream` capability), and maintain a rolling buffer.
- Use a simple energy-based or `silero-vad` Voice Activity Detection check (whichever is already a transitive dependency of `faster-whisper`; do not add a new dep just for VAD) to detect silence-driven endpoints.
- Re-run the shared `WhisperModel.transcribe(...)` over the rolling buffer every ~500 ms with `beam_size=1` for the partial pass and the configured `beam_size` for the final pass, emitting `partial` and `final` events with millisecond timestamps relative to the WebSocket connection start.

Reasoning: the upstream `whisper-streaming` repository is not currently distributed as a versioned wheel on PyPI under that exact name, so depending on it would either require a git pin or vendoring. Embedding the small subset we actually need keeps the dependency graph clean and lets the implementation align tightly with the WS protocol contract documented in the `transcribe-stream` capability.

Alternative considered: vendor `ufal/whisper_streaming` directly. Rejected because the upstream code includes adapters for other ASR engines and protocol shapes that would add dead code; the embedded variant is small enough to maintain.

### Document `whisper-streaming` + Breeze ASR 25 compatibility spike before committing the protocol contract

Before locking the `WS /listen` partial/final cadence and timestamp accounting, run a one-off spike: feed a 30-second Taiwanese Mandarin sample through the embedded wrapper against Breeze ASR 25 CT2 and confirm (a) partial transcripts converge to the final transcript without runaway revisions, and (b) median partial latency stays under 1 s on the operator's Mac mini. Record findings in this design document as an addendum (or update the affected scenarios). The spike is task-tracked separately so it gates Phase 3 / `WS /listen` work.

#### Spike status (apply phase, 2026-05-13)

Verified during the apply phase:

- **Model availability**: Breeze ASR 25 CT2 published at
  `shdennlin/breeze-asr-25-ct2` with subfolder `int8_float16` (1.5 GB). The
  upstream README confirms this is the recommended sweet-spot quantisation
  for Mac CPU and GPU deployments.
- **Mac CPU compute_type caveat**: `compute_type="int8_float16"` raises
  `ValueError` on Apple Silicon CPU because the storage format does NOT map
  1:1 to a CPU compute path. Resolution: default `COMPUTE_TYPE=default` in
  `.env.example` so CT2 auto-picks the runtime path; the registry's
  `compute_type` field is metadata only. Documented in `.env.example`,
  `docs/INSTALLATION.md`, and `docs/TROUBLESHOOTING.md`.
- **Embedded streaming wrapper**: `app/services/stream.py` implements the
  sliding-window VAD wrapper as designed (RMS-energy threshold, 500 ms
  partial cadence, 700 ms silence endpointing, 30 s buffer cap with single
  warning on overflow). Audio-time timestamping (not wall-clock) keeps
  timestamps deterministic across utterances per the spec scenarios.
  `tests/test_listen.py` (15 cases) exercises the partial→final lifecycle,
  multi-utterance monotonic timestamps, disconnect handling, frame-size
  guards, and backpressure.

Deferred to first real hardware run on the operator's Mac mini (manual,
non-blocking for the v2 server merge):

- **Median partial latency under 1 s** — measured during integration testing
  with the actual 16 kHz mono Taiwanese sample; the unit tests confirm
  protocol conformance but cannot measure model inference wall time on the
  target device.
- **Partial→final convergence** on Breeze ASR 25 specifically — assessed by
  running `make dev` and streaming a recorded sample through `WS /listen`.

If the deferred measurements show the latency target is not met on Mac mini,
the cadence knobs (`PARTIAL_INTERVAL_MS`, `SILENCE_DURATION_MS`) in
`app/services/stream.py` are the first lever to tune; the `WS /listen` spec
contract intentionally leaves these as implementation details.

### Unify `POST /transcribe-raw` into `POST /transcribe` via Content-Type dispatch

Inside the `POST /transcribe` handler, branch on the request `Content-Type`:

- `multipart/form-data` → read the `file` field from the form (existing behaviour).
- `audio/*` or `application/octet-stream` → read `await request.body()` as the entire audio payload (former `/transcribe-raw` behaviour).
- Anything else → respond `415 Unsupported Media Type`.

The optional `language` query parameter applies to both shapes. This collapses two routes into one without breaking iOS Shortcut clients, which only need their URL updated from `/transcribe-raw` to `/transcribe`. Documented as a BREAKING change in the proposal because the old route is deleted, not aliased.

Alternative considered: keep both routes and let `/transcribe-raw` forward to `/transcribe`. Rejected because preserving the alias contradicts the goal of shrinking the surface area, and the operator only has a single Shortcut to update.

### Add `WS /listen` with timestamped partial and final events

WebSocket endpoint accepts 16 kHz mono PCM as binary frames (chunks of ~250 ms preferred) and emits JSON text frames in two shapes:

```
{"type":"partial","text":"...","start_ms":1234,"end_ms":2345}
{"type":"final","text":"...","start_ms":1234,"end_ms":3456}
```

`start_ms` / `end_ms` are measured relative to stream start. Both `partial` and `final` events carry timestamps so the PWA can render a time-aligned caption track. Endpointing relies on the embedded wrapper's Voice Activity Detection plus sliding-window re-transcription (see the "Embed a sliding-window streaming wrapper …" decision above for the wrapper specification); target latencies are ~500–800 ms partial cadence on Mac mini and ~400–500 ms on the GPU host. On client disconnect, the handler discards any in-flight buffer without emitting a `final`.

Alternatives considered: emit only `final` with timestamps and keep `partial` as text-only — rejected because the operator confirmed timestamps on partials are useful (live caption alignment). Server-Sent Events instead of WebSocket — rejected because the audio direction is client-to-server, which SSE cannot carry.

### Add `POST /ask` with audio/text input and optional SSE streaming

`POST /ask` accepts the same Content-Types as `/transcribe`, plus `application/json` with a `{"text": "..."}` body to bypass STT. The handler resolves the transcript (either from STT or from the JSON body), composes a prompt using the configured system prompt, calls the Gemini model via `google-genai`, and returns `{"transcript": ..., "answer": ...}`. When `?stream=true` is set, respond with `Content-Type: text/event-stream` and emit, in order:

1. `event: transcript` with `data: {"text": "<transcript-string>"}` for audio inputs, or `data: {"text": null}` for the JSON text-input path.
2. Zero or more `event: token` events with `data: {"text": "<delta>"}` JSON payloads, one per Gemini token batch (zero in the rare empty-completion case — see the `ask` capability's "Streaming with empty LLM response" scenario).
3. A single terminating event: `event: done` with `{"finish_reason": ...}` carrying Gemini's stop reason on success, OR `event: error` with `{"error": "..."}` if a failure occurs after streaming has started. STT failures before the LLM call bypass the leading `transcript` event and emit a single `event: error` directly.

The system prompt is configured via `GEMINI_SYSTEM_PROMPT` (single string in `.env`). Default in `.env.example` is a short Taiwan-friendly assistant persona. Errors from Gemini surface as HTTP `502 Bad Gateway` (blocking) or as a final `event: error` (streaming).

Alternatives considered: split into `/ask` (audio) and `/ask-text` (text) — rejected to keep the endpoint surface small; the JSON branch is trivial. WebSocket for `/ask` — rejected because the data flow is one-shot in, streamed out; SSE matches that shape.

### Replace `GET /health` with `GET /status`

New schema:

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

`status` is always `"ok"` for any reachable `/status` response — see the eager-load decision above for why no `"starting"` state exists in v2.0. `gemini.configured` reflects whether `GEMINI_API_KEY` is set. The richer schema lets the operator distinguish the Mac mini deployment from the GPU host at a glance. `GET /health` is removed entirely (BREAKING).

Alternative considered: keep `/health` as a minimal `{"status":"ok"}` for load balancers and add `/status` separately — rejected because there is no load balancer in this deployment and two endpoints multiply documentation without value.

### Reshape `registry/models.yaml` for CTranslate2 directories

New entry schema:

```yaml
models:
  breeze-asr-25:
    default: true
    repo_id: shdennlin/breeze-asr-25-ct2
    format: ct2
    compute_type: int8_float16
    local_dir: models/breeze-asr-25-ct2-int8_float16
    size: "~800MB"
    languages: [zh-TW, en]
    description: "MediaTek Breeze ASR 25 — Taiwanese Mandarin + English code-switching"
  large-v3-turbo:
    repo_id: Systran/faster-whisper-large-v3-turbo
    format: ct2
    compute_type: int8_float16
    local_dir: models/faster-whisper-large-v3-turbo
    size: "~800MB"
    languages: [multilingual]
    description: "OpenAI Whisper large-v3-turbo (CTranslate2)"
```

Required fields: `repo_id`, `format` (only `"ct2"` accepted in v2.0; the field is a reserved discriminator so future GGML or Core ML re-entries are possible), `compute_type`, `local_dir`, `size`, `languages`, `description`. Optional fields: `subfolder` (string, sub-path inside a multi-quantisation Hugging Face repository; downloaded files SHALL be flattened into `local_dir`), `revision` (string, commit SHA / branch / tag for reproducible pins). Exactly one entry SHALL have `default: true` — the loader rejects a registry with zero or multiple default entries, matching the `model-registry` capability's "Registry missing a default" and "Registry with multiple defaults" scenarios. Entries with any `format` other than `"ct2"` are rejected with a clear per-entry error; the loader does not crash the process. The old GGML schema fields (`url`, `filename`) are removed.

Alternative considered: keep both GGML and CT2 entries side by side — rejected because v2.0 deletes the GGML loader entirely, so any GGML entry would be unloadable.

### Rewrite `scripts/model-manager.sh` to drive `huggingface-cli`

Old script (~13 KB) parsed the GGML registry and downloaded single files via curl. New script (~3–4 KB) keeps the same subcommands (`list`, `download <name>`, `download-default`, `set <name>`, `delete <name>`) but:

- `download` invokes `huggingface-cli download <repo_id> --local-dir <local_dir>`.
- `set` updates `MODEL_NAME` in `.env` (the FastAPI server reads this on next start).
- `delete` removes `<local_dir>` and optionally prunes the Hugging Face cache (`huggingface-cli cache scan` + manual rm; do not silently delete the HF cache root).

The `Makefile` targets that call this script keep their names. The standalone `./whisper-wrap` CLI shim has already been removed in the pre-v2 cleanup commit, so the user-visible entry points are `make ...` only.

Alternative considered: rewrite in Python — rejected because the script is short, bash is sufficient, and the project's other scripts are already bash.

### Bump to v2.0.0 with a migration note in CHANGELOG

This is a BREAKING change for any external consumer of the API or `.env`. `CHANGELOG.md` gains a `## [2.0.0]` section listing removed endpoints, renamed endpoint, removed env vars, added env vars, and the `registry/models.yaml` schema change. README and CLAUDE.md are updated in lockstep.

## Implementation Contract

**Behavior delivered**

1. A single FastAPI process serves all endpoints. After `make dev` starts, `pgrep -af whisper-server` returns no matches and `lsof -i :9000` returns no listener.
2. `POST /transcribe` returns `{"transcript": "..."}` for both `multipart/form-data` uploads and raw `audio/*` bodies. The optional `language` and `prompt` query parameters are forwarded to the underlying model.
3. `WS /listen` accepts binary PCM frames (`pcm_s16le`, 16 kHz mono, recommended ~250 ms frames) and emits one or more `partial` events followed by a `final` event per utterance, each carrying `start_ms` and `end_ms`. A single connection MAY produce multiple utterances back-to-back; closing the socket mid-utterance does not emit a `final` for the in-flight utterance.
4. `POST /ask` returns `{"transcript": ..., "answer": "..."}` for any supported input mode (`transcript` is a string for audio inputs, `null` for `application/json {"text": ...}` inputs). `POST /ask?stream=true` returns `text/event-stream` whose every `data:` line is a single JSON document; the event sequence is one `transcript`, then zero or more `token` events (zero only on the empty-LLM-response edge case), then terminating `done` on success or terminating `error` on failure. The configured system prompt is loaded from `GEMINI_SYSTEM_PROMPT` at startup; missing values fall back to a baked-in default persona.
5. `GET /status` returns the schema documented in the Decisions section. `status` is always `"ok"` once the endpoint is reachable, because `WhisperModel` load completes synchronously during lifespan startup and the app does not accept connections until then. `model.loaded` is always `true` for the same reason; the field is preserved in the response so external consumers have a stable shape. The version is sourced from `whisper_wrap.__version__` (a constant declared in `app/__init__.py`).
6. `make models` shows every entry in `registry/models.yaml` with its installation state (directory present and contains a CT2 `model.bin` plus at least one tokenizer file) and marks the active one. `make set-model MODEL=breeze-asr-25` updates `.env` and a restart picks up the change. `make download-model MODEL=large-v3-turbo` downloads the CT2 directory under `models/` via `huggingface-cli`.
7. `make docker` produces an image without the `whisper.cpp` build stage and finishes in under five minutes on a typical developer laptop.
8. `GET /` returns a JSON document listing all registered endpoints with their HTTP verb and a one-line description, replacing the v1 discovery payload.

**Interfaces / data shapes**

- Endpoint URLs and response shapes are defined in the Decisions section and the new spec files (`ask`, `transcribe-stream`, `status`, modified `inference-params`).
- Environment variables added: `MODEL_NAME` (registry key, default `breeze-asr-25`), `MODEL_DIR` (optional override; if set, bypasses `MODEL_NAME` lookup), `COMPUTE_TYPE` (default `int8_float16`), `DEVICE` (default `auto`), `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`), `GEMINI_SYSTEM_PROMPT` (default: baked-in Taiwan-friendly assistant persona, overridable per `.env.example`).
- Environment variables removed (must not appear in `.env.example`; the v2 startup code SHALL scan `os.environ` directly for them solely to emit a one-line WARNING per detected obsolete key, without surfacing them as config attributes): `WHISPER_SERVER_HOST`, `WHISPER_SERVER_PORT`, `WHISPER_SERVER_URL`, `WHISPER_AUTO_RESTART`, `WHISPER_BINARY_PATH`, `WHISPER_MAX_RETRIES`, `MODEL_PATH`.
- `WS /listen` wire format: binary frames containing little-endian signed 16-bit integer PCM (`pcm_s16le`) at 16 kHz mono. Each frame SHOULD contain 250 ms (4 000 samples = 8 000 bytes at `pcm_s16le`) of audio; the server MUST accept frames in the inclusive range `[200 bytes, 64 KiB]` and reject anything outside that range with a `{"type":"error","message":"frame size out of range"}` text frame followed by a WebSocket close code `1003` (Unsupported Data). PCM-to-float conversion is performed server-side.

**Failure modes**

- Missing or unreadable model directory on startup → process exits with a clear error message naming the missing path. The "missing" determination follows the `MODEL_DIR` / `MODEL_NAME` precedence in the Decisions section.
- `compute_type` not supported on the current device (for example `float16` on a CPU-only host) → process exits with the CT2 error verbatim plus a hint to switch to `int8_float16`.
- `MODEL_NAME` set but absent from `registry/models.yaml`, or registry entry's `local_dir` missing → process exits naming both the variable and the missing entry/directory.
- Obsolete env var detected (any of the seven removed names) → server logs a WARNING naming the variable and proceeds; no startup failure.
- WebSocket client sends a non-binary frame, or a binary frame outside the accepted size range → server responds with a JSON error text frame and closes with code `1003`.
- WebSocket client streams faster than ASR can consume → server drops oldest buffered audio after a configurable cap (default 30 s of buffered PCM), emits a single text frame `{"type":"warning","message":"buffer overflow, oldest audio dropped"}`, and continues. This applies backpressure without dropping the connection.
- Gemini API returns an error → blocking `/ask` becomes `502 Bad Gateway` with a JSON `{"error":"..."}` body; streaming `/ask` emits a final `event: error` then closes. The same path applies if `GEMINI_API_KEY` is missing at startup.
- STT fails before the LLM call in streaming `/ask` (audio input) → server emits `event: error` with `{"error":"transcription failed: ..."}` and closes, without emitting the leading `transcript` event.
- Unknown `Content-Type` on `POST /transcribe` or `POST /ask` (audio mode) → `415 Unsupported Media Type`.
- `POST /ask` with `Content-Type: application/json` and a missing/empty/invalid body → `400 Bad Request` with `{"error":"<reason>"}`. Specifically: missing `text` field → `"missing field 'text'"`; empty `text` → `"field 'text' must be non-empty"`; malformed JSON → `"invalid JSON: <parser message>"`.
- `POST /ask` or `POST /transcribe` multipart with no `file` part → `400 Bad Request` with `{"error":"missing form field 'file'"}`.
- `POST /ask` or `POST /transcribe` raw body of zero bytes → `400 Bad Request` with `{"error":"empty audio body"}`.

**Threat model and deployment boundary**

`whisper-wrap` is designed for LAN-only or localhost deployment behind a trusted boundary (Tailscale, home network, Docker compose network). No authentication is built in. `GET /status` exposes the active model path, `compute_type`, and `device` — operators MUST place the service behind a reverse proxy or VPN before exposing it to the public internet. The CHANGELOG migration note and `docs/INSTALLATION.md` SHALL state this assumption explicitly. Adding bearer-token auth is an explicit v2.x non-goal recorded in §7 Open Questions for a possible future change.

**Acceptance criteria**

- Existing test suite passes after migration: all tests in `tests/test_api.py`, `tests/test_whisper.py`, and `tests/test_config.py` either continue to pass against the new backend or are rewritten with equivalent assertions; new tests `tests/test_ask.py` and `tests/test_listen.py` cover the new endpoints (audio + text + streaming for `/ask`; partial + final + disconnect for `/listen`).
- `make lint` and `make test` succeed.
- `curl -X POST -H 'Content-Type: audio/m4a' --data-binary @sample.m4a http://localhost:8000/transcribe` returns a transcript (raw-body branch).
- `curl -F 'file=@sample.m4a' http://localhost:8000/transcribe` returns a transcript (multipart branch).
- `wscat -c ws://localhost:8000/listen` followed by streaming PCM frames yields at least one `partial` event before the matching `final` event, and both carry `start_ms`/`end_ms`.
- `curl -X POST -H 'Content-Type: application/json' --data '{"text":"say hi"}' http://localhost:8000/ask` returns `{"transcript":null,"answer":"..."}`.
- `curl -N -X POST -H 'Content-Type: application/json' --data '{"text":"say hi"}' 'http://localhost:8000/ask?stream=true'` prints a `transcript` event, zero or more `token` events (typically one or more on the success path), then a `done` event.
- `curl http://localhost:8000/status` returns the schema with `status="ok"` and the active model details.
- Docker image build (`make docker`) completes in under five minutes on the project maintainer's hardware and the resulting container starts the FastAPI process without spawning a child.

**Scope boundaries**

- In scope: everything listed in this contract plus the documentation updates in `docs/API.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`, and the Apple Shortcut template + screenshot refresh.
- Out of scope: the PWA front-end (separate `add-pwa-frontend` change); publishing Breeze ASR 25 to Hugging Face (separate `publish-breeze-asr-25-models` change); switching the Mac mini to WhisperKit (deferred v2.1 escape hatch via future `BACKEND_TYPE` env var); a `/cleanup` endpoint for transcript polishing (parked prompts in `docs/future-prompts/transcript-cleanup.md`).

## Risks / Trade-offs

- **Streaming quality regression on Mac mini under load** → if Slack/IDE/browser saturate the M-series cores during a `/listen` session, partial latency may drift above 1 s. Mitigation: log per-utterance latency, document the v2.1 WhisperKit escape hatch in `docs/PRD-roadmap.md §7`.
- **Breeze ASR 25 CT2 conversion not yet on Hugging Face** → the spec assumes the Breeze CT2 repository exists at `shdennlin/breeze-asr-25-ct2`. Mitigation: the parallel `publish-breeze-asr-25-models` change is responsible for uploading. If it slips, the v2.0 release SHALL ship with a coordinated triple-flip — change the hard-coded `MODEL_NAME` default constant in `app/config.py` to `"large-v3-turbo"`, set `default: true` on the `large-v3-turbo` registry entry instead of `breeze-asr-25`, and update `.env.example` accordingly — so the active model resolution remains consistent across all three sources. Flip back to `breeze-asr-25` in a v2.0.1 once the upload completes. Either way, the resolution rule itself ("MODEL_NAME unset → use the hard-coded default; that default must be a registry entry marked `default: true`") stays unchanged.
- **The embedded streaming wrapper may not handle Breeze fine-tune edge cases on the spike** → if the pre-implementation spike (task 0.1) shows runaway partial revisions or partial latency above the contract target, the fallback is to vendor `ufal/whisper_streaming` rather than ship the embedded wrapper. Marked as a contingency that branches in the design only if the spike fails.
- **Gemini free tier rate limits** → `gemini-2.5-flash` free tier caps the daily request count. Mitigation: surface 429 errors verbatim; the operator already plans to keep this a personal-use deployment.
- **Migration friction for the operator's own deployments** → `.env` and `registry/models.yaml` both change. Mitigation: write a `Migration` section in `CHANGELOG.md` showing before/after for both files, and add a startup check that names removed env vars if they are still present (warn, do not fail).
- **Two-process auto-restart logic disappears** → previously, a crashed `whisper-server` was restarted; now any crash takes the whole FastAPI process down. Mitigation: rely on the deployment supervisor (`systemd` on Mac mini, `docker compose restart: unless-stopped` on PVE) to bring it back; document in `docs/TROUBLESHOOTING.md`.

## Migration Plan

0. **Compatibility spike (before any production code change)**: run the embedded streaming wrapper against a 30 s Taiwanese Mandarin Breeze ASR 25 sample on the Mac mini. Confirm partial→final convergence and median partial latency < 1 s. Document the result in this file (or replace this bullet with a link to the recorded notes). If the spike fails, return to Decisions and pick between (a) loosening latency targets in the `transcribe-stream` spec, or (b) vendoring upstream `ufal/whisper_streaming`.
1. Land the `publish-breeze-asr-25-models` change first or in parallel so that the CT2 model is on Hugging Face by the time this server change finalises.
2. On a feature branch, perform the refactor in this order: (a) add `faster-whisper` and the new env vars; (b) rewrite `app/services/whisper.py` and load the model at lifespan with the `MODEL_DIR`/`MODEL_NAME` precedence; (c) merge `/transcribe-raw` into `/transcribe` and update existing tests; (d) ship `GET /status` and the refreshed `GET /` discovery payload; (e) add `/ask` with the JSON-only SSE protocol; (f) add `WS /listen` with the embedded streaming wrapper; (g) rewrite `scripts/model-manager.sh` and update `Makefile`; (h) strip `whisper.cpp` submodule, `whisper_manager.py`, and the old Dockerfile build stage; (i) update docs, Apple Shortcut, and deployment supervisor configs (systemd unit, `docker-compose.yml restart: unless-stopped`).
3. Update CHANGELOG with a `## [2.0.0]` section that includes a `### Migration` subsection: removed endpoints (`/transcribe-raw`, `/health`), renamed/expanded endpoint (`/health` → `/status`), removed env vars (with a callout that the server emits one-line warnings for residual values rather than failing startup), added env vars, registry schema before/after with side-by-side YAML, the dropped built-in registry entries (`large-v3-turbo-q8`, `large-v3`, `medium`, `base`) and the equivalent CT2 entries users can re-add by hand, and the LAN-only deployment assumption.
4. Tag and release. Mac mini and PVE deployments each pull the new image, update `.env`, and verify `GET /status` returns `status="ok"`, `model.loaded=true`, the correct `device`, and the version constant. Operators MUST also confirm the deployment supervisor restart policy is in place (`systemctl status whisper-wrap` on Mac mini, `docker compose ps` on PVE with `restart: unless-stopped`).
5. Rollback strategy: this is a breaking change, so rollback is "redeploy the previous tag and restore the previous `.env` and `registry/models.yaml`". No in-place forward/back compatibility is attempted.

## Open Questions

- Should `large-v3-turbo` remain in the registry as a maintained fallback, or be removed once `breeze-asr-25` is fully published? (Default decision in this proposal: keep it.)
- Should the `BACKEND_TYPE` env var be introduced now (with a single implementation) so that the v2.1 WhisperKit escape hatch is easier to add later, or wait until it is actually needed? (Default decision: wait.)
- When the GitHub release is cut, should the tag be pinned to a specific commit of the Hugging Face CT2 repo for reproducibility, or float on whatever is current? (Decide during the release pass.)
