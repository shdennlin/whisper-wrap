## Context

The PWA captures audio in two modes:

- **Batch mode**: a `MediaRecorder` records to `audio/webm;codecs=opus` (or `audio/mp4` Safari fallback) and uploads the blob to `POST /transcribe` on stop. The blob is currently discarded after upload.
- **Live mode**: an `AudioWorklet` downsamples to 16 kHz mono PCM and ships raw PCM frames over `WS /listen`. The PCM stream is consumed by the server's sliding-window VAD pipeline; nothing on the client retains the audio.

Session metadata (start/end timestamps, finals, action runs) is already persisted to `localStorage` under `whisper-wrap.sessions` (see `frontend/src/storage/history-store.ts`), capped at 20 sessions. There is no client-side store for raw or compressed audio.

Users have asked for two related capabilities:

1. **Replay**: listen back to a session to verify a transcript or hear what was said.
2. **Re-ASR**: re-run transcription on a stored session — useful after fixing a model bug, or to try a different prompt / language.

Both depend on having the original audio available client-side. The smallest viable design stores one compressed audio blob per session, scoped to the same session lifecycle that `history-store` already manages.

Stakeholders: the single user of this PWA (single-tenant deployment). No multi-user / ACL concerns.

## Goals / Non-Goals

**Goals:**

- Persist the captured audio of every new session (Batch and Live) by default, in a format that decodes natively in the browser for replay and that the existing `POST /transcribe` endpoint accepts for re-ASR.
- Bound disk usage with a user-controlled byte budget; never block recording because storage is full (evict instead).
- Render a usable waveform-based player in the session history card with play/pause and click-to-seek.
- Add a "Re-transcribe" action that sends the stored audio to `POST /transcribe` and shows the new transcript next to the original.
- Add Settings controls to opt out of audio storage, adjust the budget, and clear everything in one click.
- Cover the storage layer, peaks computation, dual recorder, and waveform player with unit tests; keep the bundle increment under ~10 KB gzip.

**Non-Goals:**

- Server-side audio storage or any new backend endpoint. Audio lives in IndexedDB only.
- Per-utterance segment extraction. The store holds one blob per *session*, not one per `final`. Click-to-seek is by waveform position, not by transcript word.
- Cross-device sync, export of audio blobs, or sharing.
- Migration of existing localStorage-only sessions to acquire audio retroactively — sessions captured before this ships SHALL render "no audio available".
- Lossless audio. Opus is lossy; that is acceptable for both replay and re-ASR (Whisper re-decodes anyway).
- Editing the stored audio (trim, denoise, etc.).
- Per-session encryption-at-rest beyond what the browser already provides for IndexedDB.

## Decisions

### Storage format: `audio/webm;codecs=opus` (with `audio/mp4` Safari fallback)

Use whatever MIME `MediaRecorder.isTypeSupported` accepts in priority order: `audio/webm;codecs=opus`, then `audio/mp4`. Both decode natively via `<audio>` and `AudioContext.decodeAudioData`, and both are accepted by the server's libmagic + ffmpeg input filter on `/transcribe`.

Why not raw PCM? 16 kHz mono PCM is ~32 KB/s → 1.9 MB/min → 114 MB/hour, blowing the budget in one meeting. Opus at the same input is ~4-8 KB/s → 240-480 KB/min → 14-29 MB/hour, a 5-8× reduction with no perceptual quality loss for replay and no measurable WER hit for re-ASR (the model re-decodes from compressed input the same way as from PCM).

Why not WAV at 16 kHz? Lossless but only ~50% smaller than 24-bit PCM; still much larger than Opus, with no payoff for this use case.

### IndexedDB schema

