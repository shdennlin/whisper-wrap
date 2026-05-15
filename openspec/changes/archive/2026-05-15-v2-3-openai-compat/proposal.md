## Why

The whisper-wrap server exposes `POST /transcribe` with a custom request and response schema. Several mature LLM clients in the open-source ecosystem — LibreChat, open-webui, Continue.dev, Cherry Studio, and a long tail of OpenAI-SDK-based scripts — expect the **OpenAI Whisper REST API** shape (`POST /v1/audio/transcriptions`). Today they cannot use whisper-wrap as a speech-to-text backend because the schemas do not match.

Closing this gap unlocks two concrete wins:

1. **Borrow an existing front-end for free.** A user can point any OpenAI-Whisper-compatible web UI (open-webui being the canonical example) at whisper-wrap, get a polished dictation / Q&A interface, and not need a bespoke PWA. The ROADMAP entry called this out: closing the OpenAI-compat gap may obsolete the need for a custom front-end.
2. **Programmatic clients reuse standard libraries.** Any existing Python / TypeScript / curl example that uses the OpenAI SDK becomes a working whisper-wrap client by changing only the base URL — no per-project adapter code.

This is a small, well-scoped surface change. The OpenAI Whisper API has been stable for over a year and well-documented at <https://platform.openai.com/docs/api-reference/audio/createTranscription>. We wrap our existing in-process `WhisperBackend` (which already handles all the heavy lifting) with a thin compatibility layer.

## What Changes

- Add `POST /v1/audio/transcriptions` that accepts the OpenAI request shape (multipart `file`, `model`, `language`, `prompt`, `response_format`, `temperature`) and returns the documented response shapes (`json`, `text`, `srt`, `verbose_json`, `vtt`).
- Add `POST /v1/audio/translations` (English-only output) — routes through the underlying Whisper backend's translation task. Returns the same response-format options.
- Add a `GET /v1/models` discovery endpoint that lists the active whisper-wrap model name in the OpenAI-compatible `data: [{"id": "...", "object": "model", ...}]` shape so OpenAI-SDK clients that probe the catalogue do not error.
- The `model` request field is **accepted but advisory**: whisper-wrap always loads exactly one model per process (the v2.1 registry / variant choice), so any non-empty `model` value is accepted; reserved OpenAI values (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`) are accepted as aliases that route to the active backend; an explicitly unknown / mismatched value is accepted with a one-line WARNING log so operators see why their client sent a surprising name.
- `response_format` defaults to `json`. `verbose_json` adds the per-segment fields (`segments[].start`, `segments[].end`, `segments[].text`, `segments[].avg_logprob` set to `null` since whisper.cpp does not expose it). `srt` and `vtt` are generated from segments using a small formatter helper. `text` returns `Content-Type: text/plain`.
- Update `/status` and `GET /` (the endpoint catalogue) to advertise the new `/v1/audio/transcriptions`, `/v1/audio/translations`, and `/v1/models` paths so operators can confirm the compat layer is live.

## Non-Goals

- **Streaming OpenAI compat (`/v1/audio/transcriptions` with `stream=true`)** — the OpenAI 2025 streaming variant is not yet ubiquitous; clients that need streaming use our native `WS /listen`. Add later if a real consumer asks.
- **Audio-input chat completions (`/v1/chat/completions` with audio modality)** — that is a Realtime API surface, not the Whisper surface. Out of scope.
- **Other OpenAI endpoints (`/v1/embeddings`, `/v1/chat/completions`, etc.)** — this change is the speech-to-text compatibility layer only. The `/ask` endpoint already routes to Gemini; making it OpenAI-chat-compatible is a separate proposal if ever wanted.
- **Authentication / bearer-token enforcement** — whisper-wrap is LAN-only by design (see INSTALLATION.md deployment scope). OpenAI compat accepts an `Authorization` header for SDK convenience but does not validate it. Adding token enforcement is a deployment-mode question, not an OpenAI-compat question.
- **Token usage accounting in the response** — OpenAI returns approximate token counts; whisper-wrap does not produce them and would have to fabricate values. Omitted rather than faked.
- **Replacing the existing `POST /transcribe` endpoint** — the new endpoint is additive. v2-shaped clients (iOS Shortcut, our own scripts) keep using `/transcribe`; OpenAI-shaped clients use `/v1/audio/transcriptions`.

## Capabilities

### New Capabilities

- `openai-compat`: OpenAI Whisper REST API compatibility layer. Wraps the in-process `WhisperBackend` with `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, and `GET /v1/models` matching the OpenAI request and response shapes documented at <https://platform.openai.com/docs/api-reference/audio>.

### Modified Capabilities

- `status`: `GET /` endpoint catalogue gains entries for the three `/v1/...` paths so the discovery payload reflects the actual mounted routes.

## Impact

- Affected specs: new `openai-compat`; modified `status` (endpoint catalogue).
- Affected code:
  - New: `app/api/openai_compat.py`, `app/services/subtitle_format.py`, `tests/test_openai_compat.py`
  - Modified: `app/main.py` (router include), `app/api/status.py` (catalogue entries), `README.md`, `CLAUDE.md`, `docs/INSTALLATION.md` (open-webui integration note)
  - Removed: (none)
- Affected env vars: (none) — the compat layer reads no new env vars; it reuses `app.state.whisper`, `app.state.llm_client`, and the existing model-resolution chain.
- Operational impact: zero additional dependencies, zero memory increase (no new model loaded). One new module + one new test module + a small subtitle formatter. The `/transcribe` semantics are unchanged so existing iOS Shortcut / CLI integrations keep working without edits.
- Integration impact: after this lands, the developer can run `docker run -p 3000:8080 ghcr.io/open-webui/open-webui:main` (or any OpenAI-compatible UI), point its STT base URL at `http://localhost:8000/v1`, and use whisper-wrap as the speech backend. Document this recipe in `docs/INSTALLATION.md`.
