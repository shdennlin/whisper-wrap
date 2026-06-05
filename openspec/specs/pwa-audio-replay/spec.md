# pwa-audio-replay Specification

## Purpose

TBD - created by archiving change 'audio-replay-and-re-asr'. Update Purpose after archive.

## Requirements

### Requirement: Per-session audio persistence in IndexedDB

The PWA SHALL persist exactly one compressed audio blob per recording session in an IndexedDB database named `whisper-wrap`, object store `audio`, keyed by `session_id` (the same identifier used by `whisper-wrap.sessions` in localStorage). Each record SHALL store the fields `session_id`, `mime_type`, `blob`, `duration_ms`, `byte_size`, and `stored_at`. The `mime_type` SHALL be one of `audio/webm;codecs=opus` or `audio/mp4`, chosen at recorder construction by probing `MediaRecorder.isTypeSupported` in that priority order. The store SHALL be created at version `1` with an index `by_stored_at` on the `stored_at` field in ascending order. The PCM frames sent to `WS /listen` SHALL NOT be retained on the client; only the compressed copy from `MediaRecorder` SHALL be stored.

#### Scenario: Batch session writes audio on stop

- **WHEN** the user stops a Batch session whose `MediaRecorder` produced a non-empty blob
- **THEN** the system SHALL write one `audio` record with `session_id` equal to the just-finalised session id, `blob` equal to the recorder output, `duration_ms` equal to the recorded duration, `byte_size` equal to `blob.size`, and `stored_at` equal to `Date.now()`

#### Scenario: Live session writes audio after graceful stop

- **WHEN** the user stops a Live session and all in-flight `final` events have been received and the parallel `MediaRecorder` has emitted its `stop` event
- **THEN** the system SHALL write one `audio` record for that `session_id` using the parallel recorder's blob, before clearing the in-memory recorder state

#### Scenario: IndexedDB unavailable does not break recording

- **WHEN** opening the `whisper-wrap` IndexedDB database fails (private browsing, quota exhausted, or any `IDBOpenDBRequest.onerror`)
- **THEN** the system SHALL toast a single warning whose message begins with `audio-store unavailable:` and SHALL continue the recording and transcription pipeline without persisting audio; subsequent recordings in the same page lifetime SHALL NOT re-toast the same warning


<!-- @trace
source: audio-replay-and-re-asr
updated: 2026-05-17
code:
  - app/main.py
  - frontend/package.json
  - data/audio/mp9wgs6f-52apn.bin
  - frontend/bun.lock
  - registry/actions.yaml
  - app/api/actions.py
  - frontend/src/ui/transcript-view.ts
  - data/audio/mp9wf5vh-1xp8i.bin
  - frontend/src/i18n/strings.ts
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/ui/re-asr-form.ts
  - frontend/src/style.css
  - frontend/src/capture/dual-recorder.ts
  - frontend/src/ui/waveform-player.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/ui/settings-panel.ts
  - app/services/actions.py
  - frontend/src/storage/history-store.ts
  - frontend/src/main.ts
  - frontend/src/ui/waveform-peaks.ts
  - data/history.db
  - frontend/src/ui/actions-bar.ts
  - frontend/src/storage/audio-store.ts
  - frontend/src/theme/index.ts
tests:
  - frontend/src/theme/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/waveform-peaks.test.ts
  - frontend/src/storage/audio-store.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/ui/re-asr-form.test.ts
  - frontend/src/i18n/index.test.ts
  - frontend/src/capture/dual-recorder.test.ts
  - frontend/src/ui/waveform-player.test.ts
-->

---
### Requirement: User-configurable byte budget with FIFO eviction

The system SHALL enforce a total-byte budget over all records in the `audio` object store, defaulting to `100 MB`, persisted under the localStorage key `whisper-wrap.audio_budget` as an integer megabyte value clamped to the closed range `[10, 1000]`. When persisting a new audio record would push the sum of all `byte_size` values plus the new blob's size above the budget, the system SHALL delete records in ascending `stored_at` order until the sum fits, then insert the new record. The corresponding entries in `whisper-wrap.sessions` SHALL NOT be deleted by eviction; the history card for an evicted session SHALL render the player in the `expired` state.

