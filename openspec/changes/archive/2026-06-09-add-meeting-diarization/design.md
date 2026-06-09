## Context

`whisper-wrap` currently runs exactly one `WhisperBackend` per process, selected at lifespan startup based on the host platform: `PyWhisperCppBackend` on macOS (ggml + Core ML/ANE acceleration) and `CTranslate2Backend` on Linux (CT2 + optional CUDA). Every transcription endpoint (`/transcribe`, `/listen`, `/ask`, `/v1/audio/transcriptions`) routes through that single backend. The Protocol exposes segment-level timestamps only.

Meeting analysis introduces three new requirements that the current architecture cannot satisfy:

1. **Word-level timestamps** — needed for click-to-seek UX and accurate subtitle splitting.
2. **Speaker diarization** — needed for the core "who said what" output.
3. **Long-form batched ASR** — meetings are typically 30-180 minutes; sequential streaming via `/transcribe` is acceptable but suboptimal for the analysis workflow.

The WhisperX library (m-bain/whisperX) packages all three as a tested pipeline: faster-whisper batched ASR → wav2vec2 forced phoneme alignment → pyannote.audio segmentation + embedding + clustering. It is the de-facto open-source solution. Constraints carried in from the existing system: HF_TOKEN is required for pyannote's gated models; pyannote and wav2vec2 have no Core ML/ANE port (CPU/CUDA only); `/transcribe/meeting` therefore runs entirely off the ANE path even on macOS.

Stakeholders: end users analysing meetings via the PWA; operators running the server (concerned about model storage, HF credentials, startup time); developers maintaining the existing single-backend hot path (must not regress).

## Goals / Non-Goals

**Goals:**

- Deliver `POST /transcribe/meeting` returning structured JSON with per-segment speaker labels, segment timestamps, and word-level timestamps.
- Keep existing endpoints (`/transcribe`, `/listen`, `/ask`, `/v1/*`, `/status`) unchanged in contract, latency, and memory footprint.
- Lazy-load WhisperX and pyannote models on first request to the meeting endpoint so server startup time is unaffected.
- Fail fast and explicitly when prerequisites are missing (no HF_TOKEN, missing CT2 variant of the active model, missing optional dependencies).
- Provide a PWA Meeting Mode page with upload, speaker-colour-coded transcript, click-to-seek timeline, and speaker-aware SRT/VTT/TXT export.
- Allow operators to pre-stage diarization models so air-gapped hosts work after first download.

**Non-Goals:**

- Real-time / streaming diarization. The endpoint is request/response over a fully-uploaded file. WebSocket streaming diarization is out of scope.
- Replacing the existing per-process backend with a per-endpoint backend matrix. The architectural "one inference backend per process" contract for transcribe/listen/ask remains.
- Substituting Apple Neural Engine acceleration for the meeting endpoint. WhisperX requires CT2; there is no ANE path for pyannote or wav2vec2.
- Bring-your-own diarization (custom embeddings, third-party diarizers). The endpoint is opinionated about pyannote.audio.
- Speaker identification (mapping `SPEAKER_00` → "Alice"). Only diarization (speakers as anonymous labels) is delivered; naming is a future enhancement.
- Adding diarization to the OpenAI-compat endpoints (`/v1/audio/transcriptions`). OpenAI's contract has no speaker field; bolting one on breaks compatibility.

## Decisions

### Decision: New endpoint instead of extending `/transcribe`

`/transcribe/meeting` is a new route, not a query-string or header flag on `/transcribe`. Rationale: dispatching different pipelines from the same URL hides large performance and dependency differences from clients. A separate URL makes the cost and prerequisites legible (404/503 vs. silent slow path) and keeps OpenAPI documentation accurate. Rejected alternative: `/transcribe?diarize=true` — opaque about cost and unable to surface meeting-specific 503 (missing HF_TOKEN) without poisoning every `/transcribe` client.

### Decision: Standalone `MeetingAnalyzer` service, not a new `WhisperBackend` implementation

`MeetingAnalyzer` is a dedicated class in `app/services/meeting.py` that owns the WhisperX pipeline. It does NOT implement the `WhisperBackend` Protocol. Rationale: the Protocol's `transcribe(...)` signature returns segment-level results without speakers or word timestamps; reshaping it would either break callers or require a parallel "v2" Protocol. The diarization pipeline also has a fundamentally different lifecycle (lazy load, multiple sub-models). Keeping it separate isolates the WhisperX dependency and prevents accidental coupling to the hot path. Rejected alternative: add `transcribe_meeting(...)` to the Protocol — forces every backend implementation (current and future) to either implement it or stub it, even though only one backend will ever do so.

### Decision: Lazy model loading on first meeting request

