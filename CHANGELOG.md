# Changelog

All notable changes to this project will be documented in this file.

---

## [2.1.0] — 2026-06-09

**Meeting Mode release.** Adds long-form meeting analysis with speaker
diarization on a dedicated, architecturally-isolated endpoint. The four
existing endpoints (`/transcribe`, `/listen`, `/ask`, `/v1/*`) are
unchanged. No migration required from 2.0.0.

### Added

- **`POST /transcribe/meeting`** + **`GET /transcribe/meeting/{job_id}`** —
  async meeting analysis combining WhisperX (ASR), wav2vec2 (word-level
  alignment), and pyannote 3.1 (speaker diarization). Per-segment
  `speaker` labels, segment + word-level timestamps, `speakers` summary
  array. Opt-in via `uv sync --extra meeting` + `HF_TOKEN` (`503
  meeting_unavailable` if missing).
- **PWA Meeting Mode** at `/app/#/meeting` — file upload, async progress
  polling, speaker-coloured transcript, click-to-seek audio player,
  speaker-aware SRT/VTT/TXT exports, editable note titles, sidebar
  delete with two-step confirm.
- **Meeting history persistence** — backend SQLite store + server-side
  audio retention for cross-device replay. Sidebar shows past meetings
  per device.
- **Chat view + AI Enhance** integration for meeting transcripts.
- **PWA batch file upload** for `/transcribe`.
- **i18n in Meeting Mode** — language switcher, per-speaker rename UI,
  per-job toggles for speaker labels / language / word timestamps.
- **`GET /status`** now exposes a `meeting` block (loaded /
  hf_token_configured / supported features).
- **Model registry** — variants intended for meeting analysis must
  declare a `ct2` variant (WhisperX requires CT2). On macOS that means
  downloading BOTH ggml (for `/transcribe`) and ct2 (for
  `/transcribe/meeting`).
- **`make download-model DIARIZE=1`** — pre-stages pyannote
  `speaker-diarization-3.1`, `segmentation-3.0`, AND
  `speaker-diarization-community-1` (PLDA backend loaded transitively).
- **Third-party model licenses** section in README documenting upstream
  licenses for every model whisper-wrap can download.

### Performance

- **Fast mode** — ggml ASR + MPS align/diarize on Apple Silicon
  delivers ~3× speedup over baseline.
- **WhisperX `batch_size=32`** (tunable via `MEETING_BATCH_SIZE`) for
  better CPU SIMD saturation on long files.
- **`compute_type` propagation from registry** to WhisperX yields 3-5×
  ASR speedup on quantised variants.
- **`MEETING_TORCH_DEVICE`** decouples ct2 ASR device (cpu/cuda) from
  torch align/diarize device (mps/cuda/cpu) — best-effort MPS on Apple
  Silicon with CPU fallback.

### Fixed

- pyannote `DiarizeOutput` → `DataFrame` conversion before merge.
- WAV loader now accepts `Path` objects; stepper connector alignment.
- Pre-decode audio to bypass torchcodec dylib bug on certain hosts.
- `int8_float16` → `int8` automatic fallback on macOS CPU (CTranslate2
  limitation).
- Restored colourised level prefix in uvicorn `DefaultFormatter`.
- Four UX polish issues from real-world meeting feedback.

### Security

- Meeting job ID allowlist + audio MIME allowlist + `X-Content-Type-Options: nosniff`
  header on audio replay endpoint.

### Documentation

- README Meeting Mode section (English + zh-TW).
- API.md contracts for `POST /transcribe/meeting` and `GET /transcribe/meeting/{id}`.
- CLAUDE.md Meeting Mode architecture subsection.
- ROADMAP: desktop-app pivot strategic direction (post-v2.x).
- ROADMAP: license posture decision (dual-track, stay MIT for now).

### Known limitations (deferred to follow-ups)

- `docs/API.zh-TW.md` does NOT yet cover the meeting endpoints — the
  README zh-TW translation landed in this release but the API reference
  zh-TW lagged. Tracked for a follow-up PR.
- `docs/INSTALLATION.md` + `INSTALLATION.zh-TW.md` do not yet document
  the meeting-extras install path; the README + API.md cover it.
- No Meeting Mode screenshot in `docs/images/` yet — pending UI capture.

---

## [2.0.0] — 2026-06-05