- Database name: `whisper-wrap`
- Version: `1`
- Object store: `audio`, keyPath `session_id`
- Record shape:
  ```ts
  interface StoredAudio {
    session_id: string;     // matches history-store SessionRecord.id
    mime_type: string;      // "audio/webm;codecs=opus" or "audio/mp4"
    blob: Blob;             // the compressed audio
    duration_ms: number;    // recorded duration; populated on stop
    byte_size: number;      // blob.size, denormalised so eviction does not need to read blobs
    stored_at: number;      // Date.now()
  }
  ```
- Index: `by_stored_at` on `stored_at` (ascending) for FIFO eviction.

The store is intentionally flat (one record per session, no per-segment subkeys). Eviction reads only the `by_stored_at` index plus `byte_size` — never the blob itself — so accounting stays cheap.

### Capture wiring

- **Batch mode**: the existing `MediaRecorder` already produces a blob. Keep that blob, and on session stop write it to `audio-store` keyed by the just-finalised `session_id`. No structural change to the capture pipeline.
- **Live mode**: the `AudioWorklet` PCM tap remains the only thing feeding the WebSocket. *Additionally* attach a `MediaRecorder` to the same `MediaStream` so the browser encodes a parallel compressed copy. On Live-stop, after the in-flight finals have flushed (existing graceful-stop behaviour), wait for the recorder's `stop` event and persist the resulting blob.

The dual-recorder wrapper SHALL expose a single `stop()` that resolves with the final blob, abstracting the difference between Batch (one recorder, returns blob) and Live (PCM stream + recorder, returns blob after both finish). This keeps `main.ts` from having to branch on mode when persisting audio.

If the user has disabled "Save audio for replay" in Settings, the dual-recorder skips attaching the parallel `MediaRecorder` in Live mode and discards the Batch blob without writing it. The recording itself proceeds unchanged.

### Eviction policy: FIFO by `stored_at` until under budget

When a new session's blob is written:

1. Compute `total_bytes` by summing `byte_size` across all records (cheap, index-only read).
2. If `total_bytes + new_blob.size > budget_bytes`, walk the `by_stored_at` index in ascending order and delete records (oldest first) until `total_bytes + new_blob.size <= budget_bytes`.
3. Insert the new record.
4. Emit a one-line toast naming how many sessions' audio was evicted, only if at least one was.

The history record in localStorage is *not* touched — the session card stays visible, the player just shows "audio expired". This decouples audio retention from transcript retention so the user can keep a year of transcripts even with a small audio budget.

Why FIFO over LRU? LRU would require tracking last-replay time, which adds writes on every playback. FIFO has a single timestamp and matches the user's mental model ("old recordings get dropped first").

### Waveform rendering: peaks-on-canvas, computed once and cached

On first display of a session card, the player decodes the blob to a `Float32Array` via `AudioContext.decodeAudioData`, computes min/max peaks per pixel column for the canvas width, and caches the peaks array in memory (not in IndexedDB — recompute is cheap and the cache lives for the page lifetime).

Peaks algorithm: sample the decoded `Float32Array` into `canvas.width` buckets, take `min` and `max` per bucket, render as a vertical line from `min` to `max` per column. This is the standard "two-level" waveform. No external library — ~40 lines of plain TS.

On window resize, peaks are recomputed for the new width.

If `decodeAudioData` rejects (corrupt blob, unsupported codec on some Safari version), the player renders a flat baseline and disables play. Toast a warning once per session.

### Player state machine

States: `idle`, `loading` (decoding), `ready`, `playing`, `paused`, `error`.

The `<audio>` element is the time source. Player ticks 30 Hz via `requestAnimationFrame` to move the cursor (no `timeupdate` event reliance — its rate is browser-dependent).

Click on canvas: seek to `(clickX / canvas.width) * audio.duration`, then resume the prior `playing` / `paused` state.

### Re-ASR flow

The "Re-transcribe" button reveals an inline form with: prompt (text), language (select), and Submit / Cancel. Defaults pull from current Settings. On submit:

1. Read blob from `audio-store`.
2. POST to `/transcribe` as multipart with `file=<blob>`, `language?=...`, `prompt?=...`.
3. Append the response text + timestamp to the session's `action_runs` as a new entry with `action_id: "re_asr"`.
4. History card re-renders to show the new run.