#### Scenario: New session within budget

- **WHEN** writing a new audio record whose `byte_size` plus the existing total stays within the budget
- **THEN** the system SHALL insert the record without deleting any existing record and SHALL NOT emit an eviction toast

#### Scenario: New session triggers eviction

- **WHEN** writing a new audio record whose `byte_size` plus the existing total would exceed the budget
- **THEN** the system SHALL delete the oldest record first (lowest `stored_at`), recompute the total, and continue deleting in `stored_at` ascending order until the new record fits; the system SHALL then insert the new record and SHALL emit one toast naming the count of sessions whose audio was evicted

##### Example: budget eviction order

- **GIVEN** budget `10 MB` and existing records `{A: 5 MB stored_at=1, B: 3 MB stored_at=2, C: 1 MB stored_at=3}` (total `9 MB`)
- **WHEN** inserting record `D: 7 MB stored_at=4`
- **THEN** records `A` and `B` SHALL be deleted (oldest-first), the resulting store SHALL be `{C: 1 MB, D: 7 MB}` totalling `8 MB`, and the toast SHALL announce that 2 sessions' audio was evicted

#### Scenario: Eviction does not remove transcript record

- **WHEN** the audio record for `session_id = X` is deleted by eviction
- **THEN** the entry for `session_id = X` in `whisper-wrap.sessions` SHALL remain unchanged and the history card for that session SHALL render with the player in the `expired` state


<!-- @trace
source: audio-replay-and-re-asr
updated: 2026-05-17
code:
  - app/main.py
  - frontend/package.json
  - data/audio/mp9wgs6f-52apn.bin
  - frontend/bun.lock
  - registry/actions.yaml
  - app/api/actions.py
  - frontend/src/ui/transcript-view.ts
  - data/audio/mp9wf5vh-1xp8i.bin
  - frontend/src/i18n/strings.ts
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/ui/re-asr-form.ts
  - frontend/src/style.css
  - frontend/src/capture/dual-recorder.ts
  - frontend/src/ui/waveform-player.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/ui/settings-panel.ts
  - app/services/actions.py
  - frontend/src/storage/history-store.ts
  - frontend/src/main.ts
  - frontend/src/ui/waveform-peaks.ts
  - data/history.db
  - frontend/src/ui/actions-bar.ts
  - frontend/src/storage/audio-store.ts
  - frontend/src/theme/index.ts
tests:
  - frontend/src/theme/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/waveform-peaks.test.ts
  - frontend/src/storage/audio-store.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/ui/re-asr-form.test.ts
  - frontend/src/i18n/index.test.ts
  - frontend/src/capture/dual-recorder.test.ts
  - frontend/src/ui/waveform-player.test.ts
-->

---
### Requirement: Waveform player in every history card

Each history card in the `HistoryPanel` SHALL render a `WaveformPlayer` whose state is determined by the audio record for that `session_id`. When the audio record exists, the player SHALL render a canvas-drawn waveform computed from the decoded `Float32Array` peaks at the canvas width, plus a play / pause button, a click-to-seek interaction anywhere on the canvas, and a current-time / total-time readout in `m:ss` format. When the audio record does not exist because the session was captured before this capability shipped, the player SHALL render in the `missing` state with the `audio.playerNoAudio` label and disabled controls. When the audio record was deleted by eviction (the `session_id` exists in `whisper-wrap.sessions` but not in `whisper-wrap.audio`), the player SHALL render in the `expired` state with the `audio.playerExpired` label and disabled controls.

#### Scenario: Player loads and plays stored audio

- **WHEN** the user expands a history card whose session has a stored audio record
- **THEN** the player SHALL transition through `loading` (while `decodeAudioData` runs) to `ready`, render a non-empty waveform, and the play button SHALL be enabled; pressing play SHALL transition the player to `playing` and start audio playback at the current cursor position

#### Scenario: Click on canvas seeks playback

- **WHEN** the user clicks the canvas at horizontal pixel `x`
- **THEN** the underlying `<audio>` element's `currentTime` SHALL be set to `(x / canvas.width) * duration_seconds`, and the player SHALL resume the prior `playing` or `paused` state

