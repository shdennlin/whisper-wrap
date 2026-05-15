# openai-compat Specification

## Purpose

TBD - created by archiving change 'v2-3-openai-compat'. Update Purpose after archive.

## Requirements

### Requirement: OpenAI-compatible audio transcription endpoint

The system SHALL expose `POST /v1/audio/transcriptions` accepting the OpenAI Whisper REST API request shape and returning the documented OpenAI response shapes, so that any OpenAI-Whisper-compatible client (open-webui, LibreChat, the OpenAI Python/TypeScript SDK, curl recipes from the OpenAI docs) can use whisper-wrap as a drop-in speech-to-text backend.

The endpoint SHALL accept `multipart/form-data` with the following fields:

- `file` (required, binary): the audio file in any format supported by the existing `/transcribe` ingestion path (mp3, wav, m4a, flac, ogg, webm — whatever libmagic + ffmpeg accept today).
- `model` (required by OpenAI clients; advisory in whisper-wrap): any non-empty string is accepted. The values `whisper-1`, `gpt-4o-transcribe`, and `gpt-4o-mini-transcribe` SHALL be accepted as aliases for the active whisper-wrap model. Any other non-empty value SHALL also be accepted, with a one-line WARNING log naming the received value and the active model so operators see why their client sent a surprising name. Empty string or missing `model` SHALL respond HTTP 400 with an OpenAI-shaped error body (see error scenario below).
- `language` (optional, string): an ISO-639-1 code (e.g. `"en"`, `"zh"`, `"ja"`). Maps directly to the underlying backend's `language` parameter. Omitted → backend default (`auto`).
- `prompt` (optional, string): an initial seed string. Maps directly to the backend's `prompt` parameter.
- `response_format` (optional, string, default `"json"`): one of `"json"`, `"text"`, `"srt"`, `"verbose_json"`, `"vtt"`. Any other value SHALL respond HTTP 400 with an OpenAI-shaped error.
- `temperature` (optional, float, default `0`): forwarded to the backend's `temperature` parameter when the backend supports it; ignored otherwise (silently — the OpenAI client expects this field to be accepted even when the model does not honour it).

The endpoint SHALL reuse the existing in-process WhisperBackend (the same one `/transcribe` uses). It SHALL NOT load a separate model.

The endpoint SHALL be reachable without authentication. Clients MAY send an `Authorization: Bearer <token>` header (the OpenAI SDK always does); the value SHALL be ignored.

#### Scenario: Default `json` response for a short clip

- **WHEN** a client POSTs a 3-second wav file with form fields `model=whisper-1`, no `response_format`, no `language`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: application/json` and body of shape `{"text": "<transcript>"}` — exactly the OpenAI `audio.transcriptions.create` default response shape

##### Example: minimal json response

- **GIVEN** a 3-second wav clip of the spoken phrase "hello world"
- **WHEN** the client POSTs `multipart/form-data` with `file=<wav>`, `model=whisper-1`
- **THEN** the response body SHALL equal `{"text": "hello world"}` (the transcript may be normalised by the existing post-processing pipeline used by `/transcribe`)

#### Scenario: `text` response returns plain text

- **WHEN** a client posts with `response_format=text`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: text/plain; charset=utf-8` and the body SHALL be the raw transcript string (no JSON wrapping, no trailing newline added by the endpoint beyond what the transcript itself contains)

#### Scenario: `verbose_json` includes per-segment timing

- **WHEN** a client posts with `response_format=verbose_json` and the backend produces N segments
- **THEN** the response SHALL be HTTP 200 with `Content-Type: application/json` and body of shape `{"task": "transcribe", "language": "<detected-or-requested>", "duration": <seconds-float>, "text": "<full-transcript>", "segments": [{"id": 0, "seek": 0, "start": <sec-float>, "end": <sec-float>, "text": "<segment-text>", "tokens": [], "temperature": 0.0, "avg_logprob": null, "compression_ratio": null, "no_speech_prob": null}, ...]}`. Fields the backend cannot supply (`tokens`, `avg_logprob`, `compression_ratio`, `no_speech_prob`) SHALL be present but `null` or `[]` — present with falsy values, never omitted, so OpenAI SDK clients can rely on the shape.

