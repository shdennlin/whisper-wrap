# ask Specification

## Purpose

TBD - created by archiving change 'v2-server-redesign'. Update Purpose after archive.

## Requirements

### Requirement: Question-answering endpoint accepts audio and text inputs

The system SHALL provide a `POST /ask` endpoint that accepts audio input (multipart form or raw audio body) or text input (JSON body), and SHALL return a JSON document of shape `{"transcript": <string or null>, "answer": "..."}`. The `transcript` field SHALL be the resolved transcript string for audio inputs and SHALL be `null` for the JSON text input path. The `language` and `prompt` query parameters defined by the `inference-params` capability SHALL apply to the audio inputs of `/ask` with identical semantics and defaults as on `POST /transcribe`; the same post-processing (segment join, punctuation normalisation) SHALL be applied before the transcript is passed to the LLM.

#### Scenario: Audio multipart input

- **WHEN** a client sends `POST /ask` with `Content-Type: multipart/form-data` and a `file` form field containing audio
- **THEN** the system SHALL transcribe the audio (honouring any `language` / `prompt` query parameter), invoke the configured LLM with the post-processed transcript, and return `{"transcript": "<transcript-string>", "answer": "..."}` with HTTP 200

#### Scenario: Raw audio body input

- **WHEN** a client sends `POST /ask` with `Content-Type: audio/m4a` (or any `audio/*` value, or `application/octet-stream`) and the raw audio bytes as the request body
- **THEN** the system SHALL transcribe the body (honouring any `language` / `prompt` query parameter) and return `{"transcript": "<transcript-string>", "answer": "..."}` with HTTP 200

#### Scenario: Text input via JSON

- **WHEN** a client sends `POST /ask` with `Content-Type: application/json` and body `{"text": "say hi"}`
- **THEN** the system SHALL skip transcription, invoke the LLM directly with the supplied text, and return `{"transcript": null, "answer": "..."}` with HTTP 200

#### Scenario: Unsupported content type

- **WHEN** a client sends `POST /ask` with a `Content-Type` that is neither multipart, audio, octet-stream, nor JSON
- **THEN** the system SHALL respond with HTTP 415 and body `{"error": "unsupported content-type"}`


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
### Requirement: Question-answering endpoint validates input bodies

The system SHALL reject malformed `/ask` request bodies with HTTP 400 and a `{"error": "<reason>"}` JSON body. The same validation applies to both the blocking and streaming response modes; in streaming mode the validation runs before the SSE response is started, so a 400 response is delivered as a normal HTTP response without any SSE framing.

#### Scenario: Missing JSON text field

- **WHEN** a client sends `POST /ask` with `Content-Type: application/json` and body `{}`
- **THEN** the response SHALL be HTTP 400 with body `{"error": "missing field 'text'"}`

#### Scenario: Empty JSON text field

- **WHEN** a client sends `POST /ask` with `Content-Type: application/json` and body `{"text": ""}`
- **THEN** the response SHALL be HTTP 400 with body `{"error": "field 'text' must be non-empty"}`

#### Scenario: Malformed JSON body

- **WHEN** a client sends `POST /ask` with `Content-Type: application/json` and body `{not-json`
- **THEN** the response SHALL be HTTP 400 with body `{"error": "invalid JSON: <parser-message>"}` where `<parser-message>` is the underlying parser's error text

#### Scenario: Missing multipart file field

- **WHEN** a client sends `POST /ask` with `Content-Type: multipart/form-data` and no `file` form field
- **THEN** the response SHALL be HTTP 400 with body `{"error": "missing form field 'file'"}`

#### Scenario: Empty audio body

- **WHEN** a client sends `POST /ask` with `Content-Type: audio/m4a` and a zero-byte request body
- **THEN** the response SHALL be HTTP 400 with body `{"error": "empty audio body"}`


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
### Requirement: Question-answering endpoint supports server-sent event streaming

When `POST /ask` is called with the query parameter `stream=true`, the system SHALL respond with `Content-Type: text/event-stream`. Every SSE event's `data:` line SHALL contain a single JSON document (never a bare string or a multi-line payload). The system SHALL emit a deterministic event sequence on the success path: exactly one `transcript` event, then **zero or more** `token` events (typically one or more; zero is permitted only when the LLM returns an empty completion — see the "Streaming with empty LLM response" scenario below), then exactly one terminating `done` event. On the failure path the system SHALL emit a single terminating `error` event in place of `done`; if the failure occurs before the transcript is available (for example a transcription failure on the audio path), the system SHALL emit the `error` event WITHOUT a leading `transcript` event.

