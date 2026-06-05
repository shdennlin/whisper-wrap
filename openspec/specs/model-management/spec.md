# model-management Specification

## Purpose

TBD - created by archiving change 'multi-model-support'. Update Purpose after archive.

## Requirements

### Requirement: List models command

The system SHALL provide a `make models` command that displays all registry models. For each model entry, the output SHALL show the model name, total size (sum across installed variants), description, and active status. The output SHALL list every variant of each model on a separate sub-line showing the variant's `format`, format-specific identifier (`compute_type` for ct2; `quant` for ggml), and install status per variant.

A variant is considered **installed** when:

- `format: ct2`: the variant's `local_dir` exists AND contains both a `model.bin` file and at least one tokenizer file (`tokenizer.json` OR `vocabulary.json`).
- `format: ggml`: the variant's `local_dir` exists AND contains the file named by the variant's `filename` field AND the directory named by the variant's `coreml_encoder` field.

The active model (the one matching `MODEL_NAME` in `.env`) SHALL be visually distinguished. The active variant within the active model (resolved from `BACKEND_FORMAT` or platform `default_on`) SHALL also be visually distinguished within that model's variant list.

#### Scenario: List with mixed install states across variants

- **WHEN** the user runs `make models` with `breeze-asr-25` having its ggml variant installed but not its ct2 variant, and `large-v3-turbo` not installed at all
- **THEN** the output SHALL show each model's variants individually, marking the ggml variant of `breeze-asr-25` as installed and the others as not installed, and SHALL mark `breeze-asr-25` as the active model plus its ggml variant as the active variant (on a darwin host)

##### Example: shipped registry listed on macOS with one variant installed

| Model | Variant | Installed | Active |
| ----- | ------- | --------- | ------ |
| breeze-asr-25 | ggml (q6_k) | yes | ★ active |
| breeze-asr-25 | ct2 (int8_float16) | no | — |
| large-v3-turbo | ct2 (int8_float16) | no | — |

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - Makefile
  - scripts/model-manager.sh
tests:
  - tests/test_model_manager.py
-->


<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Download model by name

The system SHALL provide a `make download-model MODEL=<name>` command that looks up the model name in `registry/models.yaml` and downloads **every variant** declared on that entry. For each variant, the command SHALL invoke `huggingface-cli download <variant.repo_id> --local-dir <variant.local_dir>` (applying `--revision` and `--include "<subfolder>/*"` when those optional fields are present). Variants are downloaded sequentially; the command SHALL emit a per-variant heading naming the variant being fetched, and SHALL show download progress per variant.

If any single variant download fails, the command SHALL exit non-zero with an error naming the failing variant; previously successful variants in the same invocation SHALL remain installed on disk so the user MAY retry only the failing variant by re-running the command (already-installed variants SHALL be skipped per the "already installed" scenario below).

#### Scenario: Download all variants of a model

- **WHEN** the user runs `make download-model MODEL=breeze-asr-25` and the entry declares both a ct2 and a ggml variant
- **THEN** the system SHALL fetch each variant's artefacts into its own `local_dir` (the ct2 directory under `models/breeze-asr-25-ct2`, the ggml `.bin` plus `.mlmodelc` under `models/breeze-asr-25-ggml`)
- **THEN** the system SHALL emit per-variant headings and SHALL display download progress while each variant transfers

#### Scenario: Download skips already-installed variants

- **WHEN** the user runs `make download-model MODEL=<name>` for an entry whose ggml variant is already installed but whose ct2 variant is not
- **THEN** the system SHALL inform the user the ggml variant is already installed and SHALL skip it, then SHALL proceed to download the ct2 variant

#### Scenario: Partial download is treated as not installed

