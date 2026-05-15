# whisper-wrap Roadmap

Post-v2.1 backlog. Items here are not yet specced — each becomes a `spectra-propose <name>`
when picked up. Order is recommended priority (highest CP at top).

---

## v2.2 — Streaming quality + ecosystem integration

### 1. silero-vad replacing RMS-energy VAD

**Problem.** `app/services/stream.py` currently uses a fixed RMS-energy threshold
(`SILENCE_RMS_THRESHOLD = 500.0` on int16 samples) plus a 700 ms silence-duration
check to endpoint utterances. Known failure modes on real-world audio:

- **Environmental noise** (fan, traffic, keyboard typing) keeps RMS above
  threshold → `_in_utterance` never finalises → buffer grows indefinitely → the
  partial-cost-grows-with-buffer problem the v2.1 sliding window only partially
  fixes.
- **Quiet speech** (mumbling, far-mic) falls under threshold → speech frames
  are treated as silence → start-of-utterance missed.
- **Mid-utterance pauses** (thinking, breath) that exceed 700 ms get split into
  two utterances when they should be one.

**Proposed change.** Replace the RMS check with [`silero-vad`](https://github.com/snakers4/silero-vad)
— a small (~1 MB) neural VAD that returns per-frame speech probability.

- Add `silero-vad` (or `pysilero-vad` wrapper) to `pyproject.toml`. Loads as a
  TorchScript model on the same in-process Python — no extra subprocess.
- New `app/services/vad.py` exposes a `SileroVAD` class with `is_speech(pcm: bytes) -> bool`.
- `stream.py` swaps the `compute_rms` call for `vad.is_speech(pcm)`; the
  `SILENCE_DURATION_MS` semantics stay the same (consecutive non-speech frames
  for N ms → finalise).
- Add `VAD_BACKEND` env var (`rms` | `silero`) so users on constrained hosts
  can fall back to the cheap RMS path.

**Effort.** ~1 day.
**Risk.** Low. silero-vad is widely used (WhisperLive, WhisperLiveKit) and
small enough to run on CPU even when ggml/Metal owns the GPU.
**Verification.** Add a `tests/test_vad.py` fixture set: a clean speech clip
(both backends should agree it's voice), a fan-noise clip (silero should say
silence; RMS may say voice), and a quiet-speech clip (silero should say voice;
RMS may say silence). Plus a manual mic check via `scripts/live-caption.py`.

### 2. OpenAI Whisper API compatibility — `POST /v1/audio/transcriptions`

**Problem.** Several LLM client tools (LibreChat, Continue.dev, open-webui,
OpenAI-compatible CLIs) expect the OpenAI Whisper API shape. Today they cannot
talk to whisper-wrap because our `/transcribe` endpoint uses a different request
and response schema.

**Proposed change.** Add a thin compatibility layer that wraps the existing
in-process backend:

- `POST /v1/audio/transcriptions` — accepts `multipart/form-data` with `file`,
  `model`, `language`, `prompt`, `response_format`, `temperature` (latter two
  optional). Returns `{"text": "..."}` for `response_format=json` (default),
  raw text for `text`, plus SRT / VTT generation from segments for those
  formats.
- `POST /v1/audio/translations` (English-only output) — same shape; routes
  through Whisper's `task=translate` mode under the hood.
- Reject unsupported `model` values with a clear error so clients see why
  their `whisper-1` / `gpt-4o-transcribe` request is being rejected.

**Effort.** ~half day.
**Risk.** Very low — pure wrapper, no behaviour change to the live backend.
**Verification.** `tests/test_openai_compat.py` covers each response format
plus the unsupported-model error. Manual: point LibreChat / open-webui at
`http://localhost:8000/v1` and confirm a sample transcription round-trips.

---

## Considered and deferred

| Item | Why deferred |
| ---- | ------------ |
| **LocalAgreement-2 (N=2 consensus)** | Adds one more inference round-trip before the first partial appears. Conflicts with the v2.1 user feedback that wanted partials faster. May revisit if the simplified N=1 filter shows visible thrashing in practice. |
| **ct-punc Chinese punctuation restoration** (FunASR) | High value — streaming `/listen` final transcripts currently come back without zh punctuation. ~2 days work. Move to v2.3 if the v2.2 items land cleanly. |
| **Multi-format response (SRT / VTT / verbose_json)** | Sub-task of the OpenAI-compat work above; included by virtue of `response_format` support. |
| **Two-pass decoding (streaming Parakeet + Whisper batch final)** | Real big-co architecture but ~2-3 weeks of work + 2× memory footprint. Only justified if this project pivots to live-captioning-first. Tracked for v3.x. |
| **PWA front-end for `/listen`** | Tracked under the v2 PRD as v2.x. The OpenAI-compat work above opens the door to using existing third-party WebUIs as a stop-gap, which may obsolete a custom PWA. |
| **Streaming-native ASR model with Taiwanese Mandarin support** | Does not exist as an open-source model today (WeNet, NeMo, FunASR streaming are all Mandarin / Putonghua oriented). This is the only thing that would break the Whisper-architecture latency plateau. Out of scope unless the community publishes one. |

---

## Process

When picking up an item from this file:

1. `spectra-propose <kebab-case-name>` — opens the change with proposal /
   design / specs / tasks scaffolding.
2. Lift the problem statement, proposed change, and verification notes from
   here into the proposal artifacts.
3. Remove the entry from this file in the same commit that creates the change
   (so the roadmap reflects only NOT-yet-specced work).
