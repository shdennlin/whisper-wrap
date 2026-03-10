## ADDED Requirements

### Requirement: Language parameter on transcribe endpoints

Both `POST /transcribe` and `POST /transcribe-raw` SHALL accept an optional `language` query parameter. The value SHALL be forwarded to whisper-server's `/inference` endpoint in the `language` form field. When omitted, the value SHALL default to `"auto"`.

#### Scenario: Explicit language specified

- **WHEN** a client sends `POST /transcribe?language=en` with an audio file
- **THEN** the system forwards `language=en` to whisper-server's `/inference` endpoint

#### Scenario: Language parameter omitted

- **WHEN** a client sends `POST /transcribe` without a `language` query parameter
- **THEN** the system forwards `language=auto` to whisper-server's `/inference` endpoint

#### Scenario: Language parameter on raw endpoint

- **WHEN** a client sends `POST /transcribe-raw?language=zh` with raw audio data
- **THEN** the system forwards `language=zh` to whisper-server's `/inference` endpoint

### Requirement: Prompt parameter on transcribe endpoints

Both `POST /transcribe` and `POST /transcribe-raw` SHALL accept an optional `prompt` query parameter. The value SHALL be forwarded to whisper-server's `/inference` endpoint in the `prompt` form field. When omitted, the prompt field SHALL NOT be included in the inference request.

#### Scenario: Prompt specified

- **WHEN** a client sends `POST /transcribe?prompt=Hello, how are you.` with an audio file
- **THEN** the system forwards `prompt=Hello, how are you.` to whisper-server's `/inference` endpoint

#### Scenario: Prompt omitted

- **WHEN** a client sends `POST /transcribe` without a `prompt` query parameter
- **THEN** the system does NOT include a `prompt` field in the whisper-server inference request

### Requirement: WhisperClient forwards inference parameters

`WhisperClient.transcribe()` SHALL accept optional `language` and `prompt` keyword arguments. These SHALL be included in the form data sent to whisper-server's `/inference` endpoint.

#### Scenario: Both parameters forwarded

- **WHEN** `transcribe()` is called with `language="en"` and `prompt="Hello."`
- **THEN** the `/inference` request form data includes `language=en` and `prompt=Hello.`

#### Scenario: Only language forwarded

- **WHEN** `transcribe()` is called with `language="zh"` and no prompt
- **THEN** the `/inference` request form data includes `language=zh` and does NOT include `prompt`