**Breaking release.** Single in-process FastAPI server replaces the v1
FastAPI + `whisper-server` subprocess pair. This bundle also folds in the
v2.1–v2.4 work (dual-backend, OpenAI compat, live PWA, SQLite persistence,
history UX overhaul) that landed on the development branch but never tagged
separately. Migrating from v1 requires changes to `.env` and
`registry/models.yaml`; see the migration sections below.

### Migration overview

#### Removed endpoints

- `POST /transcribe-raw` — folded into `POST /transcribe` via Content-Type
  dispatch (use `Content-Type: audio/m4a`, `audio/wav`, etc., or
  `application/octet-stream` for raw bodies).
- `GET /health` — replaced by `GET /status` with a richer payload.

#### Removed environment variables

The v2 server detects these still present in the environment at startup and
emits a one-line `WARNING` per detected key, then proceeds — startup does NOT
fail. Remove them from `.env` to silence the warnings.

```
WHISPER_SERVER_HOST    WHISPER_SERVER_PORT     WHISPER_SERVER_URL
WHISPER_AUTO_RESTART   WHISPER_BINARY_PATH     WHISPER_MAX_RETRIES
MODEL_PATH
```

In-app auto-restart is also gone. Use the supervisor's restart policy
(`docker-compose.yml` ships `restart: unless-stopped`; a sample systemd unit
with `Restart=on-failure` lives at `deploy/whisper-wrap.service`).

#### Added environment variables

```
MODEL_NAME              registry key (default: breeze-asr-25)
MODEL_DIR               optional CT2 directory override (bypasses registry)
COMPUTE_TYPE            default; required on Apple Silicon CPU
DEVICE                  auto
GEMINI_API_KEY          required for /ask
GEMINI_MODEL            default: gemini-2.5-flash
GEMINI_SYSTEM_PROMPT    optional; falls back to baked-in Taiwan persona
```

#### Registry schema change

`registry/models.yaml` now describes CTranslate2 directories instead of single
GGML files. Required fields per entry: `repo_id`, `format` (only `ct2`
accepted), `compute_type`, `local_dir`, `size`, `languages`, `description`.
Optional: `subfolder`, `revision`, `default`. **Exactly one entry** SHALL set
`default: true`; zero or multiple defaults fail validation.

**Before (v1):**

```yaml
models:
  large-v3-turbo-q8:
    default: true
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin"
    filename: "ggml-large-v3-turbo-q8_0.bin"
    size: "874MB"
    languages: [multilingual]
    description: "..."
```

**After (v2):**

```yaml
models:
  breeze-asr-25:
    default: true
    repo_id: "shdennlin/breeze-asr-25-ct2"
    format: ct2
    subfolder: int8_float16
    compute_type: int8_float16
    local_dir: breeze-asr-25
    size: "1.5GB"
    languages: [zh-TW, en]
    description: "Breeze ASR 25 (CT2 int8_float16) — Taiwanese Mandarin + EN"
```

#### Dropped built-in registry entries

`large-v3-turbo-q8`, `large-v3`, `medium`, `base`, and the GGML `breeze-asr-25`
are removed from the shipped registry. Replace them in your local registry
copy with CT2 equivalents:

| v1 (GGML)           | v2 (CT2) repo                            |
| ------------------- | ---------------------------------------- |
| `large-v3-turbo-q8` | `Systran/faster-whisper-large-v3-turbo`  |
| `large-v3`          | `Systran/faster-whisper-large-v3`        |
| `medium`            | `Systran/faster-whisper-medium`          |
| `base`              | `Systran/faster-whisper-base`            |

#### Deployment assumption

`/status` exposes the loaded model path and runtime configuration but no
credentials. v2 ships no built-in auth/TLS/rate limiting and is designed for
LAN/localhost deployments. For public exposure, terminate TLS and authenticate
at a reverse proxy or place the service behind a VPN / Tailscale boundary.

### Added

- **`POST /ask`** — audio or text question, Gemini answer. Optional
  `?stream=true` returns `text/event-stream` with `transcript` → `token*` →
  `done`/`error` event order.
- **`WS /listen`** — live captioning over a WebSocket: 16 kHz mono `pcm_s16le`
  frames in, `partial`/`final` JSON events out with millisecond timestamps.
- **`GET /status`** — service health, loaded model details, and LLM
  configuration in one payload.
