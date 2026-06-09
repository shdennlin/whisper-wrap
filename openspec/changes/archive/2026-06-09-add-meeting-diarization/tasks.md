## 1. Dependencies and configuration surface

- [x] 1.1 Add `whisperx` and `pyannote.audio` under `[project.optional-dependencies.meeting]` in `pyproject.toml`, implementing **Decision: Optional dependency group instead of unconditional install** so a baseline `uv sync` SHALL NOT pull either package. Verified by `uv sync` succeeding without the extras and `uv sync --extra meeting` succeeding with them (assert via `pip show whisperx`).
- [x] 1.2 [P] Extend `app/config.py` with the `HF_TOKEN`, `MEETING_MODEL_NAME`, `MEETING_JOB_TTL_SECONDS`, `MEETING_MAX_JOBS`, `MEETING_DIARIZATION_PIPELINE`, and `MEETING_ALIGN_MODEL` environment variables so `Config(...)` instances expose them with the documented defaults, implementing **Decision: HF_TOKEN gated at endpoint level, not at startup** (missing token does not block lifespan). Verified by new cases in `tests/test_config.py` asserting both default values and `.env` overrides.
- [x] 1.3 [P] Document the new environment variables and the meeting-mode installation steps in `.env.example` and the README "Meeting Mode — installation" section. Verified by manual review confirming `HF_TOKEN`, the two pyannote model URLs requiring user-agreement acceptance, and the `[meeting]` extras install command are each present.

## 2. Registry helper for the meeting CT2 variant

- [x] 2.1 Add a `resolve_ct2_variant(name)` helper to `app/services/registry.py` that returns the CT2 variant directory for any registry model and raises a typed `MeetingModelMissing` error when no `ct2` variant is declared, satisfying the meeting analysis CT2 prerequisite. Verified by new cases in `tests/test_registry_variants.py` covering both a model with a ct2 variant and a model without one.
- [x] 2.2 [P] Confirm `registry/models.yaml` ships the default `breeze-asr-25` entry with both `ct2` and `ggml` variants intact and add a regression test in `tests/test_registry.py` asserting the shipped default has at least one variant of each format. Verified by `pytest tests/test_registry.py` passing.

## 3. MeetingAnalyzer service

- [x] 3.1 Implement `app/services/meeting.py` per **Decision: Standalone `MeetingAnalyzer` service, not a new `WhisperBackend` implementation**, owning the WhisperX ASR model, the wav2vec2 alignment model, and the pyannote diarization pipeline. Verified by `tests/test_meeting.py::test_analyzer_runs_pipeline_on_fixture` running against `tests/fixtures/meeting/two_speaker_30s.wav` and asserting at least two `SPEAKER_*` labels in the result.
- [x] 3.2 Implement **Decision: Lazy model loading on first meeting request** so that `MeetingAnalyzer is loaded lazily on first request`: models load on first job dispatch (not at FastAPI lifespan startup) and remain resident afterwards. Verified by `tests/test_meeting_lifecycle.py::test_lifespan_does_not_load_meeting_models` asserting no whisperx/pyannote imports happen during `lifespan()` startup, plus a second test asserting models load on first job and are reused on the second.
- [x] 3.3 [P] Implement **Decision: Reuse the registry CT2 variant via the existing model resolution code** by having `MeetingAnalyzer` resolve its ASR model directory through `resolve_ct2_variant(MEETING_MODEL_NAME)`. Verified by `tests/test_meeting.py::test_analyzer_uses_registry_ct2_path` asserting the resolved path matches the registry helper's output.
- [x] 3.4 Implement **Decision: Single-job concurrency at the WhisperX layer** via an `asyncio.Lock` in `MeetingAnalyzer` so that the requirement "Concurrent meeting jobs serialise behind a single-job lock" holds. Verified by `tests/test_meeting.py::test_concurrent_jobs_serialise` submitting two jobs back-to-back and asserting one stays `pending` until the first finishes.

## 4. In-memory job store

