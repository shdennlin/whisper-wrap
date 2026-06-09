## ADDED Requirements

### Requirement: Meeting analysis endpoint accepts upload and returns job handle

The system SHALL expose `POST /transcribe/meeting` that accepts an audio upload using the same Content-Type dispatch rules as `POST /transcribe`: multipart/form-data with a `file` field, raw `audio/*` bodies, and `application/octet-stream`. The endpoint SHALL accept the optional form fields and query parameters `language` (ISO 639-1 string), `num_speakers` (positive integer), `min_speakers` (positive integer), `max_speakers` (positive integer), and `enable_word_timestamps` (boolean, default true).

On accepting the upload, the endpoint SHALL perform the same libmagic content sniffing and ffmpeg-based normalisation to 16 kHz mono WAV as `/transcribe`, then SHALL create a job, return HTTP 202 with body `{"job_id": "<ulid>", "status_url": "/transcribe/meeting/<ulid>"}`, and SHALL begin background processing.

#### Scenario: Multipart upload returns job handle

- **WHEN** a client sends `POST /transcribe/meeting` with `Content-Type: multipart/form-data` containing a valid `file` field
- **THEN** the server SHALL respond with HTTP 202 and a JSON body containing `job_id` (string) and `status_url` (string starting with `/transcribe/meeting/`) within 1 second of the upload completing

#### Scenario: Invalid audio is rejected with HTTP 400

- **WHEN** a client uploads a file whose libmagic-detected MIME type is not an audio type
- **THEN** the server SHALL respond with HTTP 400 and body `{"error": "invalid_audio", "reason": "<libmagic reason>"}` and SHALL NOT create a job

#### Scenario: max_speakers below min_speakers is rejected

- **WHEN** a client submits `min_speakers=5` and `max_speakers=2`
- **THEN** the server SHALL respond with HTTP 400 and body `{"error": "invalid_speaker_range", "reason": "max_speakers must be >= min_speakers"}` and SHALL NOT create a job

---
### Requirement: Job status endpoint reports lifecycle and final result

The system SHALL expose `GET /transcribe/meeting/{job_id}` that returns the current state of a previously created meeting job. The response JSON SHALL contain a `status` field whose value is one of `pending`, `running`, `done`, or `error`. While `status` is `pending` or `running`, the response SHALL include `progress` (float between 0.0 and 1.0), `stage` (one of `asr`, `align`, `diarize`), and `result: null`. When `status` is `done`, the response SHALL include `progress: 1.0`, `stage: "complete"`, and `result` set to a `MeetingResult` object. When `status` is `error`, the response SHALL include `error` (object with `code` string and `message` string) and `result: null`.

When the `job_id` does not exist (never created or already evicted), the endpoint SHALL respond with HTTP 404 and body `{"error": "job_not_found"}`.

#### Scenario: Pending job reports stage and progress

- **WHEN** a client polls `GET /transcribe/meeting/<id>` while the background task is in the ASR stage at 40% progress
- **THEN** the response SHALL contain `{"status": "running", "stage": "asr", "progress": 0.4, "result": null}`

#### Scenario: Completed job returns final MeetingResult

- **WHEN** a client polls `GET /transcribe/meeting/<id>` after the background task has finished successfully
- **THEN** the response SHALL contain `status: "done"`, `progress: 1.0`, `stage: "complete"`, and a `result` object matching the MeetingResult shape

#### Scenario: Failed job exposes error code and message

- **WHEN** a client polls `GET /transcribe/meeting/<id>` after the diarization stage raised an exception
- **THEN** the response SHALL contain `status: "error"`, an `error.code` value of `diarize_failed`, an `error.message` string describing the cause, and `result: null`

#### Scenario: Unknown or evicted job returns 404

- **WHEN** a client polls `GET /transcribe/meeting/<id>` for an id that was never issued or has been evicted from the in-memory store
- **THEN** the response SHALL be HTTP 404 with body `{"error": "job_not_found"}`

---
### Requirement: MeetingResult JSON shape carries speakers, segments, and optional words

The `MeetingResult` object returned for a completed job SHALL contain the fields:

- `language` (string, ISO 639-1 code detected or supplied for the recording)
- `duration_seconds` (float, total decoded audio duration after ffmpeg normalisation)
- `speakers` (array of strings, the distinct speaker labels assigned by the diarization stage; ordering SHALL be the order of first appearance in the timeline)
- `segments` (array of `Segment` objects)

