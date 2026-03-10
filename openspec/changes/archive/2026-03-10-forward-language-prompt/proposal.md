## Why

When using Breeze ASR 25 (or other multilingual models) with `-l auto`, the model may produce missing punctuation or use Chinese punctuation marks (`，。？`) even for purely English speech. Users need control over the `language` and `prompt` parameters sent to whisper-server's `/inference` endpoint to guide punctuation style and language detection.

## What Changes

- Add optional `language` parameter to `/transcribe` and `/transcribe-raw` endpoints, forwarded to whisper-server (defaults to `auto` — preserving current behavior)
- Add optional `prompt` parameter to both endpoints, forwarded to whisper-server as the initial prompt (defaults to empty)
- Update `WhisperClient.transcribe()` to accept and forward these parameters to the `/inference` request

## Capabilities

### New Capabilities

- `inference-params`: User-facing API parameters (`language`, `prompt`) forwarded to whisper-server's inference endpoint for controlling transcription behavior

### Modified Capabilities

(none)

## Impact

- Affected code: `app/services/whisper.py`, `app/api/transcribe.py`
- Affected APIs: `POST /transcribe` and `POST /transcribe-raw` gain optional `language` and `prompt` parameters
- Backward compatible: all new parameters have defaults matching current behavior
