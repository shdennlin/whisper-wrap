## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Server warns about obsolete v1 environment variables

**Reason**: The v1-era environment-variable warning shim was a transitional courtesy for users migrating from v1 to v2. v2 has not been released externally, so no externally-installed v1 instance exists to migrate from. Retaining the warning code adds ongoing maintenance with no remaining audience.

**Migration**: None required. The seven v1 variables (`WHISPER_SERVER_HOST`, `WHISPER_SERVER_PORT`, `WHISPER_SERVER_URL`, `WHISPER_AUTO_RESTART`, `WHISPER_BINARY_PATH`, `WHISPER_MAX_RETRIES`, `MODEL_PATH`) remain absent from `app/config.py`'s typed model and are silently ignored if still present in `os.environ`. Users who carry these from local notes SHALL remove them from `.env` at their convenience; the server SHALL NOT acknowledge them.

#### Scenario: Obsolete WHISPER_SERVER_URL is silently ignored

- **WHEN** a v2.1 server starts with `WHISPER_SERVER_URL=http://localhost:9000` still present in the environment but `MODEL_NAME=breeze-asr-25` correctly set
- **THEN** the server SHALL start successfully and SHALL NOT emit any log line referencing `WHISPER_SERVER_URL`

#### Scenario: Multiple obsolete variables are silently ignored

- **WHEN** a v2.1 server starts with both `MODEL_PATH=./old.bin` and `WHISPER_AUTO_RESTART=true` still in the environment
- **THEN** the server SHALL start successfully without emitting warnings about either variable
