## Why

The PWA currently throws audio away the instant transcription completes. Users have repeatedly asked: "the transcript got one word wrong — can I just listen back to that part?" and "can I re-run the bigger model on my last meeting?" — and the answer is no, because we keep only text. Persisting the captured audio in the browser unlocks (a) verifying a suspect transcript by ear, (b) re-running ASR with different parameters or after fixing a model bug, and (c) future per-segment seek/click-to-replay. Doing this client-side avoids any new server storage, auth, or privacy surface.

## What Changes

- **New IndexedDB store** `whisper-wrap.audio` keyed by `session_id` holding one compressed audio blob per session (MIME `audio/webm;codecs=opus` from `MediaRecorder`), plus duration and byte size metadata.
- **Capture wiring**: Batch mode already produces a `MediaRecorder` blob — it will be saved on stop. Live mode currently only sends raw PCM over the WebSocket; a parallel `MediaRecorder` instance SHALL be attached to the same `MediaStream` so we get a compressed master copy in addition to the PCM stream sent to `/listen`.
- **Retention**: total audio storage SHALL be bounded by a user-configurable budget (default 100 MB). When a new session would push usage over the budget, the oldest sessions' audio blobs SHALL be evicted in chronological order until usage fits. The session text record in localStorage SHALL be retained even after its audio is evicted; the UI SHALL render "audio expired" for those sessions.
- **Waveform player UI** in each `HistoryPanel` session card: a canvas-rendered waveform (computed from decoded PCM peaks, no external dependency), a play/pause button, a seek-by-click interaction on the canvas, and a current-time / total-time readout. Disabled state with "no audio available" label for sessions captured before this feature shipped or whose blob has been evicted.
- **Re-ASR action**: a "Re-transcribe" button on each session card with stored audio that POSTs the blob to the existing `POST /transcribe` endpoint and appends the new transcript as an `ActionRun` entry (so the original transcript stays intact and the comparison is visible). User can pick prompt and language via a small inline form before submitting; defaults to current Settings values.
- **Settings additions**: a "Save audio for replay" toggle (default ON), an "Audio storage budget (MB)" numeric field (default 100, min 10, max 1000), and a "Clear all stored audio" destructive button with double-confirm.
- **i18n**: ~15 new translation keys covering player controls, settings labels, eviction notices, and re-ASR prompts; both `en` and `zh-TW` populated.
- No server changes. No new dependencies (uses native IndexedDB, `MediaRecorder`, and `AudioContext.decodeAudioData`).

## Non-Goals (optional)

(Non-goals are recorded in design.md under Goals/Non-Goals.)

## Capabilities

### New Capabilities

- `pwa-audio-replay`: Client-side persistence of captured audio per session in IndexedDB, with a waveform-based player and a re-transcription action wired to `POST /transcribe`. Includes a configurable byte budget with FIFO eviction and Settings controls for opt-out and clear-all.

### Modified Capabilities

(none — the existing live-streaming capability covers the WebSocket transcription contract; audio replay is a separate persistence/playback concern and ships as a new capability.)

## Impact

- Affected specs: new `openspec/specs/pwa-audio-replay/spec.md`
- Affected code:
  - New:
    - frontend/src/storage/audio-store.ts
    - frontend/src/storage/audio-store.test.ts
    - frontend/src/capture/dual-recorder.ts
    - frontend/src/capture/dual-recorder.test.ts
    - frontend/src/ui/waveform-player.ts
    - frontend/src/ui/waveform-player.test.ts
    - frontend/src/ui/waveform-peaks.ts
    - frontend/src/ui/waveform-peaks.test.ts
    - frontend/src/ui/re-asr-form.ts
    - frontend/src/ui/re-asr-form.test.ts
  - Modified:
    - frontend/src/capture/mic-pipeline.ts
    - frontend/src/main.ts
    - frontend/src/ui/history-panel.ts
    - frontend/src/ui/settings-panel.ts
    - frontend/src/storage/history-store.ts
    - frontend/src/i18n/strings.ts
    - frontend/src/i18n/index.test.ts
    - frontend/src/ui/actions-and-settings.test.ts
  - Removed: (none)
