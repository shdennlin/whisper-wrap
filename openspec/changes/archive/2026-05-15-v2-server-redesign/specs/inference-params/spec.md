## MODIFIED Requirements

### Requirement: Language parameter on transcribe endpoints

The unified `POST /transcribe` endpoint SHALL accept an optional `language` query parameter regardless of whether the request body is `multipart/form-data` or raw audio (`audio/*` or `application/octet-stream`). The value SHALL be forwarded to the in-process ASR model as the `language` argument on the transcribe call. When omitted, the value SHALL default to `"auto"`.

#### Scenario: Explicit language with multipart upload

- **WHEN** a client sends `POST /transcribe?language=en` with `Content-Type: multipart/form-data` and a `file` form field
- **THEN** the system SHALL invoke the in-process ASR model with `language="en"`

#### Scenario: Explicit language with raw audio body

- **WHEN** a client sends `POST /transcribe?language=zh` with `Content-Type: audio/m4a` and a raw audio body
- **THEN** the system SHALL invoke the in-process ASR model with `language="zh"`

#### Scenario: Language parameter omitted

- **WHEN** a client sends `POST /transcribe` without a `language` query parameter
- **THEN** the system SHALL invoke the in-process ASR model with `language="auto"`

<!-- @trace
source: forward-language-prompt
updated: 2026-03-10
code:
  - app/api/transcribe.py
  - app/services/whisper.py
  - app/services/punctuation.py
tests:
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_punctuation.py
-->

### Requirement: Prompt parameter on transcribe endpoints

The unified `POST /transcribe` endpoint SHALL accept an optional `prompt` query parameter regardless of body format. The value SHALL be forwarded to the in-process ASR model as the `initial_prompt` argument on the transcribe call. When omitted, no initial prompt SHALL be sent to the model.

#### Scenario: Prompt specified with multipart upload

- **WHEN** a client sends `POST /transcribe?prompt=Hello,%20how%20are%20you.` with multipart audio
- **THEN** the system SHALL invoke the in-process ASR model with `initial_prompt="Hello, how are you."`

#### Scenario: Prompt specified with raw audio body

- **WHEN** a client sends `POST /transcribe?prompt=Hi` with `Content-Type: audio/m4a` and a raw audio body
- **THEN** the system SHALL invoke the in-process ASR model with `initial_prompt="Hi"`

#### Scenario: Prompt omitted

- **WHEN** a client sends `POST /transcribe` without a `prompt` query parameter
- **THEN** the system SHALL NOT pass `initial_prompt` to the in-process ASR model

<!-- @trace
source: forward-language-prompt
updated: 2026-03-10
code:
  - app/api/transcribe.py
  - app/services/whisper.py
  - app/services/punctuation.py
tests:
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_punctuation.py
-->

### Requirement: WhisperClient forwards inference parameters

The internal ASR wrapper (historically named `WhisperClient`) invoked by `POST /transcribe`, `POST /ask`, and `WS /listen` SHALL accept optional `language` and `initial_prompt` keyword arguments. These values SHALL be passed unchanged to the in-process ASR model when the wrapper performs a transcribe call. The historical name `WhisperClient` is retained as the public type name for backwards compatibility with existing imports.

#### Scenario: Both parameters forwarded

- **WHEN** the wrapper is invoked with `language="en"` and `initial_prompt="Hello."`
- **THEN** the call into the in-process ASR model SHALL receive both arguments verbatim

#### Scenario: Only language forwarded

- **WHEN** the wrapper is invoked with `language="zh"` and no prompt
- **THEN** the call into the in-process ASR model SHALL receive `language="zh"` and SHALL NOT pass `initial_prompt`

<!-- @trace
source: forward-language-prompt
updated: 2026-03-10
code:
  - app/api/transcribe.py
  - app/services/whisper.py
  - app/services/punctuation.py
tests:
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_punctuation.py
-->