##### Example: verbose_json shape

- **GIVEN** a 6-second clip transcribed as two segments
- **WHEN** the client posts with `response_format=verbose_json`, `language=en`
- **THEN** the response body SHALL be JSON of the form:

```json
{
  "task": "transcribe",
  "language": "en",
  "duration": 6.0,
  "text": "hello world. how are you.",
  "segments": [
    {"id": 0, "seek": 0, "start": 0.0, "end": 2.5, "text": "hello world.", "tokens": [], "temperature": 0.0, "avg_logprob": null, "compression_ratio": null, "no_speech_prob": null},
    {"id": 1, "seek": 0, "start": 2.5, "end": 6.0, "text": " how are you.", "tokens": [], "temperature": 0.0, "avg_logprob": null, "compression_ratio": null, "no_speech_prob": null}
  ]
}
```

#### Scenario: `srt` response returns SRT subtitle text

- **WHEN** a client posts with `response_format=srt`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: text/plain; charset=utf-8` (matching the OpenAI documented behaviour) and the body SHALL be valid SRT formatted from the backend's segments

##### Example: SRT formatting

- **GIVEN** segments `[(0.0, 2.5, "hello world."), (2.5, 6.0, " how are you.")]`
- **WHEN** the client posts with `response_format=srt`
- **THEN** the body SHALL equal:

```
1
00:00:00,000 --> 00:00:02,500
hello world.

2
00:00:02,500 --> 00:00:06,000
 how are you.