#### Scenario: Streaming a successful answer

- **WHEN** a client sends `POST /ask?stream=true` with a valid JSON or audio body and the LLM responds normally with a non-empty completion
- **THEN** the response SHALL be `Content-Type: text/event-stream` and SHALL contain, in order: one `event: transcript` with `data: {"text": "<transcript or null>"}`, one or more `event: token` frames with `data: {"text": "<delta>"}`, and a final `event: done` with `data: {"finish_reason": "<gemini-reason>"}`. The zero-token case is covered separately by the "Streaming with empty LLM response" scenario below.

##### Example: event sequence for a text-input ask

```
event: transcript
data: {"text": null}

event: token
data: {"text": "你"}

event: token
data: {"text": "好"}

event: done
data: {"finish_reason": "stop"}
```

#### Scenario: Streaming error after transcript

- **WHEN** the LLM raises an error after the `transcript` event has been emitted
- **THEN** the system SHALL emit a final `event: error` with `data: {"error": "<reason>"}` and close the connection without emitting `event: done`

#### Scenario: Streaming error before transcript (transcription failure)

- **WHEN** the audio path is taken and transcription fails before any LLM token is produced
- **THEN** the system SHALL emit a single `event: error` with `data: {"error": "transcription failed: <reason>"}` and close the connection without emitting either a `transcript` or `done` event

#### Scenario: Streaming with empty LLM response

- **WHEN** the LLM returns a successful response with zero output tokens (for example a safety-blocked completion that finishes immediately)
- **THEN** the system SHALL still emit the `transcript` event, SHALL emit zero `token` events, and SHALL emit a terminating `done` event whose `finish_reason` is the verbatim stop-reason string from the Gemini SDK (for example `"safety"`, `"recitation"`, `"stop"`) when one is provided; if the SDK does not supply a stop-reason for the empty completion, `finish_reason` SHALL be the literal string `"empty"`.


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
### Requirement: System prompt is configurable via environment

The system SHALL read the LLM system prompt from the `GEMINI_SYSTEM_PROMPT` environment variable at startup and SHALL inject that exact string as the system message on every `/ask` request to the LLM. The fallback policy is:

- If `GEMINI_SYSTEM_PROMPT` is **unset**, the system SHALL silently fall back to a baked-in default Taiwan-friendly assistant persona (no warning — this is the expected fresh-install path).
- If `GEMINI_SYSTEM_PROMPT` is **set to the empty string** (typically an operator configuration mistake), the system SHALL fall back to the same default AND SHALL emit a one-line WARNING the first time `/ask` is invoked, naming the variable.

`.env.example` SHALL ship with a non-empty override demonstrating the customisation point. The default persona SHALL be defined as a single string constant in `app/services/llm.py` so the source of truth is unambiguous.

#### Scenario: Custom system prompt is forwarded verbatim

- **WHEN** `GEMINI_SYSTEM_PROMPT="你是一個會用台灣口語回答的助理"` is set in `.env` at server start
- **WHEN** a client sends `POST /ask` with `{"text":"hi"}`
- **THEN** the request issued to the LLM SHALL include that exact system prompt string as the system message

#### Scenario: Unset variable falls back to default

- **WHEN** `GEMINI_SYSTEM_PROMPT` is unset in the environment at server start
- **WHEN** a client sends `POST /ask` with any valid body
- **THEN** the request issued to the LLM SHALL include the baked-in default Taiwan-friendly assistant persona string

#### Scenario: Empty variable falls back to default with warning

- **WHEN** `GEMINI_SYSTEM_PROMPT` is set to the empty string in `.env`
- **THEN** the server SHALL start successfully and SHALL emit a one-line WARNING the first time `/ask` is invoked, naming the variable and noting the default fallback


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
### Requirement: Missing LLM credentials surface as 502 or stream error

If `GEMINI_API_KEY` is not set at startup, the `/ask` endpoint SHALL still be reachable but SHALL respond with HTTP 502 in the blocking mode and with a single `event: error` followed by socket close in the streaming mode. The `GET /status` response SHALL reflect this by setting `gemini.configured` to `false`.

#### Scenario: Blocking ask with no API key

- **WHEN** `GEMINI_API_KEY` is unset and a client sends `POST /ask` with any valid body
- **THEN** the response SHALL be HTTP 502 with body `{"error": "<reason>"}` describing the missing configuration

