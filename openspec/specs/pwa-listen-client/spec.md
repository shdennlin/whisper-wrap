# pwa-listen-client Specification

## Purpose

TBD - created by archiving change 'v2-4-pwa-listen-client'. Update Purpose after archive.

## Requirements

### Requirement: Installable PWA mounted at `/app/`

The system SHALL serve a Progressive Web App at the path `/app/` of the whisper-wrap FastAPI host. The PWA SHALL be a single-page TypeScript application with a Web App Manifest declaring `start_url: "/app/"`, `display: "standalone"`, a `name`, a `short_name`, a `theme_color`, a `background_color`, and `192x192` plus `512x512` icon entries. The PWA SHALL be installable to the home screen on Chrome / Safari / Edge on macOS, iOS, and Android. The PWA SHALL be reachable without authentication.

The static bundle SHALL ship under `app/static/app/` and SHALL be mounted via FastAPI's `StaticFiles` so the same FastAPI process that serves `/transcribe`, `/listen`, `/ask`, `/v1/...`, and `/actions` also serves the PWA. The PWA SHALL call backend endpoints at `window.location.origin` so no CORS configuration is required.

#### Scenario: PWA shell loads at /app/

- **WHEN** a client requests `GET /app/`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: text/html; charset=utf-8` and the body SHALL contain a `<link rel="manifest" href="/app/manifest.webmanifest">` element and a `<script type="module">` loading the application bundle

#### Scenario: Manifest is reachable

- **WHEN** a client requests `GET /app/manifest.webmanifest`
- **THEN** the response SHALL be HTTP 200 with `Content-Type` for a web app manifest (`application/manifest+json` or `application/json`) and the JSON body SHALL contain at minimum the fields `name`, `short_name`, `start_url` (equal to `/app/`), `display` (equal to `standalone`), `icons` (a non-empty list), `theme_color`, `background_color`


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Real-time captioning UI consumes WS /listen

The PWA SHALL capture microphone audio when the user presses Record, downsample it client-side to 16 kHz mono `pcm_s16le` (handling browsers that report any source sample rate by passing the audio through an AudioWorklet that linearly interpolates as needed), chunk it into frames of 4 000 samples (8 000 bytes ≈ 250 ms), and stream those frames as binary WebSocket messages to `WS /listen` of the same origin. The PWA SHALL stop streaming and close the socket cleanly when the user presses Stop.

The PWA SHALL receive JSON events of shape `{"type": "partial"|"final", "text": str, "start_ms": int, "end_ms": int}` from the WebSocket and SHALL render them so:

- `partial` events: render as a single grey, italic line that REPLACES (not appends to) the prior partial. Each new `partial` event overwrites the previous one.
- `final` events: append as a black, non-italic transcript cue with the `text` shown verbatim and a small timestamp label (`mm:ss`). The grey partial line is cleared whenever a final arrives for the same utterance.

#### Scenario: Live partials and finals render in expected colours

- **WHEN** a `partial` event arrives followed by a `final` event with overlapping text
- **THEN** the PWA SHALL render the partial as grey italic text in a dedicated partial slot, replace it on each subsequent partial, and clear it when the final arrives — at which point the final SHALL appear as a new black cue with its `mm:ss` timestamp

#### Scenario: Recording stops cleanly

- **WHEN** the user clicks Stop while a recording is in progress
- **THEN** the PWA SHALL stop publishing PCM frames, send a WebSocket close frame, retain all already-confirmed finals in the on-screen transcript, and persist the session to localStorage (per the History Persistence requirement)


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Connection state indicator with bounded auto-reconnect

The PWA SHALL render a connection-status indicator visible in the application header at all times. The indicator SHALL have exactly three observable states:

- **green** — WebSocket is open and a frame has been acknowledged by the server (or the WS is open and no errors have occurred since the last successful send)
- **yellow** — the WebSocket is closed unexpectedly and the PWA is attempting reconnect, or the initial connect is in progress
- **red** — the auto-reconnect attempt limit has been exhausted, OR the user has not yet pressed Record (idle initial state SHALL be neutral grey, distinguishable from red)

On unexpected disconnect (any close that is not the user pressing Stop), the PWA SHALL reconnect with exponential backoff using the delay sequence `1 s, 2 s, 4 s, 8 s, 16 s, 16 s, 16 s, 16 s, 16 s, 16 s` (10 attempts, capped at 16 s). If all 10 attempts fail, the indicator SHALL go red and a manual Retry button SHALL appear alongside it.

Across reconnects the PWA SHALL preserve all `final` cues already on screen. Only the in-flight partial MAY be lost. The PWA SHALL maintain a per-session monotonic time offset so that newly arriving `start_ms`/`end_ms` from a fresh connection are translated to the session's global time before being added to finals (used by SRT/VTT export to produce non-decreasing timestamps).

#### Scenario: WebSocket reconnect preserves prior finals

- **WHEN** the WebSocket is dropped after 3 finals have been emitted and the PWA reconnects successfully on attempt 2
- **THEN** the 3 finals SHALL remain on screen, the indicator SHALL return to green, and the next final emitted on the new connection SHALL appear after them with a timestamp greater than the previous final's

#### Scenario: Reconnect exhaustion shows red state

- **WHEN** 10 reconnect attempts have failed in a row
- **THEN** the indicator SHALL be red, a Retry button SHALL be visible, and clicking Retry SHALL reset the attempt counter and start a new connect cycle


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Subtitle export (SRT, VTT, TXT) generated client-side from finals

The PWA SHALL offer Export menu actions for each persisted session producing:

- **TXT** — the `text` field of each final, separated by single newlines, with no timestamps
- **SRT** — sequential numbered cues, comma `,` as the millisecond separator, blank line between cues, trailing blank line, using `start_ms` and `end_ms` directly from each final
- **VTT** — `WEBVTT` header followed by a blank line, period `.` as the millisecond separator, blank line between cues, trailing blank line

Export SHALL be performed client-side (no backend round-trip) and SHALL trigger a browser download (`<a download="…">` or `URL.createObjectURL` + `Blob`). Output filenames SHALL include the session `started_at` formatted as `YYYY-MM-DD_HHMMSS` so multiple exports do not collide.

#### Scenario: SRT export matches the canonical format

- **WHEN** the user clicks Export → SRT on a session containing two finals `[(0 ms, 2500 ms, "hello world."), (2500 ms, 6000 ms, " how are you.")]`
- **THEN** the downloaded `.srt` file SHALL have the body:

```
1
00:00:00,000 --> 00:00:02,500
hello world.