Each `Segment` object SHALL contain `speaker` (string from the `speakers` array), `start` (float seconds), `end` (float seconds, strictly greater than `start`), and `text` (string). When the request had `enable_word_timestamps=true` (the default), each `Segment` SHALL additionally contain `words` (array of `Word` objects). Each `Word` SHALL contain `word` (string), `start` (float seconds), and `end` (float seconds, strictly greater than `start`).

When `enable_word_timestamps=false`, the `words` field SHALL be omitted entirely from every `Segment`.

Within `segments`, consecutive entries SHALL satisfy `segments[i].start <= segments[i+1].start` (non-decreasing start times). Within a single `Segment`, consecutive entries in `words` SHALL satisfy `words[j].start <= words[j+1].start` and `words[j].end <= segment.end`.

#### Scenario: Two-speaker fixture produces distinct speaker labels

- **WHEN** a client submits `tests/fixtures/meeting/two_speaker_30s.wav` (a fixture with two distinct speakers) and polls until `status: "done"`
- **THEN** the `MeetingResult.speakers` array SHALL contain at least two distinct labels of the form `SPEAKER_NN`

##### Example: minimal MeetingResult shape

- **GIVEN** a 30-second recording with two speakers alternating roughly every 5 seconds
- **WHEN** the analysis completes
- **THEN** the JSON SHALL be of the form:
  ```json
  {
    "language": "zh",
    "duration_seconds": 30.0,
    "speakers": ["SPEAKER_00", "SPEAKER_01"],
    "segments": [
      {"speaker": "SPEAKER_00", "start": 0.5, "end": 4.8, "text": "...", "words": [...]},
      {"speaker": "SPEAKER_01", "start": 5.0, "end": 9.7, "text": "...", "words": [...]}
    ]
  }
  ```

#### Scenario: Word timestamps omitted on opt-out

- **WHEN** a client submits the same fixture with `enable_word_timestamps=false`
- **THEN** every `Segment` in the resulting `MeetingResult.segments` array SHALL NOT contain a `words` key

---
### Requirement: MeetingAnalyzer is loaded lazily on first request

The system SHALL define a `MeetingAnalyzer` class in `app/services/meeting.py` that owns the WhisperX ASR model, the wav2vec2 alignment model, and the pyannote diarization pipeline. The class SHALL load these models only when a meeting job is first dispatched, not at FastAPI lifespan startup. Once loaded, the models SHALL remain resident for the lifetime of the process. The class SHALL NOT implement the `WhisperBackend` Protocol.

When a meeting job is dispatched and the analyzer is not yet loaded, the endpoint SHALL set the job's `stage` to `asr` and `progress` to a value below 0.1 while loading. The `GET /transcribe/meeting/<id>` poll SHALL therefore remain responsive throughout the load.

#### Scenario: Lifespan startup time is unaffected by the new capability

- **WHEN** the server starts on a host where the `meeting` extras are installed and `HF_TOKEN` is configured
- **THEN** the lifespan startup time SHALL be within ±0.5 seconds of a baseline server start measured before this change on the same host

#### Scenario: First meeting request loads models, second is warm

- **WHEN** a fresh server process accepts its first `POST /transcribe/meeting` upload
- **THEN** the analyzer SHALL load all required models before returning the first `MeetingResult`, and a second meeting job submitted within the same process SHALL NOT re-load any model

---
### Requirement: Meeting endpoint returns 503 when prerequisites are missing

`POST /transcribe/meeting` and `GET /transcribe/meeting/<id>` SHALL each respond with HTTP 503 and a JSON error body when any of the following prerequisites are missing at request time. Server startup SHALL NOT fail for any of these conditions.

| Condition | error.reason value |
| - | - |
| The `meeting` optional dependency group is not installed (either `whisperx` or `pyannote.audio` import fails) | `meeting extras not installed` |
| The `HF_TOKEN` environment variable is empty or unset | `HF_TOKEN is not configured` |
| The active meeting ASR model (resolved from `MEETING_MODEL_NAME`, default `MODEL_NAME`) has no `format: ct2` variant in `registry/models.yaml` | `model <name> has no ct2 variant` |
| The CT2 variant directory exists in the registry but is not installed on disk | `model <name> ct2 variant is not downloaded; run make download-model MODEL=<name>` |