Why reuse `ActionRun`? It already has `prompt`, `answer`, and `ran_at` — perfect fit. No schema change to history-store. The card's existing AI-response section renders it automatically.

If `/transcribe` fails (network, 4xx, 5xx), show the error in the form (do not append a failed run to history). User can retry.

### Settings additions

Three new fields, in order, below the existing Live timeout fields:

- `audio.save` (boolean, default `true`) — when off, no audio is written for new sessions; the player on existing cards is unaffected.
- `audio.budget_mb` (integer, default `100`, min `10`, max `1000`) — clamped on save; values outside range are rejected with an inline error.
- "Clear all stored audio" button — opens a double-confirm dialog (matches existing Discard pattern), then deletes every record in `audio-store`. Toast confirms count deleted.

Settings keys live under existing `whisper-wrap.settings` localStorage entry.

### i18n keys

Add ~15 keys under a new `audio` group in `frontend/src/i18n/strings.ts`, populated in both `en` and `zh-TW`:

- `audio.playerExpired`, `audio.playerNoAudio`, `audio.playerLoading`, `audio.playerError`
- `audio.reTranscribe`, `audio.reTranscribeSubmit`, `audio.reTranscribeCancel`, `audio.reTranscribePromptLabel`, `audio.reTranscribeLanguageLabel`, `audio.reTranscribeFailed`
- `audio.evicted` (with `{count}` placeholder)
- `settings.audioSaveLabel`, `settings.audioSaveHint`, `settings.audioBudgetLabel`, `settings.audioBudgetHint`, `settings.audioClearAllButton`, `settings.audioClearAllConfirm`, `settings.audioClearedToast` (with `{count}` placeholder)

## Implementation Contract

**Behaviour:** After this ships, the PWA SHALL persist the captured audio of every new Batch and Live session (when the `audio.save` Setting is enabled) into IndexedDB, render a waveform player with working play / pause / click-to-seek in every history card whose session has stored audio, and offer a "Re-transcribe" action that posts the stored blob to `/transcribe` and appends the answer as an `ActionRun`. Sessions captured before this change ships, or whose audio has been evicted, SHALL render a disabled player labelled with the `audio.playerNoAudio` or `audio.playerExpired` string.

**Interfaces / data shapes:**

- `AudioStore` class in `frontend/src/storage/audio-store.ts` exposing:
  - `put(session_id: string, blob: Blob, duration_ms: number): Promise<void>` — also runs eviction
  - `get(session_id: string): Promise<StoredAudio | null>`
  - `delete(session_id: string): Promise<void>`
  - `clear(): Promise<number>` — returns count deleted
  - `totalBytes(): Promise<number>`
  - `setBudgetBytes(n: number): void` — runtime budget, persisted to localStorage `whisper-wrap.audio_budget`
- `DualRecorder` class in `frontend/src/capture/dual-recorder.ts` exposing:
  - `constructor(stream: MediaStream, mode: "batch" | "live", saveAudio: boolean)`
  - `start(): void`
  - `pause(): void` / `resume(): void`
  - `stop(): Promise<{ blob: Blob | null; mime_type: string | null; duration_ms: number }>` — `blob` is `null` when `saveAudio` was `false`
- `WaveformPlayer` component in `frontend/src/ui/waveform-player.ts` rendering a canvas + controls into a passed root element, taking `{ blob, mime_type, duration_ms } | { kind: "expired" } | { kind: "missing" }`.
- `computePeaks(samples: Float32Array, columns: number): Array<[min, max]>` exported from `frontend/src/ui/waveform-peaks.ts`.
- `ReAsrForm` component in `frontend/src/ui/re-asr-form.ts` exposing `mount(session_id, defaults, onComplete)`.
- New `ActionRun.action_id` value `"re_asr"` SHALL be treated as a normal run by `history-panel.ts` (no schema change).

