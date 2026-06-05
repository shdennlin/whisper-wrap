# transcribe-stream Specification

## Purpose

TBD - created by archiving change 'v2-server-redesign'. Update Purpose after archive.

## Requirements

### Requirement: WebSocket endpoint accepts 16 kHz mono PCM audio

The system SHALL expose `WS /listen` that accepts binary WebSocket frames containing 16 kHz mono PCM audio chunks encoded as little-endian signed 16-bit integers (`pcm_s16le`). Each binary frame SHALL be in the inclusive range `[200 bytes, 65 536 bytes (64 KiB)]`; frames smaller than 200 bytes (less than ~6 ms of audio) or larger than 64 KiB SHALL be rejected. Clients SHOULD send frames sized around 250 ms of audio (4 000 samples = 8 000 bytes at `pcm_s16le`) for stable partial cadence. The server SHALL perform any conversion to float internally before invoking the ASR model; clients SHALL NOT send float frames.

A single WebSocket connection MAY carry multiple utterances back-to-back: the server SHALL continue accepting binary frames after a `final` event is emitted and SHALL treat subsequent audio as the next utterance. Each utterance's timestamps SHALL be measured relative to the connection start (not relative to the utterance start), so timestamps are monotonically non-decreasing across the lifetime of the connection.

#### Scenario: Client streams PCM frames

- **WHEN** a client opens `WS /listen` and sends a sequence of binary frames containing `pcm_s16le` 16 kHz mono samples
- **THEN** the server SHALL accept the frames and SHALL feed them to the shared in-process ASR model without buffering the entire stream first

#### Scenario: Non-binary frame received

- **WHEN** a client sends a text WebSocket frame instead of a binary frame after the connection is open
- **THEN** the server SHALL send `{"type": "error", "message": "binary PCM expected"}` as a text frame and SHALL close the socket with WebSocket close code `1003` (Unsupported Data)

#### Scenario: Binary frame too small

- **WHEN** a client sends a binary frame smaller than 200 bytes
- **THEN** the server SHALL send `{"type": "error", "message": "frame size out of range"}` and close the socket with code `1003`

#### Scenario: Binary frame too large

- **WHEN** a client sends a binary frame larger than 65 536 bytes
- **THEN** the server SHALL send `{"type": "error", "message": "frame size out of range"}` and close the socket with code `1003`

#### Scenario: Multiple utterances per connection

- **WHEN** a client streams audio that contains two utterances separated by silence within the same WebSocket connection
- **THEN** the server SHALL emit a `final` event for the first utterance, then continue accepting frames, then emit additional `partial` and `final` events for the second utterance, with all timestamps measured relative to the original connection start


<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: Server emits timestamped partial and final transcript events

The system SHALL emit JSON text frames in two shapes during a `/listen` session. Both shapes SHALL carry `start_ms` and `end_ms` fields measured in milliseconds relative to the start of the WebSocket connection. Timestamps within a single utterance SHALL be monotonically non-decreasing and SHALL never go backwards across utterances within the same connection.

#### Scenario: Partial transcript event shape

- **WHEN** the ASR model produces an interim transcript for the audio received so far in the current utterance
- **THEN** the server SHALL emit a JSON text frame matching the shape `{"type": "partial", "text": "...", "start_ms": <int>, "end_ms": <int>}`

#### Scenario: Final transcript event shape

- **WHEN** the ASR model produces a finalised transcript for a completed utterance (typically after Voice Activity Detection endpointing detects sustained silence)
- **THEN** the server SHALL emit a JSON text frame matching the shape `{"type": "final", "text": "...", "start_ms": <int>, "end_ms": <int>}`

##### Example: ordering and timestamps for a single utterance

| Event order | type | start_ms | end_ms | Notes |
| ----------- | ---- | -------- | ------ | ----- |
| 1 | partial | 0 | 900 | After ~1 s of audio received |
| 2 | partial | 0 | 1800 | After ~2 s of audio received |
| 3 | final | 0 | 2400 | VAD endpoint detected at 2.4 s |


<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: Disconnect mid-utterance discards in-flight buffer

