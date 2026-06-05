## ADDED Requirements

### Requirement: OpenAI compat endpoints preserve schema when transcription is filtered

When `POST /v1/audio/transcriptions` or `POST /v1/audio/translations` receives audio whose backend transcription is filtered to a Drop decision by `app.services.postprocess.filter_empty_transcription`, the endpoint SHALL return an empty-content response in the shape native to the requested `response_format`. The OpenAI response schema SHALL NOT gain any custom fields (no `meta`, no `filtered`, no project-specific keys) so third-party OpenAI clients keep parsing the response.

Empty-content shapes per `response_format`:

- `json` (default): HTTP 200 with body `{"text": ""}` and `Content-Type: application/json`.
- `text`: HTTP 200 with empty body and `Content-Type: text/plain; charset=utf-8`.
- `verbose_json`: HTTP 200 with body `{"task": <"transcribe" or "translate">, "language": <detected language code or "unknown">, "duration": <input audio duration in seconds, float>, "text": "", "segments": []}` and `Content-Type: application/json`. The `task` field SHALL be `"transcribe"` for `/v1/audio/transcriptions` and `"translate"` for `/v1/audio/translations`.
- `srt`: HTTP 200 with empty body and `Content-Type: application/x-subrip`.
- `vtt`: HTTP 200 with body `WEBVTT\n\n` (header followed by one blank line) and `Content-Type: text/vtt`.

The endpoint SHALL emit a structured INFO log line named `"transcription_filtered"` with `extra={"endpoint": <"/v1/audio/transcriptions" or "/v1/audio/translations">, "reason": <"empty_text" or "below_min_duration">, "response_format": <chosen format>, "raw_text_len": <int>}` exactly once per filtered request.

When `FILTER_EMPTY_ENABLED=false`, the filter SHALL be a no-op for these endpoints and the response SHALL contain the unfiltered transcription per the existing OpenAI-compatible behavior, including for whitespace-only or punctuation-only backend output.

#### Scenario: json format returns empty text body when filtered

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `model=whisper-1`, `response_format=json`, and audio that the backend transcribes to `"  "` (whitespace only)
- **THEN** the response SHALL be HTTP 200 with body `{"text": ""}`
- **AND** the server SHALL emit a log line named `"transcription_filtered"` with `extra.endpoint="/v1/audio/transcriptions"` and `extra.response_format="json"`

#### Scenario: text format returns empty body when filtered

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `response_format=text` and audio that the backend transcribes to `"。"`
- **THEN** the response SHALL be HTTP 200 with an empty body and `Content-Type: text/plain; charset=utf-8`

#### Scenario: verbose_json format returns segments=[] with metadata preserved when filtered

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `response_format=verbose_json` and audio that the backend transcribes to `""` with detected language `"en"` and input duration 0.4 s
- **THEN** the response SHALL be HTTP 200 with a JSON body whose keys are exactly `task`, `language`, `duration`, `text`, `segments`
- **AND** `task` SHALL be `"transcribe"`, `language` SHALL be `"en"`, `duration` SHALL be `0.4`, `text` SHALL be `""`, and `segments` SHALL be `[]`

#### Scenario: srt format returns empty body when filtered

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `response_format=srt` and audio that the backend transcribes to `","`
- **THEN** the response SHALL be HTTP 200 with an empty body and `Content-Type: application/x-subrip`

#### Scenario: vtt format returns WEBVTT header when filtered

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `response_format=vtt` and audio that the backend transcribes to `""`
- **THEN** the response SHALL be HTTP 200 with body `WEBVTT\n\n` and `Content-Type: text/vtt`

#### Scenario: translations endpoint applies the same filter and shape

- **GIVEN** `FILTER_EMPTY_ENABLED=true`
- **WHEN** the client sends `POST /v1/audio/translations` with `response_format=verbose_json` and audio that the backend transcribes to whitespace only with detected language `"fr"` and input duration 1.2 s
- **THEN** the response SHALL be HTTP 200 with body `{"task": "translate", "language": "fr", "duration": 1.2, "text": "", "segments": []}`
- **AND** the server SHALL emit a log line named `"transcription_filtered"` with `extra.endpoint="/v1/audio/translations"` and `extra.response_format="verbose_json"`

#### Scenario: Disabled filter forwards whitespace transcription unchanged

- **GIVEN** `FILTER_EMPTY_ENABLED=false`
- **WHEN** the client sends `POST /v1/audio/transcriptions` with `response_format=json` and audio that the backend transcribes to `"   "`
- **THEN** the response SHALL be HTTP 200 with body `{"text": "   "}`
- **AND** no `"transcription_filtered"` log line SHALL be emitted