WhisperX (faster-whisper CT2 model + wav2vec2 alignment model) and pyannote (segmentation + speaker-diarization pipelines) are loaded the first time `/transcribe/meeting` is called, not at server startup. Models stay resident afterwards. Rationale: meeting analysis is bursty/optional; loading 1-2 GB of additional models on every server start would penalise users who never use the feature. The first meeting request pays a one-time ~20-40 second penalty (acceptable for a multi-minute analysis); subsequent requests are warm. Rejected alternative: eager load at lifespan startup — wastes resources for non-meeting users; rejected alternative: per-request load — kills throughput for back-to-back meeting analyses.

### Decision: Reuse the registry CT2 variant via the existing model resolution code

The WhisperX ASR stage points at the CT2 variant of the model that is named by `MEETING_MODEL_NAME` (default: same as `MODEL_NAME`). On Linux this is typically the active backend's model directory. On macOS the active backend is ggml-based, so the CT2 variant must be downloaded separately. `app/services/registry.py` is extended with a helper that resolves any model name to its CT2 variant directory and raises a clear error if no CT2 variant exists. Rationale: keeps a single source of truth for model storage; reuses the variant abstraction; surfaces the macOS dual-download requirement as a clear error rather than a silent download. Rejected alternative: a separate `MEETING_MODEL_DIR` env-only path — duplicates concept of model storage and bypasses registry validation.

### Decision: HF_TOKEN gated at endpoint level, not at startup

Missing `HF_TOKEN` does NOT block server startup. `/transcribe/meeting` returns HTTP 503 with body `{"error": "meeting_unavailable", "reason": "HF_TOKEN is not configured"}` and `/status.meeting.hf_token_configured = false`. All other endpoints remain fully functional. Rationale: most existing users will not configure HF_TOKEN; failing startup would be a hostile regression. Rejected alternative: hard requirement at startup — breaks every existing deployment on upgrade.

### Decision: Optional dependency group instead of unconditional install

`whisperx` and `pyannote.audio` are added under a `[project.optional-dependencies]` group named `meeting` in `pyproject.toml`. Users install via `pip install -e ".[meeting]"` or `uv sync --extra meeting`. When the import fails at module load time, `app/api/meeting.py` registers a stub route that returns HTTP 503 with body `{"error": "meeting_unavailable", "reason": "meeting extras not installed"}`. Rationale: WhisperX + pyannote pull in PyTorch and a heavy ML stack (~1.5 GB extra); making this opt-in keeps the baseline install size unchanged. Rejected alternative: unconditional dependency — bloats baseline install by ~1.5 GB.

### Decision: Async background processing with polling, not synchronous response

The endpoint accepts the upload, returns `202 Accepted` with `{"job_id": "...", "status_url": "/transcribe/meeting/{job_id}"}`, and processes in a background task. Clients poll the status URL for `{"status": "pending|running|done|error", "progress": 0..1, "result": {...} | null}`. Rationale: a 1-hour meeting takes 9-16 minutes to process; holding an HTTP connection that long is fragile (proxies, idle timeouts, retries). Polling is reliable and decoupled from connection lifetime. Rejected alternatives: synchronous response (fragile for long jobs); WebSocket progress stream (more code, no real benefit for a one-shot job); SSE (works but polling is simpler client-side).

### Decision: In-memory job store with eviction, not persistent storage

Job results are kept in a process-local dict keyed by job ID. Each job carries a creation timestamp and is evicted after 1 hour (configurable via `MEETING_JOB_TTL_SECONDS`, default 3600) or when memory pressure exceeds `MEETING_MAX_JOBS` entries (default 20, oldest evicted first). If the server restarts, jobs are lost; the client SHALL re-upload. Rationale: persistence requires choosing storage (sqlite? redis?), introduces migration concerns, and serves no real workflow — clients hold their own copy of the upload. Rejected alternative: filesystem persistence — adds cleanup complexity and a new failure mode.

### Decision: Single-job concurrency at the WhisperX layer

Only one meeting analysis runs at a time per process; concurrent submissions queue behind an `asyncio.Lock`. Rationale: WhisperX, like the existing backend, holds a single model in memory and is CPU-bound; running two simultaneously would simply double memory and halve throughput. The existing system already serialises Whisper inference. Operators needing higher throughput run a reverse proxy with multiple replicas. Rejected alternative: thread pool — duplicates models in memory and gains nothing on CPU-bound inference.

### Decision: PWA Meeting Mode is a separate top-level route

The PWA gains a new route `/app/meeting` (mounted under existing `/app/`) with its own page module under `frontend/src/meeting/`. The existing transcript view is untouched. Rationale: meeting analysis UX (speaker columns, click-to-seek audio player, speaker colour assignments, async progress) is materially different from streaming transcription; cramming both into one view harms both. Shared utility code (export generators, audio playback) lives in `frontend/src/export/` and `frontend/src/capture/`. Rejected alternative: toggle inside the main page — adds modal state and hides one mode from discoverability.

