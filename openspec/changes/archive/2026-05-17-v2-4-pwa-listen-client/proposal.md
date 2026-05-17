## Why

whisper-wrap's live-captioning surface (`WS /listen`) currently has no graphical front-end. To use it the operator has to run `scripts/live-caption.py` in a terminal — fine for development and benchmarking, useless for actual meeting capture, sharing, or recall. The v2 PRD listed a PWA front-end as a planned v2.x deliverable, and the v2.3 OpenAI-compat work explicitly stopped short of touching this gap (open-webui only does file-upload dictation, never real-time captioning).

Closing this gap delivers three concrete capabilities the current stack cannot:

1. **Real-time captioning for meetings / dictation.** Open a browser tab, press record, see partial captions firm into finals as you speak. Stop, copy the transcript, or export it as an SRT/VTT subtitle file timed to your audio.
2. **One-button "ask Gemini about what I just said."** After recording, pick a pre-defined Action (`整理會議重點`, `翻譯成英文`, `改寫流暢`, `直接送`, or any custom template), and the PWA wraps the transcript with the Action's template before POSTing to `/ask`. The answer renders in-page.
3. **Offline-capable history.** A service worker caches the static shell so the PWA opens on the home screen even without the whisper-wrap backend reachable, and the last 20 capture sessions are persisted in `localStorage` (incrementally written as finals arrive, not only on stop) so a meeting survives a browser crash or backend restart.

The PWA is the natural execution point for the deferred "two-pass" Refine flow (live captions while you talk + batch re-transcribe on stop for cleaner output) — but that lands in a separate change after v1 ships, so the user can start using the basic capture loop sooner.

## What Changes

- A static PWA built with Vite + vanilla TypeScript (no UI framework) is added under `frontend/`. The build output is shipped to `app/static/app/` and mounted at `/app/` by FastAPI's `StaticFiles`. Single FastAPI process; no separate web server.
- The PWA records 16 kHz mono `pcm_s16le` from the browser microphone (downsampling from the typical 48 kHz device rate via an AudioWorklet), streams it to `WS /listen`, renders `partial` events as grey "still-improving" text and `final` events as black confirmed cues with timestamps.
- A new backend capability `prompt-actions` adds a YAML registry (`registry/actions.yaml`) of Action templates (`id`, `label`, `template` with `{transcript}` placeholder) and a `GET /actions` endpoint that returns the list. Built-in actions: `passthrough` ("just send as-is"), `cleanup` ("add punctuation / smooth phrasing"), `summarize` ("整理會議重點"), `translate-en` ("翻譯成英文"), `formalize` ("改寫得更專業"). The PWA fetches this list once at startup and renders Action chips below the transcript.
- The PWA's history pane lists the last 20 capture sessions (one session = one record-to-stop cycle) with timestamp, total word count, an expand/collapse button, a Copy-to-clipboard button, a Delete button, and an "Export SRT" / "Export VTT" / "Export TXT" menu. SRT/VTT are generated client-side from the captured finals' `start_ms`/`end_ms` values. Each session is incrementally written to `localStorage` as new finals arrive so a crash doesn't lose progress.
- A connection-state indicator (green/yellow/red dot) reflects the WebSocket state. On unexpected disconnect the PWA auto-reconnects with exponential backoff (1s → 2s → 4s → 8s, capped at 16s) and preserves the already-confirmed finals — only the in-flight partial is lost.
- A Settings page exposes: microphone device picker (`navigator.mediaDevices.enumerateDevices()`), backend base URL (default `window.location.origin`), display toggles (show partials, auto-scroll, dark mode follows `prefers-color-scheme`), and history retention count (default 20).
- HTTPS deployment via Tailscale cert is documented in a new doc and a `make dev-https` target that reads `WHISPER_CERT`/`WHISPER_KEY` env vars and forwards them to uvicorn's `--ssl-certfile` / `--ssl-keyfile`. The PWA itself works equally on `http://localhost:8000/app/` (Mac mini local browser) and `https://mac-mini.tailXXXXX.ts.net/app/` (phone / iPad over Tailscale) — only the `getUserMedia` permission requires HTTPS for non-localhost origins.
- `GET /` catalogue gains entries for `/actions` and `/app/` so operators can confirm the PWA is mounted.

## Non-Goals