#### Scenario: Streaming ask with no API key

- **WHEN** `GEMINI_API_KEY` is unset and a client sends `POST /ask?stream=true` with a valid JSON body
- **THEN** the response SHALL be `Content-Type: text/event-stream`, SHALL emit exactly one `event: error` with `data: {"error": "<reason>"}`, and SHALL close the connection

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
### Requirement: Audio /ask returns 400 when STT yields empty content

When the `POST /ask` endpoint receives an audio input (multipart, raw audio `audio/*`, or `application/octet-stream`) and the resulting transcript is filtered to a Drop decision by `app.services.postprocess.filter_empty_transcription`, the endpoint SHALL NOT invoke the configured LLM and SHALL return HTTP 400 with body `{"error": "no_speech_detected"}` for the blocking response mode.

For the streaming response mode (`?stream=true`), the endpoint SHALL emit one `event: error` SSE frame with `data: {"error": "no_speech_detected"}` then close the response stream cleanly. The endpoint SHALL NOT emit a `transcript` event, any `token` event, or a `done` event in this case.

The endpoint SHALL emit a structured INFO log line named `"transcription_filtered"` with `extra={"endpoint": "/ask", "reason": <"empty_text" or "below_min_duration">, "stream": <true or false>, "raw_text_len": <int>}` exactly once per filtered request.

The JSON text-input path (`Content-Type: application/json` with body `{"text": "..."}`) SHALL NOT be affected by this requirement; its existing 400 validation for empty `text` (in the `Question-answering endpoint validates input bodies` requirement) continues to apply unchanged.

When `FILTER_EMPTY_ENABLED=false`, the audio path SHALL forward the (potentially empty) transcript to the LLM as before; no 400 SHALL be returned on account of an empty STT result.

#### Scenario: Audio multipart input with punctuation-only transcript returns 400

- **GIVEN** `FILTER_EMPTY_ENABLED=true` and `GEMINI_API_KEY` is configured
- **WHEN** the client sends `POST /ask` with `Content-Type: multipart/form-data` and a `file` containing audio that the backend transcribes to `"。"`
- **THEN** the response SHALL be HTTP 400 with body `{"error": "no_speech_detected"}`
- **AND** the configured LLM client SHALL NOT be invoked
- **AND** the server SHALL emit a log line named `"transcription_filtered"` with `extra.endpoint="/ask"` and `extra.reason="empty_text"` and `extra.stream=false`

#### Scenario: Streaming audio request with empty transcript emits SSE error then closes

- **GIVEN** `FILTER_EMPTY_ENABLED=true` and `GEMINI_API_KEY` is configured
- **WHEN** the client sends `POST /ask?stream=true` with audio that the backend transcribes to `""`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: text/event-stream`
- **AND** the body SHALL contain exactly one frame matching `event: error\ndata: {"error": "no_speech_detected"}\n\n`
- **AND** the body SHALL NOT contain any `event: transcript`, `event: token`, or `event: done` frame
- **AND** the configured LLM client SHALL NOT be invoked

#### Scenario: Sub-minimum-duration audio /ask returns 400

- **GIVEN** `FILTER_EMPTY_ENABLED=true`, `FILTER_MIN_DURATION_MS=500`
- **WHEN** the client sends `POST /ask` with an audio body whose decoded duration is 400 ms
- **THEN** the response SHALL be HTTP 400 with body `{"error": "no_speech_detected"}`
- **AND** the configured LLM client SHALL NOT be invoked

#### Scenario: Disabled filter forwards empty transcript to the LLM

- **GIVEN** `FILTER_EMPTY_ENABLED=false`
- **WHEN** the client sends `POST /ask` with audio that the backend transcribes to `""`
- **THEN** the configured LLM client SHALL be invoked with the empty transcript per the existing endpoint contract
- **AND** the response shape SHALL match the `Question-answering endpoint accepts audio and text inputs` requirement

#### Scenario: JSON text-input path is unaffected

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /ask` with `Content-Type: application/json` and body `{"text": "what is the weather?"}`
- **THEN** the endpoint SHALL forward the text to the LLM unchanged
- **AND** the response SHALL match the `Question-answering endpoint accepts audio and text inputs` requirement for the text input scenario

<!-- @trace
source: transcription-empty-filter
updated: 2026-06-05
code:
  - uv.lock
  - pyproject.toml
  - CHANGELOG.md
  - frontend/package.json
-->