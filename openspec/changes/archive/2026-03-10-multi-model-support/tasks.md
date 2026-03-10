## 1. Repository Structure — Submodule and Models Directory

- [x] 1.1 Add whisper.cpp as git submodule at `./whisper.cpp` pinned to a release tag (whisper.cpp as git submodule)
- [x] 1.2 [P] Create project-level models directory with `.gitkeep` and add `models/*.bin` to `.gitignore` (models directory)
- [x] 1.3 [P] Create `.env.example` with `MODEL_NAME`, `MODEL_PATH`, and all existing config variables

## 2. Model Registry

- [x] 2.1 [P] Create `registry/models.yaml` with built-in model entries for large-v3-turbo, large-v3-turbo-q8, breeze-asr-25, large-v3, medium, and base (registry file format, built-in model entries)
- [x] 2.2 Verify registry entries have all required fields and one model has `default: true` (registry file format)

## 3. Model Manager Script

- [x] 3.1 Create `scripts/model-manager.sh` with `list` command — parse registry YAML, show install/active status (list models command, YAML registry over script-based download)
- [x] 3.2 Add `download` command — support download model by name from registry and download model by URL (shell script over Python for model management)
- [x] 3.3 Add `set` command — update `.env` with MODEL_NAME/MODEL_PATH, verify model file exists (set active model)
- [x] 3.4 Add `delete` command — remove model file, refuse if active model (delete model)
- [x] 3.5 Handle registry is user-extensible — ensure custom entries are recognized by all commands

## 4. Makefile Updates

- [x] 4.1 Update `WHISPER_DIR` to `./whisper.cpp` and `WHISPER_CMD` to use `MODEL_PATH` (model path configuration, submodule over sibling clone)
- [x] 4.2 Add `init-submodule` target and update `setup` target sequence
- [x] 4.3 [P] Add model management targets: `models`, `download-model`, `set-model`, `delete-model`
- [x] 4.4 [P] Update `download-model` default target to download the registry default model

## 5. Application Configuration

- [x] 5.1 [P] Update `app/config.py` — add `MODEL_NAME` and `MODEL_PATH` fields with defaults, add `validate_model` method (model path configuration, environment-based model selection)
- [x] 5.2 [P] Update `app/main.py` — log active model name on startup
- [x] 5.3 [P] Update health endpoint to include model info in response (health endpoint includes model info)

## 6. Convenience CLI Wrapper

- [x] 6.1 [P] Create executable `whisper-wrap` script at project root with command delegation (convenience CLI wrapper)

## 7. Docker Updates

- [x] 7.1 Update `Dockerfile` — use submodule COPY, add `MODEL_NAME` build arg, use `MODEL_PATH` env var in startup script
- [x] 7.2 Update `docker-compose.yml` — add models volume, MODEL_NAME/MODEL_PATH environment variables

## 8. Testing and Documentation

- [x] 8.1 [P] Add tests for new config fields (`MODEL_NAME`, `MODEL_PATH`, `validate_model`)
- [x] 8.2 [P] Update `CLAUDE.md` with new model management workflow and commands
- [x] 8.3 Manually verify end-to-end: clone → setup → download breeze-asr-25 → set-model → dev