Each 503 response SHALL have body `{"error": "meeting_unavailable", "reason": "<reason>"}` with the reason text taken verbatim from the table above (with `<name>` substituted).

#### Scenario: Missing HF_TOKEN returns 503 without breaking other endpoints

- **WHEN** the server starts without `HF_TOKEN` set and a client sends `POST /transcribe/meeting`
- **THEN** the response SHALL be HTTP 503 with body `{"error": "meeting_unavailable", "reason": "HF_TOKEN is not configured"}`, and the same server SHALL still respond HTTP 200 to `POST /transcribe` and `GET /status` for unrelated requests

#### Scenario: macOS missing CT2 variant returns 503

- **WHEN** the server runs on macOS with the ggml variant of `breeze-asr-25` installed but the ct2 variant not downloaded, `HF_TOKEN` configured, and `meeting` extras installed, and a client sends `POST /transcribe/meeting`
- **THEN** the response SHALL be HTTP 503 with body `{"error": "meeting_unavailable", "reason": "model breeze-asr-25 ct2 variant is not downloaded; run make download-model MODEL=breeze-asr-25"}`

---
### Requirement: Concurrent meeting jobs serialise behind a single-job lock

The system SHALL run at most one meeting analysis at a time per process by serialising the ASR + align + diarize pipeline behind an `asyncio.Lock`. When a second meeting job is submitted while another is `running`, the second job SHALL be created with `status: "pending"` and SHALL remain `pending` until the first job finishes (successfully or with error), at which point its `status` SHALL transition to `running`.

#### Scenario: Second job stays pending while first runs

- **WHEN** a client submits two meeting jobs back-to-back to a fresh server and polls both immediately
- **THEN** exactly one of the two jobs SHALL report `status: "running"` and the other SHALL report `status: "pending"` until the first reaches `status: "done"` or `status: "error"`

---
### Requirement: Jobs are evicted by age and capacity

The system SHALL retain meeting job records in a process-local in-memory store. The store SHALL evict a job whose creation timestamp is older than `MEETING_JOB_TTL_SECONDS` (env var, default 3600) seconds, regardless of status. When the number of stored jobs would exceed `MEETING_MAX_JOBS` (env var, default 20), the oldest jobs SHALL be evicted first to bring the count back to `MEETING_MAX_JOBS`. Eviction SHALL run on every poll of `GET /transcribe/meeting/<id>` and on every `POST /transcribe/meeting` accept.

Jobs SHALL NOT be persisted across server restarts; after a restart, all previously-issued job IDs SHALL return HTTP 404.

#### Scenario: Evicted job returns 404 after TTL elapses

- **WHEN** `MEETING_JOB_TTL_SECONDS=1` is set, a job is completed, the test waits 2 seconds, and the client polls `GET /transcribe/meeting/<id>` for the completed job
- **THEN** the response SHALL be HTTP 404 with body `{"error": "job_not_found"}`

#### Scenario: Capacity overflow evicts oldest jobs first

- **WHEN** `MEETING_MAX_JOBS=3` is set and four jobs are created in sequence (each completing before the next starts)
- **THEN** the first-created job SHALL return HTTP 404, and the latest three jobs SHALL remain queryable

---
### Requirement: /status exposes meeting subsystem metadata

`GET /status` SHALL include a top-level `meeting` object alongside the existing `backend` object (which SHALL remain unchanged). The `meeting` object SHALL contain the fields:

- `available` (boolean) — true when extras are installed, `HF_TOKEN` is configured, and the active ASR model's ct2 variant is installed on disk; false otherwise.
- `loaded` (boolean) — true after `MeetingAnalyzer` has finished its first-call lazy load in the current process; false before.
- `hf_token_configured` (boolean) — true when `HF_TOKEN` is non-empty in the process environment.
- `extras_installed` (boolean) — true when `whisperx` and `pyannote.audio` import successfully.
- `asr_model_dir` (string or null) — absolute path to the ct2 variant directory when installed; null when not.
- `active_jobs` (integer) — count of jobs currently in `running` status.
- `queued_jobs` (integer) — count of jobs currently in `pending` status (waiting for the lock).

#### Scenario: /status reports availability and zero jobs on fresh server

