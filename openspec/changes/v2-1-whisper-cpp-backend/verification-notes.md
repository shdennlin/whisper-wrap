## v2 baseline latency

- Target host:
- Capture command:
- Median ms:

## v2.1 measured latency

- Target host:
- Capture command:
- Median ms:
- Ratio vs baseline:

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
