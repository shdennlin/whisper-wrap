# Installation Guide

**English** | [繁體中文](INSTALLATION.zh-TW.md)


Complete setup guide for whisper-wrap with system requirements and dependencies.

> **Deployment scope: LAN / localhost only.**
> whisper-wrap v2 ships no built-in authentication, rate limiting, or transport
> encryption. `GET /status` exposes the loaded model name/path and runtime
> configuration but no credentials. For public-internet exposure, terminate TLS
> and authenticate requests at a reverse proxy (Caddy, nginx, Cloudflare Tunnel)
> or place the service behind a VPN / Tailscale boundary. Bind to `127.0.0.1`
> (not `0.0.0.0`) when the host has a public network interface.

## Backend selection (v2.1)

whisper-wrap v2.1 ships two backends and picks one at startup:

| Platform     | Default backend         | Variant `format` | Acceleration                          |
| ------------ | ----------------------- | ---------------- | ------------------------------------- |
| macOS        | `pywhispercpp`          | `ggml`           | Apple Neural Engine (Core ML)         |
| Linux        | `faster-whisper`        | `ct2`            | CPU / CUDA via CTranslate2 (untested) |

> ⚠ The Linux CUDA path is **untested end-to-end**. The code paths exist
> and faster-whisper supports CUDA via CTranslate2, but the maintainer has
> only verified the macOS Apple Silicon setup. If you run it on a CUDA host,
> please file an issue.

Override with `BACKEND_FORMAT=ct2` or `BACKEND_FORMAT=ggml`:

- `BACKEND_FORMAT=ct2` is supported on every platform.
- `BACKEND_FORMAT=ggml` is supported only on macOS — the `pywhispercpp`
  dependency carries a `sys_platform == 'darwin'` marker, so Linux installs
  cannot resolve the ggml backend and startup fails with a clear error.

### Core ML first-run compile (macOS, ggml backend)

The first time a Core ML encoder loads on a given host, the runtime compiles
the bundled `.mlmodelc` to ANE-optimised form. This typically takes 10-30 s.
The lifespan blocks startup until the compile finishes and emits one INFO log
line per second showing elapsed seconds. Subsequent starts on the same host
reuse the cached compiled encoder and reach ready state within the normal
CT2 model-load time budget.

### silero-vad model cache (v2.2)

The first server start downloads a ~1 MB silero-vad TorchScript model to
`~/.cache/torch/hub/snakers4_silero-vad/`. Subsequent starts read from the
cache offline. On air-gapped hosts, prime the cache by running the server
once with internet access (or copy the cache directory from another machine).

If `silero-vad` is not installed at all, the server emits one INFO log line
`silero-vad unavailable, falling back to rms` and continues with the v2.1
RMS-energy detector. Set `VAD_BACKEND=rms` to opt out explicitly without
the log line; set `VAD_BACKEND=silero` to fail fast if the package is
missing (useful for production-config audits).

### Building pywhispercpp with Core ML

The published `pywhispercpp` wheels for macOS include Core ML support out of
the box. If you build from source (for example on a custom Python build) set
the `WHISPER_COREML=1` environment variable so the underlying `libwhisper`
is compiled with the Core ML encoder path enabled:

```bash
WHISPER_COREML=1 uv sync
```

Without that flag, importing the package on macOS still succeeds, but the
ggml backend silently falls back to CPU-only ggml decode and emits a single
WARNING log line naming the reason.

## Model Directory Layout (v2)

Models live in `./models/<entry.local_dir>/` as CTranslate2 directories. The directory
is created at clone time via `models/.gitkeep`; downloaded artefacts are gitignored.
`make download-model MODEL=<name>` uses `hf download` to populate the directory.

### Dropped v1 built-in entries

