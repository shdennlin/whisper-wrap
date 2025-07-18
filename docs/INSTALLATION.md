# Installation Guide

Complete setup guide for whisper-wrap with system requirements and dependencies.

## System Requirements

### Hardware Requirements
- **RAM**: 4GB minimum, 8GB+ recommended (whisper models are memory-intensive)
- **Disk Space**: ~3GB free space (whisper.cpp compilation + models)
- **CPU**: Multi-core recommended for faster transcription

### Software Requirements
- **Python**: 3.8 or higher
- **uv**: Fast Python package manager ([install guide](https://github.com/astral-sh/uv))
- **git**: For cloning whisper.cpp repository
- **cmake**: For building whisper.cpp (3.16+)
- **C++ compiler**: GCC, Clang, or MSVC for compilation

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

### 3. Whisper.cpp Setup

```bash
# Clone whisper.cpp
make clone-whisper

# Build whisper.cpp
make build-whisper

# Download model
make download-model
```

### 4. Start Services

```bash
# Terminal 1: Start whisper-server
make run-whisper

# Terminal 2: Start FastAPI
make run
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