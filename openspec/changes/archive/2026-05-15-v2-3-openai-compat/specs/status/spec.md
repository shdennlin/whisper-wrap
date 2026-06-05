## MODIFIED Requirements

### Requirement: API discovery endpoint lists every registered route

The system SHALL expose `GET /` returning a JSON document that lists every public HTTP and WebSocket route registered on the FastAPI app. Each entry SHALL include the HTTP method (or the literal string `"WS"` for WebSocket routes), the URL path, and a one-line `description`. The list SHALL be a single source of truth for clients discovering the API surface; documentation generators MAY read it. The response SHALL be reachable without authentication.

The catalogue SHALL include the OpenAI-compatibility surface introduced by the `openai-compat` capability so operators can confirm at a glance that the compat layer is mounted.

#### Scenario: Discovery payload shape

- **WHEN** a client requests `GET /`
- **THEN** the response SHALL be HTTP 200 with a JSON document of shape `{"endpoints": [{"method": "POST", "path": "/transcribe", "description": "..."}, ...]}` and SHALL include at least these entries: `POST /transcribe`, `WS /listen`, `POST /ask`, `GET /status`, `GET /`, `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, `GET /v1/models`

##### Example: catalogue rows for OpenAI-compat routes

| method | path | description (illustrative; exact wording is implementation-defined) |
| ------ | ---- | --- |
| POST | /v1/audio/transcriptions | OpenAI-compatible audio transcription endpoint |
| POST | /v1/audio/translations | OpenAI-compatible audio translation endpoint (output: English) |
| GET | /v1/models | OpenAI-compatible model catalogue (lists the active whisper-wrap model) |