**Failure modes:**

- `IDBOpenDBRequest.onerror` (private mode in some browsers, quota exhausted): `AudioStore` methods reject with an `Error` whose message starts with `audio-store unavailable:`. Callers in `main.ts` SHALL catch and toast once per session, then proceed without audio persistence (recording itself MUST NOT fail).
- `decodeAudioData` rejection: waveform player enters `error` state, renders flat baseline, disables play, toasts once.
- `/transcribe` failure during re-ASR: form shows inline error, no `ActionRun` is appended, blob remains in store, user can retry.
- Eviction failure (write to delete fails mid-walk): retry up to 3 times; on permanent failure, abort the new `put`, surface error to caller, leave existing records intact.

**Acceptance criteria:**

- `cd frontend && bun run test` passes including the new vitest suites for `audio-store`, `waveform-peaks`, `waveform-player`, `dual-recorder`, and `re-asr-form`. Total test count goes from 71 to ≥ 95.
- `make build-frontend` succeeds; gzipped bundle stays under +10 KB compared to the pre-change baseline.
- Manual: record one Batch session and one Live session, confirm each shows a waveform with play / pause / seek that match the audio; click "Re-transcribe" and confirm a new entry appears in the history card. Toggle "Save audio for replay" off, record a new session, confirm the player renders `audio.playerNoAudio` and storage size has not grown.
- Manual: lower the budget to 10 MB, record sessions until eviction fires, confirm the eviction toast appears and the oldest cards now render `audio.playerExpired` while their text remains intact.

**Scope boundaries:**

- **In scope:** new `pwa-audio-replay` capability spec; new IndexedDB layer; capture pipeline dual-recorder wiring for both modes; waveform player UI; re-ASR action; three Settings fields; i18n keys for both locales; vitest coverage for storage, peaks, recorder, player, form; updated existing tests that count Settings selects.
- **Out of scope:** server changes; new dependencies; cross-device sync; per-utterance audio segmentation; transcript word click-to-seek; LRU eviction; encryption-at-rest beyond the browser default; migration of pre-existing sessions; CI / Docker / deployment changes.

## Risks / Trade-offs

- [Browser quota varies wildly across vendors and Safari aggressively evicts IndexedDB after 7 days of inactivity] → We bound usage with our own budget rather than relying on the browser's quota. Sessions whose audio has been evicted (by us or by the browser) render `audio.playerExpired`. The transcript text in localStorage is unaffected by both.
- [Safari's `MediaRecorder` Opus support has historical gaps; might fall back to `audio/mp4`] → Probe `MediaRecorder.isTypeSupported` in priority order at recorder construction; record the chosen MIME on the stored record. Both formats are accepted by `/transcribe` via libmagic + ffmpeg.
- [Decoding a 1-hour blob for waveform peaks could spike memory] → Decode on-demand only when the user expands the session card (`<details open>` event); release the `AudioBuffer` reference after computing peaks. Peaks cache is small (~1 KB per session for typical canvas widths).
- [Adding `MediaRecorder` to Live mode means two encoders running on the same stream] → Measured cost is small (Opus encoding is fast). If profiling shows it stutters PCM frame cadence on low-end devices, fall back to disabling the parallel recorder in Live mode and surface a Settings note.
- [Users may rely on private browsing; IndexedDB is per-origin and may be unavailable] → `AudioStore` open failure is non-fatal: warn once, continue without audio persistence, recording still works.

## Migration Plan

Existing sessions in localStorage are read unchanged. The history card renders the new player; for any session whose `id` is not present in `audio-store`, the player shows `audio.playerNoAudio`. No data conversion is needed and no version bump on the localStorage `whisper-wrap.sessions` schema.

Rollback: revert the frontend commit and rebuild. IndexedDB content becomes orphaned but consumes no incremental cost beyond what the user already opted into. No server rollback is needed because the server is unchanged.

