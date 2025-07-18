# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

whisper-wrap is a production-ready FastAPI wrapper service that provides universal audio transcription with iOS Shortcuts support. The service offers:

1. **Universal Audio Processing**: Accepts any audio/video format (mp3, wav, m4a, flac, ogg, aac, mp4, avi, mov, mkv)
2. **Dual API Endpoints**: Standard multipart upload `/transcribe` and iOS-compatible raw binary `/transcribe-raw`
3. **Automatic Format Conversion**: Uses ffmpeg to convert files to 16kHz mono WAV for optimal whisper performance
4. **Intelligent File Management**: libmagic-based MIME detection with automatic temporary file cleanup
5. **Production Features**: Health monitoring, debug logging, comprehensive error handling

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client App    │───▶│  whisper-wrap   │───▶│ whisper-server  │
│  (iOS/Web/CLI)  │    │   (FastAPI)     │    │  (whisper.cpp)  │
│                 │    │   Port 8000     │    │   Port 9000     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

**Data Flow**: Upload → Validate (libmagic) → Convert (ffmpeg) → Transcribe (whisper) → Cleanup

**Core Components:**
- **FastAPI Application** (`app/main.py`): Web server with lifespan management and health checks
- **API Endpoints** (`app/api/transcribe.py`): Two endpoints with comprehensive error handling and debug logging
- **File Services** (`app/services/files.py`): MIME detection, validation, and temporary file management
- **Audio Converter** (`app/services/converter.py`): ffmpeg integration with timeout and error handling
- **Whisper Client** (`app/services/whisper.py`): HTTP client for whisper-server communication
- **Configuration** (`app/config.py`): Environment-based configuration with validation

**Setup Automation:**
- **Makefile**: Complete automation for dependency checking, installation, building, and deployment
- **Docker Support**: Single-container deployment with model persistence
- **Cross-Platform**: Automated dependency installation for macOS, Ubuntu, RHEL, Arch Linux

## Development Workflow

**First-Time Setup:**
```bash
make check-system-deps    # Verify system requirements
make install-system-deps  # Auto-install dependencies if needed
make setup               # Complete setup (clone + build + install)
```

**Development:**
```bash
make dev                 # Start both services
make test               # Run test suite (14 tests)
make lint               # Code quality checks
```

**Docker Deployment:**
```bash
make docker             # Build and start with persistence
```

## API Endpoints

### POST /transcribe
Standard multipart file upload for web applications and curl.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `file` field with audio/video file

### POST /transcribe-raw  
iOS Shortcuts compatible endpoint for raw binary data.

**Request:**
- Content-Type: `audio/mp3`, `audio/wav`, etc.
- Body: Raw binary audio data

**iOS Shortcuts Configuration:**
- URL: `http://your-server:8000/transcribe-raw`
- Method: POST
- Headers: `Content-Type = audio/m4a` (match your format)
- Body: Select audio file

### GET /health
Health check endpoint for load balancers and monitoring.

### GET /
API information and endpoint documentation.

## Configuration

Environment variables (`.env` file):
```env
WHISPER_SERVER_URL=http://localhost:9000  # whisper-server location
MAX_FILE_SIZE_MB=100                      # File upload limit
TEMP_DIR=/tmp/whisper-wrap                # Temporary file storage
LOG_LEVEL=DEBUG                           # Logging level (DEBUG for development)
UPLOAD_TIMEOUT_SECONDS=30                 # Processing timeout
```

## whisper-server Integration

**Automatic Setup:**
```bash
make setup              # Clones to ../whisper.cpp, builds, downloads model
make run-whisper        # Start whisper-server only
```

**Manual Setup:**
```bash
cd ../whisper.cpp
./build/bin/whisper-server --host 0.0.0.0 --port 9000 -m ./models/ggml-large-v3-turbo-q8_0.bin -l 'auto' -tdrz
```

**Model Information:**
- **File**: `ggml-large-v3-turbo-q8_0.bin` (~1.5GB)
- **Languages**: 100+ languages with tier-based quality
- **Performance**: ~2-4x real-time transcription speed

## Development Guidelines

**Code Quality:**
- Use `uv` for package management (fast, reliable)
- Follow existing patterns in `app/` directory structure
- Maintain comprehensive error handling with debug logging
- All changes should pass: `make lint && make test`

**Testing:**
- 14 comprehensive tests covering all major functionality
- Test both API endpoints and service layers
- Include error conditions and edge cases

**Documentation:**
- Update README.md for user-facing changes
- Update CLAUDE.md for development guidance
- Maintain inline docstrings for complex logic

**Security:**
- Never log sensitive information or file contents
- All file uploads validated with libmagic MIME detection
- Automatic cleanup prevents disk exhaustion
- Configurable file size limits and timeouts

## Common Operations

**Troubleshooting:**
```bash
make check-system-deps  # Verify all dependencies
make test              # Run comprehensive test suite
curl http://localhost:8000/health  # Check service health
```

**Performance:**
- **Memory**: 2-4GB during processing, 6-8GB recommended for production
- **Timing**: 1min audio ≈ 15-30s processing time
- **Concurrency**: Single-threaded whisper-server (queue requests)

**Docker:**
- **Build Time**: 10-15 minutes first build (downloads and compiles whisper.cpp)
- **Image Size**: ~3GB (includes models and build tools)
- **Volumes**: Models persisted via named volumes, temp files ephemeral