If a client closes the WebSocket before the model emits a `final` event for the in-flight utterance, the server SHALL discard the in-flight buffer and SHALL NOT emit any further events for that utterance — no synthesised `final`, no `error`, no `warning`. This applies regardless of how the client closes the socket (clean close, abrupt disconnect, network error). The server SHALL log the early disconnect at INFO level for observability but SHALL NOT treat it as an error condition. A previously-completed utterance's `final` event from earlier in the same connection is NOT retracted by a subsequent disconnect.

#### Scenario: Client closes during partial stream

- **WHEN** a client has sent partial PCM frames for an in-progress utterance and then closes the socket
- **THEN** the server SHALL stop processing the in-flight audio and SHALL NOT emit a `final` event for that utterance

#### Scenario: Client closes after a final event but before sending more audio

- **WHEN** a client has received a `final` event for utterance A and then closes the socket without sending any new audio
- **THEN** the server SHALL NOT emit any additional events; the `final` already delivered for utterance A remains the authoritative transcript for that utterance


<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: Server applies backpressure when audio arrives faster than ASR consumes

If a client streams audio faster than the in-process ASR can consume (typical when running on a slower device while sending continuously), the server SHALL maintain at most 30 seconds of buffered PCM. When that limit is reached, the server SHALL drop the oldest buffered audio to make room for the newest frames and SHALL emit a single text frame `{"type": "warning", "message": "buffer overflow, oldest audio dropped"}` per overflow event (not per dropped frame). The server SHALL NOT close the connection on buffer overflow; processing continues with the trimmed buffer.

#### Scenario: Buffer overflow drops oldest audio

- **WHEN** a client sends continuous audio faster than the ASR can transcribe for long enough to fill the 30-second buffer
- **THEN** the server SHALL drop the oldest buffered samples to keep at most 30 s queued, SHALL emit one `{"type":"warning","message":"buffer overflow, oldest audio dropped"}` text frame for that overflow event, and SHALL continue processing without closing the connection

<!-- @trace
source: v2-server-redesign
updated: 2026-05-15
code:
  - app/services/vad.py
  - app/services/_whisper_backend.py
  - scripts/bench-stream-latency.py
  - docker-compose.yml
  - app/config.py
  - README.md
  - app/__init__.py
  - CHANGELOG.md
  - app/api/ask.py
  - app/services/converter.py
  - .gitmodules
  - app/services/registry.py
  - pyproject.toml
  - app/main.py
  - app/api/status.py
  - deploy/whisper-wrap.service
  - tests/fixtures/vad/fan_noise.pcm
  - whisper.cpp
  - Dockerfile
  - samples/.gitkeep
  - tests/fixtures/vad/quiet_speech.pcm
  - tests/fixtures/streaming/mandarin_10s.pcm
  - app/api/transcribe.py
  - app/services/stream.py
  - Makefile
  - docs/ROADMAP.md
  - app/api/listen.py
  - uv.lock
  - scripts/model-manager.sh
  - registry/models.yaml
  - app/services/whisper.py
  - docs/TROUBLESHOOTING.md
  - scripts/live-caption.py
  - CLAUDE.md
  - scripts/record-and-transcribe.sh
  - docs/INSTALLATION.md
  - scripts/fetch-samples.sh
  - .env.example
  - docs/PRD-roadmap.md
  - docs/API.md
  - tests/fixtures/vad/clean_speech.pcm
  - app/services/llm.py
  - app/services/whisper_ct2.py
  - app/services/whisper_cpp.py
  - app/services/whisper_manager.py
tests:
  - tests/test_model_manager.py
  - tests/test_listen.py
  - tests/test_ask.py
  - tests/test_status.py
  - tests/test_whisper_ct2.py
  - tests/test_lifespan_integration.py
  - tests/test_registry_variants.py
  - tests/test_vad.py
  - tests/test_backend_protocol.py
  - tests/test_stream_consensus.py
  - tests/test_whisper_cpp.py
  - tests/test_config.py
  - tests/test_api.py
  - tests/test_whisper.py
  - tests/test_llm.py
  - tests/test_main.py
-->

---
### Requirement: Partial-consensus filter stabilises partial emissions

The system SHALL apply a single-step consensus filter inside `app/services/stream.py` before emitting `partial` events on `WS /listen`. For each completed sliding-window inference within an in-flight utterance, the wrapper SHALL:

