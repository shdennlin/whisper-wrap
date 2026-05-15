## ADDED Requirements

### Requirement: /status surfaces the active VAD backend

`GET /status` SHALL include a top-level `vad` object naming the active voice-activity-detection backend. The object SHALL contain the field `backend: "silero" | "rms"`. The object SHALL always be present (never null and never missing) so monitoring clients can write defensive code that does not need null-checks per response.

The field SHALL reflect the runtime resolution per the `VAD_BACKEND` env var rules in the `transcribe-stream` capability: if `VAD_BACKEND` was unset and silero-vad was importable, the field SHALL be `"silero"`; if silero-vad fell back to RMS at startup, the field SHALL be `"rms"`.

#### Scenario: silero-vad active on macOS default config

- **WHEN** a client sends `GET /status` after the server started with `silero-vad` installed and no `VAD_BACKEND` env var set
- **THEN** the response SHALL include `"vad": {"backend": "silero"}` alongside the existing `/status` fields

#### Scenario: rms-vad active under explicit opt-out

- **WHEN** a client sends `GET /status` after the server started with `VAD_BACKEND=rms` set in the environment
- **THEN** the response SHALL include `"vad": {"backend": "rms"}`

#### Scenario: rms-vad active under auto-fallback

- **WHEN** a client sends `GET /status` after the server started with `VAD_BACKEND` unset on a host where `import silero_vad` failed
- **THEN** the response SHALL include `"vad": {"backend": "rms"}`, indistinguishable from the explicit opt-out case
