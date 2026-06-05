## ADDED Requirements

### Requirement: Pluggable WhisperBackend Protocol

The system SHALL define a `WhisperBackend` Protocol in `app/services/_whisper_backend.py` that abstracts the in-process Whisper inference surface. The Protocol SHALL declare:

- An async method `transcribe(wav_path: str, *, language: str, initial_prompt: str | None) -> TranscriptionResult` that transcribes a WAV file on disk.
- An async method `transcribe_pcm(samples: np.ndarray, *, language: str) -> TranscriptionResult` that transcribes a raw float32 PCM array sampled at 16 kHz mono.
- A dataclass `TranscriptionResult` with fields `text: str`, `segments: list[Segment]`, `language: str`, `duration_seconds: float`. `Segment` SHALL declare `text: str`, `start: float`, `end: float`.
- Standardised exception types `WhisperLoadError` (raised during construction or model load) and `WhisperTranscriptionError` (raised during inference), both inheriting from a common `WhisperBackendError` base so callers can catch any backend error generically.

All callers that invoke Whisper inference (`app/api/transcribe.py`, `app/api/ask.py`, `app/services/stream.py`) SHALL depend only on the `WhisperBackend` Protocol surface and SHALL NOT import backend-specific implementation modules directly.

#### Scenario: Caller imports only the Protocol surface

- **WHEN** a developer reviews `app/api/transcribe.py` and `app/services/stream.py` after v2.1 lands
- **THEN** neither module SHALL import `app.services.whisper_ct2` nor `app.services.whisper_cpp` directly — both modules SHALL accept a `WhisperBackend` instance from `app.state.whisper` whose concrete type is determined at lifespan startup

#### Scenario: Standardised error type is raised on inference failure

- **WHEN** the active backend encounters an inference error
- **THEN** the backend SHALL raise `WhisperTranscriptionError` regardless of whether the underlying library raised a `RuntimeError` (CTranslate2) or a `pywhispercpp.WhisperError` (pywhispercpp)

### Requirement: CTranslate2 backend implementation

The system SHALL provide a `CTranslate2Backend` class in `app/services/whisper_ct2.py` that implements the `WhisperBackend` Protocol by wrapping `faster_whisper.WhisperModel`. The class SHALL:

- Accept constructor arguments `model_dir: str`, `compute_type: str`, `device: str`, plus runtime configuration carried from `app/config.py`.
- Run `WhisperModel.transcribe` calls inside `asyncio.to_thread` so the event loop is not blocked.
- Map `faster_whisper` exceptions to the standardised `WhisperLoadError` / `WhisperTranscriptionError` types from the Protocol module.

#### Scenario: Construction succeeds with a valid CT2 directory

- **WHEN** `CTranslate2Backend(model_dir="./models/breeze-asr-25-ct2", compute_type="int8_float16", device="auto")` is instantiated against a directory containing a valid CT2 `model.bin` plus tokenizer files
- **THEN** the constructor SHALL return without raising and the resulting instance SHALL satisfy the `WhisperBackend` Protocol

#### Scenario: Construction raises WhisperLoadError on missing model

- **WHEN** `CTranslate2Backend` is instantiated with `model_dir` pointing at a directory that lacks `model.bin`
- **THEN** the constructor SHALL raise `WhisperLoadError` with a message naming the missing file path

### Requirement: pywhispercpp backend implementation

The system SHALL provide a `PyWhisperCppBackend` class in `app/services/whisper_cpp.py` that implements the `WhisperBackend` Protocol by wrapping `pywhispercpp.model.Model`. The class SHALL:

- Accept constructor arguments `model_path: str` (path to the ggml `.bin` file), `coreml_encoder: str | None` (path to the `.mlmodelc` directory, or None to skip Core ML), `n_threads: int`, plus runtime configuration carried from `app/config.py`.
- Load the model with `use_coreml=True` whenever `coreml_encoder` is provided and the underlying library reports Core ML support; otherwise fall back to CPU-only ggml decode and emit a single WARNING log line naming the reason.
- Run `Model.transcribe` calls inside `asyncio.to_thread` so the event loop is not blocked.
- Map `pywhispercpp` exceptions to the standardised `WhisperLoadError` / `WhisperTranscriptionError` types from the Protocol module.
- Be importable only on macOS — on non-macOS platforms `import app.services.whisper_cpp` SHALL raise `WhisperLoadError("pywhispercpp is not available on <platform>")` (delegated through the conditional import in `pyproject.toml`).