1. Compute the longest common prefix (LCP) of the current inference's transcript and the immediately previous inference's transcript, both compared as Unicode strings.
2. Truncate the LCP at the last whitespace or punctuation boundary (so partial emissions never end mid-word). If no boundary exists inside the LCP, the truncated prefix SHALL be the empty string.
3. Emit a `partial` event whose `text` is the truncated prefix only when (a) the truncated prefix is non-empty AND (b) the truncated prefix differs from the most recently emitted `partial` text. Otherwise, no `partial` event SHALL be emitted for this inference round.
4. Cache the current inference's full transcript as the "previous inference" for the next round.

The `start_ms` of each emitted `partial` SHALL remain anchored to the utterance start (unchanged from v2 semantics). The `end_ms` SHALL reflect the position at which the truncated prefix ends within the inferred segments, computed by mapping the truncated prefix length back to the deepest segment whose accumulated text length covers that prefix.

The filter SHALL NOT alter `final` event behaviour: when the underlying VAD endpointing fires, the wrapper SHALL still emit a `final` event whose `text` is the full transcript of the just-completed utterance, even if no `partial` ever stabilised during that utterance (the "starvation" case).

#### Scenario: Two stable inferences produce a partial

- **WHEN** within an in-flight utterance the inference at window N produces transcript "今天" and the inference at window N+1 produces "今天天氣"
- **THEN** the wrapper SHALL compute LCP "今天", emit a `partial` event with `text="今天"` (after the inference at N+1), and cache "今天天氣" as the previous transcript for window N+2

#### Scenario: Unstable consecutive inferences emit no partial

- **WHEN** within an in-flight utterance window N produces "今天" and window N+1 produces "明天天氣很好"
- **THEN** the wrapper SHALL compute an empty LCP (no shared prefix at a word boundary), SHALL NOT emit a `partial` event for window N+1, and SHALL cache "明天天氣很好" as the previous transcript

#### Scenario: Idempotent partial is suppressed

- **WHEN** the wrapper has already emitted a `partial` event with `text="今天天氣"` and the next inference round produces an LCP that truncates back to "今天天氣"
- **THEN** the wrapper SHALL NOT emit a second `partial` event with the same text

#### Scenario: Final still emits when no partial ever stabilised

- **WHEN** an utterance contains only one inference round before VAD-final fires (e.g. a single short word "好"), so no consecutive-inference consensus is possible
- **THEN** the wrapper SHALL emit zero `partial` events for the utterance but SHALL still emit one `final` event with the full transcript

##### Example: LCP truncation with mixed-language transcript

| Window N transcript | Window N+1 transcript | LCP raw | LCP at word boundary | Emitted partial |
| ------------------- | --------------------- | ------- | -------------------- | --------------- |
| "I went to" | "I went to the store" | "I went to" | "I went to" | `text="I went to"` |
| "I went to" | "I want some coffee" | "I w" | "" | none |
| "今天天氣" | "今天天氣不錯" | "今天天氣" | "今天天氣" | `text="今天天氣"` |
| "Hello wor" | "Hello world" | "Hello wor" | "Hello" | `text="Hello"` |


<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Partial-consensus filter reduces emission rate

When measured against a captured-audio regression fixture (10 seconds of continuous Mandarin speech recorded at 16 kHz mono, replayed deterministically against `WS /listen`), the total number of `partial` events emitted by a v2.1 server with the consensus filter active SHALL be ≤50% of the count emitted by a v2.0 server (no consensus filter) against the same fixture under the same VAD configuration.

This requirement SHALL be verified by a regression test (`tests/test_stream_consensus.py`) that injects the captured PCM through the stream wrapper with both filter-on and filter-off code paths and asserts the count ratio.

#### Scenario: Consensus filter halves partial emissions on regression fixture

- **WHEN** the regression test replays the 10 s Mandarin fixture through the stream wrapper with the consensus filter active, and separately through the same wrapper with the filter disabled (counted directly from the underlying inference loop)
- **THEN** the filter-active partial count SHALL be ≤50% of the filter-disabled partial count

##### Example: target reduction on shipped fixture

| Fixture | Filter disabled | Filter active | Ratio | Pass |
| ------- | --------------- | ------------- | ----- | ---- |
| 10 s Mandarin sample A | 18 partials | 7 partials | 0.39 | yes (≤0.5) |
| 10 s Mandarin sample B | 22 partials | 10 partials | 0.45 | yes (≤0.5) |