### Decision: Speaker-aware export by extending existing export modules

New files `frontend/src/export/speaker-srt.ts`, `speaker-vtt.ts`, `speaker-txt.ts` mirror the existing non-speaker exporters but accept the meeting JSON shape. SRT/VTT prefix each cue's text with `[SPEAKER_xx] ` (configurable via export settings). TXT groups consecutive same-speaker segments into paragraphs. Rationale: the JSON shapes differ enough (no `words[]` and no `speaker` in the existing path) that branching inside the current exporters would obscure both behaviours. New files keep each exporter focused. Rejected alternative: unified exporter with optional speaker field — branches everywhere; both paths get harder to read.

## Implementation Contract

### Behaviour

- A user uploads a meeting audio file to `POST /transcribe/meeting` and receives a job ID. The user polls the job status URL until `status == "done"`, then reads `result` containing the structured transcript with speakers.
- The PWA Meeting Mode page accepts the audio file, displays upload progress, polls the job, and renders a transcript with each segment coloured by speaker. Clicking a segment seeks the embedded audio player to that timestamp. The user exports the result as SRT, VTT, or TXT with speaker labels included.
- Existing endpoints behave identically to before this change, including `/status` (whose `backend` object is unchanged; a new `meeting` object is added alongside).

### Interface / data shape

`POST /transcribe/meeting` request:

- Content-Type dispatch identical to `/transcribe`: multipart/form-data with `file`, or raw `audio/*`, or `application/octet-stream`.
- Form fields / query params: `language` (optional ISO 639-1), `num_speakers` (optional int), `min_speakers` (optional int), `max_speakers` (optional int), `enable_word_timestamps` (optional bool, default true).

`POST /transcribe/meeting` response (202 Accepted):

```json
{
  "job_id": "01HXYZ...",
  "status_url": "/transcribe/meeting/01HXYZ..."
}
```

`GET /transcribe/meeting/{job_id}` response shapes:

- Pending/Running: `{"status": "pending"|"running", "progress": 0.0..1.0, "stage": "asr"|"align"|"diarize", "result": null}`
- Done: `{"status": "done", "progress": 1.0, "stage": "complete", "result": <MeetingResult>}`
- Error: `{"status": "error", "error": {"code": "...", "message": "..."}, "result": null}`
- Unknown job: HTTP 404 `{"error": "job_not_found"}`

`MeetingResult` JSON shape:

```json
{
  "language": "zh",
  "duration_seconds": 1823.4,
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "segments": [
    {
      "speaker": "SPEAKER_00",
      "start": 0.52,
      "end": 4.18,
      "text": "今天會議的主題是…",
      "words": [
        {"word": "今天", "start": 0.52, "end": 0.91},
        {"word": "會議", "start": 0.95, "end": 1.34}
      ]
    }
  ]
}
```

`words` array is omitted entirely when `enable_word_timestamps=false`.

`GET /status` extension (additive only):

```json
{
  "backend": { ...unchanged... },
  "meeting": {
    "available": true|false,
    "loaded": true|false,
    "hf_token_configured": true|false,
    "extras_installed": true|false,
    "asr_model_dir": "./models/breeze-asr-25-ct2" | null,
    "active_jobs": 0,
    "queued_jobs": 0
  }
}
```

### Configuration surface

- `HF_TOKEN` (env) — Hugging Face access token. Default empty.
- `MEETING_MODEL_NAME` (env) — registry key for the ASR model used in meetings. Default: value of `MODEL_NAME`.
- `MEETING_JOB_TTL_SECONDS` (env) — seconds before completed jobs are evicted. Default 3600.
- `MEETING_MAX_JOBS` (env) — maximum jobs retained in memory. Default 20.
- `MEETING_DIARIZATION_PIPELINE` (env) — pyannote pipeline identifier. Default `pyannote/speaker-diarization-3.1`.
- `MEETING_ALIGN_MODEL` (env, optional) — wav2vec2 model identifier. Default: WhisperX's per-language default.

### Failure modes