#### Scenario: Construction succeeds with a valid ggml file plus Core ML encoder on macOS

- **WHEN** `PyWhisperCppBackend(model_path="./models/breeze-asr-25-ggml/ggml-breeze-asr-25-q6_k.bin", coreml_encoder="./models/breeze-asr-25-ggml/ggml-breeze-asr-25-encoder.mlmodelc", n_threads=4)` is instantiated on macOS
- **THEN** the constructor SHALL return without raising and the resulting instance SHALL satisfy the `WhisperBackend` Protocol

#### Scenario: Construction raises WhisperLoadError when Core ML encoder is missing on a ggml variant that requires it

- **WHEN** `PyWhisperCppBackend` is instantiated with `model_path` pointing at a valid ggml file but `coreml_encoder` pointing at a non-existent path
- **THEN** the constructor SHALL raise `WhisperLoadError` with a message naming the missing `.mlmodelc` path and suggesting `make download-model MODEL=<name>` to fetch the encoder

#### Scenario: Import on Linux raises WhisperLoadError

- **WHEN** `app.services.whisper_cpp` is imported on a Linux host where `pywhispercpp` is not installed (per platform marker in `pyproject.toml`)
- **THEN** the import SHALL raise `WhisperLoadError("pywhispercpp is not available on linux")` rather than a raw `ImportError`

### Requirement: Lifespan selects backend based on resolved variant format

The FastAPI lifespan (`app/main.py`) SHALL select and instantiate exactly one `WhisperBackend` per process at startup using the following precedence:

1. If `MODEL_DIR` is set, the lifespan SHALL inspect the directory layout and SHALL instantiate `CTranslate2Backend` when the directory matches the CT2 layout (contains `model.bin` plus tokenizer files) or `PyWhisperCppBackend` when the directory contains a `ggml-*.bin` file (Core ML encoder is detected automatically when an adjacent `.mlmodelc` directory is present).
2. Otherwise, the lifespan SHALL look up the active model in `registry/models.yaml` (per the `model-registry` capability), select the variant whose `default_on` list contains the current platform tag (`darwin` or `linux`), and instantiate the backend matching that variant's `format`. When `BACKEND_FORMAT` is set, the lifespan SHALL select the variant whose `format` matches the override instead of using `default_on`.

The lifespan SHALL store the resulting instance on `app.state.whisper` and SHALL block startup until the backend's model finishes loading (including any first-run Core ML encoder compile for pywhispercpp). The selected backend metadata SHALL be exposed via `/status` so operators can confirm which backend is active.

#### Scenario: macOS default config selects pywhispercpp via ggml variant

- **WHEN** the server starts on macOS with `MODEL_NAME=breeze-asr-25`, no `MODEL_DIR`, no `BACKEND_FORMAT` override, and the registry's `breeze-asr-25` entry has a ggml variant marked `default_on: [darwin]`
- **THEN** the lifespan SHALL instantiate `PyWhisperCppBackend` against that variant's `local_dir`, and `/status` SHALL report `backend: "pywhispercpp"`, `format: "ggml"`, and `quant: "q6_k"`

#### Scenario: Linux default config selects CTranslate2 via ct2 variant

- **WHEN** the server starts on Linux with `MODEL_NAME=breeze-asr-25`, no `MODEL_DIR`, no `BACKEND_FORMAT` override, and the registry's `breeze-asr-25` entry has a ct2 variant marked `default_on: [linux]`
- **THEN** the lifespan SHALL instantiate `CTranslate2Backend` against that variant's `local_dir`, and `/status` SHALL report `backend: "ctranslate2"`, `format: "ct2"`, and `compute_type: "int8_float16"`

#### Scenario: BACKEND_FORMAT override on macOS

- **WHEN** the server starts on macOS with `MODEL_NAME=breeze-asr-25` and `BACKEND_FORMAT=ct2`
- **THEN** the lifespan SHALL select the ct2 variant of `breeze-asr-25` even though `default_on: [darwin]` points at the ggml variant, and `/status` SHALL report `backend: "ctranslate2"`

