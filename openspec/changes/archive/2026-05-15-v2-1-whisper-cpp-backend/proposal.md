## Why

v2 with CTranslate2 + CPU achieves only ~1× real-time on Apple Silicon, making `WS /listen` partial latency 3–5 seconds with heavy text loss — the realtime captioning feature is effectively unusable on the primary deployment target (a personal Mac mini). VoiceInk on identical hardware reaches 5–7× real-time using Apple ANE via Core ML, so the bottleneck is the backend choice, not a fundamental conflict between realtime and Apple Silicon. CTranslate2 cannot use Metal/Core ML/MLX (upstream issue is two years old with no progress), so we swap in `pywhispercpp` to unlock ANE acceleration while preserving the existing CT2 path for future Linux/CUDA deployment.

## What Changes

- Add a `pywhispercpp`-based Whisper backend (in-process binding to `libwhisper`) that loads a ggml-format model plus its Core ML encoder so transcription routes through Apple ANE on macOS. Targets ≥3× partial-latency improvement vs v2 on the same hardware.
- Introduce a `WhisperBackend` Protocol in `app/services/_whisper_backend.py` with a stable async interface (`transcribe`, `transcribe_pcm`, plus `WhisperLoadError` / `WhisperTranscriptionError` types). Both the existing CT2 implementation (renamed/refactored from current `app/services/whisper.py`) and the new pywhispercpp implementation conform to it.
- **BREAKING** `registry/models.yaml` schema changes from a single-format-per-entry layout to a `variants` list per model. Each model entry SHALL contain one or more variants; each variant SHALL declare `format` (`ct2` | `ggml`), backend-specific fields (`compute_type` for ct2; `quant` and Core ML encoder reference for ggml), `local_dir`, optional `repo_id` / `revision` / `subfolder`, and `default_on` (list of platform tags from `darwin` / `linux`) used for platform-aware default selection. No migration is provided because v2 has not been released externally.
- Add platform-aware variant resolution in `app/services/registry.py`: given `MODEL_NAME`, pick the variant whose `default_on` matches the current platform; explicit `BACKEND_FORMAT` env var overrides the auto choice; `MODEL_DIR` continues to bypass registry lookup entirely. Default selection rule: `darwin` → ggml variant, `linux` → ct2 variant.
- Update `app/main.py` lifespan to instantiate either backend based on the resolved variant's `format`, surface the chosen backend in `/status`, and block startup until the model finishes loading (including any first-run Core ML encoder compile).
- Add a new ggml model entry for Breeze ASR 25 with `q6_k` quantisation as the default ggml variant, including the bundled Core ML encoder folder (`ggml-breeze-asr-25-encoder.mlmodelc`). Keep the existing ct2 variant intact.
- Extend `scripts/model-manager.sh` so `make download-model MODEL=<name>` understands variant entries: it downloads every variant declared for the model (`format: ct2` directory + `format: ggml` `.bin` + `.mlmodelc` folder) and the existing `make set-model` / `make delete-model` commands operate on the full model (all variants) rather than a single format.
- Add `pywhispercpp` to `pyproject.toml` as a platform-conditional dependency (`pywhispercpp; sys_platform == "darwin"`) so Linux installs are unaffected; document the macOS Core ML build flag in `docs/INSTALLATION.md`.
- **Phase 2** of the same change: add a partial-consensus filter (simplified LocalAgreement-2) to `app/services/stream.py` so emitted `partial` events stabilise — a partial text segment SHALL only be emitted when the same prefix is produced by two consecutive sliding-window inferences. Targets ≤50% of v2's partial-rewrite frequency on the same captured audio.
- Remove v1-deprecated environment variable warning code in `app/config.py` (the warning was for users migrating from v1, which never shipped externally either).
- Update `.env.example`, `README.md`, `CLAUDE.md`, and `docs/INSTALLATION.md` to document the new backend, registry schema, and platform-aware defaults.

## Capabilities

### New Capabilities

- `whisper-backend`: Pluggable in-process Whisper backend abstraction. Defines the `WhisperBackend` Protocol surface (async transcribe/transcribe_pcm + standardised error types) and platform-aware backend selection rules used by the FastAPI lifespan. Covers both the CTranslate2 implementation (Linux default; macOS fallback) and the pywhispercpp implementation (macOS default; Linux unavailable).

### Modified Capabilities

- `model-registry`: Schema gains a required `variants` list per model entry; each variant declares its `format` discriminator and format-specific fields. Variant-level `default_on` controls per-platform default selection. Removes the previous single-format flat schema.
- `model-management`: `make download-model` SHALL fetch every variant of the requested model. `make set-model` / `make delete-model` SHALL operate on the full model (all variants). `make models` SHALL show installed status per variant alongside the active variant.
- `transcribe-stream`: Server SHALL apply a partial-consensus filter before emitting `partial` events so a `partial` segment is only emitted after two consecutive sliding-window inferences produce the same prefix. Connection lifecycle, final emission, and timestamp semantics are unchanged.

## Impact

- Affected specs: new `whisper-backend`; modified `model-registry`, `model-management`, `transcribe-stream`.
- Affected code:
  - New: `app/services/_whisper_backend.py`, `app/services/whisper_cpp.py`, `app/services/whisper_ct2.py`, `tests/test_whisper_cpp.py`, `tests/test_backend_protocol.py`, `tests/test_registry_variants.py`, `tests/test_stream_consensus.py`
  - Modified: `app/services/whisper.py`, `app/services/registry.py`, `app/services/stream.py`, `app/main.py`, `app/api/status.py`, `app/config.py`, `registry/models.yaml`, `scripts/model-manager.sh`, `pyproject.toml`, `.env.example`, `README.md`, `CLAUDE.md`, `docs/INSTALLATION.md`
  - Removed: deprecated v1 env-var warning lines inside `app/config.py`
- Affected env vars:
  - Added: `BACKEND_FORMAT` (optional override: `ct2` | `ggml`; defaults to platform-resolved variant)
  - Unchanged: `MODEL_NAME`, `MODEL_DIR`, `COMPUTE_TYPE`, `DEVICE`, `GEMINI_*`
- Operational impact: macOS `WS /listen` partial latency drops to <1s (target; measured against v2 baseline on same hardware); Linux behaviour unchanged (still ct2). New dependency `pywhispercpp` is macOS-only. First model load includes a one-time Core ML encoder compile that lifespan SHALL block on with a startup log line; subsequent loads use the cached `.mlmodelc` directory.
