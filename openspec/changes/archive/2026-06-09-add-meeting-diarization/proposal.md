## Why

Users need to analyse meeting recordings and attribute statements to specific speakers with precise timestamps — a capability the existing `/transcribe` endpoint cannot provide because it emits only segment-level (sentence) timestamps and has no speaker awareness. Without diarization the user must manually mark "who said what" in long-form recordings, which is the dominant pain point for any multi-party audio workflow.

The existing single-backend architecture (one `WhisperBackend` per process for `/transcribe`, `/listen`, `/ask`, `/v1`) is intentionally optimised for low-latency single-speaker workflows and platform-native acceleration (Core ML/ANE on macOS, CT2/CUDA on Linux). Bolting diarization onto that path would compromise both flows. A purpose-built endpoint keeps the hot paths untouched while delivering meeting analysis as a focused capability.

## What Changes

- Add `POST /transcribe/meeting` — async meeting-analysis endpoint accepting multipart and raw `audio/*` uploads (same Content-Type dispatch as `/transcribe`). Returns JSON with per-segment `speaker` labels, segment-level `start`/`end`, optional word-level timestamps, and a `speakers` summary array.
- Add `app/services/meeting.py` — `MeetingAnalyzer` service that wraps the WhisperX three-stage pipeline (ASR via faster-whisper batched → forced phoneme alignment → speaker diarization via pyannote.audio). Loaded lazily on first request; remains resident afterwards.
- Add `HF_TOKEN` environment variable — required by pyannote.audio for accessing the gated `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` models. Endpoint returns HTTP 503 with a clear message when missing; existing endpoints are unaffected.
- Extend `registry/models.yaml` semantics — each model intended for meeting analysis SHALL declare a `ct2` variant (WhisperX requires CT2 regardless of host platform). On macOS this means a model used for meeting analysis must be downloaded with both `ggml` and `ct2` variants.
- Add new optional dependencies `whisperx` and `pyannote.audio` to `pyproject.toml`. Install via `pip install -e ".[meeting]"` extra; absent the extra, `/transcribe/meeting` returns HTTP 503.
- Expose meeting-related metadata in `GET /status` under a new `meeting` object (loaded/not-loaded, HF token configured, supported features) without altering the existing `backend` object contract.
- Add PWA Meeting Mode page in `frontend/src/meeting/` — file upload, async progress polling, transcript view with speaker colour-coding, click-to-seek on an audio player timeline, and speaker-aware export to SRT/VTT/TXT.
- Extend `frontend/src/export/` with speaker-aware SRT/VTT generators (emit speaker tags in cue text) and TXT generator (group consecutive segments by speaker).
- Update `make download-model` to also fetch the diarization models into the HF cache when invoked with a new `--with-diarization` flag (so air-gapped operators can pre-stage everything).
- Update README.md, docs/API.md, .env.example, and CLAUDE.md to document the new endpoint, environment variable, and macOS dual-variant requirement.

## Capabilities

### New Capabilities

- `meeting-diarization`: Long-form meeting analysis endpoint that combines Whisper ASR, forced phoneme alignment for word-level timestamps, and pyannote-based speaker diarization into a single JSON response. Covers the HTTP contract, the WhisperX service wrapper, lazy model lifecycle, HF token gating, and `/status` exposure.

### Modified Capabilities

- `model-registry`: Registry SHALL document and validate that models declared usable for meeting analysis carry a `ct2` variant in addition to their default-platform variant, since WhisperX's ASR stage requires CT2 on every host.
- `model-management`: `make download-model` SHALL accept a `--with-diarization` flag that, when present, additionally pre-fetches the pyannote diarization and segmentation models into the user's HF cache.

## Impact

- Affected specs:
  - New: `openspec/specs/meeting-diarization/spec.md`
  - Modified: `openspec/specs/model-registry/spec.md`, `openspec/specs/model-management/spec.md`
- Affected code:
  - New:
    - `app/api/meeting.py`
    - `app/services/meeting.py`
    - `tests/test_meeting.py`
    - `tests/test_meeting_lifecycle.py`
    - `tests/fixtures/meeting/two_speaker_30s.wav`
    - `frontend/src/meeting/meeting-page.ts`
    - `frontend/src/meeting/meeting-upload.ts`
    - `frontend/src/meeting/meeting-transcript.ts`
    - `frontend/src/meeting/meeting-timeline.ts`
    - `frontend/src/meeting/speaker-colors.ts`
    - `frontend/src/meeting/meeting-page.test.ts`
    - `frontend/src/export/speaker-srt.ts`
    - `frontend/src/export/speaker-vtt.ts`
    - `frontend/src/export/speaker-txt.ts`
    - `frontend/src/export/speaker-srt.test.ts`
  - Modified:
    - `app/main.py`
    - `app/config.py`
    - `app/api/status.py`
    - `app/services/registry.py`
    - `pyproject.toml`
    - `scripts/model-manager.sh`
    - `registry/models.yaml`
    - `frontend/src/main.ts`
    - `frontend/src/ui/transcript-view.ts`
    - `.env.example`
    - `README.md`
    - `docs/API.md`
    - `CLAUDE.md`
  - Removed: none
- Dependencies: `whisperx >= 3.1.0`, `pyannote.audio >= 3.1.0`, `torch >= 2.0` (already transitive via faster-whisper but pinned here)
- External: requires Hugging Face account with accepted user agreements for `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0`