- **WHEN** the user runs `make download-model MODEL=<name>` for a ct2 variant whose `local_dir` contains a `model.bin` but no tokenizer file (a partial or corrupted prior download)
- **THEN** the system SHALL NOT mark the variant installed and SHALL re-run the download to fill in the missing tokenizer (relying on `huggingface-cli`'s built-in resume behaviour)

#### Scenario: One variant fails mid-download

- **WHEN** the user runs `make download-model MODEL=<name>` for an entry with two variants, the first variant downloads successfully, and the second variant download fails (e.g. network error)
- **THEN** the system SHALL exit non-zero with an error naming the failing variant; the first variant's installed artefacts SHALL remain on disk so re-running the command resumes with the failing variant only

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - Makefile
  - scripts/model-manager.sh
tests:
  - tests/test_model_manager.py
-->


<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Set active model

The system SHALL provide a `make set-model MODEL=<name>` command that updates `MODEL_NAME` in the `.env` file. The command SHALL verify that the model is present in `registry/models.yaml` and that **at least one variant** of the model is installed (per the per-variant installed definition in "List models command") before updating `.env`. The command SHALL NOT modify `BACKEND_FORMAT`; backend selection between installed variants is controlled by the lifespan rules in the `whisper-backend` capability. The server process SHALL read the new `MODEL_NAME` value on the next start; live reload is not required.

#### Scenario: Set a model with at least one installed variant

- **WHEN** the user runs `make set-model MODEL=breeze-asr-25` and the entry's ggml variant is installed (ct2 variant may be missing)
- **THEN** the system SHALL update `.env` so that `MODEL_NAME=breeze-asr-25`

#### Scenario: Set a model with no installed variants

- **WHEN** the user runs `make set-model MODEL=<name>` and none of the entry's variants are installed
- **THEN** the system SHALL refuse to update `.env` and SHALL display an error suggesting `make download-model MODEL=<name>` first

#### Scenario: set-model does not touch BACKEND_FORMAT

- **WHEN** the user runs `make set-model MODEL=large-v3-turbo` while `BACKEND_FORMAT=ggml` is set in `.env`
- **THEN** the system SHALL update `MODEL_NAME=large-v3-turbo` but SHALL NOT modify `BACKEND_FORMAT`; the lifespan will surface the resulting variant-resolution error at startup if the active model lacks a ggml variant

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - Makefile
  - scripts/model-manager.sh
tests:
  - tests/test_model_manager.py
-->


<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Delete model

The system SHALL provide a `make delete-model MODEL=<name>` command that removes **all variant `local_dir` directories** for the named model from disk. The command SHALL refuse to delete a model whose name matches the currently active `MODEL_NAME` (regardless of which variant is installed).

#### Scenario: Delete a non-active model removes all variants

- **WHEN** the user runs `make delete-model MODEL=large-v3-turbo` and that entry has one ct2 variant installed
- **THEN** the system SHALL recursively remove the ct2 variant's `local_dir` and SHALL confirm deletion

#### Scenario: Delete a non-active model with multiple installed variants

- **WHEN** the user runs `make delete-model MODEL=<name>` for a non-active entry whose ct2 and ggml variants are both installed
- **THEN** the system SHALL recursively remove both variants' `local_dir` directories and SHALL confirm each removal individually

#### Scenario: Attempt to delete the active model

- **WHEN** the user runs `make delete-model MODEL=<name>` for the model currently named in `.env`'s `MODEL_NAME`
- **THEN** the system SHALL refuse and SHALL instruct the user to switch models first via `make set-model MODEL=<other-name>`

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - Makefile
  - scripts/model-manager.sh
tests:
  - tests/test_model_manager.py
-->


<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Models directory

The system SHALL store downloaded CTranslate2 model directories under a `./models/` directory at the project root. Each model SHALL occupy its own subdirectory matching the `local_dir` from `registry/models.yaml`. The `models/` directory SHALL be listed in `.gitignore` and SHALL contain a `.gitkeep` file so the empty directory is preserved in version control.

#### Scenario: Models directory exists after clone

- **WHEN** the project is freshly cloned
- **THEN** a `models/` directory SHALL exist via `.gitkeep` and SHALL be otherwise empty

<!-- @trace
source: multi-model-support
updated: 2026-03-10
code:
  - registry/models.yaml
  - Makefile
  - scripts/model-manager.sh
  - app/config.py
  - .env.example
tests:
  - tests/test_config.py
-->


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
### Requirement: Active model is resolved from MODEL_DIR override or MODEL_NAME registry lookup

The server SHALL resolve the active CTranslate2 model directory at startup using two environment variables with a defined precedence:

1. If `MODEL_DIR` is set to a non-empty value, the server SHALL pass that exact path to `WhisperModel(MODEL_DIR, ...)`. The registry is not consulted in this branch. This is the **ad-hoc override path** for running against an unregistered local model directory (for example during conversion experiments).
2. Otherwise, the server SHALL read `MODEL_NAME`, look it up in `registry/models.yaml`, and pass the entry's resolved `local_dir` to `WhisperModel`. This is the **default registry-driven path** that `make set-model MODEL=<name>` operates against. If `MODEL_NAME` is unset OR set to the empty string, the server SHALL fall back to the hard-coded default `"breeze-asr-25"` (declared as a constant in `app/config.py`).
3. If `MODEL_NAME` (after the hard-coded fallback above) is not present in the registry, or the resolved directory does not satisfy the "installed" definition (contains `model.bin` plus at least one tokenizer file), the server SHALL exit at startup with a clear error naming the offending input (registry entry name or directory path).

`make set-model MODEL=<name>` SHALL only update `MODEL_NAME` in `.env`; it SHALL NOT modify `MODEL_DIR`. `MODEL_DIR` is intentionally not modified by tooling — it is operator-controlled. This separation keeps the registry as the single source of truth for "named models" while still allowing one-off paths.

#### Scenario: MODEL_DIR override path

- **WHEN** the server is started with `MODEL_DIR=/tmp/my-experiment-model` (an existing CT2 directory) and `MODEL_NAME=breeze-asr-25`
- **THEN** the server SHALL load `/tmp/my-experiment-model` and SHALL NOT touch the `breeze-asr-25` registry entry

#### Scenario: MODEL_NAME registry path

- **WHEN** the server is started with `MODEL_DIR` unset and `MODEL_NAME=breeze-asr-25`, and the registry's `breeze-asr-25` entry's `local_dir` exists with a `model.bin`
- **THEN** the server SHALL load the directory resolved from that registry entry

#### Scenario: Neither variable set (fallback to default)

- **WHEN** the server is started with both `MODEL_DIR` and `MODEL_NAME` unset in the environment
- **THEN** the server SHALL fall back to `MODEL_NAME="breeze-asr-25"` (the hard-coded default) and SHALL load the resolved registry entry, failing only if that entry's `local_dir` is not installed
- **THEN** if the default `breeze-asr-25` entry's `local_dir` is also missing (for example a fresh checkout where `make setup` has not been run), the server SHALL exit at startup with a clear error directing the user to run `make download-model MODEL=breeze-asr-25` first


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