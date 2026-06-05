## ADDED Requirements

### Requirement: Empty and sub-duration finals are filtered before emission

The system SHALL apply a post-process filter to every finalised transcript produced by the WhisperBackend for the `/listen` WebSocket and the `POST /transcribe` endpoint. The filter SHALL drop a finalised transcript when the input audio's measured duration is below `FILTER_MIN_DURATION_MS` (when duration is known) OR when the transcript text, after stripping all Unicode whitespace and punctuation (ASCII and CJK), contains no remaining characters. The filter SHALL be a pure function exposed as `app.services.postprocess.filter_empty_transcription(text, duration_ms, *, enabled, min_duration_ms) -> FilterDecision`.

When the filter decision is Drop, the `/listen` WS endpoint SHALL NOT emit a `final` JSON frame for that utterance; the partial-consensus filter and VAD behavior SHALL otherwise remain unchanged. The `POST /transcribe` endpoint SHALL return HTTP 200 with body `{"text": ""}` (matching its existing empty-result shape) instead of forwarding the noise text.

Every Drop SHALL emit a structured INFO log line named `"transcription_filtered"` with `extra={"endpoint": <"/listen" or "/transcribe">, "reason": <"empty_text" or "below_min_duration">, "duration_ms": <ms or null>, "raw_text_len": <int>}`. Filtered transcriptions SHALL NOT be recorded in any session or finals table and SHALL NOT reach any frontend history surface.

When `FILTER_EMPTY_ENABLED` is set to `false`, the filter SHALL be a no-op: every finalised transcript SHALL be emitted as before, including pure-whitespace and punctuation-only results.

#### Scenario: Pure punctuation final is dropped on /listen

- **GIVEN** `FILTER_EMPTY_ENABLED=true` and a `/listen` connection
- **WHEN** the WhisperBackend returns `"。"` for an utterance of 2000 ms duration
- **THEN** the WS connection SHALL receive NO `final` frame for that utterance
- **AND** the server SHALL emit a log line at INFO level named `"transcription_filtered"` with `extra.reason="empty_text"` and `extra.endpoint="/listen"`

#### Scenario: Sub-minimum-duration utterance is dropped on /listen

- **GIVEN** `FILTER_EMPTY_ENABLED=true`, `FILTER_MIN_DURATION_MS=500`, and a `/listen` connection
- **WHEN** VAD endpoints an utterance of 320 ms and the backend returns `"hi"`
- **THEN** the WS connection SHALL receive NO `final` frame for that utterance
- **AND** the server SHALL emit a log line at INFO level named `"transcription_filtered"` with `extra.reason="below_min_duration"` and `extra.duration_ms=320`

#### Scenario: Valid content passes through /listen unchanged

- **GIVEN** `FILTER_EMPTY_ENABLED=true`, `FILTER_MIN_DURATION_MS=500`, and a `/listen` connection
- **WHEN** the backend returns `"今天天氣很好"` for an utterance of 1500 ms duration
- **THEN** the WS connection SHALL receive a `final` frame with `text="今天天氣很好"` exactly once
- **AND** no `"transcription_filtered"` log line SHALL be emitted for that utterance

#### Scenario: Disabled filter restores legacy behavior on /listen

- **GIVEN** `FILTER_EMPTY_ENABLED=false`
- **WHEN** the backend returns `"。"` for an utterance of 200 ms duration
- **THEN** the WS connection SHALL receive a `final` frame with `text="。"`
- **AND** no `"transcription_filtered"` log line SHALL be emitted

#### Scenario: Empty backend output on /transcribe returns empty text body

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /transcribe` with an audio file and the backend returns `"   "` (whitespace only)
- **THEN** the response SHALL be HTTP 200 with body `{"text": ""}`
- **AND** the server SHALL emit a log line at INFO level named `"transcription_filtered"` with `extra.endpoint="/transcribe"` and `extra.reason="empty_text"`

#### Scenario: Punctuation-only backend output on /transcribe returns empty text body

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /transcribe` with an audio file and the backend returns `". , !"`
- **THEN** the response SHALL be HTTP 200 with body `{"text": ""}`
- **AND** the server SHALL emit a log line at INFO level named `"transcription_filtered"` with `extra.endpoint="/transcribe"` and `extra.reason="empty_text"`

### Requirement: FILTER_EMPTY_ENABLED and FILTER_MIN_DURATION_MS env vars control the filter

The system SHALL read two environment variables in `Config.__init__`:

- `FILTER_EMPTY_ENABLED` — case-insensitive `"true"` or `"false"`. Default `"true"`. Any other non-empty value SHALL log a WARN line naming the variable and fall back to `True`.
- `FILTER_MIN_DURATION_MS` — non-negative integer in milliseconds. Default `500`. Any non-integer or negative value SHALL log a WARN line naming the variable and fall back to `500`.

Both env vars SHALL be documented in `.env.example` with their defaults and the recommendation that they remain at defaults except for diagnostic purposes.

#### Scenario: Defaults applied when env vars unset

- **GIVEN** neither `FILTER_EMPTY_ENABLED` nor `FILTER_MIN_DURATION_MS` is set in the environment
- **WHEN** `Config()` is constructed
- **THEN** `config.FILTER_EMPTY_ENABLED` SHALL be `True` and `config.FILTER_MIN_DURATION_MS` SHALL be `500`

#### Scenario: Valid override accepted

- **GIVEN** `FILTER_EMPTY_ENABLED=false` and `FILTER_MIN_DURATION_MS=250` in the environment
- **WHEN** `Config()` is constructed
- **THEN** `config.FILTER_EMPTY_ENABLED` SHALL be `False` and `config.FILTER_MIN_DURATION_MS` SHALL be `250`
- **AND** no WARN log line SHALL be emitted

#### Scenario: Invalid bool falls back with warning

- **GIVEN** `FILTER_EMPTY_ENABLED=maybe` in the environment
- **WHEN** `Config()` is constructed
- **THEN** `config.FILTER_EMPTY_ENABLED` SHALL be `True`
- **AND** a WARN log line naming `FILTER_EMPTY_ENABLED` SHALL be emitted exactly once

#### Scenario: Invalid integer falls back with warning

- **GIVEN** `FILTER_MIN_DURATION_MS=-300` in the environment
- **WHEN** `Config()` is constructed
- **THEN** `config.FILTER_MIN_DURATION_MS` SHALL be `500`
- **AND** a WARN log line naming `FILTER_MIN_DURATION_MS` SHALL be emitted exactly once