The v1 GGML registry shipped `large-v3-turbo-q8`, `large-v3`, `medium`, `base`, and a
GGML `breeze-asr-25`. v2 ships only **`breeze-asr-25`** (default, CT2 `int8_float16`
from [shdennlin/breeze-asr-25-ct2](https://huggingface.co/shdennlin/breeze-asr-25-ct2),
plus a ggml variant at [shdennlin/breeze-asr-25-ggml](https://huggingface.co/shdennlin/breeze-asr-25-ggml))
and **`large-v3-turbo`** (from
[Systran/faster-whisper-large-v3-turbo](https://huggingface.co/Systran/faster-whisper-large-v3-turbo)).
If you depended on a dropped entry, add an equivalent CT2 entry to your local
`registry/models.yaml`. Suggested replacements:

| v1 (GGML)             | v2 (CT2) repo                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `large-v3-turbo-q8`   | [`Systran/faster-whisper-large-v3-turbo`](https://huggingface.co/Systran/faster-whisper-large-v3-turbo)                   |
| `large-v3`            | [`Systran/faster-whisper-large-v3`](https://huggingface.co/Systran/faster-whisper-large-v3)                               |
| `medium`              | [`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium)                                   |
| `base`                | [`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base)                                       |

## System Requirements

### Hardware Requirements
- **RAM**: 4GB minimum, 8GB+ recommended (CT2 Whisper models are memory-resident)
- **Disk Space**: ~2GB free (Python deps + 1.5GB Breeze CT2 model)
- **CPU**: Multi-core recommended for faster transcription

### Software Requirements
- **Python**: 3.10 or higher
- **uv**: Fast Python package manager ([install guide](https://github.com/astral-sh/uv))
- **ffmpeg**: Audio format conversion
- **libmagic**: MIME detection
- **hf** (or **huggingface-cli**): Pulled in as a Python dep; used by the model manager
- **Bun 1.1+** (build-time only): needed by `make build-frontend` to compile the
  v2.4 PWA bundle (Vite + TypeScript). Install with
  `curl -fsSL https://bun.sh/install | bash`. Not required at runtime; the
  bundle is shipped in `app/static/app/` and served by FastAPI.

### Operating Systems
- macOS 10.15+ (Intel/Apple Silicon)
- Ubuntu 18.04+ / Debian 10+
- RHEL/CentOS 7+ / Fedora 30+
- Arch Linux (current)
- Windows 10+ (WSL2 recommended)

### CPU Architectures
- **x86_64 (Intel/AMD)**: Full support with AVX/AVX2 optimizations
- **ARM64 (Apple Silicon)**: Native support with NEON optimizations
- **Generic**: Fallback support for other architectures

## Automatic Installation (Recommended)

The setup process will automatically check and install dependencies:

```bash
# Check what's needed
make check-system-deps

# Install missing system dependencies  
make install-system-deps

# Complete setup
make setup
```

**Setup Time**: Expect 10-30 minutes for first-time installation (internet speed dependent)

## Manual Installation

If you prefer manual installation:

### 1. System Dependencies

Install required system packages:

**macOS (Homebrew)**:
```bash
brew install ffmpeg libmagic
```

**Ubuntu/Debian**:
```bash
sudo apt-get update
sudo apt-get install ffmpeg libmagic1 libmagic-dev
```

**RHEL/CentOS**:
```bash
sudo yum install ffmpeg file-devel
```

**Arch Linux**:
```bash
sudo pacman -S ffmpeg file
```

### 2. Python Dependencies

```bash
make install
```

### 3. Download the ASR Model

```bash
# Download the default registry entry (Breeze ASR 25, CT2 int8_float16)
make download-default-model

# Or pick a specific entry:
make download-model MODEL=large-v3-turbo
```

### 4. Start the Server

```bash
make run        # uvicorn (single FastAPI process; in-process model load)
make dev        # uvicorn --reload for development
```

## Verification

Test your installation:

```bash
# Check system dependencies
make check-system-deps

# Test API
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test-audio.mp3"

# Check health
curl http://localhost:8000/health
```

## OpenAI-compatible front-ends (open-webui)

whisper-wrap exposes an OpenAI Whisper-compatible surface at
`POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, and
`GET /v1/models`. Any OpenAI-Whisper-compatible client (LibreChat, open-webui,
the OpenAI Python / TypeScript SDKs, curl recipes from the OpenAI docs) can use
whisper-wrap as the STT backend by pointing its base URL at
`http://<whisper-wrap-host>:8000/v1` — no per-tool adapter code needed.

The canonical recipe uses [open-webui](https://github.com/open-webui/open-webui):

```bash
# Run open-webui in Docker, exposing it on http://localhost:3000
docker run -p 3000:8080 ghcr.io/open-webui/open-webui:main
```

Then in open-webui:

1. **Settings → Audio → Speech-to-Text → API Base URL** → set to
   `http://<whisper-wrap-host>:8000/v1`
2. **API Key** → any non-empty value works (whisper-wrap accepts but ignores
   the `Authorization` header — see the security note below)
3. **Model** → any value; whisper-wrap loads exactly one model per process,
   so the request field is advisory. Reserved aliases (`whisper-1`,
   `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`) are silently accepted; other
   values log a single WARNING line server-side and still serve with the
   active model.

> **LAN-only by default.** whisper-wrap binds to `API_HOST=127.0.0.1` out of
> the box. If open-webui runs on a different machine (or in a Docker container
> on the same machine that reaches the host via a routable IP), set
> `API_HOST=0.0.0.0` in `.env` so the server accepts connections from outside
> localhost. The OpenAI compat layer does NOT enforce bearer-token
> authentication — keep whisper-wrap behind a reverse proxy, VPN, or Tailscale
> boundary if you expose it beyond a trusted LAN.

## Built-in PWA setup (v2.4 live-captioning client)

`make setup` runs `make build-frontend` automatically. If you want to rebuild
the PWA bundle without re-downloading models, use:

```bash
make build-frontend     # produces app/static/app/
make dev                # then open http://localhost:8000/app/
```

The PWA works on localhost without HTTPS. To reach it from your phone over a
tailnet, see [`HTTPS-TAILSCALE.md`](HTTPS-TAILSCALE.md). Short version:

```bash
# One time
sudo tailscale cert mac-mini.tailXXXXX.ts.net

# Each session
export WHISPER_CERT="$PWD/mac-mini.tailXXXXX.ts.net.crt"
export WHISPER_KEY="$PWD/mac-mini.tailXXXXX.ts.net.key"
make dev-https          # serves https://mac-mini.tailXXXXX.ts.net:8000/app/
```

Manual verification steps are in `frontend/CHECKLIST.md`.

## Whisper Model Information

**Model**: `ggml-large-v3-turbo-q8_0` (default)
- **Size**: ~1.5GB download
- **Quality**: High accuracy, optimized for speed
- **Languages**: 100+ languages supported including:
  - **Tier 1** (Excellent): English, Spanish, French, German, Italian, Portuguese, Dutch, Russian
  - **Tier 2** (Very Good): Japanese, Chinese, Korean, Arabic, Hindi, Turkish, Polish
  - **Tier 3** (Good): 80+ additional languages with varying quality

## Performance Characteristics

- **Transcription Speed**: ~2-4x real-time (varies by hardware)
- **Memory Usage**: ~2-4GB RAM during processing
- **CPU Usage**: Multi-threaded, scales with available cores
- **Language Detection**: Automatic language detection included

## Audio Quality Guidelines

- **Best**: Clear speech, minimal background noise, 16kHz+ sample rate
- **Good**: Podcast/call quality, some background noise acceptable
- **Fair**: Compressed audio, noisy environments (accuracy may vary)

## Troubleshooting Installation

### Common Issues

**System dependencies missing**:
- Run `make check-system-deps` to see what's missing
- Run `make install-system-deps` for automatic installation

**ffmpeg not found**:
- Install ffmpeg system dependency
- Verify ffmpeg is in system PATH

**libmagic import error**:
- Install libmagic system dependency  
- Check with: `python3 -c "import magic"`

**cmake not found**:
- Install cmake through system package manager
- Verify with: `cmake --version`

**Build fails on ARM systems**:
- Ensure you have the latest cmake version
- Check that build tools are properly installed

### Performance Issues

**Slow transcription**:
- Check available RAM (whisper needs 2-4GB)
- Monitor CPU usage during transcription
- Verify disk space for temporary files
- Consider shorter audio files for testing

**Audio quality issues**:
- Ensure audio is clear with minimal background noise
- Check supported formats list
- Try converting to WAV format first
- Verify file isn't corrupted or empty

### Getting Help

If you encounter issues not covered here:

1. Check [Troubleshooting Guide](TROUBLESHOOTING.md)
2. Review system requirements
3. Verify all dependencies are installed
4. Test with simple audio files first