- **WHEN** the server starts with extras installed, `HF_TOKEN` configured, the active model's ct2 variant downloaded, and no meeting jobs submitted yet
- **THEN** `GET /status` SHALL return a body where `meeting.available = true`, `meeting.loaded = false`, `meeting.hf_token_configured = true`, `meeting.extras_installed = true`, `meeting.asr_model_dir` is the absolute path to the ct2 directory, `meeting.active_jobs = 0`, and `meeting.queued_jobs = 0`

#### Scenario: /status reflects unavailability when HF_TOKEN missing

- **WHEN** the server starts without `HF_TOKEN` and with extras installed and the ct2 variant downloaded
- **THEN** `GET /status` SHALL return `meeting.available = false`, `meeting.hf_token_configured = false`, while still reporting `meeting.extras_installed = true` and the `asr_model_dir` path

---
### Requirement: PWA Meeting Mode page renders speaker-labelled transcript

The PWA SHALL provide a Meeting Mode page at route `/app/meeting`, distinct from the existing transcript page. The page SHALL allow the user to: upload an audio file via drag-and-drop or file picker; submit the file to `POST /transcribe/meeting`; poll `GET /transcribe/meeting/<id>` at an interval of at most 2 seconds while the job is `pending` or `running`; display the current stage (`asr` / `align` / `diarize`) and progress as a visible progress indicator; render the completed `MeetingResult` as a vertical transcript where each segment is visually colour-coded by its `speaker` label; render an HTML5 audio player positioned at the top of the page that allows the user to seek to a segment's `start` time by clicking on the segment.

The colour assignment per speaker SHALL be deterministic given the `speakers` array order (so reloading the page yields the same colour per speaker). Colour selections SHALL use a fixed palette designed for visual distinction.

#### Scenario: User uploads, sees progress, and reads colour-coded transcript

- **WHEN** the user opens `/app/meeting`, selects an audio file containing two speakers, and waits for completion
- **THEN** the page SHALL display the progress indicator while polling, transition to showing the transcript on completion, render each segment with a distinct background colour per speaker, and play the audio from the segment's `start` time when the user clicks on a segment

#### Scenario: Page handles 503 unavailable with a hint

- **WHEN** the user opens `/app/meeting` while `GET /status` reports `meeting.available = false` due to missing `HF_TOKEN`
- **THEN** the page SHALL display an inline error stating that meeting mode is unavailable and the specific reason from the `/status.meeting` block (e.g. "HF_TOKEN is not configured"), and SHALL NOT enable the upload control

---
### Requirement: Speaker-aware export of SRT, VTT, and TXT

The PWA SHALL provide export buttons on the Meeting Mode page for SRT, VTT, and TXT formats. The exported files SHALL include speaker labels:

- SRT and VTT: each cue's text SHALL begin with `[<speaker>] ` followed by the segment text, e.g. `[SPEAKER_00] 今天會議的主題是…`.
- TXT: consecutive segments with the same `speaker` SHALL be merged into a single paragraph beginning with `<speaker>:` on its own line, followed by the joined text wrapped in paragraph form.

Export generation SHALL run entirely client-side on the rendered `MeetingResult` and SHALL NOT require an additional server request.

#### Scenario: SRT export includes speaker tags in cue text

- **WHEN** the user clicks the SRT export button on a completed two-speaker meeting
- **THEN** the downloaded `.srt` file SHALL contain cues whose text lines begin with `[SPEAKER_00] ` or `[SPEAKER_01] ` matching the `speaker` field of each segment

##### Example: SRT cue format

- **GIVEN** a single segment `{speaker: "SPEAKER_01", start: 5.000, end: 9.700, text: "但是我們需要考慮"}`
- **WHEN** the SRT exporter runs
- **THEN** the cue SHALL be:
  ```
  1
  00:00:05,000 --> 00:00:09,700
  [SPEAKER_01] 但是我們需要考慮
  ```

#### Scenario: TXT export groups consecutive same-speaker segments

- **WHEN** the user clicks the TXT export button on a meeting whose first three segments are all `SPEAKER_00` followed by one segment of `SPEAKER_01`
- **THEN** the downloaded `.txt` file SHALL contain a single `SPEAKER_00:` paragraph joining the first three segments' text, followed by a single `SPEAKER_01:` paragraph for the fourth segment
