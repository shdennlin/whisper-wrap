## ADDED Requirements

### Requirement: Registry file format

The system SHALL maintain a model registry at `registry/models.yaml` containing a `models` mapping where each key is a kebab-case model identifier and each value contains the fields: `url` (string, required), `filename` (string, required), `size` (string, required), `languages` (list of strings, required), and `description` (string, required). One entry SHALL have `default: true` to indicate the model downloaded during initial setup.

#### Scenario: Valid registry file

- **WHEN** the registry file is read
- **THEN** each model entry SHALL contain all required fields (`url`, `filename`, `size`, `languages`, `description`)

#### Scenario: Default model designation

- **WHEN** `make setup` runs the model download step
- **THEN** the model with `default: true` in the registry SHALL be downloaded

### Requirement: Registry is user-extensible

Users SHALL be able to add custom model entries to `registry/models.yaml` by appending a new block with a unique model identifier and all required fields. The model management commands SHALL recognize custom entries identically to built-in entries.

#### Scenario: User adds custom model entry

- **WHEN** a user adds a new entry to `registry/models.yaml` with all required fields
- **THEN** `make models` SHALL display the custom entry alongside built-in models
- **THEN** `make download-model MODEL=<custom-name>` SHALL download the model from the specified URL

### Requirement: Built-in model entries

The registry SHALL ship with entries for at least: `large-v3-turbo`, `large-v3-turbo-q8`, `breeze-asr-25`, `large-v3`, `medium`, and `base`.

#### Scenario: Initial registry contents

- **WHEN** the project is freshly cloned
- **THEN** `registry/models.yaml` SHALL contain entries for all built-in models with valid download URLs
