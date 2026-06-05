## ADDED Requirements

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