#### Scenario: BACKEND_FORMAT=ggml on Linux fails startup

- **WHEN** the server starts on Linux with `MODEL_NAME=breeze-asr-25` and `BACKEND_FORMAT=ggml`
- **THEN** the lifespan SHALL fail to start with `WhisperLoadError("pywhispercpp is not available on linux")` and SHALL NOT attempt to serve any requests

#### Scenario: No variant matches the host platform

- **WHEN** the server starts with a registry entry whose variants list contains zero entries with `default_on` matching the current platform, and no `BACKEND_FORMAT` override is set
- **THEN** the lifespan SHALL fail to start with a clear error naming the model, the host platform, and suggesting `BACKEND_FORMAT=<format>` to choose explicitly

##### Example: variant resolution decision table

| Platform | MODEL_NAME | BACKEND_FORMAT | Variant chosen | Backend class |
| -------- | ---------- | -------------- | -------------- | ------------- |
| darwin   | breeze-asr-25 | (unset) | ggml (default_on: [darwin]) | PyWhisperCppBackend |
| darwin   | breeze-asr-25 | ct2 | ct2 | CTranslate2Backend |
| linux    | breeze-asr-25 | (unset) | ct2 (default_on: [linux]) | CTranslate2Backend |
| linux    | breeze-asr-25 | ggml | — | startup fails: WhisperLoadError |
| darwin   | model-with-only-ggml | (unset) | ggml | PyWhisperCppBackend |
| linux    | model-with-only-ggml | (unset) | — | startup fails: no matching variant |

### Requirement: /status surfaces backend metadata

`GET /status` SHALL include a `backend` object that names the active backend implementation and the underlying format-specific configuration. The object SHALL contain the fields:

- `backend`: string, one of `"pywhispercpp"` or `"ctranslate2"`.
- `format`: string, one of `"ct2"` or `"ggml"`.
- `compute_type`: string, present only when `format == "ct2"` (e.g. `"int8_float16"`).
- `quant`: string, present only when `format == "ggml"` (e.g. `"q6_k"`).
- `coreml_encoder_compiled`: boolean, present only when `format == "ggml"`. True after the lifespan's first-run compile completes; false if the encoder is missing or the backend fell back to CPU-only decode.

#### Scenario: /status reports pywhispercpp backend with Core ML active

- **WHEN** a client sends `GET /status` after the server started on macOS with the ggml variant selected and the Core ML encoder compiled successfully
- **THEN** the response SHALL include `"backend": {"backend": "pywhispercpp", "format": "ggml", "quant": "q6_k", "coreml_encoder_compiled": true}` alongside the existing `/status` fields

#### Scenario: /status reports CTranslate2 backend on Linux

- **WHEN** a client sends `GET /status` after the server started on Linux with the ct2 variant selected
- **THEN** the response SHALL include `"backend": {"backend": "ctranslate2", "format": "ct2", "compute_type": "int8_float16"}` alongside the existing `/status` fields and SHALL NOT include `quant` or `coreml_encoder_compiled`

### Requirement: First-run Core ML encoder compile blocks lifespan

When the active backend is `PyWhisperCppBackend` and the Core ML encoder `.mlmodelc` has not been compiled on the host before, the lifespan SHALL block startup until the compile completes. While compiling, the lifespan SHALL emit one INFO log line per second of elapsed wall-clock time naming the encoder path and the elapsed seconds. Upon completion, the lifespan SHALL emit one INFO log line reporting the total compile duration.

Subsequent server starts on the same host SHALL detect the cached compiled encoder and SHALL skip the compile, returning from the lifespan startup hook within the normal model-load time budget.

#### Scenario: First-run compile blocks until done

- **WHEN** the server starts on a host where the Core ML encoder has never been compiled before
- **THEN** the lifespan SHALL block startup, emit per-second progress log lines while the underlying runtime compiles the encoder, and only mark `/status` ready once the compile finishes

#### Scenario: Cached encoder skips compile

- **WHEN** the server starts on a host where the Core ML encoder was previously compiled in an earlier run
- **THEN** the lifespan SHALL detect the cache, SHALL NOT emit per-second compile progress, and SHALL reach ready state within the normal model-load time budget
