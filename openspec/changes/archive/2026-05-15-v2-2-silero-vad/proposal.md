## Summary

Replace the RMS-energy VAD inside `app/services/stream.py` with the neural [`silero-vad`](https://github.com/snakers4/silero-vad) model so `WS /listen` endpoints utterances on real speech-vs-non-speech detection instead of raw loudness, with an env-switchable fallback to the existing RMS path for constrained hosts.

## Motivation

v2.1 ships `WS /listen` with a fixed int16 RMS threshold (`SILENCE_RMS_THRESHOLD = 500.0` plus a 700 ms silence-duration check) for utterance endpointing. Real-world recordings show three failure modes:

- **Continuous environmental noise** (room fans, traffic outside the window, mechanical keyboard typing) keeps RMS above threshold even when the user is not speaking, so `_in_utterance` never finalises. The utterance buffer accumulates indefinitely; even the v2.1 sliding-window partial mitigation cannot mask the increasing end-of-utterance latency.
- **Quiet speech** (mumbling, far-mic, soft consonants) falls under the threshold, so legitimate speech frames are misclassified as silence and the start-of-utterance is missed entirely.
- **Mid-utterance pauses** (thinking, breath, sentence-internal punctuation) longer than 700 ms get split into separate utterances, producing fragmented `final` events for what should have been one sentence.

silero-vad is a small (~1 MB) PyTorch model widely used by every other open-source streaming Whisper project (WhisperLive, WhisperLiveKit, whisper_streaming) for exactly this purpose. It returns a per-frame speech probability and is robust against the failure modes above. It runs in-process on CPU even when the Whisper backend owns Metal / ANE.

## Proposed Solution

- Add `silero-vad` as a runtime dependency (sourced via `silero-vad` PyPI package; loads a TorchScript model bundle on first use, no separate weights download from the user's side).
- Create a new `app/services/vad.py` module exposing two interchangeable classes:
  - `RmsVad` — the current threshold-based detector lifted out of `stream.py` (preserves backwards compatibility for tests and constrained hosts).
  - `SileroVad` — neural detector wrapping `silero_vad.load_silero_vad()`; exposes the same `is_speech(pcm: bytes) -> bool` surface so `stream.py` does not branch on backend internally.
- Modify `app/services/stream.py` to depend on the VAD interface (not the inlined `compute_rms` call). The existing `SILENCE_DURATION_MS = 700` and "voice frame → start utterance / silence frame → check final" control flow stays as-is — only the per-frame "is this speech?" decision is replaced.
- Add a `VAD_BACKEND` env var (`silero` | `rms`) read by `app/config.py`. Default value SHALL be `silero` on hosts where the import succeeds, with an automatic fall-through to `rms` plus a one-line WARNING log if `silero-vad` is unavailable at runtime (e.g. user manually purged the dep).
- `/status` SHALL surface the active VAD backend so operators can tell at a glance which detector is running (`status["vad"]["backend"] = "silero" | "rms"`).
- Update `.env.example`, `README.md`, and `CLAUDE.md` to document `VAD_BACKEND` alongside `BACKEND_FORMAT`.

## Non-Goals

- **Endpointer neural model (predicting "user finished speaking")**: silero-vad outputs per-frame speech probability only, not "end of utterance" certainty. We keep the existing `SILENCE_DURATION_MS` heuristic on top. A dedicated endpointer model (Pyannote, Picovoice Cobra) is a separate future change.
- **VAD-driven gain control or noise suppression**: out of scope. silero-vad only classifies frames; we do not preprocess audio before handing it to Whisper.
- **Replacing silero-vad's own threshold (`speech_probability >= 0.5`)**: the library default is well-validated. Surface it as a tunable env var only if real-world tuning later proves necessary.
- **VAD for the batch `POST /transcribe` endpoint**: batch transcription is whole-file based, no endpointing needed. Only `WS /listen` is affected.

## Alternatives Considered

- **Keep RMS, tune thresholds per environment**: rejected — users would have to retune for every microphone / room change, and the failure modes (continuous noise, quiet speech) cannot be fixed by threshold tuning alone because RMS does not discriminate speech from non-speech energy.
- **WebRTC VAD (`py-webrtcvad`)**: rejected — older energy + GMM-based detector, less accurate than silero-vad on noisy mics in published benchmarks. silero-vad has effectively become the open-source streaming-ASR standard since 2022.
- **Replace VAD entirely with an endpointer neural model (Pyannote / Cobra)**: rejected for this change — pyannote.audio is a multi-hundred-MB dependency with stronger runtime requirements and the endpointer flow needs a different control loop than our current "silence-duration → final" logic. Better as a separate v3.x consideration.

## Impact

- Affected specs: modified `transcribe-stream` (VAD-related requirements) and modified `status` (new `vad` field in the response).
- Affected code:
  - New: `app/services/vad.py`, `tests/test_vad.py`, `tests/fixtures/vad/clean_speech.pcm`, `tests/fixtures/vad/fan_noise.pcm`, `tests/fixtures/vad/quiet_speech.pcm`
  - Modified: `app/services/stream.py`, `app/api/status.py`, `app/config.py`, `app/main.py`, `pyproject.toml`, `.env.example`, `README.md`, `CLAUDE.md`, `docs/INSTALLATION.md`, `tests/test_listen.py`, `tests/test_status.py`
  - Removed: the inline `compute_rms` helper and `SILENCE_RMS_THRESHOLD` constant move into `app/services/vad.py::RmsVad` (still exposed for tests via `from app.services.vad import compute_rms` re-export to keep `tests/test_listen.py`'s existing RMS-based fixture helpers working)
- Affected env vars:
  - Added: `VAD_BACKEND` (optional override: `silero` | `rms`; default resolves to `silero` if import succeeds, `rms` otherwise)
- Operational impact: new ~1 MB TorchScript download triggered on first server start (cached afterwards under `~/.cache/torch/hub/snakers4_silero-vad/`). Adds the `silero-vad` package + `torch` (already a transitive of `faster-whisper`) to the resolved environment. macOS partial latency target from v2.1 (≥3× faster than v2) SHALL still hold; silero-vad inference is ~1 ms per 30 ms frame on M-series CPU so the addition is invisible to wall-clock latency.