- **Two-pass "Refine" button** — sending the captured audio buffer to `/transcribe` (or `/v1/audio/transcriptions`) for a higher-accuracy batch pass on stop. The PWA will capture the PCM into a buffer so this becomes a one-button add later, but the v1 PWA does NOT expose the button. Tracked for a follow-up change.
- **Speaker diarization** — neither the underlying Whisper model nor the streaming pipeline distinguishes speakers, and adding this is a model-architecture problem, not a UI problem.
- **Multi-device sync** — explicitly out per user requirement. History lives only in the device's `localStorage`.
- **Multi-language UI** — explicitly out per user requirement. The UI is Traditional Chinese with English-only labels for technical concepts (model names, error codes). No `i18n` layer.
- **Editable transcripts** — clicking a final cue does NOT make it editable in v1. The Copy-to-clipboard button gives plain text the user can paste into a real editor to fix Whisper's mistakes there.
- **Multi-user / accounts / sharing** — no login, no cloud sync, no server-side storage. The PWA is a single-user tool on a LAN-only deployment.
- **`/ask` streaming via SSE in the PWA** — the v1 PWA uses the blocking `/ask` response. Streaming SSE may come later; not required for the Action flow to feel responsive (Gemini responds in 1-3 seconds for typical summaries).
- **Web Speech API offline fallback** — falling back to the browser's built-in STT when whisper-wrap is unreachable. macOS's built-in Mandarin recognition is too poor to be a useful fallback for a Taiwanese-Mandarin-tuned stack; "offline" only means the PWA shell + history are viewable.
- **Configurable LLM backend in the PWA UI** — explicitly chosen against (option A in the design discussion). The PWA only talks to `/ask`. Future Gemini-to-Claude / Gemini-to-GPT switching happens server-side by refactoring `app/services/llm.py` to use LiteLLM in a separate change; the PWA stays unaware.

## Capabilities

### New Capabilities

- `pwa-listen-client`: A browser-based Progressive Web App that captures microphone audio, streams it to `WS /listen`, renders live partial / final captions, persists the last 20 sessions to `localStorage`, exports SRT / VTT / TXT, runs configurable Action templates against the captured transcript via `POST /ask`, and remains installable + offline-capable for shell and history viewing.
- `prompt-actions`: A backend registry of named prompt templates loaded from `registry/actions.yaml`, exposed as `GET /actions`, used by the PWA to populate its Action chip selector. Each action has `id`, `label`, and `template` (a string containing the placeholder `{transcript}`).

### Modified Capabilities

- `status`: `GET /` endpoint catalogue gains entries for `/actions` (the prompt-actions list endpoint) and `/app/` (the PWA static mount) so operators can see at a glance that the new surfaces are live.

## Impact

- Affected specs: new `pwa-listen-client`, new `prompt-actions`; modified `status` (endpoint catalogue).
- Affected code:
  - New: `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/index.html`, `frontend/src/main.ts`, `frontend/src/capture/audio-worklet.ts`, `frontend/src/capture/listen-socket.ts`, `frontend/src/ui/transcript-view.ts`, `frontend/src/ui/actions-bar.ts`, `frontend/src/ui/history-panel.ts`, `frontend/src/ui/settings-panel.ts`, `frontend/src/ui/connection-indicator.ts`, `frontend/src/storage/history-store.ts`, `frontend/src/export/subtitle-export.ts`, `frontend/src/state/app-state.ts`, `frontend/public/manifest.webmanifest`, `frontend/public/icons/icon-192.png`, `frontend/public/icons/icon-512.png`, `frontend/public/sw-meta.ts`, `app/services/actions.py`, `app/api/actions.py`, `registry/actions.yaml`, `tests/test_actions.py`, `docs/HTTPS-TAILSCALE.md`
  - Modified: `app/main.py` (mount StaticFiles at `/app/`, include actions router), `app/api/status.py` (catalogue entries), `Makefile` (add `build-frontend`, `dev-https` targets, wire `build-frontend` into `setup`), `README.md` (link the PWA + open-webui sections side by side), `CLAUDE.md` (document the PWA + actions registry), `pyproject.toml` (no new Python deps; frontend deps live in `frontend/package.json`), `.gitignore` (exclude `frontend/node_modules/`, `frontend/dist/`)
  - Removed: (none)
- Affected env vars:
  - New: `WHISPER_CERT`, `WHISPER_KEY` (optional, only consumed by `make dev-https`)
  - Modified: (none)
- Operational impact:
  - Build-time dependency: Node.js 20+ and npm/pnpm for the frontend build. Not needed at runtime — only when running `make build-frontend` (which `make setup` calls).
  - Runtime: zero new Python deps, zero memory growth, single process unchanged. The PWA bundle is ~150 KB gzipped (static assets served by FastAPI).
  - Deployment: HTTPS is optional. Localhost works without certs. Tailscale cert flow documented in `docs/HTTPS-TAILSCALE.md`; auto-renewal is a launchd / cron one-liner the user runs themselves.
- Integration impact: The PWA is additive. Existing `/transcribe`, `/ask`, `/listen`, `/v1/...`, and `scripts/live-caption.py` consumers are unaffected. open-webui integration from v2.3 keeps working in parallel (different use case: file upload + chat history vs. live capture).
