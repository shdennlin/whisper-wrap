## Fan noise rejection

Test fixture: `tests/fixtures/vad/fan_noise.pcm` — 5 s of brown noise at
amplitude 0.15 (RMS well above the v2.1 RMS threshold of 500), pure
non-speech.

- **RmsVad on same fixture** — v2.1 baseline: emits ≥1 partial event with
  garbage transcribed text. This is the failure mode silero-vad exists to
  fix (the skipped test `test_rms_baseline_documents_failure_modes`
  documents this in code).
- **SileroVad on same fixture** — v2.2 behaviour: emits 0 partial events
  and 0 final events. The fan noise is correctly classified as non-speech
  by silero, so `_in_utterance` never becomes True and no inference is
  attempted. Verified by `tests/test_listen.py::test_fan_noise_emits_zero_events_with_silero`
  (passes in the test suite).

## Quiet speech capture

Test fixture: `tests/fixtures/vad/quiet_speech.pcm` — 5 s of synthesised
Mandarin TTS run through `ffmpeg -af "volume=0.15"` (RMS well below the
v2.1 threshold).

- **RmsVad on same fixture** — v2.1 baseline: emits 0 events because RMS
  never crosses the threshold. The speech is silently missed.
- **SileroVad on same fixture** — v2.2 behaviour: enters an utterance,
  emits ≥1 partial event during the speech, and emits exactly 1 final
  event after VAD-final silence accumulation. Verified by
  `tests/test_listen.py::test_quiet_speech_captures_utterance_with_silero`
  (passes in the test suite).

## Manual smoke (optional, on Mac mini)

To confirm subjective improvement against a real fan / continuous-noise
environment:

```bash
make dev
# Terminal B:
uv run python scripts/live-caption.py --server ws://localhost:12000/listen
# Hold a sentence under a fan; with silero, server should show no events
# during pure-fan moments; with rms (set VAD_BACKEND=rms) it triggers.
```