2
00:00:02,500 --> 00:00:06,000
 how are you.

```

#### Scenario: VTT export uses period millisecond separator

- **WHEN** the user clicks Export → VTT on the same session
- **THEN** the downloaded `.vtt` file SHALL begin with the literal line `WEBVTT` followed by a blank line, and each cue's timestamps SHALL use `.` as the millisecond separator (per the WebVTT specification) — distinct from SRT's `,`


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Actions bar populates from GET /actions and wraps transcripts before POST /ask

After a recording stops (and any time a session is open in the History panel), the PWA SHALL render an Actions chip bar populated by fetching `GET /actions` once per page load. Each entry SHALL be rendered as a clickable chip showing the action's `label`. Clicking a chip SHALL replace the literal `{transcript}` token in the action's `template` with the session's joined final text and POST the resulting string as JSON `{"text": "<wrapped-prompt>"}` to `/ask`, then render the returned `answer` field inline below the transcript. The PWA SHALL persist the action run (action id, wrapped prompt, answer, ran_at timestamp) into the session's `action_runs` array in localStorage so the answer survives reload.

If `GET /actions` returns HTTP non-2xx or the response body is malformed, the PWA SHALL render only a single built-in chip labelled `直接送` whose template is `{transcript}` and show a non-blocking warning toast that the server's actions registry could not be loaded.

If `/ask` returns HTTP non-2xx, the PWA SHALL render the response body's error text (or a generic "Gemini 回應失敗" message) into the answer pane and SHALL NOT remove the chip / lock the UI.

#### Scenario: Action chip wraps transcript and posts to /ask

- **WHEN** the user clicks the `整理會議重點` chip on a session whose joined finals equal "今天我們討論 X 和 Y"
- **THEN** the PWA SHALL POST `Content-Type: application/json` body `{"text": "<the template with {transcript} replaced by '今天我們討論 X 和 Y'>"}` to `/ask` and SHALL render the `answer` field of the response in the answer pane below the transcript

#### Scenario: /actions endpoint unreachable falls back to passthrough

- **WHEN** `GET /actions` returns HTTP 502
- **THEN** the Actions bar SHALL contain exactly one chip labelled `直接送` whose template is the literal string `{transcript}`, and a non-blocking warning SHALL be displayed without breaking the rest of the UI


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Settings panel exposes mic device, display toggles, retention, backend URL

The PWA SHALL provide a Settings panel reachable from the application header. The panel SHALL expose the following controls, all persisted to `localStorage`:

- **Microphone input device**: a select populated from `navigator.mediaDevices.enumerateDevices()` filtered to `kind === "audioinput"`. The PWA SHALL remember the chosen device and reuse it on subsequent recordings.
- **Backend base URL**: a text input defaulting to `window.location.origin`. Changing it SHALL retarget `/listen`, `/ask`, `/actions` to the new origin (useful only when the operator manually edits to debug).
- **Show partials**: a checkbox; when off, the PWA SHALL render only `final` cues, hiding the grey partial line entirely.
- **Auto-scroll**: a checkbox; when on, the transcript view SHALL scroll to the bottom on every new final.
- **History retention count**: an integer input, default 20, range 1–50. When lowered, oldest sessions beyond the new cap SHALL be evicted immediately.

Dark mode SHALL automatically follow the OS preference via the CSS `prefers-color-scheme: dark` media query — there SHALL be no manual dark mode toggle in v1.

#### Scenario: Mic device selection persists across reloads

- **WHEN** the user picks "AirPods Pro" from the mic select and reloads the page
- **THEN** on next reload the mic select SHALL be pre-populated with "AirPods Pro" as the active selection (assuming that device is still enumerable)

#### Scenario: Hiding partials removes the grey line

- **WHEN** the user unchecks "Show partials" and starts a new recording
- **THEN** no grey italic partial line SHALL appear during the recording, but black final cues SHALL still appear as they are confirmed


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: Service worker caches shell for offline shell + history viewing

The PWA SHALL register a service worker generated by `vite-plugin-pwa` (Workbox) that caches the static shell with a `staleWhileRevalidate` strategy: HTML, JavaScript bundles, CSS, icons, and the manifest are served from cache when available and refreshed in the background. The service worker SHALL NOT cache `/listen`, `/ask`, `/actions`, `/transcribe`, `/status`, or any `/v1/*` route — those SHALL use a `networkOnly` strategy so the user always reaches the live backend.

When the backend is unreachable but the PWA shell is cached, the user SHALL be able to open `/app/` and view their history (the history-panel reads `localStorage` only and does not require network). The Record button SHALL display a friendly disabled state with a tooltip explaining "backend unreachable" when WebSocket connect fails on the first attempt.

When `vite-plugin-pwa` detects a new bundle, the PWA SHALL show a non-blocking "新版本已就緒，重新整理？" toast with a Reload button (vite-plugin-pwa built-in `registerSW`).

#### Scenario: Offline shell loads with history visible

- **WHEN** the backend is stopped and the user opens `/app/` in a browser tab where the PWA was previously loaded successfully
- **THEN** the PWA shell SHALL render with the History panel populated from localStorage, the Record button SHALL be visibly disabled with a tooltip mentioning the backend, and no JavaScript error SHALL be raised in the browser console

#### Scenario: New version available toast

- **WHEN** a new bundle is deployed (asset URLs change due to content hashing) and the user has the old version open
- **THEN** the service worker SHALL detect the new version on next page load and the PWA SHALL display a non-blocking toast with a Reload button; clicking Reload SHALL load the new bundle


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: PWA handles browser-permission and secure-origin failures gracefully

The PWA SHALL detect and surface the following failure modes with user-friendly messages (no raw error stacks shown):

- **Microphone permission denied**: a modal explaining the issue and offering a "How do I fix this?" link. The Record button SHALL stay enabled so the user can retry after fixing the permission.
- **Insecure origin** (`window.isSecureContext === false` AND `window.location.hostname !== "localhost"`): a top-of-page banner explaining that the microphone API requires HTTPS or localhost. The banner SHALL link to `docs/HTTPS-TAILSCALE.md` and remain visible until dismissed.
- **`getUserMedia` not available** (very old browser): a modal explaining the requirement, with no Record button shown.

#### Scenario: Insecure-origin banner appears on http://192.168.x.x

- **WHEN** the PWA is loaded from `http://192.168.1.50:8000/app/` (non-localhost, non-HTTPS)
- **THEN** an `isSecureContext` banner SHALL be displayed at the top of the page with a link to the Tailscale HTTPS doc, and the banner SHALL persist until the user dismisses it

#### Scenario: Microphone permission denied surfaces a modal

- **WHEN** the user presses Record and the browser denies microphone access
- **THEN** a modal SHALL appear with a localised explanation, the Record button SHALL not enter a "recording" visual state, and the modal SHALL include a link to how to enable mic permission for the browser

<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: History view renders as master-detail pseudo-route with re-runnable AI Actions

The PWA SHALL render history as a master-detail view mounted on the hash route `#/history` (no selection) and `#/history/<session_id>` (with selection). The recording shell SHALL remain mounted at the empty hash. The History view SHALL claim the full viewport width (not the sidebar) and SHALL contain a left rail listing sessions and a right detail panel for the selected session.

The rail SHALL render sessions in reverse chronological order (newest first) and SHALL include a search box that filters the rail entries case-insensitively against each session's formatted `started_at` (`YYYY-MM-DD HH:MM`) and the concatenation of `finals[].text`. Search filtering SHALL be debounced to 120 ms on input and SHALL operate over the in-memory cache populated by `HistoryStore.prime()`. Each rail row SHALL display the session's date, duration, and word count.

The detail panel SHALL render the selected session's metadata (date, duration, word count), waveform audio player (when an audio file exists, behaviorally identical to the existing `WaveformPlayer`), full transcript (joined `finals[].text`), an action-runs list, and an "Add AI Action" control. The action-runs list SHALL render every row of `action_runs` for the session, sorted by `ran_at DESC`, each row showing the resolved action label, the timestamp, the answer body, and a per-run Delete button.

The "Add AI Action" control SHALL open the existing action picker (the same templates loaded from `/actions`); on confirm the PWA SHALL POST the templated prompt to `/ask` as text input (no audio body), and on the answer SHALL POST `{"action_id", "prompt", "answer", "ran_at"}` to `POST /v1/sessions/<id>/runs`. While a re-run is in flight, the "Add AI Action" control SHALL be disabled to prevent duplicate concurrent submissions for the same session. On success the runs list SHALL re-render to include the new row.

Each action-run row's Delete button SHALL open a confirm dialog and on confirm SHALL call `HistoryStore.deleteRun(session_id, run_id)`. On 204 the run row SHALL be removed from the panel without a full page reload.

When the viewport width is at or below 768 px the rail and detail SHALL occupy the full width and SHALL toggle: when no `session_id` is present the rail SHALL be visible; when a `session_id` is present the detail SHALL be visible with a "Back" affordance that navigates to `#/history` (rail-only).

#### Scenario: Hash route mounts History view

- **GIVEN** the PWA is loaded with hash `""`
- **AND** the recording shell is mounted
- **WHEN** the user activates the Show-history control or `location.hash` becomes `#/history`
- **THEN** the recording shell is hidden and the History view is mounted with the rail populated and the detail panel showing an empty state

#### Scenario: Selecting a session updates the route

- **GIVEN** the History view is mounted at `#/history`
- **WHEN** the user clicks a session row in the rail
- **THEN** `location.hash` SHALL become `#/history/<session_id>` and the detail panel SHALL render that session's transcript and `action_runs`

#### Scenario: Search filters the rail

- **GIVEN** the rail contains 12 sessions with various transcript content
- **WHEN** the user types "meeting" into the search box
- **THEN** within 120 ms only sessions whose formatted date or `finals[].text` contains "meeting" (case-insensitive) SHALL remain visible in the rail
- **AND** clearing the search box SHALL restore all 12 sessions

#### Scenario: Re-running an Action against a past session appends a new run

- **GIVEN** the detail panel is rendered for session `S` with two existing `action_runs`
- **WHEN** the user clicks "Add AI Action", picks template `summarize`, and confirms
- **THEN** the PWA SHALL POST `{"text": "<templated prompt>"}` to `/ask`
- **AND** on the answer SHALL POST `{"action_id": "summarize", "prompt": "...", "answer": "...", "ran_at": <ms>}` to `POST /v1/sessions/S/runs`
- **AND** the detail panel SHALL render three runs sorted by `ran_at DESC`, the newest at the top

#### Scenario: Concurrent re-run guard

- **GIVEN** the detail panel is showing session `S` and the user clicks "Add AI Action" and confirms template `summarize`
- **WHEN** the user clicks "Add AI Action" again before the in-flight `/ask` resolves
- **THEN** the "Add AI Action" control SHALL be disabled and the second click SHALL NOT produce a second `/ask` POST

#### Scenario: Deleting one run leaves others intact

- **GIVEN** session `S` has three `action_runs` rendered in the detail panel
- **WHEN** the user clicks the Delete button on the middle row, confirms the dialog, and `DELETE /v1/sessions/S/runs/<run_id>` returns 204
- **THEN** that row SHALL be removed from the detail panel
- **AND** the remaining two rows SHALL still render in their original order
- **AND** `HistoryStore.list()` for session `S` SHALL return two `action_runs`

#### Scenario: Mobile collapse toggles between rail and detail

- **GIVEN** the viewport is 360 px wide and the user is at `#/history`
- **WHEN** the user clicks a session row
- **THEN** the rail SHALL hide, the detail SHALL fill the viewport, and a "Back" control SHALL be visible
- **WHEN** the user clicks "Back"
- **THEN** `location.hash` SHALL become `#/history` and the rail SHALL be visible while the detail SHALL be hidden

<!-- @trace
source: history-ux-overhaul
updated: 2026-06-05
code:
  - frontend/package.json
  - CHANGELOG.md
  - pyproject.toml
  - uv.lock
-->