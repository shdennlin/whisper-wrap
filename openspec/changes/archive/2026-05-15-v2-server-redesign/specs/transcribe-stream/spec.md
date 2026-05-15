## ADDED Requirements

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

### Requirement: Disconnect mid-utterance discards in-flight buffer

If a client closes the WebSocket before the model emits a `final` event for the in-flight utterance, the server SHALL discard the in-flight buffer and SHALL NOT emit any further events for that utterance — no synthesised `final`, no `error`, no `warning`. This applies regardless of how the client closes the socket (clean close, abrupt disconnect, network error). The server SHALL log the early disconnect at INFO level for observability but SHALL NOT treat it as an error condition. A previously-completed utterance's `final` event from earlier in the same connection is NOT retracted by a subsequent disconnect.

#### Scenario: Client closes during partial stream

- **WHEN** a client has sent partial PCM frames for an in-progress utterance and then closes the socket
- **THEN** the server SHALL stop processing the in-flight audio and SHALL NOT emit a `final` event for that utterance

#### Scenario: Client closes after a final event but before sending more audio

- **WHEN** a client has received a `final` event for utterance A and then closes the socket without sending any new audio
- **THEN** the server SHALL NOT emit any additional events; the `final` already delivered for utterance A remains the authoritative transcript for that utterance

### Requirement: Server applies backpressure when audio arrives faster than ASR consumes

If a client streams audio faster than the in-process ASR can consume (typical when running on a slower device while sending continuously), the server SHALL maintain at most 30 seconds of buffered PCM. When that limit is reached, the server SHALL drop the oldest buffered audio to make room for the newest frames and SHALL emit a single text frame `{"type": "warning", "message": "buffer overflow, oldest audio dropped"}` per overflow event (not per dropped frame). The server SHALL NOT close the connection on buffer overflow; processing continues with the trimmed buffer.

#### Scenario: Buffer overflow drops oldest audio

- **WHEN** a client sends continuous audio faster than the ASR can transcribe for long enough to fill the 30-second buffer
- **THEN** the server SHALL drop the oldest buffered samples to keep at most 30 s queued, SHALL emit one `{"type":"warning","message":"buffer overflow, oldest audio dropped"}` text frame for that overflow event, and SHALL continue processing without closing the connection
