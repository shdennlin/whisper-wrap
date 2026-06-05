## ADDED Requirements

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

### Requirement: Server warns about obsolete v1 environment variables

The server SHALL detect the seven v1-era environment variables that are removed in v2.0 (`WHISPER_SERVER_HOST`, `WHISPER_SERVER_PORT`, `WHISPER_SERVER_URL`, `WHISPER_AUTO_RESTART`, `WHISPER_BINARY_PATH`, `WHISPER_MAX_RETRIES`, `MODEL_PATH`) by scanning `os.environ` directly at startup, and SHALL emit one WARNING-level log line per detected obsolete variable naming the variable and pointing to the migration note in CHANGELOG. The server SHALL NOT surface those variables as config attributes (they are intentionally absent from `app/config.py`'s typed model). Detection of obsolete variables SHALL NOT block startup; missing required v2 variables SHALL block startup per the standard config validation.

#### Scenario: Obsolete WHISPER_SERVER_URL is detected

- **WHEN** a v2.0 server starts with `WHISPER_SERVER_URL=http://localhost:9000` still present in the environment but `MODEL_NAME=breeze-asr-25` correctly set
- **THEN** the server SHALL emit a single WARNING log line naming `WHISPER_SERVER_URL` and SHALL start successfully

#### Scenario: Multiple obsolete variables produce multiple warnings

- **WHEN** a v2.0 server starts with both `MODEL_PATH=./old.bin` and `WHISPER_AUTO_RESTART=true` still in the environment
- **THEN** the server SHALL emit one WARNING line per detected variable (two warnings total) and SHALL start successfully

## MODIFIED Requirements

### Requirement: List models command

The system SHALL provide a `make models` command that displays all registry models with their name, size, description, installation status, and active status. A model is considered **installed** when its registry entry's `local_dir` directory exists AND contains both a `model.bin` file and at least one tokenizer file (`tokenizer.json` OR `vocabulary.json`); this definition is the single source of truth used by `list`, `download`, `set`, and `delete`. The active model (the one matching the `MODEL_NAME` value in `.env`) SHALL be visually distinguished.

#### Scenario: List with mixed install states

- **WHEN** the user runs `make models` with some CTranslate2 model directories present under `models/` and one model marked active in `.env`
- **THEN** the output SHALL show each model's install status and SHALL mark the active model with a visual distinction

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

### Requirement: Download model by name

The system SHALL provide a `make download-model MODEL=<name>` command that looks up the model name in `registry/models.yaml`, resolves the entry's `repo_id` and `local_dir`, and downloads the CTranslate2 model directory using `huggingface-cli download`. The download SHALL show progress indication.

#### Scenario: Download a registered CT2 model

- **WHEN** the user runs `make download-model MODEL=breeze-asr-25`
- **THEN** the system SHALL invoke `huggingface-cli download <repo_id> --local-dir <local_dir>` for that entry, populating the target directory with the CTranslate2 artefacts
- **THEN** the system SHALL display download progress while the transfer runs

#### Scenario: Download an already installed model

- **WHEN** the user runs `make download-model MODEL=<name>` for an entry whose `local_dir` already exists and satisfies the **installed** definition (contains `model.bin` AND at least one of `tokenizer.json` / `vocabulary.json`)
- **THEN** the system SHALL inform the user the model is already installed and SHALL skip the download

#### Scenario: Partial download is treated as not installed

- **WHEN** the user runs `make download-model MODEL=<name>` for an entry whose `local_dir` contains a `model.bin` but no tokenizer file (a partial or corrupted prior download)
- **THEN** the system SHALL NOT mark the entry installed and SHALL re-run the download to fill in the missing tokenizer (relying on `huggingface-cli`'s built-in resume behaviour)

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

### Requirement: Set active model

The system SHALL provide a `make set-model MODEL=<name>` command that updates `MODEL_NAME` in the `.env` file. The command SHALL verify that the model is present in `registry/models.yaml` and that its `local_dir` exists before updating `.env`. The server process SHALL read the new value on the next start; live reload is not required.

#### Scenario: Set an installed model as active

- **WHEN** the user runs `make set-model MODEL=breeze-asr-25` and the entry's `local_dir` exists with model artefacts
- **THEN** the system SHALL update `.env` so that `MODEL_NAME=breeze-asr-25`

#### Scenario: Set a model that is not downloaded

- **WHEN** the user runs `make set-model MODEL=<name>` and the entry's `local_dir` does not exist
- **THEN** the system SHALL refuse to update `.env` and SHALL display an error suggesting `make download-model MODEL=<name>` first

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

### Requirement: Delete model

The system SHALL provide a `make delete-model MODEL=<name>` command that removes the CTranslate2 model directory at `local_dir` from disk. The command SHALL refuse to delete the currently active model.

#### Scenario: Delete an inactive model

- **WHEN** the user runs `make delete-model MODEL=<name>` for a non-active model whose `local_dir` exists
- **THEN** the system SHALL recursively remove the directory and SHALL confirm deletion

#### Scenario: Attempt to delete the active model

- **WHEN** the user runs `make delete-model MODEL=<name>` for the model currently named in `.env`'s `MODEL_NAME`
- **THEN** the system SHALL refuse and SHALL instruct the user to switch models first

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

## REMOVED Requirements

### Requirement: Download model by URL

**Reason**: CTranslate2 models are directory trees published as Hugging Face repositories, not single-file downloads. Downloading "by URL" no longer maps to a single artefact, so this convenience is removed in v2.0.

**Migration**: Add a custom entry to `registry/models.yaml` with the relevant `repo_id` and `local_dir`, then run `make download-model MODEL=<your-entry>`. For one-off downloads outside the registry, invoke `huggingface-cli download <repo_id> --local-dir models/<name>` directly.

#### Scenario: URL form rejected after upgrade

- **WHEN** a user runs `make download-model MODEL=https://example.com/model.bin` on a v2.0 install
- **THEN** the system SHALL NOT initiate a single-file download and SHALL emit an error directing the user to add a registry entry or call `huggingface-cli` directly

### Requirement: Model path configuration

**Reason**: The `MODEL_PATH` environment variable assumed a single GGML file. v2.0 resolves the active model from `MODEL_NAME` (an entry in `registry/models.yaml`) and uses the entry's `local_dir` as the CTranslate2 directory passed to `faster-whisper`.

**Migration**: Remove `MODEL_PATH` from `.env`. Ensure `MODEL_NAME` matches an entry in `registry/models.yaml` whose `local_dir` exists. The optional `MODEL_DIR` environment variable can override the resolved path when running ad-hoc against an unregistered local model directory. The runtime warn-on-detect behaviour for any leftover `MODEL_PATH` value is owned by the ADDED requirement "Server warns about obsolete v1 environment variables" (this REMOVED block intentionally does not re-state it to avoid divergence).

#### Scenario: Legacy MODEL_PATH is ignored

- **WHEN** a v2.0 server starts with `MODEL_PATH` still set in `.env` but `MODEL_NAME` pointing at a valid registry entry
- **THEN** the system SHALL load the model resolved from `MODEL_NAME` (per the ADDED requirement "Active model is resolved from MODEL_DIR override or MODEL_NAME registry lookup") and SHALL emit the deprecation warning per the ADDED requirement "Server warns about obsolete v1 environment variables"; the same warning contract covers all seven obsolete variables — see those two ADDED requirements for the authoritative behaviour

### Requirement: Health endpoint includes model info

**Reason**: `GET /health` is removed in v2.0 and replaced by `GET /status`, which carries a strictly richer payload (active model name, path, compute_type, device, load state, load time, Gemini configuration). See the `status` capability for the new contract.

**Migration**: Monitoring clients SHALL switch to `GET /status` and read `model.name` (and any other fields needed) from the structured response.

#### Scenario: Legacy health route is gone

- **WHEN** a client sends `GET /health` to a v2.0 server expecting the previous `{"status": "ok", "model": "..."}` shape
- **THEN** the system SHALL respond with HTTP 404; the model information is reachable only via `GET /status`

### Requirement: Convenience CLI wrapper

**Reason**: The `./whisper-wrap` shell script duplicated the Makefile interface with no extra functionality. It was removed during the pre-v2 cleanup commit.

**Migration**: Replace `./whisper-wrap <cmd>` invocations with the equivalent `make` target (`make models`, `make download-model MODEL=<name>`, `make set-model MODEL=<name>`, `make delete-model MODEL=<name>`).

#### Scenario: Wrapper script absent after upgrade

- **WHEN** a user upgrades to v2.0 and attempts to run `./whisper-wrap models`
- **THEN** the shell SHALL report `whisper-wrap: command not found` (or equivalent), because the script no longer exists in the repository; the equivalent `make models` invocation SHALL continue to work

### Requirement: Whisper.cpp as git submodule

**Reason**: v2.0 migrates inference from `whisper.cpp` to `faster-whisper` (CTranslate2). The `whisper.cpp` submodule is removed entirely along with its build steps in the Dockerfile and Makefile.

**Migration**: After upgrading to v2.0, run `git submodule deinit -f whisper.cpp` and remove the local `whisper.cpp` directory. No replacement submodule is required because `faster-whisper` is installed as a Python package.

#### Scenario: Submodule absent after upgrade

- **WHEN** a developer runs `git submodule status` on a v2.0 checkout
- **THEN** the output SHALL NOT include any line for `whisper.cpp`, and `.gitmodules` SHALL NOT contain a `whisper.cpp` entry
