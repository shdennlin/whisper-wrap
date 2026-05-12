# whisper-wrap

Single-process FastAPI server for **in-process audio transcription, live captioning, and Gemini-backed Q&A**. v2 swaps the previous `whisper.cpp` + `whisper-server` subprocess for [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) running CTranslate2 models directly in the FastAPI process.

> v2.0 is a breaking release. Migrating from v1? See the **[v2.0.0 migration guide in CHANGELOG.md](CHANGELOG.md#200--unreleased)**.

## 🚀 Quick Start

```bash
# Install deps + download the default model (Breeze ASR 25, CT2 int8_float16)
make setup

# Start the server
make dev

# Test transcription
curl -X POST http://localhost:8000/transcribe \
     -F "file=@your-audio-file.mp3"
```

## ✨ Features

- **In-process backend**: `faster-whisper` + CTranslate2 — no subprocess, no second port, no startup-sleep gymnastics.
- **Unified `/transcribe`**: Content-Type dispatch handles multipart uploads, raw `audio/*` bodies, and `application/octet-stream` from iOS Shortcuts in one endpoint.
- **`/ask` with optional SSE streaming**: audio or text in, Gemini answer out. `?stream=true` returns `text/event-stream` with `transcript` → `token*` → `done` events.
- **`/listen` WebSocket**: live captioning — 16 kHz mono `pcm_s16le` frames in, timestamped `partial`/`final` events out.
- **Rich `/status`**: loaded model details, runtime device, compute type, Gemini configuration, uptime — useful for distinguishing Mac mini vs GPU deployments at a glance.
- **CT2 model registry**: `registry/models.yaml` ships **Breeze ASR 25** (default, Taiwanese Mandarin + EN code-switching) and `large-v3-turbo` (multilingual fallback).
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

**Ready-to-Use Shortcut**: 📱 **[Download ASR Shortcut](https://www.icloud.com/shortcuts/698627e2c3934b3e996426b64a943742)**

<img src="docs/ios-shortcuts-workflow.jpeg" alt="iOS Shortcuts Workflow" width="400">

This shortcut provides a complete voice transcription workflow:
- 🎙️ **Record Audio**: Tap to record voice memos
- 🌐 **Auto-Transcribe**: Sends audio to your whisper-wrap server
- 📝 **Show Results**: Displays transcribed text immediately
- 📋 **Copy to Clipboard**: Automatically copies text for easy pasting anywhere
- ⚙️ **Configurable**: Easy server URL setup in shortcut settings

**Setup**: Install shortcut → Configure server URL → Test with voice recording

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

## 🤖 Model Management

whisper-wrap includes a built-in model registry with 6 pre-configured models:

| Model | Size | Languages | Description |
|-------|------|-----------|-------------|
| `large-v3-turbo` | 1.6GB | Multilingual | Fast, general purpose |
| **`large-v3-turbo-q8`** | 874MB | Multilingual | 8-bit quantized (default) |
| `breeze-asr-25` | 3.1GB | zh-TW, en | Taiwanese Mandarin + English code-switching |
| `breeze-asr-25-q8` | 1.7GB | zh-TW, en | Breeze ASR 25 (8-bit quantized) |
| `large-v3` | 3.1GB | Multilingual | Highest accuracy, slower |
| `medium` | 1.5GB | Multilingual | Balanced speed/accuracy |
| `base` | 148MB | Multilingual | Lightweight, fast |

```bash
# List available models and their install status
make models

# Download a model
make download-model MODEL=breeze-asr-25

# Switch active model
make set-model MODEL=breeze-asr-25

# Delete a model
make delete-model MODEL=base
```

Or use the CLI wrapper:
```bash
./whisper-wrap models              # List models
./whisper-wrap download breeze-asr-25   # Download
./whisper-wrap use breeze-asr-25        # Switch model
```

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
GEMINI_MODEL=gemini-2.5-flash
# GEMINI_SYSTEM_PROMPT=          # Falls back to a Taiwan-friendly default

# File handling
MAX_FILE_SIZE_MB=100
LOG_LEVEL=INFO
```

## 🐳 Docker Deployment

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
- **[API Documentation](docs/API.md)** - Complete API reference with examples
- **[Deployment Guide](docs/DEPLOYMENT.md)** - Docker, production, monitoring
- **[Development Guide](docs/DEVELOPMENT.md)** - Contributing, testing, make targets
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