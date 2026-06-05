## Why

Whisper inference periodically returns empty or noise-only output that pollutes downstream consumers:

1. **Hallucinated punctuation** — silero-VAD occasionally fires on background noise; Whisper then returns strings like `"。"`, `"，"`, `"."`, or pure whitespace. These reach the PWA history (an empty `final` row), inflate session word counts, and break SRT/VTT exports.
2. **Zero-text but non-empty result** — Whisper sometimes returns `""` directly for sub-second clips. The current code treats this as a valid `final` event on `/listen` and as a valid `{"text": ""}` body on `/transcribe`.
3. **Wasted Gemini tokens on `/ask`** — when STT returns empty, `/ask` happily forwards the empty string (or the `prompt` template wrapping the empty transcript) to the LLM. The LLM then bills for empty-input handling and returns useless output. A single misfired tap costs real money.

All four transcription surfaces (`/listen` WS, `POST /transcribe`, `POST /ask`, `POST /v1/audio/transcriptions` and `POST /v1/audio/translations`) share this defect because each calls the same `WhisperBackend.transcribe` but no shared post-process step exists between backend output and HTTP response.

## What Changes

- **New `app/services/postprocess.py` module** centralises the "is this transcription empty?" check. Pure function: `filter_empty_transcription(text, duration_ms, *, enabled, min_duration_ms) -> FilterDecision`. `FilterDecision` is one of `Keep(text)` or `Drop(reason: Literal["empty_text", "below_min_duration"])`.
- **Two env vars** read in `Config.__init__`: `FILTER_EMPTY_ENABLED` (default `true`) and `FILTER_MIN_DURATION_MS` (default `500`). Empty value → use default. Invalid value → log WARN + use default.
- **Per-endpoint filter integration**, each with the appropriate observable behavior:
  - `/listen` (`app/api/listen.py` / `app/services/stream.py`): when a final is dropped, NO `final` event is emitted on the WebSocket; no row reaches the client. Existing partial-consensus + VAD behavior is unchanged for non-dropped finals.
  - `POST /transcribe` (`app/api/transcribe.py`): when filtered, the response is HTTP 200 with body `{"text": ""}`. Callers that rely on truthy `text` already handle empty strings.
  - `POST /ask` (`app/api/ask.py`): when STT output is filtered (audio inputs only), the endpoint SHALL return HTTP 400 with body `{"error": "no_speech_detected"}` and SHALL NOT invoke the LLM. The streaming variant (`?stream=true`) SHALL emit `event: error\ndata: {"error": "no_speech_detected"}` followed by stream close. The text-input JSON path is unaffected (validation already rejects empty `text` per existing `ask` spec).
  - `POST /v1/audio/transcriptions` and `POST /v1/audio/translations` (`app/api/openai_compat.py`): when filtered, the response body remains `{"text": ""}` for the `json` and `verbose_json` formats, an empty string for the `text` format, and a single empty cue (`1\n00:00:00,000 --> 00:00:00,000\n\n`) for `srt` / `vtt`. **The OpenAI response schema SHALL NOT gain custom fields** — third-party clients (whisper.cpp CLI, faster-whisper CLI, Open WebUI, OpenAI Python SDK) reject unknown keys.
- **Logging at the filter point** uses `logger.info("transcription_filtered", extra={"reason": ..., "endpoint": ..., "duration_ms": ..., "raw_text_len": ...})`. The log is the only audit trail for filtered transcriptions — no row is added to the `sessions` / `finals` SQLite tables, and no entry reaches the PWA history. This separation is intentional: filtered events are noise-correction telemetry, not session content.
- **`/v1/audio/transcriptions` `verbose_json` segments**: when the filter decides Drop, the `segments` array SHALL be empty (`[]`), `language` SHALL still be reported when STT detected one, and `duration` SHALL reflect the input audio duration. This keeps the schema valid while signalling "no content" the same way OpenAI does for silent audio.
- **`.env.example`** SHALL document both new env vars with the defaults and the recommendation: keep enabled in production; disable only when diagnosing why specific speech is being filtered.

## Non-Goals

- WebSocket `/listen` server-side persistence — out of scope (see `history-ux-overhaul`'s Non-Goals).
- Hallucination detection beyond empty / punctuation-only output. Filtering content like `"Thanks for watching!"` (a known Whisper hallucination for silent clips) is a separate concern and would require pattern matching against a curated list.
- Per-request override (`?filter=false`). Use the env var to disable globally for debugging.
- Min-duration adjustment per language. Chinese single-character utterances ("好", "對") may legitimately be under 500 ms; users for whom this matters SHALL adjust `FILTER_MIN_DURATION_MS` down for their environment.
- Recording filtered events to the SQLite database. Filtered events are logged only; they SHALL NOT inflate `sessions.duration_ms`, the `finals` table, or any frontend history surface.
- Changing the `/listen` WS error frame format. Filtering is a silent operation — the client receives no signal.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `transcribe-stream`: gains the post-process filter that prevents empty `final` WS events and shapes `/transcribe` empty responses.
- `ask`: gains an early-exit 400 when audio STT yields empty content (audio path only).
- `openai-compat`: gains a per-format empty-response contract for filtered transcriptions and a `verbose_json` `segments=[]` contract.

## Impact

- Affected specs: `transcribe-stream`, `ask`, `openai-compat`
- Affected code:
  - New:
    - `app/services/postprocess.py`
    - `tests/test_postprocess.py`
  - Modified:
    - `app/config.py` (read `FILTER_EMPTY_ENABLED`, `FILTER_MIN_DURATION_MS`)
    - `app/services/stream.py` (call `filter_empty_transcription` before emitting `final`; drop silently when filtered; log the drop)
    - `app/api/listen.py` (no behavior change beyond what `stream.py` exposes; only updated if the filter check actually moves to the WS handler rather than the stream pipeline)
    - `app/api/transcribe.py` (apply filter to backend output before building the response; emit log; return empty body shape)
    - `app/api/ask.py` (apply filter after STT for audio inputs; return 400 / SSE error on Drop; emit log)
    - `app/api/openai_compat.py` (apply filter after STT; shape empty responses per format; emit log)
    - `tests/test_config.py` (defaults + env override cases for both new vars)
    - `tests/test_listen.py` (drop-final cases: pure whitespace, sub-min-duration, punctuation-only)
    - `tests/test_api.py` (`/transcribe` empty-response shape; logger asserts via caplog)
    - `tests/test_ask.py` (audio path 400 + SSE error; LLM mock NOT called)
    - `tests/test_openai_compat.py` (each response format's empty contract; LLM never invoked for `/v1/audio/translations` either)
    - `.env.example`
    - `README.md` (one short subsection under Configuration)
  - Removed: (none)