<!-- @trace
source: v2-1-whisper-cpp-backend
updated: 2026-05-15
code:
  - app/services/whisper_cpp.py
  - tests/fixtures/vad/fan_noise.pcm
  - CLAUDE.md
  - registry/models.yaml
  - app/services/stream.py
  - app/services/whisper_ct2.py
  - tests/fixtures/streaming/mandarin_10s.pcm
  - uv.lock
  - app/services/converter.py
  - app/api/listen.py
  - app/api/status.py
  - app/services/registry.py
  - scripts/bench-stream-latency.py
  - pyproject.toml
  - README.md
  - docs/INSTALLATION.md
  - app/services/whisper.py
  - tests/fixtures/vad/clean_speech.pcm
  - app/api/ask.py
  - tests/fixtures/vad/quiet_speech.pcm
  - app/services/vad.py
  - app/config.py
  - docs/ROADMAP.md
  - app/main.py
  - .env.example
  - app/services/_whisper_backend.py
  - scripts/model-manager.sh
  - app/api/transcribe.py
  - app/services/llm.py
tests:
  - tests/test_config.py
  - tests/test_stream_consensus.py
  - tests/test_api.py
  - tests/test_backend_protocol.py
  - tests/test_lifespan_integration.py
  - tests/test_ask.py
  - tests/test_listen.py
  - tests/test_model_manager.py
  - tests/test_registry_variants.py
  - tests/test_whisper_cpp.py
  - tests/test_status.py
  - tests/test_vad.py
  - tests/test_registry.py
  - tests/test_whisper.py
  - tests/test_whisper_ct2.py
  - tests/test_main.py
-->

---
### Requirement: Voice activity detection backend is pluggable

The streaming wrapper SHALL classify each incoming PCM frame as speech or non-speech via a pluggable `VadBackend` protocol declared in `app/services/vad.py`. The protocol SHALL declare a single method `is_speech(pcm: bytes) -> bool` returning True when the frame contains speech and False otherwise.

The shipped concrete implementations SHALL be:

- `RmsVad` — int16 RMS-energy threshold (the v2.1 behaviour preserved for fallback and benchmarks).
- `SileroVad` — wraps the open-source `silero-vad` neural model loaded via `silero_vad.load_silero_vad()`, slicing each incoming client frame into 512-sample (32 ms) chunks before submitting them to the model and treating any-speech-in-frame as the frame's class.

`StreamSession.__init__` SHALL accept a keyword-only `vad_backend: VadBackend` parameter. The `app/api/listen.py` WebSocket handler SHALL construct a fresh `VadBackend` instance per session via the factory stored on `app.state.vad_factory`, so the silero-vad internal LSTM state never leaks across concurrent sessions.

#### Scenario: Caller does not branch on backend type

- **WHEN** a developer reviews `app/services/stream.py` after v2.2 lands
- **THEN** the module SHALL NOT import any concrete VAD class (`SileroVad`, `RmsVad`) directly; it SHALL operate against the `VadBackend` protocol surface only

#### Scenario: Per-session instance prevents state leakage

- **WHEN** two concurrent `WS /listen` connections speak alternating utterances
- **THEN** each session SHALL hold its own `VadBackend` instance and silero-vad's hidden state SHALL be reset to the initial state when each session begins, so one session's speech does not bias the other's per-frame classification

---
### Requirement: VAD_BACKEND env var selects the active backend

The server SHALL read `VAD_BACKEND` from the environment at lifespan startup with the following precedence:

1. If `VAD_BACKEND=rms` → instantiate `RmsVad` unconditionally; never import `silero-vad`.
2. If `VAD_BACKEND=silero` → instantiate `SileroVad`. If `import silero_vad` raises `ImportError`, the server SHALL fail startup with `RuntimeError("VAD_BACKEND=silero requested but silero-vad is not installed; install with: uv add silero-vad")`.
3. If `VAD_BACKEND` is unset OR empty → try `SileroVad` first. If the import succeeds, use it. If it fails, fall back to `RmsVad` and emit exactly one INFO log line `"silero-vad unavailable, falling back to rms"`.
4. If `VAD_BACKEND` is set to any other value → the server SHALL fail startup with `RuntimeError("VAD_BACKEND=<value> is not recognised; accepted values: silero, rms")`.

#### Scenario: Default config with silero installed

