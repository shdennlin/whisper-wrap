## MODIFIED Requirements

### Requirement: Registry file format

The system SHALL maintain a model registry at `registry/models.yaml` containing a `models` mapping where each key is a kebab-case model identifier and each value is an entry describing one logical model with one or more **variants** (backend-specific packagings of that model).

Each entry SHALL contain the required top-level fields `description` (string), `languages` (list of strings), and `variants` (non-empty list of variant maps). Each entry MAY also include the optional top-level fields `size` (string, human-readable approximate size; if present, applies to the model as a whole) and `default` (boolean, exactly one entry across the registry SHALL have `default: true`).

Each variant SHALL contain the required fields `format` (string, one of `"ct2"` or `"ggml"`) and `local_dir` (string, path relative to the project root indicating where the downloaded variant materialises). Format-specific required fields:

- `format: ct2` variants SHALL additionally declare `compute_type` (string, e.g. `"int8_float16"`).
- `format: ggml` variants SHALL additionally declare `quant` (string, e.g. `"q6_k"`), `filename` (string, the ggml `.bin` filename inside `local_dir`), and `coreml_encoder` (string, the `.mlmodelc` directory name inside `local_dir`).

Each variant MAY include the optional fields `repo_id` (string, Hugging Face repository identifier), `subfolder` (string, sub-path inside the Hugging Face repository when the repository publishes multiple variants side by side), `revision` (string, commit SHA, branch name, or tag for reproducibility pins), and `default_on` (list of platform tags from `darwin` / `linux`; controls per-platform default selection when `BACKEND_FORMAT` is not overriden).

The loader SHALL reject a registry that has zero entries marked `default: true` or more than one entry marked `default: true`, because `make setup` depends on a unique default to know what to download for a fresh install.

#### Scenario: Valid registry file with multi-variant entry

- **WHEN** the registry file is parsed at server start or by a `make models / download-model / set-model / delete-model` invocation
- **THEN** each model entry SHALL contain the required top-level fields (`description`, `languages`, `variants`) and each variant SHALL contain its required fields (`format`, `local_dir`, plus format-specific fields per the rules above); the loader SHALL emit a clear error naming the offending entry, variant index, and missing field if any required field is absent

##### Example: minimal valid registry with one model and two variants

```yaml
models:
  breeze-asr-25:
    description: "Breeze ASR 25 Taiwanese Mandarin"
    languages: [zh, en]
    default: true
    variants:
      - format: ct2
        repo_id: shdennlin/breeze-asr-25-ct2
        compute_type: int8_float16
        local_dir: breeze-asr-25-ct2
        default_on: [linux]
      - format: ggml
        repo_id: shdennlin/breeze-asr-25-ggml
        quant: q6_k
        filename: ggml-breeze-asr-25-q6_k.bin
        coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
        local_dir: breeze-asr-25-ggml
        default_on: [darwin]
```

#### Scenario: Default model designation

- **WHEN** `make setup` runs the initial model download step
- **THEN** the entry with `default: true` in the registry SHALL be downloaded into each of its variants' `local_dir` paths

#### Scenario: Registry missing a default

- **WHEN** the registry file is parsed and no entry has `default: true`
- **THEN** the loader SHALL emit an error stating `"registry must have exactly one entry with default: true"` and SHALL refuse to proceed

#### Scenario: Registry with multiple defaults

- **WHEN** the registry file is parsed and two or more entries have `default: true`
- **THEN** the loader SHALL emit an error naming each offending entry and SHALL refuse to proceed

#### Scenario: Unknown variant format value

- **WHEN** a variant has `format: mlx` (or any value other than `"ct2"` or `"ggml"`)
- **THEN** the loader SHALL reject the entry with a clear error naming the offending variant's index, parent model name, and the unsupported format value, and SHALL NOT crash the process; other valid entries SHALL still parse successfully

#### Scenario: Empty variants list

- **WHEN** a model entry contains `variants: []`
- **THEN** the loader SHALL emit an error stating `"model <name> SHALL declare at least one variant"` and SHALL refuse to proceed

#### Scenario: ct2 variant missing compute_type

- **WHEN** a variant declares `format: ct2` but omits `compute_type`
- **THEN** the loader SHALL emit an error naming the offending entry, variant index, and the missing `compute_type` field

#### Scenario: ggml variant missing coreml_encoder