- **`GET /`** — endpoint catalogue for API discovery.
- `deploy/whisper-wrap.service` — sample systemd unit with `Restart=on-failure`.

### Changed

- **Backend** — in-process `faster-whisper` + CTranslate2 replaces the external
  `whisper-server` subprocess; no more HTTP round-trip per request.
- **Model resolution** — `MODEL_DIR` override or `MODEL_NAME` registry lookup;
  hard-coded `breeze-asr-25` fallback when neither is set.
- **Dockerfile** — drops cmake/g++/git/build-essential and the whisper.cpp
  build stage; image build time falls from ~10–15 min to ~1–3 min.
- **`scripts/model-manager.sh`** — drives `hf download` against
  `registry/models.yaml` (CT2 entries); v1 URL-based form is rejected with a
  clear migration message.

### Removed

- `whisper.cpp` git submodule.
- `app/services/whisper_manager.py` — subprocess lifecycle manager.
- `make init-submodule`, `make build-whisper`, `make run-whisper` targets.
- `./whisper-wrap` CLI shim (Makefile targets are the only user-facing CLI).

### Added — backends, APIs, and tooling (v2.1–v2.3 work)

- **Dual Whisper backend** (v2.1): macOS now defaults to `pywhispercpp` +
  Core ML encoder for Apple Neural Engine acceleration (~5–7× real-time on
  Apple Silicon); Linux keeps `faster-whisper` + CTranslate2. Both implement
  the same `WhisperBackend` Protocol; endpoints don't see the difference.
  Override with `BACKEND_FORMAT=ct2|ggml`.
- **OpenAI Whisper API compatibility** (v2.3): `POST /v1/audio/transcriptions`,
  `POST /v1/audio/translations`, `GET /v1/models`. Drop-in for any OpenAI SDK
  pointed at a custom `base_url`. `response_format` supports
  `json|text|srt|verbose_json|vtt`. `Authorization` header is accepted and
  ignored (whisper-wrap is designed for trusted networks).
- **`registry/models.yaml` variants schema**: one model now declares multiple
  `variants:` (CT2 + ggml + Core ML encoder); `make download-model` fetches
  the platform-appropriate one. `default_on: [linux|darwin]` picks per-host.
- **Prompt actions** (`registry/actions.yaml` + `GET /actions`): server-side
  prompt-template registry with categories, i18n labels, and a `{transcript}`
  placeholder. PWA renders these as chips on each session.
- **SQLite persistence layer** + `/v1/sessions` API: sessions, action runs,
  and audio blobs persisted server-side; PWA's HistoryStore/AudioStore swapped
  from localStorage/IndexedDB to backend-backed storage.
- **Auto-session-logging**: `/transcribe`, `/ask`, and `/v1/audio/transcriptions`
  now persist their inputs and outputs (including audio blobs) automatically —
  Shortcut/curl sessions show up in the PWA history with replay + AI actions
  available.
- **End-to-end Mac deployment**: `make install-launchd` autostart via
  `~/Library/LaunchAgents/com.whisper-wrap.plist`; HTTPS variant
  (`make run-https` / `make dev-https`) consuming `WHISPER_CERT` +
  `WHISPER_KEY` for Tailscale `cert` integration. See
  `docs/DEPLOYMENT.md` and `docs/HTTPS-TAILSCALE.md`.

### Added — PWA client (v2.4 work)

- **Live captioning client**: AudioWorklet-based 16 kHz mono PCM pipeline →
  `WS /listen` → partial/final caption rendering with auto-reconnect.
- **Batch + Live mode switcher** with one-click mode cards, big record
  button, short-recording handling, and graceful Live stop that waits for
  the in-flight final before closing the socket.
- **History UX overhaul**: master-detail layout, fuzzy search, per-session
  audio replay + Re-transcribe, `+ AI Action` button to run any prompt
  template against a stored transcript, `DELETE /v1/sessions/:id/runs/:rid`.
- **Audio replay**: waveform UI, seekable `<audio>` element, sessions logged
  via Shortcut/curl playable from the PWA.
- **i18n**: English default + 繁體中文 fallback; locale persisted client-side.
- **Theme**: light/dark toggle in header with unified panel contrast.
- **PWA update flow**: NetworkFirst `/app/*` cache with 3 s timeout, manual
  "Update" toast button (no surprise reloads mid-recording), `visibilitychange`
  re-prime so new sessions appear without force-close.