```

(Including the trailing blank line after the final cue, as per SRT convention.)

#### Scenario: `vtt` response returns WebVTT text

- **WHEN** a client posts with `response_format=vtt`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: text/vtt; charset=utf-8` and the body SHALL be a valid WebVTT document starting with the literal line `WEBVTT` followed by a blank line and then each segment formatted with `start --> end` timestamps using `.` as the millisecond separator (per WebVTT spec, distinct from SRT's `,`)

##### Example: VTT formatting

- **GIVEN** segments `[(0.0, 2.5, "hello world."), (2.5, 6.0, " how are you.")]`
- **WHEN** the client posts with `response_format=vtt`
- **THEN** the body SHALL equal:

```
WEBVTT

00:00:00.000 --> 00:00:02.500
hello world.

00:00:02.500 --> 00:00:06.000
 how are you.

```

#### Scenario: Reserved OpenAI model aliases are accepted silently

- **WHEN** a client posts with `model=whisper-1` (or `gpt-4o-transcribe`, or `gpt-4o-mini-transcribe`)
- **THEN** the request SHALL be processed normally with the active whisper-wrap model and no WARNING log SHALL be emitted (these are documented OpenAI model IDs that clients commonly hardcode)

#### Scenario: Unknown model value is accepted with a warning

- **WHEN** a client posts with `model=some-other-model` (any non-empty value not on the alias list and not equal to the active whisper-wrap model name)
- **THEN** the request SHALL be processed normally with the active whisper-wrap model AND a single WARNING log line SHALL be emitted naming the received `model` value and the active model name (e.g. `WARNING: openai-compat: client requested model="some-other-model"; serving with active model="breeze-asr-25"`)

#### Scenario: Empty or missing `model` field returns 400

- **WHEN** a client posts without the `model` form field, or with `model=""`
- **THEN** the response SHALL be HTTP 400 with `Content-Type: application/json` and body of shape `{"error": {"message": "<human readable>", "type": "invalid_request_error", "param": "model", "code": null}}` — matching the OpenAI documented error envelope

#### Scenario: Invalid `response_format` returns 400

- **WHEN** a client posts with `response_format=xml` (or any value outside `{json, text, srt, verbose_json, vtt}`)
- **THEN** the response SHALL be HTTP 400 with the OpenAI-shaped error body, `error.param="response_format"`, `error.type="invalid_request_error"`, and an `error.message` that lists the accepted values

#### Scenario: Missing `file` field returns 400

- **WHEN** a client posts the multipart form without a `file` part
- **THEN** the response SHALL be HTTP 400 with the OpenAI-shaped error body, `error.param="file"`, `error.type="invalid_request_error"`

#### Scenario: Backend transcription failure returns 500 in OpenAI shape

- **WHEN** the underlying WhisperBackend raises during transcription
- **THEN** the response SHALL be HTTP 500 with `Content-Type: application/json` and body of shape `{"error": {"message": "<diagnostic>", "type": "server_error", "param": null, "code": null}}`; the `message` SHALL NOT include stack traces, file paths, or secret-bearing environment values

---
### Requirement: OpenAI-compatible audio translations endpoint

The system SHALL expose `POST /v1/audio/translations` with the same request and response shape as `/v1/audio/transcriptions`, except that the underlying inference SHALL request the Whisper "translate" task (output in English regardless of source language). The `language` form field is not accepted for translations (per OpenAI's documented surface — output language is always English).

The endpoint SHALL be reachable without authentication. It SHALL support all five `response_format` values (`json`, `text`, `srt`, `verbose_json`, `vtt`) with identical formatting to `/v1/audio/transcriptions`.

#### Scenario: Translate Mandarin clip to English JSON

- **WHEN** a client posts a Mandarin audio clip with `model=whisper-1`, no `response_format`
- **THEN** the response SHALL be HTTP 200 with body `{"text": "<English translation>"}` and the underlying backend invocation SHALL have used the translate task (not the default transcribe task)

#### Scenario: `language` form field is rejected for translations

- **WHEN** a client posts to `/v1/audio/translations` with `language=fr` set
- **THEN** the response SHALL be HTTP 400 with the OpenAI-shaped error body, `error.param="language"`, and an `error.message` explaining that translations always output English

#### Scenario: `verbose_json` translation includes `task: "translate"`

- **WHEN** a client posts to `/v1/audio/translations` with `response_format=verbose_json`
- **THEN** the response body's `task` field SHALL equal `"translate"` (distinguishing it from the transcribe path) and the `language` field SHALL equal `"en"`

---
### Requirement: OpenAI-compatible model discovery endpoint

The system SHALL expose `GET /v1/models` returning a JSON document in the OpenAI `list` shape so that OpenAI-SDK clients that probe the catalogue (e.g. open-webui's "select model" UI) do not error.

The response SHALL be of shape `{"object": "list", "data": [{"id": "<active-whisper-wrap-model-name>", "object": "model", "created": <unix-timestamp>, "owned_by": "whisper-wrap"}]}`. The `data` array SHALL contain exactly one entry: the active model resolved at startup (the same name reported in `/status` under `model.name`). The `created` value SHALL be the server's startup unix-timestamp (the same value usable to compute `uptime_seconds`).

The endpoint SHALL be reachable without authentication. Clients MAY send `Authorization`; the header SHALL be ignored.

#### Scenario: Single-model catalogue

- **WHEN** a client GETs `/v1/models` while the server is running with active model `breeze-asr-25`
- **THEN** the response SHALL be HTTP 200 with body equivalent to `{"object": "list", "data": [{"id": "breeze-asr-25", "object": "model", "created": <int>, "owned_by": "whisper-wrap"}]}`

##### Example: response shape

- **GIVEN** active model `breeze-asr-25` loaded, server startup timestamp `1715800000`
- **WHEN** a client GETs `/v1/models`
- **THEN** the body SHALL equal:

```json
{
  "object": "list",
  "data": [
    {
      "id": "breeze-asr-25",
      "object": "model",
      "created": 1715800000,
      "owned_by": "whisper-wrap"
    }
  ]
}
```

#### Scenario: Catalogue reports `<MODEL_DIR>` override

- **WHEN** a client GETs `/v1/models` on a server started with `MODEL_DIR=/tmp/my-model` (so `/status` reports `model.name="<MODEL_DIR>"`)
- **THEN** the response SHALL list a single entry with `id="<MODEL_DIR>"`, matching the `/status` field exactly