| Condition | Surface |
| - | - |
| `meeting` extra not installed | Endpoint returns HTTP 503 `{"error": "meeting_unavailable", "reason": "meeting extras not installed"}`. `/status.meeting.available = false`. Server starts normally. |
| `HF_TOKEN` missing | Endpoint returns HTTP 503 `{"error": "meeting_unavailable", "reason": "HF_TOKEN is not configured"}`. `/status.meeting.hf_token_configured = false`. |
| Active model has no CT2 variant | Endpoint returns HTTP 503 `{"error": "meeting_unavailable", "reason": "model <name> has no ct2 variant"}` with a hint pointing at `make download-model MODEL=<name>`. |
| Upload validation fails (libmagic / ffmpeg) | HTTP 400 `{"error": "invalid_audio", "reason": "..."}` — same shape as `/transcribe`. |
| Pipeline raises during background processing | Job transitions to `status: "error"` with `{"code": "asr_failed"|"align_failed"|"diarize_failed", "message": "..."}`. Job is not auto-retried. |
| Job ID unknown / evicted | HTTP 404 `{"error": "job_not_found"}`. |

### Acceptance criteria

- All scenarios in `openspec/specs/meeting-diarization/spec.md` pass under `pytest tests/test_meeting.py tests/test_meeting_lifecycle.py`.
- All scenarios in the delta specs for `model-registry` and `model-management` pass under existing test files extended for the new behaviour.
- A manual end-to-end test using `tests/fixtures/meeting/two_speaker_30s.wav` returns at least 2 distinct `SPEAKER_*` labels with monotonically non-decreasing `start` times and `end > start` for every segment.
- `make test` (full pytest suite) and `cd frontend && bun run test` pass.
- `ruff check` and `ruff format --check` pass.
- `make dev` startup time is within ±0.5 seconds of pre-change baseline on the same host (proving lazy loading).
- The PWA Meeting Mode page is reachable at `/app/meeting`, accepts a file, displays progress, renders a colour-coded transcript, and exports SRT/VTT/TXT containing speaker tags.

### Scope boundaries

**In scope:**

- `POST /transcribe/meeting` and `GET /transcribe/meeting/{job_id}` endpoints, including upload validation, ffmpeg normalisation reuse, and background job orchestration.
- `MeetingAnalyzer` service with lazy WhisperX + pyannote loading and single-job `asyncio.Lock`.
- `MEETING_*` env var configuration in `app/config.py`.
- `/status.meeting` block.
- `registry/models.yaml` validation that meeting-eligible models declare a `ct2` variant.
- `scripts/model-manager.sh --with-diarization` flag.
- PWA Meeting Mode page, upload widget, transcript viewer, timeline player, speaker colour map, export modules, and Vitest coverage.
- Documentation updates in README.md, docs/API.md, .env.example, CLAUDE.md.

**Out of scope:**

- Changes to `/transcribe`, `/listen`, `/ask`, `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/models`, `/actions`.
- Changes to the existing `WhisperBackend` Protocol or its implementations.
- Streaming or WebSocket diarization.
- Speaker naming / identification.
- Persistent storage of meeting jobs.
- A Docker image variant that bundles the meeting extras (operators install the extras manually; documentation explains the steps).

## Risks / Trade-offs

- [WhisperX upstream maintenance is one-person, occasionally lags new Whisper releases] → Pin a tested version range in `pyproject.toml`. Add a CI test that runs the meeting pipeline end-to-end on a tiny fixture so an upstream break is detected before users hit it.
- [pyannote requires accepting two HF user agreements per account; quiet failure if either is not accepted] → Document the exact agreement URLs in README.md and `.env.example`. On `MeetingAnalyzer` first-load, catch pyannote's 401/403 and translate to a 503 with a clear pointer to the agreement step.
- [First call after server start incurs 20-40 s loading penalty that may look like a hang to PWA users] → The PWA Meeting Mode UI SHALL display "Loading models (first run after server start)…" when the `/status` endpoint reports `loaded: false` while a job is `pending` for more than 3 seconds. Document the expected first-call latency.
- [Diarization quality degrades on overlapping speech or fewer than ~20 seconds per speaker] → Document known limits in README.md "Meeting Mode — accuracy notes". Surface `num_speakers` as a quality lever in the PWA.
- [Mac users may be surprised that the meeting endpoint runs CPU-only despite running on ANE-capable hardware] → `/status.meeting` exposes the CT2 model path. README.md "Meeting Mode — performance" section explains the ANE limitation explicitly and provides ballpark wall-clock numbers per platform.
- [The 1.5 GB extra-dependency install footprint may surprise operators] → The `[meeting]` extra is opt-in; `make setup` does not install it. README.md "Meeting Mode — installation" calls out the extra step and size.
- [WhisperX uses PyTorch which conflicts with strict reproducible-build setups] → Pin PyTorch via the optional extra; document that air-gapped installs need a local PyTorch wheel and HF cache. Validation script `make models --with-diarization` SHALL pre-fetch everything for air-gapped use.
- [Two model variants per model on macOS doubles model storage] → Acceptable trade-off (~3-5 GB per model rather than 1.5-2.5 GB); documented in README.md and surfaced as the error message when the CT2 variant is missing.