- **Streaming-perf tuning**: partial-greedy decode (`beam_size=1` for partials,
  full beam for final) — ~1.5–2× partial speedup on ct2; adaptive cadence skip
  avoids re-running inference during inter-word silence.
- **Bundled Apple Shortcuts**: ASR (transcribe → clipboard) and ASR-Ask
  (transcribe → Gemini answer spoken aloud). Both prompt for endpoint on
  import with `localhost` default — share-safe (your endpoint never gets
  baked into the file).

### Fixed (highlights since v1.2.0)

- `/transcribe` accepts `audio/webm` + `video/webm` MediaRecorder uploads.
- AudioWorklet served as `.js` so Vite emits `application/javascript` MIME
  (was `video/mp2t` and broke `AudioWorklet.addModule`).
- PWA batch-mode duration now reads real recording length instead of file
  metadata (some MediaRecorder containers report 0).
- launchd plist: strips `.env` quote chars (Make's `include` is not shell),
  adds cert-readability guard with self-healing chown/chmod hints, uses
  `make run-https` (no `--reload`) for production.
- `model-manager.sh` uses `.venv` python so `pyyaml` resolves; default
  download now fetches only the active platform's variant (set `ALL=1` for
  every variant).
- PWA: Re-transcribe button restored after master-detail refactor;
  service-worker updates are user-clickable (no auto-reload mid-recording);
  history rows de-cluttered on mobile; deleting a session replaces URL so
  iOS Back doesn't return to a stale id.

### Frontend toolchain

- Switched from npm to **bun** for faster install + build (`make build-frontend`
  invokes `bun install && bun run build`). Requires Bun 1.1+.
- New PWA shell: Vite + vanilla TypeScript + vite-plugin-pwa; emits to
  `app/static/app/`. `app/main.py` silently skips the `/app/` mount when the
  bundle is missing — backend works standalone.

---

## [v1.2.0] — 2026-03-19

### Developer Changelog

#### Features

- **whisper**: add auto-restart process manager for whisper-server (927e846)
- **config**: enable auto-restart by default and skip managed start if server is healthy (490943d)

#### Bug Fixes

- **transcribe, whisper_manager**: handle `audio/x-m4a` MIME type and external whisper-server processes (9720159)

#### Refactoring

- **whisper**: make server lifecycle async and introduce typed errors (12a190a)

---

### What's New

whisper-wrap can now manage the whisper-server process directly. When the server crashes or becomes unresponsive, whisper-wrap automatically restarts it and retries your transcription request — no manual intervention needed. This feature is enabled out of the box, so existing deployments will benefit immediately after upgrading.

### Fixed

iOS devices that send audio with the `audio/x-m4a` content type will now be handled correctly. Previously, those requests could fail due to an unrecognized MIME type.

The service also now detects whisper-server processes that were started externally (e.g. via `make dev`) and cleans them up properly on shutdown, preventing orphaned processes.

### Improved

The internal whisper-server connection layer was rewritten to be fully asynchronous. Error handling is now backed by distinct exception types (`WhisperServerError`, `WhisperConnectError`, `WhisperTimeoutError`) instead of string matching. A file-handle leak during transcription was also fixed.

---

## [v1.1.0] — 2026-03-10

### Developer Changelog

#### Features

- **registry**: add breeze-asr-25-q8 model and archive multi-model-support change (9fa32b3)
- **forward-language-prompt**: add language/prompt params and punctuation normalization (01a7249)
- Add multi-model support with registry and model manager (8e91e19)

#### Bug Fixes

_None in this release._

#### Documentation

- **openspec**: add multi-model support spec and update README (23f6702)

#### Tests

- **tests**: add tests for language and prompt parameter forwarding (a6d7ee6)

---

### What's New

This release introduces multi-model support, making it easy to select and manage different Whisper models from a central registry. A new `breeze-asr-25-q8` model has been added to the registry alongside the existing default. You can now pass a `language` parameter directly when requesting a transcription, letting the service skip auto-detection and deliver faster, more accurate results for known languages. A `prompt` parameter is also available to guide the model with context or terminology hints.

### Fixed

No user-visible bug fixes in this release.

### Improved

Transcription output is now automatically cleaned up with punctuation normalization, producing more consistent and readable text without extra post-processing on your end. Under the hood, the model manager script and registry configuration make it straightforward to add, switch, and maintain Whisper models as the project grows.

---