- **WHEN** a variant declares `format: ggml` but omits `coreml_encoder`
- **THEN** the loader SHALL emit an error naming the offending entry, variant index, and the missing `coreml_encoder` field

#### Scenario: Variant subfolder field

- **WHEN** a variant includes `subfolder: int8_float16` pointing at a sub-path inside a multi-quantisation Hugging Face repository
- **THEN** `make download-model` SHALL invoke `huggingface-cli download <repo_id> --local-dir <local_dir> --include "<subfolder>/*"` so only that sub-tree is fetched, and the downloaded files SHALL be flattened into `<local_dir>` (the leading `<subfolder>/` path component is stripped during materialisation, either via the CLI flag or via a post-download move step in `scripts/model-manager.sh`)

#### Scenario: Variant revision field

- **WHEN** a variant includes `revision: abc123def4` for reproducibility
- **THEN** `make download-model` SHALL invoke `huggingface-cli download <repo_id> --revision abc123def4 --local-dir <local_dir>` for that variant

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - app/services/registry.py
  - scripts/model-manager.sh
tests:
  - tests/test_registry_variants.py
-->

### Requirement: Built-in model entries

The shipped `registry/models.yaml` SHALL contain exactly two built-in entries in v2.1: `breeze-asr-25` (marked `default: true`; MediaTek Breeze ASR 25 optimised for Taiwanese Mandarin plus English code-switching, declared with both a `ct2` and a `ggml` variant) and `large-v3-turbo` (the multilingual fallback; OpenAI Whisper large-v3-turbo, declared with a `ct2` variant only). Each built-in variant SHALL include a valid `repo_id` pointing to a publicly accessible Hugging Face repository.

The `breeze-asr-25` entry's `ggml` variant SHALL declare `quant: q6_k` and reference the Core ML encoder filename `ggml-breeze-asr-25-encoder.mlmodelc` so macOS lifespan can ANE-accelerate the encoder.

#### Scenario: Initial registry contents at v2.1

- **WHEN** the project is freshly cloned at v2.1 or later
- **THEN** `registry/models.yaml` SHALL contain exactly two entries — `breeze-asr-25` (with two variants, marked `default: true`) and `large-v3-turbo` (with one ct2 variant)

##### Example: shipped breeze-asr-25 entry

```yaml
breeze-asr-25:
  description: "Breeze ASR 25 Taiwanese Mandarin (MediaTek)"
  languages: [zh, en]
  default: true
  variants:
    - format: ct2
      repo_id: shdennlin/breeze-asr-25-ct2
      compute_type: int8_float16
      local_dir: breeze-asr-25-ct2
      default_on: [linux]
    - format: ggml
      repo_id: shdennlin/breeze-asr-25-ggml
      quant: q6_k
      filename: ggml-breeze-asr-25-q6_k.bin
      coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
      local_dir: breeze-asr-25-ggml
      default_on: [darwin]
```

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
tests:
  - tests/test_registry_variants.py
-->

### Requirement: Registry is user-extensible

Users SHALL be able to add custom model entries to `registry/models.yaml` by appending a new top-level block with a unique kebab-case identifier and all required top-level and variant fields. The model management commands SHALL recognise custom entries identically to built-in entries. Custom entries MAY declare one or more variants in any combination of supported `format` values.

#### Scenario: User adds custom model entry with single variant

- **WHEN** a user adds a new entry to `registry/models.yaml` with one ct2 variant and all required fields
- **THEN** `make models` SHALL display the custom entry alongside built-in models, listing its single variant's install status
- **THEN** `make download-model MODEL=<custom-name>` SHALL download the variant's CTranslate2 directory using `huggingface-cli` and the variant's `repo_id`

#### Scenario: User adds custom model entry with multiple variants

- **WHEN** a user adds a new entry to `registry/models.yaml` with both a `ct2` and a `ggml` variant
- **THEN** `make download-model MODEL=<custom-name>` SHALL fetch both variants' artefacts; `make models` SHALL display install status per variant; `make set-model MODEL=<custom-name>` SHALL set the model active and the lifespan SHALL pick the variant matching the host platform (or the `BACKEND_FORMAT` override)

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - registry/models.yaml
  - app/services/registry.py
  - scripts/model-manager.sh
tests:
  - tests/test_registry_variants.py
-->
