## Why

whisper-wrap currently hardcodes a single model (`ggml-large-v3-turbo-q8_0.bin`) and relies on whisper.cpp cloned as a sibling directory (`../whisper.cpp`). Users who want to use different models — particularly MediaTek Breeze ASR 25 for Traditional Chinese + English code-switching — must manually download, convert, and configure everything. The project should support easy model switching to unlock different ASR capabilities without code changes.

## What Changes

- **Git submodule**: Move whisper.cpp from a sibling directory clone (`../whisper.cpp`) to a git submodule at `./whisper.cpp`, pinned to a release tag for stability
- **Model storage**: Add a project-level `models/` directory (`.gitignore`'d) for downloaded GGML model files, replacing the model path inside whisper.cpp
- **Model registry**: Add `registry/models.yaml` — a version-controlled catalog mapping friendly model names to download URLs, sizes, language support, and descriptions
- **Model management CLI**: Add Makefile targets (`models`, `download-model`, `set-model`, `delete-model`) backed by `scripts/model-manager.sh` for downloading, listing, switching, and removing models
- **Configuration**: Add `MODEL_NAME` and `MODEL_PATH` to `.env` configuration; whisper-server launch uses `MODEL_PATH` instead of a hardcoded filename
- **Convenience CLI**: Add a `whisper-wrap` shell script at project root as a simple command wrapper around Makefile targets
- **Docker updates**: Support `MODEL_NAME` as a build arg, use models volume for persistence, reference submodule instead of cloning
- **Health endpoint**: Include active model name in `/health` response

## Capabilities

### New Capabilities

- `model-registry`: A YAML-based catalog of available ASR models with metadata (URL, size, languages, description) that users can extend with custom entries
- `model-management`: CLI commands for downloading, listing, activating, and deleting GGML models, supporting both registry lookups and direct URL downloads

### Modified Capabilities

(none — no existing specs)

## Impact

- Affected code: `app/config.py` (new MODEL_NAME/MODEL_PATH fields), `app/main.py` (startup logging), `app/api/transcribe.py` (no changes needed — model is transparent to API layer)
- Affected infra: `Makefile` (new targets, updated paths), `Dockerfile` (submodule + build arg), `docker-compose.yml` (model volume), `.gitmodules` (new)
- New files: `registry/models.yaml`, `scripts/model-manager.sh`, `whisper-wrap` CLI script, `.env.example`
- Dependencies: No new Python dependencies. Shell script uses `curl` for downloads (already available).
- **BREAKING**: `WHISPER_DIR` changes from `../whisper.cpp` to `./whisper.cpp`. Existing setups need to re-run `make setup`.
