## Context

`app/services/stream.py` currently runs an int16 RMS energy threshold as its voice-activity detector. The implementation lives inline as `compute_rms(pcm)` plus a hard-coded `SILENCE_RMS_THRESHOLD = 500.0`. v2.1 measurements on real microphone input surface three failure modes that no amount of threshold tuning fixes:

- Continuous low-grade noise (fans, traffic) keeps the threshold tripped → `_in_utterance` never returns to false → `_utterance_buffer` grows until the 30 s overflow cap, masking real silence breaks the user is producing.
- Quiet speech (soft consonants, distant mic) falls below the threshold → frames misclassified as silence → `start-of-utterance` missed and the leading text is dropped from the eventual partial / final.
- Sub-utterance pauses (mid-thought breath, comma) exceeding 700 ms fragment what should be one utterance into two, producing fragmented `final` events.

silero-vad (https://github.com/snakers4/silero-vad) is the open-source streaming-ASR standard for this problem. WhisperLive, WhisperLiveKit, and the UFAL `whisper_streaming` reference all use it; the model is ~1 MB and runs at <1 ms per 30 ms frame on Apple Silicon CPU.

## Goals / Non-Goals

**Goals:**

- Replace RMS-based per-frame speech detection with silero-vad on `WS /listen`.
- Keep RMS available as a fallback path via `VAD_BACKEND=rms`, both for hosts that cannot install `silero-vad` and for tests / benchmarks that need the cheap synthetic detector.
- Surface the active VAD backend through `GET /status` so operators can confirm at a glance which detector is engaged.
- Preserve the existing endpointing control flow in `stream.py`: silence-duration accumulation, partial/final cadence, sliding window for partial inference. Only the per-frame "is speech?" decision is replaced.
- The macOS partial-latency target from v2.1 (≥3× faster than v2 baseline) SHALL still hold; silero-vad inference must not add measurable wall-clock latency.

**Non-Goals:**

- **Neural end-of-utterance prediction**: silero-vad classifies frames as speech/non-speech only. Predicting "the speaker just finished a thought" needs a different model class (Pyannote, Picovoice Cobra). Out of scope.
- **Audio preprocessing / noise suppression / AGC**: VAD only classifies; we do not modify audio handed to Whisper.
- **Tunable speech-probability threshold**: silero-vad's built-in `speech_probability >= 0.5` default is used as-is. A `SILERO_VAD_THRESHOLD` env var would be a future change if tuning evidence warrants.
- **Custom VAD for batch `POST /transcribe`**: that endpoint receives complete audio files; VAD applies to the streaming endpoint only.
- **Replacing the v2.1 `SILENCE_DURATION_MS` heuristic**: the silence-accumulation logic that converts "non-speech frames" into "utterance finalises" is unchanged. silero-vad replaces the boolean classifier, not the surrounding endpointing logic.

## Decisions

### Decision 1: VadBackend protocol with two implementations

Introduce a thin `VadBackend` protocol in `app/services/vad.py` with one method:

```python
class VadBackend(Protocol):
    def is_speech(self, pcm: bytes) -> bool: ...
```

Two concrete implementations live in the same file: `RmsVad` (current logic, no new dependency) and `SileroVad` (TorchScript wrapper).

Rationale: keeps `stream.py` ignorant of which backend is engaged — same pattern as `app/services/_whisper_backend.py::WhisperBackend` in v2.1. Adding a third detector (WebRTC VAD, Pyannote) later only adds a new class plus a `VAD_BACKEND` enum value, no surgery on `stream.py`.

### Decision 2: Default to silero with auto-fallback to rms

`VAD_BACKEND` is resolved at lifespan startup:

1. If env var is explicitly `rms` → instantiate `RmsVad`.
2. If env var is explicitly `silero` → instantiate `SileroVad`. If `import silero_vad` fails, fail startup with a clear error naming the missing dependency (operator opted in explicitly).
3. If env var is unset → try `SileroVad` first. If the import succeeds, use it. If it fails, fall back to `RmsVad` and emit one INFO log line stating the fallback reason.

Rationale: most users SHOULD get the better detector without configuration. Operators who opt out get the cheap path with no surprise log spam. Operators who opt in explicitly want to know why their choice could not be honoured (fail fast).

### Decision 3: TorchScript model lives in the standard PyTorch hub cache

`silero-vad` loads its TorchScript bundle via `torch.hub.load(...)` (or the equivalent `silero_vad.load_silero_vad()` API). That call caches into `~/.cache/torch/hub/snakers4_silero-vad/`.

First-server-start triggers a one-time ~1 MB download from GitHub (with internet) or fails with a clear error (offline). After that, subsequent starts use the cache. We do not vendor the model into the repo because:

- The model is ~1 MB but git LFS adds operational complexity for a single-file artefact.
- silero releases new versions periodically; pinning via the library's package version is cleaner than a copy-pasted weights file.

Document this caching behaviour in `docs/INSTALLATION.md` so users on air-gapped machines know to prime the cache.

### Decision 4: Run silero-vad on 32 ms frames (512 samples at 16 kHz)

silero-vad's documented frame sizes are 256 / 512 / 768 / 1024 samples at 16 kHz. Our client frames come in at 250 ms = 4000 samples. We chunk each incoming client frame into 512-sample slices (32 ms each) and feed them sequentially to silero-vad; if ANY slice returns speech, the whole client frame is considered speech for the purposes of the `stream.py` control loop.

Rationale: 512 samples is the silero-recommended balance of latency / accuracy. Treating any-speech-in-frame as "voice frame" matches RMS behaviour (RMS aggregates the whole frame) so the surrounding silence-duration logic continues to work without re-tuning.

### Decision 5: Per-session VAD instance, not shared

Each `StreamSession` constructs its own `VadBackend` instance via a factory passed by the WS handler. Silero-vad's internal state (LSTM hidden state across frames) MUST be per-session — sharing state across concurrent WebSocket connections would mix speech context between users.

The factory is injected (similar to `transcribe_fn` and `send_event`) so tests can construct sessions with fake / RMS-only VAD without involving torch.

### Decision 6: Test fixtures are recorded PCM clips, not synthesised noise

`tests/fixtures/vad/` will hold three short (~5 s) PCM clips committed to the repo:

- `clean_speech.pcm` — clear Mandarin speech, expected silero=voice, rms=voice (sanity)
- `fan_noise.pcm` — continuous broadband noise without speech, expected silero=silence, rms=voice (this is the failure mode silero exists to fix)
- `quiet_speech.pcm` — quiet Mandarin speech, expected silero=voice, rms=silence (the other failure mode)

Generating these via macOS `say` + post-processing keeps them deterministic. Each fixture is ~160 KB at 16 kHz mono pcm_s16le for 5 s, all three together <1 MB — safely committable to git.

## Implementation Contract

#### Behavior

- **VAD_BACKEND unset, silero importable**: lifespan loads `SileroVad`. `/status` reports `vad.backend == "silero"`. WS /listen endpoints utterances using silero's per-frame speech probability with the existing `SILENCE_DURATION_MS` accumulator.
- **VAD_BACKEND unset, silero NOT importable**: lifespan emits one INFO log line "silero-vad unavailable, falling back to rms" and loads `RmsVad`. `/status` reports `vad.backend == "rms"`. Behaviour matches v2.1 exactly.
- **VAD_BACKEND=silero, silero NOT importable**: lifespan fails startup with `RuntimeError("VAD_BACKEND=silero requested but silero-vad is not installed")`. No server starts.
- **VAD_BACKEND=rms**: lifespan unconditionally loads `RmsVad`, never imports silero-vad. Useful for benchmarks / constrained hosts.
- **Continuous-noise scenario** (the failure case silero solves): when a fan-only fixture plays through WS /listen, the server SHALL NOT enter or stay in an utterance — `partial` and `final` events SHALL NOT be emitted. Under the old RMS path, partial events were emitted with empty / garbage text.
- **Quiet-speech scenario**: when a quiet-speech fixture plays through WS /listen with silero engaged, the server SHALL enter an utterance and emit at least one `final` event. Under the old RMS path, the utterance was missed entirely.

#### Interface / data shape

- `app.services.vad.VadBackend` protocol declares `is_speech(pcm: bytes) -> bool` only. Both `RmsVad` and `SileroVad` are constructable with no required positional arguments (each reads its own configuration internally, e.g. `RmsVad(threshold=SILENCE_RMS_THRESHOLD)` with a default).
- `app.services.vad.make_vad_backend(name: str | None) -> VadBackend` factory: maps the `VAD_BACKEND` env value to an instance, including the fallback logic from Decision 2. Returns the constructed backend (never None).
- `StreamSession.__init__` gains a keyword-only `vad_backend: VadBackend` parameter (default `RmsVad()` for backwards compatibility in existing tests). The WS handler in `app/api/listen.py` constructs the session with `vad_backend=request.app.state.vad_factory()`.
- `app.state.vad_factory: Callable[[], VadBackend]` is set during lifespan startup. The factory pattern allows per-session instances (Decision 5) without re-running the env resolution each connection.
- `/status` response gains a top-level `vad` object: `{"backend": "silero" | "rms"}`. The object is always present so clients can write defensive code.
- `app.config.Config.VAD_BACKEND: str | None` follows the same unset-vs-empty-vs-set semantics as `BACKEND_FORMAT` in v2.1.

#### Failure modes

- `silero-vad` package missing under `VAD_BACKEND=silero` → `RuntimeError` at startup naming the missing package and suggesting `uv add silero-vad`. Server does not start.
- TorchScript model download fails (network or air-gapped host) under `VAD_BACKEND=silero` → first request raises `WhisperLoadError("silero-vad model not in torch hub cache; run with internet access once to prime ~/.cache/torch/hub/")`. Server starts but `/listen` returns an error frame.
- Invalid `VAD_BACKEND` value (e.g. `webrtc`, typo) → `RuntimeError` at startup listing the accepted values (`silero`, `rms`).

#### Acceptance criteria

- Unit tests in `tests/test_vad.py` cover: `RmsVad` matches the old `compute_rms` behaviour on synthetic frames; `SileroVad` correctly classifies the three fixture clips; the factory returns `RmsVad` for `VAD_BACKEND=rms`, `SileroVad` for `VAD_BACKEND=silero`, and falls back gracefully for unset when silero is mocked-unavailable.
- Integration test extends `tests/test_status.py` to assert the `vad.backend` field is present and reports the active backend.
- Manual verification on the developer's Mac mini: stream 30 s of fan-only audio through `WS /listen`; confirm zero `partial` or `final` events. Switch to a 30 s clean-speech clip; confirm the utterances are captured and finalised correctly. Record results in `openspec/changes/v2-2-silero-vad/verification-notes.md`.

#### Scope boundaries

**In scope:**

- New `app/services/vad.py` with `VadBackend` protocol + `RmsVad` + `SileroVad` + `make_vad_backend` factory.
- `app/services/stream.py` refactor: replace inline `compute_rms` call with `vad_backend.is_speech(pcm)`.
- `app/api/listen.py` wiring: construct `StreamSession` with the per-session VAD backend.
- `app/main.py` lifespan: resolve `VAD_BACKEND` env, store factory on `app.state`.
- `app/api/status.py`: add `vad` block.
- Documentation refresh: `.env.example`, `README.md`, `CLAUDE.md`, `docs/INSTALLATION.md`.
- Test fixtures + unit tests + integration test.

**Out of scope:**

- Endpointer neural model (Pyannote, Cobra) — separate v3.x consideration.
- VAD-driven audio preprocessing (denoise, AGC) — separate concern.
- VAD on `POST /transcribe` — batch path needs no endpointing.
- Reworking `SILENCE_DURATION_MS` heuristic — keeps current value, only the per-frame classifier changes.
- Linux CI install path for `silero-vad` — Linux test runs SHALL set `VAD_BACKEND=rms` until a separate task verifies the silero+linux installation footprint.

## Risks / Trade-offs

- [silero-vad first-run TorchScript download requires internet] → Document caching behaviour in `docs/INSTALLATION.md`; `make setup` prime step SHALL fetch the model so air-gapped first-run after setup is OK; fallback path on missing cache produces a clear actionable error.
- [silero-vad introduces a torch.hub call inside the FastAPI lifespan, adding ~200 ms to startup the first time] → Acceptable for a personal Mac mini server; document the one-time cost. Subsequent starts hit the cache and are ~10 ms.
- [silero-vad internal LSTM state must be per-session — wrong sharing would mix speech contexts] → Factory pattern (Decision 5) enforces per-session instantiation. Tests cover two parallel sessions to confirm no state leakage.
- [Library updates between silero releases may change the API] → Pin to a known-good version range in `pyproject.toml` (`silero-vad>=5.0,<6.0`). Track upstream releases in CHANGELOG.
- [silero-vad has false-positive risk on music or singing] → Out of scope: the product target is speech transcription, not arbitrary audio. Document that VAD assumes spoken input.
- [Adding torch.hub side-channels (file download on first run) to the security review surface] → silero-vad's TorchScript bundle is from a well-known github repo (snakers4/silero-vad, 5k+ stars). Acceptable supply-chain risk for an open-source project; mitigations require a separate `spectra-audit` if security stance changes.
