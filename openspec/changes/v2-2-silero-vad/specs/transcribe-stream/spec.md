## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Server applies silence-duration endpointing to finalise utterances

The streaming wrapper SHALL accumulate non-speech frames per `VadBackend.is_speech` and convert sustained non-speech into a `final` event when the accumulator reaches `SILENCE_DURATION_MS` (700 ms by default). The accumulator SHALL reset to zero on every frame the backend classifies as speech.

The per-frame "is this speech?" decision is fully delegated to the active `VadBackend` — the v2.1 inline `compute_rms` energy check is replaced by `vad_backend.is_speech(pcm)`. The remainder of the endpointing control flow (utterance start on first voice frame, sliding-window partial inference, final on silence-duration threshold) is unchanged from v2.1.

`SILENCE_DURATION_MS` SHALL remain 700 ms by default. Tuning is a separate future change.

#### Scenario: Silero classifies frame as non-speech

- **WHEN** the active VAD is `SileroVad` and the most recent frame is classified as non-speech by silero
- **THEN** the silence accumulator SHALL advance by the frame duration; the inline RMS calculation SHALL NOT be consulted at all

#### Scenario: Sustained non-speech finalises utterance

- **WHEN** the silence accumulator reaches `SILENCE_DURATION_MS` (700 ms by default) during an active utterance
- **THEN** the server SHALL emit one `final` event and reset `_in_utterance` to false, regardless of which VAD backend produced the classifications

#### Scenario: Speech frame resets accumulator

- **WHEN** the active VAD classifies any frame as speech during a non-speech run shorter than `SILENCE_DURATION_MS`
- **THEN** the silence accumulator SHALL reset to zero and `_in_utterance` SHALL remain true (or transition to true if not yet in utterance)
