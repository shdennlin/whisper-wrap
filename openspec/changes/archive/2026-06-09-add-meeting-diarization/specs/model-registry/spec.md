## ADDED Requirements

### Requirement: Meeting analysis CT2 prerequisite

A model that is intended to serve `POST /transcribe/meeting` SHALL declare a `format: ct2` variant in its `registry/models.yaml` entry, regardless of which variant is the platform default. This is because the WhisperX-based meeting pipeline requires a CT2 ASR model on every host (Apple Neural Engine is not used on the meeting path).

The registry loader SHALL NOT enforce this requirement at parse time, because not every model in the registry is intended for meeting use. Validation SHALL be performed by the meeting endpoint at request time and surfaced as the 503 response defined in the `meeting-diarization` capability.

The shipped default model (`breeze-asr-25`) SHALL retain both its `ct2` and `ggml` variants so that the meeting endpoint works out of the box on every host once the meeting extras and `HF_TOKEN` are configured.

#### Scenario: Default model has both variants after this change

- **WHEN** an operator inspects `registry/models.yaml` after this change is applied
- **THEN** the entry whose `default: true` value resolves SHALL list at least one variant with `format: ct2` and at least one variant with `format: ggml`

#### Scenario: Registry parses successfully even when a non-default model lacks ct2

- **WHEN** a custom model entry is added that declares only a `format: ggml` variant
- **THEN** the registry loader SHALL parse the file successfully without raising, and the loader SHALL NOT emit any warning specific to meeting analysis at parse time