#### Scenario: Decoding failure disables play

- **WHEN** `AudioContext.decodeAudioData` rejects for the stored blob
- **THEN** the player SHALL transition to `error`, render a flat baseline, disable the play button, and toast one warning naming the session id; the player SHALL NOT crash the surrounding card

#### Scenario: Pre-capability session shows no-audio state

- **WHEN** rendering a history card whose `session_id` is not present in the `audio` object store and whose `started_at` timestamp predates the first run of this capability
- **THEN** the player SHALL render with the `audio.playerNoAudio` label and disabled controls


<!-- @trace
source: audio-replay-and-re-asr
updated: 2026-05-17
code:
  - app/main.py
  - frontend/package.json
  - data/audio/mp9wgs6f-52apn.bin
  - frontend/bun.lock
  - registry/actions.yaml
  - app/api/actions.py
  - frontend/src/ui/transcript-view.ts
  - data/audio/mp9wf5vh-1xp8i.bin
  - frontend/src/i18n/strings.ts
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/ui/re-asr-form.ts
  - frontend/src/style.css
  - frontend/src/capture/dual-recorder.ts
  - frontend/src/ui/waveform-player.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/ui/settings-panel.ts
  - app/services/actions.py
  - frontend/src/storage/history-store.ts
  - frontend/src/main.ts
  - frontend/src/ui/waveform-peaks.ts
  - data/history.db
  - frontend/src/ui/actions-bar.ts
  - frontend/src/storage/audio-store.ts
  - frontend/src/theme/index.ts
tests:
  - frontend/src/theme/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/waveform-peaks.test.ts
  - frontend/src/storage/audio-store.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/ui/re-asr-form.test.ts
  - frontend/src/i18n/index.test.ts
  - frontend/src/capture/dual-recorder.test.ts
  - frontend/src/ui/waveform-player.test.ts
-->

---
### Requirement: Re-transcribe action posts stored blob to /transcribe

Each history card whose session has a stored audio record SHALL display a "Re-transcribe" button labelled with the `audio.reTranscribe` string. Pressing the button SHALL reveal an inline form with a `prompt` text input, a `language` select pre-populated from the current Settings defaults, a Submit button labelled with `audio.reTranscribeSubmit`, and a Cancel button labelled with `audio.reTranscribeCancel`. On Submit, the system SHALL POST a `multipart/form-data` request to the existing `/transcribe` endpoint with `file` set to the stored blob and the supplied `prompt` and `language` parameters when present. On success, the system SHALL append an `ActionRun` record to the session with `action_id = "re_asr"`, `prompt` equal to the submitted prompt (empty string when not provided), `answer` equal to the response body's transcript text, and `ran_at` equal to `Date.now()`. On failure, the system SHALL render an inline error in the form using the `audio.reTranscribeFailed` string with the HTTP status or thrown message, and SHALL NOT append any `ActionRun`.

#### Scenario: Successful re-transcription appends ActionRun

- **WHEN** the user submits the Re-transcribe form for a session whose stored blob is present and `/transcribe` returns HTTP 200 with a transcript
- **THEN** the system SHALL append one new `ActionRun` to that session's `action_runs` with `action_id = "re_asr"`, and the history card SHALL re-render to show the new run in the AI-response section

#### Scenario: Failed re-transcription preserves history

- **WHEN** the user submits the Re-transcribe form and `/transcribe` returns a non-2xx status or the fetch throws
- **THEN** the system SHALL render the failure message inline in the form, SHALL NOT modify the session's `action_runs`, and the stored audio record SHALL remain in `audio`

#### Scenario: Re-transcribe button hidden when no audio available

- **WHEN** rendering a history card whose `session_id` is absent from the `audio` object store
- **THEN** the Re-transcribe button SHALL NOT be rendered


