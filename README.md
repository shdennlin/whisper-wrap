# whisper-wrap

**English** | [繁體中文](README.zh-TW.md)


Single-process FastAPI server for **in-process audio transcription, live captioning, and Gemini-backed Q&A**.

v2.1 ships two Whisper backends in the same codebase and picks one at startup based on the host OS:

- **macOS** — [`pywhispercpp`](https://github.com/absadiki/pywhispercpp) (whisper.cpp binding) with Core ML encoder on the Apple Neural Engine. On Mac, CTranslate2 has no Metal/Core ML path and falls back to CPU; the pywhispercpp + Core ML path reaches 5-7× real-time on Apple Silicon via ANE.
- **Linux** — [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (CTranslate2). Keeps the CPU/CUDA path open for future GPU deployments.

Both backends conform to the same `WhisperBackend` Protocol; the `/transcribe`, `/ask`, and `WS /listen` endpoints don't know which one is loaded. Override the auto-selection with `BACKEND_FORMAT=ct2` or `BACKEND_FORMAT=ggml`.

> **Tested surface**: macOS (Apple Silicon) with the ggml + Core ML path is the primary developer setup and is exercised regularly. The Linux CUDA path and the Docker image are **untested** — they exist in code but have not been verified end-to-end. If you run either, please file an issue with what worked and what didn't.

## 📸 Screenshots

| Live captioning | History + AI actions | Apple Shortcuts |
| - | - | - |
| <img src="docs/images/live-caption.jpg" alt="Live caption view: timestamped transcript streaming in real time" width="280"> | <img src="docs/images/history-view.jpg" alt="History master-detail with search, audio player, and Re-transcribe" width="280"> | <img src="docs/images/shortcut-asr-ask.jpg" alt="ASR-Ask Shortcut wired to the API endpoint via import question" width="280"> |
| Real-time partial → final captions via `WS /listen` (PWA, installable). | Browse past sessions, search, replay audio, re-run AI actions, export SRT/VTT/TXT. | iOS/macOS Shortcut that records, posts to `/ask`, and reads the answer aloud. |

## 🚀 Quick Start

### Prerequisites (one-time on a fresh machine)

```bash
# macOS
brew install ffmpeg libmagic
curl -fsSL https://astral.sh/uv/install.sh | sh      # Python deps
curl -fsSL https://bun.sh/install | bash             # PWA bundler

# Linux
sudo apt-get install ffmpeg libmagic1 libmagic-dev   # (or yum / pacman)
curl -fsSL https://astral.sh/uv/install.sh | sh
curl -fsSL https://bun.sh/install | bash
```

### Run it

```bash
# Install deps + download the default model + build the PWA (5-15 min)
make setup

# Start the server (foreground; Ctrl-C to stop)
make dev

# Test transcription
curl -X POST http://localhost:8000/transcribe \
     -F "file=@your-audio-file.mp3"
```

Open `http://localhost:8000/app/` for the PWA, `http://localhost:8000/status` for health.

**Want autostart + crash-recovery?** See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — `make install-launchd` on macOS, systemd unit sketch for Linux.

## ✨ Features

- **Dual in-process backend** (v2.1): pywhispercpp + Core ML/ANE on macOS, faster-whisper + CTranslate2 on Linux. No subprocess, no second port. `WS /listen` partial latency drops from ~3-5 s to <1 s on Mac mini via Apple Neural Engine.
- **Unified `/transcribe`**: Content-Type dispatch handles multipart uploads, raw `audio/*` bodies, and `application/octet-stream` from iOS Shortcuts in one endpoint.
- **`/ask` with optional SSE streaming**: audio or text in, Gemini answer out. `?stream=true` returns `text/event-stream` with `transcript` → `token*` → `done` events.
- **`/listen` WebSocket**: live captioning — 16 kHz mono `pcm_s16le` frames in, timestamped `partial`/`final` events out. v2.1 adds a partial-consensus filter (simplified LocalAgreement-2) so `partial` text no longer thrashes between inferences. v2.2 swaps the RMS-energy VAD for [silero-vad](https://github.com/snakers4/silero-vad) (neural; with RMS fallback) so utterance endpointing is robust against environmental noise and quiet speech.
- **Rich `/status`**: loaded model details, runtime device, compute type, Gemini configuration, uptime — useful for distinguishing Mac mini vs GPU deployments at a glance.
- **Variants-aware model registry** (v2.1): `registry/models.yaml` ships `breeze-asr-25` with both a `ct2` and a `ggml` variant (`q6_k` quantisation + bundled `.mlmodelc` Core ML encoder), plus `large-v3-turbo` as the multilingual fallback. `make download-model MODEL=<name>` fetches only the variant your platform will load; add `ALL=1` to fetch every variant.
- **Meeting Mode** (v2.5): long-form upload → speaker-diarized transcript with word-level timestamps via WhisperX + pyannote. Optional `?fast=true` re-uses `/transcribe`'s ggml+ANE backend for ASR (skipping WhisperX's CT2), cutting macOS wall-clock by **~3×** while keeping diarization. Results persist to a SQLite-backed `/v1/meetings` API with optional audio sidecar storage so the PWA history sidebar survives restarts and works cross-device.
- **PWA Batch file upload**: drop or pick an existing audio file on the Batch card instead of recording — same `/transcribe` pipeline, no second endpoint.
- **iOS Shortcuts ready**: bundled shortcut for one-tap voice transcription.

## 🏗️ Architecture

```
┌──────────────────┐         ┌────────────────────────────────────┐
│   Client App     │───────▶ │  whisper-wrap (FastAPI, port 8000) │
│  (iOS/Web/CLI)   │         │  ├── /transcribe                   │
│                  │         │  ├── /ask  → Gemini API            │
│                  │         │  ├── /listen (WebSocket)           │
│                  │         │  ├── /status, /                    │
│                  │         │  └── in-process faster-whisper     │
└──────────────────┘         └────────────────────────────────────┘
```

## 📱 iOS Shortcuts Integration

Two ready-to-use shortcuts. On import, each one prompts for your server URL (default `localhost`) — your endpoint never gets baked into the shared file.

| Shortcut | What it does | Install |
| - | - | - |
| **ASR** | Record → `/transcribe` → copy text to clipboard. | 📱 [Add to Shortcuts](https://www.icloud.com/shortcuts/cc6e3b42e9c743ec9d15db4c30d0c205) |
| **ASR-Ask** | Record → `/ask` → speak the Gemini answer back. | 📱 [Add to Shortcuts](https://www.icloud.com/shortcuts/02d03d53364e49bab0542a2a6daa3cb6) |

<img src="docs/images/shortcut-asr-ask.jpg" alt="ASR-Ask shortcut workflow on iOS" width="320">

**Setup**: tap the link → "Add Shortcut" → on first run, paste your endpoint (e.g., `http://192.168.1.10:8000` or your Tailscale `https://...ts.net:PORT`).

## 🔧 API Endpoints

### POST /transcribe
Multipart file upload, raw `audio/*` body, or `application/octet-stream` — the
handler branches on `Content-Type`:

```bash
# Multipart (web/CLI clients)
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@audio.mp3"

# Raw body (iOS Shortcuts)
curl -X POST "http://localhost:8000/transcribe" \
     -H "Content-Type: audio/mp3" \
     --data-binary "@audio.mp3"
```

**Response**:
```json
{
  "text": "transcribed text content",
  "language": "en", 
  "duration": 123.45,
  "confidence": 0.95
}
```

### OpenAI Whisper-compatible surface (v2.3)

For drop-in use with any OpenAI-Whisper-compatible client
(open-webui, LibreChat, the OpenAI SDK, etc.) whisper-wrap exposes:

| Method | Path                          | Description                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------------------ |
| POST   | `/v1/audio/transcriptions`    | OpenAI-compatible audio transcription endpoint                           |
| POST   | `/v1/audio/translations`      | OpenAI-compatible audio translation endpoint (output: English)           |
| GET    | `/v1/models`                  | OpenAI-compatible model catalogue (lists the active whisper-wrap model)  |

`response_format` accepts `json` (default), `text`, `srt`, `verbose_json`,
and `vtt`. The `model` request field is advisory — whisper-wrap loads
exactly one model per process; any non-empty value is accepted, with a
WARNING log when it doesn't match an OpenAI alias or the active model.

```bash
# Drop-in OpenAI SDK example (Python)
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="any")
with open("audio.mp3", "rb") as f:
    print(client.audio.transcriptions.create(model="whisper-1", file=f).text)
```

See [`docs/INSTALLATION.md`](docs/INSTALLATION.md#openai-compatible-front-ends-open-webui)
for the open-webui Docker recipe.

### Built-in PWA: live captioning client (v2.4)

A Vite-built, installable Progressive Web App ships with whisper-wrap at
`/app/`. It captures the browser microphone, streams 16 kHz PCM to
`WS /listen`, renders partial-to-final captions in real time, persists the
last 20 sessions to `localStorage`, and lets you run pre-defined Action
templates (defined in `registry/actions.yaml`, surfaced via `GET /actions`)
against the transcript via `POST /ask`.

The Batch capture card also accepts **file uploads** — click 📁 or drag
an audio file onto it to transcribe an existing recording instead of
recording a fresh one. Same `/transcribe` pipeline; no second endpoint.

A separate **Meeting Mode** page lives at `/app/#/meeting` (see the
[Meeting Mode](#-meeting-mode) section below for the long-form
diarization workflow with chat/detail views and AI Enhance).

| Method | Path | Description |
| ------ | ---- | --- |
| GET    | `/app/`          | PWA live-captioning client (Live, Batch, Meeting modes) |
| GET    | `/app/#/meeting` | Meeting Mode page (diarization, AI Enhance, history sidebar) |
| GET    | `/actions`       | Action templates registry (consumed by the chip bar) |

```bash
make build-frontend     # one-time: produces app/static/app/
make dev                # serves whisper-wrap + the PWA on http://localhost:8000/app/
```

Reach it from a phone over your tailnet by running `make dev-https` once you
have a Tailscale cert — see [`docs/HTTPS-TAILSCALE.md`](docs/HTTPS-TAILSCALE.md).

## 🤖 Model Management

whisper-wrap ships two models in the registry. Each model has one or more
**variants** (a packaging for a specific backend). `make download-model
MODEL=<name>` fetches the variant matching your platform; pass `ALL=1` to
fetch every declared variant of that model.

| Model | Size | Languages | Description |
|-------|------|-----------|-------------|
| **`breeze-asr-25`** ✅ default | 1.5-2.0 GB | zh-TW, en | MediaTek Breeze ASR 25 — Taiwanese Mandarin + English code-switching |
| `large-v3-turbo` | 1.6 GB | Multilingual | OpenAI Whisper large-v3-turbo — multilingual fallback |

### Sources (Hugging Face)

| Model | Variant | Backend | Quant / Compute | Size | Hugging Face repo |
|-------|---------|---------|-----------------|------|-------------------|
| `breeze-asr-25` | `ct2` | faster-whisper (Linux default) | `int8_float16` | ~1.5 GB | [shdennlin/breeze-asr-25-ct2](https://huggingface.co/shdennlin/breeze-asr-25-ct2) |
| `breeze-asr-25` | `ggml` | pywhispercpp + Core ML (macOS default) | `q6_k` | ~1.5 GB | [shdennlin/breeze-asr-25-ggml](https://huggingface.co/shdennlin/breeze-asr-25-ggml) |
| `large-v3-turbo` | `ct2` | faster-whisper | `int8_float16` | ~1.6 GB | [Systran/faster-whisper-large-v3-turbo](https://huggingface.co/Systran/faster-whisper-large-v3-turbo) |

**Quant / compute notes**:
- `q6_k` — whisper.cpp 6-bit K-quants. Near-FP16 quality at ~37% of the original file size. The ggml variant also ships a bundled Core ML `.mlmodelc` encoder for ANE acceleration.
- `int8_float16` — CTranslate2 mixed precision: int8 weights, float16 activations. Standard CT2 path on CUDA. On Apple Silicon CPU it automatically falls back to `default` — the `COMPUTE_TYPE` env var has no effect there.

**Upstream provenance**: The `shdennlin/breeze-asr-25-*` repos are quantized + converted from MediaTek's original Breeze ASR 25 release. The `Systran/faster-whisper-large-v3-turbo` repo is the CT2 repackaging of OpenAI's [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo).

To add another model (e.g. `large-v3`, `medium`, `base`), append an entry to
`registry/models.yaml` pointing at any CT2-format Hugging Face repo. See the
schema comments at the top of that file. Suggested CT2 repos:
[`Systran/faster-whisper-large-v3`](https://huggingface.co/Systran/faster-whisper-large-v3),
[`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium),
[`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base).

```bash
# List registry entries + show which variant is active on this platform
make models

# Download ONLY the variant that will be used on this platform
# (macOS → ggml, Linux → ct2). ~1.5 GB.
make download-model MODEL=breeze-asr-25

# Download EVERY variant of the model (~3 GB for breeze-asr-25).
# Use when benchmarking ct2 vs ggml on the same host.
ALL=1 make download-model MODEL=breeze-asr-25

# Switch the active model (refuses unless its active variant is downloaded)
make set-model MODEL=breeze-asr-25

# Delete every variant directory of a model from disk
make delete-model MODEL=large-v3-turbo
```

## 🎙️ Meeting Mode

`POST /transcribe/meeting` is an opt-in long-form endpoint that combines
Whisper ASR, forced phoneme alignment for word-level timestamps, and
[pyannote.audio](https://github.com/pyannote/pyannote-audio) speaker
diarization (via [WhisperX](https://github.com/m-bain/whisperX)). It is
loaded lazily on first request and leaves every other endpoint
(`/transcribe`, `/listen`, `/ask`, `/v1/*`) unchanged.

### Installation

Three prerequisites — the endpoint returns HTTP 503 with a clear `reason`
if any of them is missing:

1. **Install the optional extras** (~1.5 GB: whisperx + pyannote.audio +
   torch):

   ```bash
   uv sync --extra meeting
   ```

2. **Accept the pyannote user agreements** on Hugging Face for all three
   gated repos — diarization 403s otherwise:

   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
   - https://huggingface.co/pyannote/speaker-diarization-community-1

   The third is a transitive PLDA backend that the 3.1 pipeline downloads
   at construction time — easy to miss until the first job fails.

3. **Set `HF_TOKEN`** in your `.env` with a token that has read access to
   the accepted models. Without it, `/transcribe/meeting` returns
   `503 {"error": "meeting_unavailable", "reason": "HF_TOKEN is not configured"}`
   and `/status.meeting.hf_token_configured` is `false`.

Pre-stage the pyannote model weights AND the CT2 ASR variant for air-gapped
or first-run-latency reasons:

```bash
# Linux (ct2 is already the platform default):
DIARIZE=1 make download-model MODEL=breeze-asr-25

# macOS — also pass ALL=1 so the WhisperX-required CT2 variant comes down
# alongside the ggml variant that /transcribe uses for ANE acceleration:
ALL=1 DIARIZE=1 make download-model MODEL=breeze-asr-25
```

If the prefetch fails with `GatedRepoError`, click "Agree" on the
specific URL the error names and re-run the command — it's idempotent.

### Usage

```bash
# Upload a meeting → returns a job handle.
# ?fast=true     re-uses /transcribe's platform-default backend for ASR
#                (ggml+ANE on macOS, ct2+CUDA on Linux), then routes the
#                segments through WhisperX align + pyannote diarize on MPS.
#                ~3× faster on Apple Silicon. Recommended unless you need
#                word-level alignment precision from WhisperX's CT2 path.
# ?filename=...  shown as the meeting title in the PWA history sidebar.
curl -s -X POST "http://localhost:8000/transcribe/meeting?fast=true&filename=Q3-review.m4a" \
  -H "Content-Type: audio/wav" \
  --data-binary @meeting.wav
# → {"job_id":"01JFA…","status_url":"/transcribe/meeting/01JFA…"}

# Poll until status == "done"
curl -s http://localhost:8000/transcribe/meeting/01JFA…
# → {"status":"done","progress":1.0,"stage":"complete",
#    "result":{"language":"zh","duration_seconds":1823.4,
#              "speakers":["SPEAKER_00","SPEAKER_01"],
#              "segments":[{"speaker":"SPEAKER_00",
#                           "start":0.52,"end":4.18,
#                           "text":"今天會議的主題是…","words":[…]},…]}}

# Cancel a running job (best-effort, between stage boundaries).
curl -s -X DELETE http://localhost:8000/transcribe/meeting/01JFA…
```

The PWA Meeting Mode page at `/app/#/meeting` wraps the same workflow with
**chat / detail view-mode toggle**, **speaker rename via hover ✏️**,
**click-to-seek audio playback**, **AI Enhance** (reuses the main page's
`registry/actions.yaml` chips — `Meeting notes` produces structured
summaries), speaker-aware **SRT / VTT / TXT (chat) / TXT (script) / JSON**
exports, an editable **meeting note title**, and a persistent history
sidebar.

### Persisted history & cross-device replay

Meeting analyses (and the original audio, if uploaded) persist to the
existing SQLite history DB so the PWA sidebar survives the in-memory
job-store TTL (default 1 h), server restarts, and access from another
device on the same server.

| Method | Path | Description |
| - | - | - |
| GET | `/v1/meetings` | Paginated list (`limit`, `before_ms`). |
| GET | `/v1/meetings/{id}` | Single analysis with full result + speaker_names. |
| POST | `/v1/meetings` | Create (used by worker auto-persist + PWA legacy-localStorage migration). |
| PATCH | `/v1/meetings/{id}` | Patch `speaker_names` and/or `filename`. |
| DELETE | `/v1/meetings/{id}` | Removes the row AND unlinks the audio sidecar file. |
| POST | `/v1/meetings/{id}/audio` | Upload original audio as a sidecar (multipart `file`). |
| GET | `/v1/meetings/{id}/audio` | Stream the audio back (`X-Content-Type-Options: nosniff`; MIME allowlisted). |

### Performance

Meeting analysis runs three stages — ASR + wav2vec2 align + pyannote
diarize. CTranslate2 has no Core ML/ANE backend, so the slow-path ASR
stays on CPU on macOS; the torch-native align + diarize stages DO
accept MPS and cut their contribution by 4-8× on Apple Silicon.

Two ASR paths are available — pick at request time via `?fast=true`:

| Path | ASR backend | macOS Apple Silicon | Loses |
| - | - | - | - |
| **Fast (`?fast=true`)** | ggml + Core ML + ANE (same as `/transcribe`) | **~3-5 min** for a 1 h meeting | Nothing — diarize + align still run |
| Slow (`?fast=false`, default) | WhisperX CT2 batched on CPU | ~10-20 min for a 1 h meeting | — |
| Linux + NVIDIA GPU | WhisperX CT2 on CUDA | ~1-3 min for a 1 h meeting | — |

Fast mode is the default in the PWA on macOS (toggleable). It works on
Linux too — there it routes through whatever `/transcribe` already uses
(ct2+CUDA if available, else ct2+CPU which matches the slow path).

ASR dominates the slow-path macOS wall-clock (~70% of total time);
fast mode collapses that 70% to whatever `/transcribe` takes for the
same audio (~10× real-time on M-series via ANE) and leaves only the
~2-5 min align+diarize tail.

Two tunables (both in `.env`, both have sensible defaults — touch only
when debugging perf):

```env
MEETING_BATCH_SIZE=32        # WhisperX ASR batch_size; 16-64 (slow path only)
MEETING_TORCH_DEVICE=auto    # auto | mps | cuda | cpu (align + diarize)
```

`MEETING_TORCH_DEVICE=auto` picks MPS on macOS, CUDA on Linux, CPU
elsewhere. Forcing an unavailable device logs a WARN and falls back to
CPU — the endpoint stays available even with a wrong env var.

The first request after server start incurs an additional ~20-40 s while
the WhisperX and pyannote models load into memory; subsequent jobs reuse
the in-memory pipeline.

### Accuracy notes

- Diarization quality **degrades on overlapping speech** — heavily
  cross-talked sections may collapse into a single speaker or split a
  single speaker across labels.
- Pyannote needs roughly **~20 seconds of speech per speaker** to produce
  stable separation; very short turns (single sentences) often get merged
  into a neighbouring speaker.
- When the number of participants is known up-front, pass `num_speakers`
  on the request as a quality lever — it constrains the clustering stage
  and usually improves separation noticeably for 2-4 speaker meetings.

## ⚙️ Configuration

Create a `.env` file for custom configuration (see `.env.example` for the full
list):

```env
# API server
API_PORT=8000
API_HOST=0.0.0.0

# Model
MODEL_NAME=breeze-asr-25         # Registry key (./models/breeze-asr-25)
# MODEL_DIR=/absolute/path       # Bypass registry lookup
COMPUTE_TYPE=default             # Required on Apple Silicon CPU
DEVICE=auto

# Gemini (for /ask)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite
# GEMINI_SYSTEM_PROMPT=          # Falls back to a Taiwan-friendly default

# File handling
MAX_FILE_SIZE_MB=100
LOG_LEVEL=INFO

# Meeting endpoint (only meaningful when /transcribe/meeting is used)
# MEETING_BATCH_SIZE=32        # WhisperX ASR batch_size; raise for RAM-rich hosts
# MEETING_TORCH_DEVICE=auto    # auto | mps | cuda | cpu — align + diarize accelerator

# CT2 worker threads (applies to /transcribe AND /transcribe/meeting on ct2 paths)
# CPU_THREADS=8                # Apple Silicon M2 (4P+6E) typically benefits from 6-8

# Transcription post-process filter
# FILTER_EMPTY_ENABLED=true
# FILTER_MIN_DURATION_MS=500
```

### Transcription post-processing filter

Whisper occasionally returns empty strings or pure punctuation (e.g. `。`, `。。。`)
for noise inputs. The post-processing filter is **enabled by default** and
suppresses those results across every transcription surface:

- `WS /listen` — no `final` JSON frame is emitted for the dropped utterance.
- `POST /transcribe` — the response body becomes `{"text": ""}`.
- `POST /ask` — returns HTTP `400 {"error": "no_speech_detected"}` and **does not
  invoke Gemini**, saving tokens on noise inputs. The streaming variant emits a
  single `event: error` frame and closes.
- `POST /v1/audio/transcriptions` and `POST /v1/audio/translations` — preserve
  the OpenAI response schema with `text: ""` (and `segments: []` for
  `verbose_json`); no custom fields are added.

Two environment variables tune the filter:

- `FILTER_EMPTY_ENABLED` (default `true`) — set to `false` to disable, e.g. when
  diagnosing why a real utterance appears to have been dropped.
- `FILTER_MIN_DURATION_MS` (default `500`) — speech shorter than this is dropped
  on `/listen`. Lower to `300` if single CJK characters get filtered.

Every drop is logged at `INFO` as a structured `transcription_filtered` record
(`extra` fields: `endpoint`, `reason`, `response_format`/`stream`,
`raw_text_len`) so operators can grep server logs to verify the filter is
behaving as expected.

## 🐳 Docker Deployment

> ⚠ **Untested**. The Dockerfile + `make docker` target exist in the repo but
> have not been verified end-to-end. ARM Macs cannot reach the Metal / Neural
> Engine from inside Docker (CT2 falls back to CPU, ggml does not work in
> container). If you run this and it works, please file an issue.

```bash
# Quick start with Docker (uses default model: breeze-asr-25)
make docker

# Build with a specific model
docker build --build-arg MODEL_NAME=breeze-asr-25 -t whisper-wrap:latest .
docker run -p 8000:8000 whisper-wrap:latest
```

## 🛠️ Development

```bash
make help               # Show all available targets
make setup              # Complete setup (first time)
make dev                # Start development environment
make test               # Run test suite
make lint               # Code quality checks
```

## 📚 Documentation

- **[Installation Guide](docs/INSTALLATION.md)** - System requirements, dependencies, setup
- **[Deployment Guide](docs/DEPLOYMENT.md)** - End-to-end Mac mini recipe, launchd autostart, log management
- **[API Documentation](docs/API.md)** - Complete API reference with examples
- **[HTTPS via Tailscale](docs/HTTPS-TAILSCALE.md)** - Reach the PWA from your phone with mic permission
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

## 🎯 Common Use Cases

- **Voice Memos**: Use iOS Shortcuts for instant voice-to-text
- **Taiwanese Mandarin**: Use Breeze ASR 25 for zh-TW + English code-switching
- **Batch Processing**: Process multiple audio files via command line
- **API Integration**: Embed transcription in your applications
- **Multi-language Support**: 100+ languages with automatic detection

## 📊 Performance

- **Speed**: ~2-4x real-time transcription
- **Memory**: 2-4GB RAM during processing
- **Formats**: All major audio/video formats supported
- **Languages**: 100+ languages with tier-based quality

## 💡 Quick Examples

**Python Integration**:
```python
import httpx

with open("audio.mp3", "rb") as f:
    response = httpx.post(
        "http://localhost:8000/transcribe",
        headers={"Content-Type": "audio/mp3"},
        content=f.read()
    )
    print(response.json()["text"])
```

**Batch Processing**:
```bash
for file in *.mp3; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@$file" \
       -o "${file%.mp3}.json"
done
```

## 🔍 System Requirements

- **RAM**: 4GB minimum, 8GB+ recommended
- **Python**: 3.8+
- **Dependencies**: ffmpeg, libmagic, cmake
- **Platforms**: macOS, Linux, Windows (WSL2)

## 🆘 Need Help?

- **Quick Issues**: Check [Troubleshooting](docs/TROUBLESHOOTING.md)
- **Installation**: See [Installation Guide](docs/INSTALLATION.md)
- **API Questions**: Refer to [API Documentation](docs/API.md)
- **Deployment**: Follow [Deployment Guide](docs/DEPLOYMENT.md)

## 🙏 Acknowledgments

This project is built upon the excellent work of:
- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** by SYSTRAN — CTranslate2-based Whisper runtime that powers v2's in-process backend
- **[CTranslate2](https://github.com/OpenNMT/CTranslate2)** by OpenNMT — fast inference engine for Transformer models
- **[OpenAI Whisper](https://github.com/openai/whisper)** — the original speech recognition model and research
- **[Breeze ASR 25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)** by [MediaTek Research](https://github.com/MediaTek-Research) — Taiwanese Mandarin + English code-switching ASR model
- **[Google Gemini](https://ai.google.dev/)** — LLM backend for `/ask`

v1 was built around `whisper.cpp` (kept in `CHANGELOG.md` as historical context); v2 transitions to faster-whisper / CTranslate2 for a single-process server.

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.