- [x] 4.1 Implement an in-memory job store per **Decision: In-memory job store with eviction, not persistent storage**, supporting create / get / list operations keyed by ULID job ID and tracking `status`, `progress`, `stage`, `result`, `error`, and `created_at`. Verified by `tests/test_meeting.py::test_job_store_lifecycle` exercising create → pending → running → done transitions and assertions on each field.
- [x] 4.2 Implement eviction so the requirement "Jobs are evicted by age and capacity" holds (TTL via `MEETING_JOB_TTL_SECONDS`, capacity via `MEETING_MAX_JOBS`, eviction runs on every poll and accept). Verified by two cases in `tests/test_meeting.py`: TTL eviction returning 404 after the configured age, and capacity overflow evicting the oldest job first.

## 5. HTTP endpoints

- [x] 5.1 Implement `POST /transcribe/meeting` in `app/api/meeting.py` per **Decision: New endpoint instead of extending `/transcribe`**, covering the requirement "Meeting analysis endpoint accepts upload and returns job handle" and reusing the libmagic + ffmpeg upload path from `/transcribe`. Verified by `tests/test_meeting.py::test_post_meeting_returns_job_handle` against the fixture, plus a 400-on-bad-audio case and a 400-on-invalid-speaker-range case.
- [x] 5.2 Implement `GET /transcribe/meeting/{job_id}` satisfying the requirement "Job status endpoint reports lifecycle and final result" with the documented JSON `Interface / data shape` per status and HTTP 404 on unknown/evicted IDs. Verified by `tests/test_meeting.py::test_get_meeting_status_phases` exercising pending, running, done, error, and unknown branches.
- [x] 5.3 Implement **Decision: Async background processing with polling, not synchronous response** so that `POST /transcribe/meeting` returns HTTP 202 + job handle within 1 second and processing runs in a FastAPI `BackgroundTasks` task. Verified by `tests/test_meeting.py::test_post_meeting_returns_within_one_second` asserting end-to-end latency from request to response.
- [x] 5.4 Implement the 503 gating per the requirement "Meeting endpoint returns 503 when prerequisites are missing" (covering the design's documented `Failure modes` table) for missing extras, missing `HF_TOKEN`, missing ct2 variant in the registry, and ct2 variant not downloaded — each with the documented `error.reason` text. Verified by four cases in `tests/test_meeting.py` covering each branch and one case asserting `POST /transcribe` and `GET /status` are unaffected.
- [x] 5.5 Ensure the `MeetingResult` returned by completed jobs satisfies the requirement "MeetingResult JSON shape carries speakers, segments, and optional words" (matching the design's `Interface / data shape` for `MeetingResult`) including non-decreasing segment starts and the `enable_word_timestamps=false` opt-out. Verified by `tests/test_meeting.py::test_meeting_result_shape` against the fixture and a second case asserting `words` is absent when opt-out is requested.

## 6. /status integration

- [x] 6.1 Extend `app/api/status.py` so `GET /status` includes a `meeting` block satisfying the requirement "/status exposes meeting subsystem metadata" with `available`, `loaded`, `hf_token_configured`, `extras_installed`, `asr_model_dir`, `active_jobs`, `queued_jobs`. Verified by `tests/test_status.py` cases covering: fresh-server happy path, missing HF_TOKEN, and during a running job.
- [x] 6.2 [P] Confirm the existing `backend` object in `/status` is unchanged after this change. Verified by `tests/test_status.py::test_backend_block_unchanged` asserting the response keys and values match the pre-change contract.

## 7. FastAPI wiring

- [x] 7.1 Mount the meeting router in `app/main.py` under prefix `/transcribe/meeting` and construct a singleton `MeetingAnalyzer` instance plus job store on `app.state.meeting`. Verified by `tests/test_main.py::test_meeting_router_mounted` asserting the routes are registered without triggering any model load at startup.

## 8. Model manager script

- [x] 8.1 Implement the requirement "Download command supports diarization pre-fetch flag" by adding `--with-diarization` to `scripts/model-manager.sh` (pre-fetch `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` into the HF cache when present). Verified by `tests/test_model_manager.py::test_download_with_diarization_flag` mocking `huggingface_hub` and asserting both pyannote model snapshots are requested.
- [x] 8.2 [P] Implement the fail-fast behaviour when `--with-diarization` is used without `HF_TOKEN`. Verified by `tests/test_model_manager.py::test_with_diarization_requires_hf_token` asserting the script exits non-zero with an error mentioning `HF_TOKEN` and the README installation section.

## 9. PWA Meeting Mode page

- [x] 9.1 Create the Meeting Mode page at route `/app/meeting` per **Decision: PWA Meeting Mode is a separate top-level route**, with file modules under `frontend/src/meeting/`. The page SHALL render an upload control, a poll-driven progress indicator, and a speaker-coloured transcript per the requirement "PWA Meeting Mode page renders speaker-labelled transcript". Verified by `frontend/src/meeting/meeting-page.test.ts` driving a fake fetch through pending → done and asserting the rendered DOM includes one CSS class per distinct speaker.
- [x] 9.2 Implement deterministic speaker-to-colour mapping (same `speakers` array order yields the same colour assignment across reloads) using a fixed palette. Verified by a vitest case asserting the same input produces the same colour map across two invocations.
- [x] 9.3 Implement click-to-seek on the embedded audio player so clicking a segment seeks the player to the segment's `start`. Verified by a vitest case asserting `audio.currentTime` is set to the expected segment start when the segment element is clicked.
- [x] 9.4 [P] Handle the meeting-unavailable case by reading `/status.meeting.available` and rendering a disabled upload control with the reason text when false. Verified by a vitest case where the mocked `/status` reports `available: false` and the upload control is disabled.

## 10. Speaker-aware exports

- [x] 10.1 Implement `frontend/src/export/speaker-srt.ts` per **Decision: Speaker-aware export by extending existing export modules** so the requirement "Speaker-aware export of SRT, VTT, and TXT" holds for SRT (cue text begins with `[<speaker>] `). Verified by `frontend/src/export/speaker-srt.test.ts` asserting the cue format on a two-segment fixture.
- [x] 10.2 [P] Implement `frontend/src/export/speaker-vtt.ts` with the same speaker-tag-in-cue-text contract as SRT. Verified by `frontend/src/export/speaker-vtt.test.ts` against the same fixture.
- [x] 10.3 [P] Implement `frontend/src/export/speaker-txt.ts` so consecutive same-speaker segments merge into a single `SPEAKER_xx:` paragraph. Verified by `frontend/src/export/speaker-txt.test.ts` covering both same-speaker grouping and speaker-change boundaries.
- [x] 10.4 Wire the three export buttons into the Meeting Mode page so client-side export runs entirely on the rendered `MeetingResult` without an additional server request. Verified by a vitest case asserting clicking each button triggers a download with the expected filename pattern and no network fetch.

## 11. Documentation

- [x] 11.1 Update README.md with a "Meeting Mode" section covering installation (`[meeting]` extras + HF_TOKEN + HF user agreements), performance expectations per platform (the Mac/ANE caveat surfaced in the design's Risks list), and accuracy notes for overlapping speech. Verified by a content review confirming the section explicitly names HF_TOKEN, the two pyannote model URLs, and a per-platform wall-clock-time table.
- [x] 11.2 [P] Update `docs/API.md` with the contracts for `POST /transcribe/meeting` and `GET /transcribe/meeting/{job_id}` matching the `MeetingResult` shape and the 503/404/400 error shapes documented in the meeting-diarization spec. Verified by a content review confirming every spec scenario for these endpoints maps to a documented behaviour.
- [x] 11.3 [P] Update `CLAUDE.md` with a "Meeting Mode" subsection summarising the architecture (separate endpoint, lazy load, HF token gating, two-variant model requirement on macOS) so future Claude sessions have the context. Verified by a content review.

## 12. Release gate

- [x] 12.1 Run the design's `Acceptance criteria` checklist end-to-end against the implementation and verify each item passes: the pytest suite, the vitest suite, ruff check, ruff format check, the manual fixture run against `two_speaker_30s.wav`, the ±0.5 s startup-time budget, and the PWA Meeting Mode reachability. Verified by attaching the command output for each check to the change's PR description before merge.
- [x] 12.2 Confirm the change respects the design's `Scope boundaries` by auditing the diff for any modifications outside the in-scope list (no changes to `/transcribe`, `/listen`, `/ask`, `/v1/*`, the `WhisperBackend` Protocol, or its implementations). Verified by `git diff --name-only main...HEAD` review against the in-scope file list in design.md.