<!-- @trace
source: audio-replay-and-re-asr
updated: 2026-05-17
code:
  - app/main.py
  - frontend/package.json
  - data/audio/mp9wgs6f-52apn.bin
  - frontend/bun.lock
  - registry/actions.yaml
  - app/api/actions.py
  - frontend/src/ui/transcript-view.ts
  - data/audio/mp9wf5vh-1xp8i.bin
  - frontend/src/i18n/strings.ts
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/ui/re-asr-form.ts
  - frontend/src/style.css
  - frontend/src/capture/dual-recorder.ts
  - frontend/src/ui/waveform-player.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/ui/settings-panel.ts
  - app/services/actions.py
  - frontend/src/storage/history-store.ts
  - frontend/src/main.ts
  - frontend/src/ui/waveform-peaks.ts
  - data/history.db
  - frontend/src/ui/actions-bar.ts
  - frontend/src/storage/audio-store.ts
  - frontend/src/theme/index.ts
tests:
  - frontend/src/theme/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/waveform-peaks.test.ts
  - frontend/src/storage/audio-store.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/ui/re-asr-form.test.ts
  - frontend/src/i18n/index.test.ts
  - frontend/src/capture/dual-recorder.test.ts
  - frontend/src/ui/waveform-player.test.ts
-->

---
### Requirement: Settings controls for opt-out, budget, and clear-all

The Settings panel SHALL include three controls related to audio replay, placed below the existing Live timeout fields in this order: a boolean toggle `audio.save` labelled with `settings.audioSaveLabel` and defaulting to `true`; an integer field `audio.budget_mb` labelled with `settings.audioBudgetLabel`, defaulting to `100`, with `min=10` and `max=1000`; and a button labelled with `settings.audioClearAllButton` that opens a double-confirm dialog and on second confirmation deletes every record in the `audio` object store. The boolean toggle SHALL be persisted under the existing `whisper-wrap.settings` localStorage entry. The integer field SHALL be persisted under `whisper-wrap.audio_budget` as a megabyte integer; values outside `[10, 1000]` SHALL be rejected with an inline error and SHALL NOT be saved.

#### Scenario: Disabling audio.save skips audio writes

- **WHEN** `audio.save` is set to `false` in Settings and the user records a new session in either mode
- **THEN** no `MediaRecorder` SHALL be attached to the Live stream and no Batch blob SHALL be written to the `audio` object store; the session's transcript and `ActionRun` data SHALL still be persisted to `whisper-wrap.sessions`

#### Scenario: Clear-all deletes every audio record

- **WHEN** the user presses the clear-all button and confirms twice in the dialog
- **THEN** the system SHALL delete every record in the `audio` object store and emit one toast using the `settings.audioClearedToast` string with the count of deleted records; entries in `whisper-wrap.sessions` SHALL remain unchanged

#### Scenario: Budget value out of range is rejected

- **WHEN** the user sets `audio.budget_mb` to a value outside `[10, 1000]` or to a non-integer
- **THEN** the field SHALL display an inline error, the previous valid value SHALL remain in effect, and `whisper-wrap.audio_budget` SHALL NOT be written

<!-- @trace
source: audio-replay-and-re-asr
updated: 2026-05-17
code:
  - app/main.py
  - frontend/package.json
  - data/audio/mp9wgs6f-52apn.bin
  - frontend/bun.lock
  - registry/actions.yaml
  - app/api/actions.py
  - frontend/src/ui/transcript-view.ts
  - data/audio/mp9wf5vh-1xp8i.bin
  - frontend/src/i18n/strings.ts
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/ui/re-asr-form.ts
  - frontend/src/style.css
  - frontend/src/capture/dual-recorder.ts
  - frontend/src/ui/waveform-player.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/ui/settings-panel.ts
  - app/services/actions.py
  - frontend/src/storage/history-store.ts
  - frontend/src/main.ts
  - frontend/src/ui/waveform-peaks.ts
  - data/history.db
  - frontend/src/ui/actions-bar.ts
  - frontend/src/storage/audio-store.ts
  - frontend/src/theme/index.ts
tests:
  - frontend/src/theme/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/waveform-peaks.test.ts
  - frontend/src/storage/audio-store.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/ui/re-asr-form.test.ts
  - frontend/src/i18n/index.test.ts
  - frontend/src/capture/dual-recorder.test.ts
  - frontend/src/ui/waveform-player.test.ts
-->