- **WHEN** the server starts on a host where `silero-vad` is importable and no `VAD_BACKEND` env var is set
- **THEN** the server SHALL load `SileroVad`, SHALL NOT emit a fallback log line, and SHALL NOT consult RMS thresholds during VAD decisions

#### Scenario: Default config with silero missing

- **WHEN** the server starts on a host where `import silero_vad` raises ImportError and no `VAD_BACKEND` env var is set
- **THEN** the server SHALL emit one INFO log line `"silero-vad unavailable, falling back to rms"` and SHALL load `RmsVad`; the server SHALL start successfully

#### Scenario: Explicit silero opt-in with missing package

- **WHEN** the server starts with `VAD_BACKEND=silero` set in the environment and `import silero_vad` raises ImportError
- **THEN** the server SHALL fail startup with a RuntimeError naming silero-vad as the missing dependency and including the `uv add silero-vad` install hint

#### Scenario: Explicit rms opt-in

- **WHEN** the server starts with `VAD_BACKEND=rms` set in the environment
- **THEN** the server SHALL load `RmsVad` directly, SHALL NOT import `silero_vad`, and SHALL NOT emit any fallback log line

#### Scenario: Unrecognised VAD_BACKEND value

- **WHEN** the server starts with `VAD_BACKEND=webrtc` (or any value other than `silero` / `rms`) set in the environment
- **THEN** the server SHALL fail startup with a RuntimeError naming the offending value and listing the accepted values

---
### Requirement: Silero-vad correctly endpoints continuous-noise environments

When the active VAD backend is `SileroVad` and `WS /listen` receives a stream of pure non-speech audio (continuous fan noise, traffic, room tone — anything that crossed the v2.1 RMS threshold), the server SHALL NOT enter an utterance and SHALL NOT emit any `partial` or `final` events for the duration of the noise.

This requirement directly addresses the v2.1 RMS-threshold failure mode where ambient noise above the energy threshold caused the utterance buffer to grow indefinitely and emit garbage partials.

#### Scenario: Fan-noise fixture produces zero events

- **WHEN** a client streams 5 seconds of fan-noise PCM (sampled at 16 kHz mono pcm_s16le, RMS ~1500 — well above the v2.1 threshold of 500) through `WS /listen` with `VAD_BACKEND=silero`
- **THEN** the server SHALL emit zero `partial` events and zero `final` events; `_in_utterance` SHALL remain false throughout

##### Example: regression test fixture

| Fixture | Backend | Expected events |
| ------- | ------- | --------------- |
| `tests/fixtures/vad/fan_noise.pcm` | silero | 0 partial, 0 final |
| `tests/fixtures/vad/fan_noise.pcm` | rms | ≥1 partial (regression — known v2.1 failure) |

---
### Requirement: Silero-vad captures quiet speech the RMS threshold misses

When the active VAD backend is `SileroVad` and `WS /listen` receives speech audio whose RMS energy is below the v2.1 threshold (mumbling, far-mic, quiet consonants), the server SHALL enter an utterance and SHALL emit at least one `final` event for the captured speech.

This requirement addresses the second v2.1 failure mode where quiet speech fell under the energy threshold and was misclassified as silence, missing start-of-utterance entirely.

#### Scenario: Quiet-speech fixture is captured

- **WHEN** a client streams 5 seconds of quiet-speech PCM (intelligible Mandarin speech with RMS ~300 — below the v2.1 threshold of 500) through `WS /listen` with `VAD_BACKEND=silero`
- **THEN** the server SHALL enter an utterance, SHALL emit at least one `partial` event during the speech, and SHALL emit exactly one `final` event after silence-duration accumulates post-speech

##### Example: regression test fixture

| Fixture | Backend | Expected events |
| ------- | ------- | --------------- |
| `tests/fixtures/vad/quiet_speech.pcm` | silero | ≥1 partial, 1 final |
| `tests/fixtures/vad/quiet_speech.pcm` | rms | 0 partial, 0 final (regression — known v2.1 failure) |

---
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


<!-- @trace
source: transcription-empty-filter
updated: 2026-06-05
code:
  - uv.lock
  - pyproject.toml
  - CHANGELOG.md
  - frontend/package.json
-->

---
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

<!-- @trace
source: transcription-empty-filter
updated: 2026-06-05
code:
  - uv.lock
  - pyproject.toml
  - CHANGELOG.md
  - frontend/package.json
-->