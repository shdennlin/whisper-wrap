## Context

whisper-wrap is a FastAPI wrapper that proxies audio transcription requests to a whisper.cpp server. Currently:

- whisper.cpp is cloned as a sibling directory (`../whisper.cpp`) and not version-controlled within the project
- A single model (`ggml-large-v3-turbo-q8_0.bin`) is hardcoded in the Makefile and Dockerfile
- Users cannot switch models without manual file management and config editing
- The project lacks a model discovery/download mechanism

Stakeholders: developers self-hosting whisper-wrap, particularly those needing Traditional Chinese (Taiwanese Mandarin) support via Breeze ASR 25.

## Goals / Non-Goals

**Goals:**

- Make the project fully self-contained via git submodule
- Enable easy model discovery, download, and switching via CLI
- Maintain backward compatibility for existing users (default model unchanged)
- Keep the architecture simple — whisper.cpp remains the sole inference backend

**Non-Goals:**

- Supporting non-whisper.cpp backends (e.g., HuggingFace Transformers in-process)
- Automatic model format conversion (HF → GGML)
- GPU acceleration in Docker containers
- Model quantization tooling
- Web UI for model management

## Decisions

### Submodule over sibling clone

Use git submodule pinned to a whisper.cpp release tag instead of cloning to `../whisper.cpp`.

**Rationale**: A submodule makes the project self-contained (`git clone --recursive` gets everything), pins to a known-good version, and is standard practice for C++ dependencies. Pinning to a release tag (not master) prevents breaking changes.

**Alternative considered**: Git subtree — merges whisper.cpp history into the repo, making it harder to update and bloating the repository.

### YAML registry over script-based download

Use a `registry/models.yaml` file as the model catalog instead of extending whisper.cpp's `download-ggml-model.sh`.

**Rationale**: A declarative YAML file is easier for users to extend (add a block, done), version-control friendly, and decouples model metadata from download logic. The shell script (`model-manager.sh`) reads the registry and handles downloads uniformly — one mechanism for all models.

**Alternative considered**: Embedding model URLs in the Makefile — harder to maintain, not user-extensible.

### Shell script over Python for model management

Implement `scripts/model-manager.sh` in bash rather than Python.

**Rationale**: Model management (download, list, set env var) is inherently a shell task — it calls `curl`, reads YAML, updates `.env`. Bash avoids requiring the Python venv to be active for model operations. The YAML structure is flat enough for grep/awk parsing without `yq`.

**Alternative considered**: Python CLI with `click` — adds a dependency and requires venv activation for basic model operations.

### Project-level models directory

Store models in `./models/` at the project root instead of inside the whisper.cpp submodule.

**Rationale**: Submodule directories get reset on `git submodule update`. A project-level directory survives submodule updates, is easy to `.gitignore`, and makes the model path explicit in configuration.

### Environment-based model selection

Configure the active model via `MODEL_PATH` in `.env` rather than a separate config file or CLI state.

**Rationale**: Consistent with the existing configuration pattern (all config in `.env`). `make set-model` updates `.env` automatically, so users don't edit it manually. The Makefile and whisper-server launch command both read from the same source.

## Risks / Trade-offs

- **[YAML parsing in bash]** → Parse with grep/awk; the schema is flat (no nesting beyond one level). If parsing becomes complex, migrate to a Python helper script.
- **[Submodule complexity for new users]** → Document `git clone --recursive` prominently. Add a check in `make setup` that initializes the submodule if missing.
- **[Breaking change: WHISPER_DIR path]** → Existing users' `../whisper.cpp` directory is not removed. `make setup` documentation clearly states the migration. Old directory can be manually cleaned up.
- **[Large model downloads]** → Show progress bar via `curl --progress-bar`. No retry logic initially — users can re-run `make download-model`.
- **[Registry staleness]** → URLs point to HuggingFace `resolve/main/` which is stable. Community can PR new model entries.
