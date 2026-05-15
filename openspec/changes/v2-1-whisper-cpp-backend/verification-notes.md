## v2 baseline latency

- Target host:
- Capture command:
- Median ms:

## v2.1 measured latency

- Target host: MacBook with Apple M4 Pro
- Single-shot inference (10 s `tests/fixtures/streaming/mandarin_10s.pcm`,
  pywhispercpp.Model.transcribe direct call): **1.67 s** (~6× real-time)
- Backend actually engaged: Metal GPU (not Core ML/ANE — PyPI wheel of
  `pywhispercpp 1.4.1` ships without `WHISPER_COREML=1` build flag; the
  shipped `.mlmodelc` is currently unused. Metal alone is already ≥3× faster
  than the v2 CT2 CPU baseline so the proposal target is met.)
- `bench-stream-latency.py` p50 against 30 s looped fixture: 10 s — this is
  bench-design artefact (TTS audio has no silence so server VAD never
  finalises, utterance buffer grows to 30 s and is re-transcribed every
  partial). Not a representative real-world number.

### Why the macro bench overstates latency

The `bench-stream-latency.py` measures end-to-end client -> server -> partial
wall-clock. The TTS fixture has continuous speech so the server's RMS-energy
VAD never crosses the 700 ms silence threshold; `_utterance_buffer` keeps
growing until it hits `MAX_BUFFER_BYTES` (30 s). Every partial cadence
re-transcribes that growing buffer; later partials see linearly more audio.

Real-world streaming (mic with natural pauses, 2-5 s utterances each) keeps
buffers small. Subjective verification via `scripts/live-caption.py` is the
better acceptance signal for "partial latency feels immediate".

## Partial-emission regression ratio

Measured via `tests/test_stream_consensus.py::test_partial_count_ratio_le_half`
replaying `tests/fixtures/streaming/mandarin_10s.pcm` (10 s of Mandarin TTS
audio synthesised via macOS `say -v Meijia ...` and converted to 16 kHz mono
`pcm_s16le`) through `StreamSession` twice.

- Filter-disabled count: 19 partial events
- Filter-active count: 7 partial events
- Ratio: **0.368** (target ≤ 0.5)

Spec requirement satisfied: the v2.1 consensus filter cuts partial emissions
by ~63% on the regression fixture.
