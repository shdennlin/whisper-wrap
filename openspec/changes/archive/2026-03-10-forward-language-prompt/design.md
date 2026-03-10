## Context

whisper-wrap forwards audio to whisper-server's `/inference` endpoint with hardcoded parameters (`temperature`, `temperature_inc`, `response_format`). Users cannot control `language` or `prompt`, which are supported by whisper-server and directly affect punctuation style and language detection.

Current flow: `Client → whisper-wrap (fixed params) → whisper-server /inference`

## Goals / Non-Goals

**Goals:**

- Allow users to pass `language` and `prompt` through whisper-wrap to whisper-server
- Maintain backward compatibility (defaults match current behavior)

**Non-Goals:**

- Post-processing punctuation normalization
- Exposing all whisper-server parameters (only `language` and `prompt` for now)
- Changing whisper-server startup flags

## Decisions

### Forward parameters via form data

Both `/transcribe` (multipart) and `/transcribe-raw` (raw body) endpoints will accept `language` and `prompt` as query parameters. These are forwarded to whisper-server's `/inference` endpoint in the form data dict alongside existing `temperature` and `response_format` fields.

Query parameters are chosen over form fields because `/transcribe-raw` has a raw binary body — it cannot carry form fields. Query parameters work uniformly for both endpoints.

### Default language to auto

The `language` parameter defaults to `"auto"` matching the current `-l auto` flag on whisper-server startup. This preserves existing behavior when the parameter is omitted.

### Prompt as optional with no default

The `prompt` parameter defaults to empty string (no initial prompt). Users who want punctuation guidance can pass a styled prompt like `"Hello, how are you?"` to nudge the model toward English punctuation patterns.

## Risks / Trade-offs

- [Risk] Users pass invalid language codes → whisper-server returns an error. Mitigation: let whisper-server validate and return its error naturally — no need to duplicate validation.
- [Risk] Long prompts may affect transcription quality → Document recommended prompt length in API docs.
