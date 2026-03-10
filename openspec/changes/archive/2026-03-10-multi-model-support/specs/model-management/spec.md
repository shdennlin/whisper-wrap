## ADDED Requirements

### Requirement: List models command

The system SHALL provide a `make models` command that displays all registry models with their name, size, description, installation status (installed/not installed), and active status. The active model SHALL be visually distinguished.

#### Scenario: List with mixed install states

- **WHEN** the user runs `make models` with some models downloaded and one active
- **THEN** the output SHALL show each model's install status and mark the active model

### Requirement: Download model by name

The system SHALL provide a `make download-model MODEL=<name>` command that looks up the model name in the registry and downloads the file to the `models/` directory using `curl`. The download SHALL show progress indication.

#### Scenario: Download a registered model

- **WHEN** the user runs `make download-model MODEL=breeze-asr-25`
- **THEN** the system SHALL download the file from the registry URL to `models/<filename>`
- **THEN** the system SHALL display download progress

#### Scenario: Download already installed model

- **WHEN** the user runs `make download-model MODEL=<name>` for an already downloaded model
- **THEN** the system SHALL inform the user the model is already installed and skip the download

### Requirement: Download model by URL

The system SHALL support downloading models by direct URL when the `MODEL` parameter is a URL (starts with `http://` or `https://`). The filename SHALL be derived from the URL.

#### Scenario: Download from direct URL

- **WHEN** the user runs `make download-model MODEL=https://example.com/ggml-custom.bin`
- **THEN** the system SHALL download the file to `models/ggml-custom.bin`

### Requirement: Set active model

The system SHALL provide a `make set-model MODEL=<name>` command that updates `MODEL_NAME` and `MODEL_PATH` in the `.env` file. The command SHALL verify the model file exists before updating.

#### Scenario: Set an installed model as active

- **WHEN** the user runs `make set-model MODEL=breeze-asr-25` and the model file exists
- **THEN** the system SHALL update `.env` with the correct `MODEL_NAME` and `MODEL_PATH`

#### Scenario: Set a model that is not downloaded

- **WHEN** the user runs `make set-model MODEL=<name>` and the model file does not exist
- **THEN** the system SHALL display an error suggesting to download the model first

### Requirement: Delete model

The system SHALL provide a `make delete-model MODEL=<name>` command that removes the model file from `models/`. The command SHALL refuse to delete the currently active model.

#### Scenario: Delete an inactive model

- **WHEN** the user runs `make delete-model MODEL=<name>` for a non-active model
- **THEN** the system SHALL remove the model file and confirm deletion

#### Scenario: Attempt to delete the active model

- **WHEN** the user runs `make delete-model MODEL=<name>` for the currently active model
- **THEN** the system SHALL refuse and instruct the user to switch models first

### Requirement: Model path configuration

The system SHALL read `MODEL_PATH` from the `.env` file to determine which model file whisper-server uses. The `MODEL_PATH` SHALL default to `./models/ggml-large-v3-turbo-q8_0.bin` when not set.

#### Scenario: Whisper-server uses configured model

- **WHEN** the whisper-server starts via `make dev` or `make run-whisper`
- **THEN** whisper-server SHALL be launched with the `-m` flag pointing to the value of `MODEL_PATH`

### Requirement: Health endpoint includes model info

The `GET /health` endpoint SHALL include the active model name in its response body.

#### Scenario: Health check with model info

- **WHEN** a client requests `GET /health`
- **THEN** the response SHALL include a `model` field with the value of `MODEL_NAME`

### Requirement: Convenience CLI wrapper

The system SHALL provide an executable `whisper-wrap` script at the project root that delegates to Makefile targets, supporting commands: `setup`, `start`, `models`, `download <name>`, `use <name>`, `delete <name>`, `build`, `test`, and `help`.

#### Scenario: CLI wrapper delegates to Makefile

- **WHEN** the user runs `./whisper-wrap models`
- **THEN** the system SHALL execute `make models`

### Requirement: Whisper.cpp as git submodule

The project SHALL include whisper.cpp as a git submodule at `./whisper.cpp`, pinned to a release tag. `make setup` SHALL initialize the submodule automatically.

#### Scenario: Fresh clone setup

- **WHEN** a user runs `git clone --recursive` followed by `make setup`
- **THEN** the whisper.cpp submodule SHALL be initialized at `./whisper.cpp` at the pinned release tag

### Requirement: Models directory

The system SHALL store downloaded models in a `./models/` directory at the project root. This directory SHALL be listed in `.gitignore` with a `.gitkeep` file to preserve the empty directory in version control.

#### Scenario: Models directory exists after clone

- **WHEN** the project is freshly cloned
- **THEN** a `models/` directory SHALL exist (via `.gitkeep`)
