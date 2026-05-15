## MODIFIED Requirements

### Requirement: Registry file format

The system SHALL maintain a model registry at `registry/models.yaml` containing a `models` mapping where each key is a kebab-case model identifier and each value is an entry describing a CTranslate2 model. Each entry SHALL contain the required fields `repo_id` (string, Hugging Face repository identifier), `format` (string, the only accepted value in v2.0 is `"ct2"`; the field is a reserved discriminator so future formats may be added without breaking the schema), `compute_type` (string, e.g. `"int8_float16"`), `local_dir` (string, path relative to the project root indicating where the downloaded directory lives), `size` (string, human-readable approximate size), `languages` (list of strings), and `description` (string). Each entry MAY also include the optional fields `subfolder` (string, sub-path inside the Hugging Face repository when the repository publishes multiple quantisations side by side) and `revision` (string, commit SHA, branch name, or tag for reproducibility pins; resolved by `huggingface-cli download --revision <value>`). Exactly one entry SHALL have `default: true`; the loader SHALL reject a registry that has zero entries marked default or more than one entry marked default, since `make setup` depends on a unique default to know what to download for a fresh install.

#### Scenario: Valid registry file

- **WHEN** the registry file is parsed at server start or by a `make models / download-model / set-model / delete-model` invocation
- **THEN** each model entry SHALL contain all required fields (`repo_id`, `format`, `compute_type`, `local_dir`, `size`, `languages`, `description`) and the loader SHALL emit a clear error naming the offending entry and missing field if any field is absent

#### Scenario: Default model designation

- **WHEN** `make setup` runs the initial model download step
- **THEN** the entry with `default: true` in the registry SHALL be downloaded into its `local_dir`

#### Scenario: Registry missing a default

- **WHEN** the registry file is parsed and no entry has `default: true`
- **THEN** the loader SHALL emit an error stating "registry must have exactly one entry with default: true" and SHALL refuse to proceed

#### Scenario: Registry with multiple defaults

- **WHEN** the registry file is parsed and two or more entries have `default: true`
- **THEN** the loader SHALL emit an error naming each offending entry and SHALL refuse to proceed

#### Scenario: Unknown format value

- **WHEN** an entry has `format: ggml` (or any value other than `"ct2"`)
- **THEN** the loader SHALL reject the entry with a clear error naming the unsupported format value and SHALL NOT crash the process; other valid entries SHALL still parse successfully

#### Scenario: Optional subfolder field

- **WHEN** an entry includes `subfolder: int8_float16` pointing at a sub-path inside a multi-quantisation Hugging Face repository
- **THEN** `make download-model` SHALL invoke `huggingface-cli download <repo_id> --local-dir <local_dir> --include "<subfolder>/*"` so only that sub-tree is fetched, and the downloaded files SHALL be **flattened** into `<local_dir>` (i.e. the leading `<subfolder>/` path component is stripped during materialisation, either via `huggingface-cli`'s flag or via a post-download move step in `scripts/model-manager.sh`). This guarantees the "installed" check (`<local_dir>/model.bin` plus a tokenizer file) and the `WhisperModel(<local_dir>)` constructor both work without needing to know whether a subfolder was used.

#### Scenario: Optional revision field

- **WHEN** an entry includes `revision: abc123def4` for reproducibility
- **THEN** `make download-model` SHALL invoke `huggingface-cli download <repo_id> --revision abc123def4 --local-dir <local_dir>` so the downloaded files match that commit

<!-- @trace
source: multi-model-support
updated: 2026-03-10
code:
  - registry/models.yaml
  - scripts/model-manager.sh
  - app/config.py
  - .env.example
tests:
  - tests/test_config.py
-->

### Requirement: Registry is user-extensible

Users SHALL be able to add custom model entries to `registry/models.yaml` by appending a new block with a unique kebab-case identifier and all required fields. The model management commands SHALL recognise custom entries identically to built-in entries.

#### Scenario: User adds custom model entry

- **WHEN** a user adds a new entry to `registry/models.yaml` with all required CT2 fields
- **THEN** `make models` SHALL display the custom entry alongside built-in models
- **THEN** `make download-model MODEL=<custom-name>` SHALL download the CTranslate2 model directory using `huggingface-cli` and the entry's `repo_id`

<!-- @trace
source: multi-model-support
updated: 2026-03-10
code:
  - registry/models.yaml
  - scripts/model-manager.sh
  - app/config.py
  - .env.example
tests:
  - tests/test_config.py
-->

### Requirement: Built-in model entries

The shipped `registry/models.yaml` SHALL contain exactly two built-in entries in v2.0: `breeze-asr-25` (marked `default: true`; MediaTek Breeze ASR 25 in CTranslate2 `int8_float16` form, optimised for Taiwanese Mandarin plus English code-switching) and `large-v3-turbo` (the multilingual fallback; OpenAI Whisper large-v3-turbo in CTranslate2 form, published by `Systran/faster-whisper-large-v3-turbo`). Each built-in entry SHALL include a valid `repo_id` pointing to a publicly accessible Hugging Face repository. The v1 GGML-only built-in entries (`large-v3-turbo-q8`, `large-v3`, `medium`, `base`, and the v1 GGML `breeze-asr-25` entry pointing at `alan314159/Breeze-ASR-25-whispercpp`) SHALL NOT appear in the v2.0 shipped registry; the REMOVED Requirements section of this delta documents that change.

#### Scenario: Initial registry contents

- **WHEN** the project is freshly cloned at v2.0 or later
- **THEN** `registry/models.yaml` SHALL contain exactly two entries — `breeze-asr-25` marked `default: true` and `large-v3-turbo` — both with valid CT2 fields

<!-- @trace
source: multi-model-support
updated: 2026-03-10
code:
  - registry/models.yaml
  - scripts/model-manager.sh
  - app/config.py
  - .env.example
tests:
  - tests/test_config.py
-->

## REMOVED Requirements

### Requirement: GGML-based built-in registry entries

**Reason**: The v1 built-in entries (`large-v3-turbo-q8`, `large-v3`, `medium`, `base`, and the GGML `breeze-asr-25`) all pointed at single-file GGML downloads served by `whisper.cpp`'s release page or `alan314159/Breeze-ASR-25-whispercpp`. v2.0 deletes the GGML loader entirely, so leaving those entries in the shipped registry would produce dead pointers and confusing error messages on first use.

**Migration**: Users who previously relied on any of these entries SHALL add an equivalent CT2 entry to their own `registry/models.yaml` after upgrading. Suggested replacements: `Systran/faster-whisper-medium` for `medium`, `Systran/faster-whisper-large-v3` for `large-v3`, `Systran/faster-whisper-base` for `base`. The new shipped registry contains the active default (`breeze-asr-25` in CT2 form) and the multilingual fallback (`large-v3-turbo` in CT2 form); these cover the operator's actual deployments.

#### Scenario: v1 entry name is no longer recognised

- **WHEN** a user upgrades from v1 to v2.0 and runs `make download-model MODEL=large-v3-turbo-q8` against the freshly shipped `registry/models.yaml`
- **THEN** the command SHALL fail with `error: unknown model 'large-v3-turbo-q8'` and SHALL list the available v2.0 entries (`breeze-asr-25`, `large-v3-turbo`) so the user knows what to add manually if they want the old behaviour
