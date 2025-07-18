# whisper-wrap

FastAPI wrapper for whisper.cpp with universal audio format support.

## Features

- **Universal Format Support**: Accepts any audio/video format (mp3, wav, m4a, flac, ogg, aac, mp4, avi, mov, mkv)
- **Automatic Conversion**: Uses ffmpeg to convert files to WAV format for whisper
- **Simple REST API**: Single endpoint for transcription with JSON responses
- **Automatic Cleanup**: Manages temporary files automatically
- **Health Monitoring**: Built-in health checks for service monitoring
- **Production Ready**: Built with FastAPI for performance and reliability

## System Requirements

**Hardware Requirements**:
- **RAM**: 4GB minimum, 8GB+ recommended (whisper models are memory-intensive)
- **Disk Space**: ~3GB free space (whisper.cpp compilation + models)
- **CPU**: Multi-core recommended for faster transcription

**Software Requirements**:
- **Python**: 3.8 or higher
- **uv**: Fast Python package manager ([install guide](https://github.com/astral-sh/uv))
- **git**: For cloning whisper.cpp repository
- **cmake**: For building whisper.cpp (3.16+)
- **C++ compiler**: GCC, Clang, or MSVC for compilation

**Operating Systems**:
- macOS 10.15+ (Intel/Apple Silicon)
- Ubuntu 18.04+ / Debian 10+
- RHEL/CentOS 7+ / Fedora 30+
- Arch Linux (current)
- Windows 10+ (WSL2 recommended)

**CPU Architectures**:
- **x86_64 (Intel/AMD)**: Full support with AVX/AVX2 optimizations
- **ARM64 (Apple Silicon)**: Native support with NEON optimizations
- **Generic**: Fallback support for other architectures

## Architecture

whisper-wrap provides a REST API layer over whisper.cpp's whisper-server:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client App    │───▶│  whisper-wrap   │───▶│ whisper-server  │
│  (iOS/Web/CLI)  │    │   (FastAPI)     │    │  (whisper.cpp)  │
│                 │    │   Port 8000     │    │   Port 9000     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

**Data Flow**:
1. **Upload**: Client sends audio file to `/transcribe` or `/transcribe-raw`
2. **Validate**: Check file size, type, and format using libmagic
3. **Convert**: ffmpeg converts audio to 16kHz mono WAV format
4. **Transcribe**: Forward WAV file to whisper-server for processing
5. **Response**: Return JSON with transcription text, language, duration
6. **Cleanup**: Automatically remove temporary files

## Prerequisites

### Automatic Installation (Recommended)

The setup process will automatically check and install dependencies:

```bash
# Check what's needed
make check-system-deps

# Install missing system dependencies  
make install-system-deps

# Complete setup
make setup
```

### Manual Installation

If you prefer manual installation:

1. **System Dependencies**:
   - ffmpeg (for audio conversion)
   - libmagic (for file type detection)

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

2. **whisper-server**: whisper.cpp will be automatically downloaded
   ```bash
   # All setup is handled by the Makefile
   # See Quick Start section below
   ```

**Setup Time**: Expect 10-30 minutes for first-time installation (internet speed dependent)

## Quick Start

1. **Complete setup** (first time only):
   ```bash
   # Clone, build, and setup everything
   make setup
   ```

2. **Start development environment**:
   ```bash
   make dev
   ```

3. **Test the API**:
   ```bash
   # Standard multipart upload (default port 8000)
   curl -X POST "http://localhost:8000/transcribe" \
        -F "file=@your-audio-file.mp3"
   
   # Raw binary upload (iOS Shortcuts style)  
   curl -X POST "http://localhost:8000/transcribe-raw" \
        -H "Content-Type: audio/mp3" \
        --data-binary "@your-audio-file.mp3"
   
   # With custom port (if API_PORT is set)
   curl -X POST "http://localhost:${API_PORT:-8000}/transcribe" \
        -F "file=@your-audio-file.mp3"
   ```

### Manual Setup (Alternative)

1. **Install dependencies**:
   ```bash
   make install
   ```

2. **Clone whisper.cpp**:
   ```bash
   make clone-whisper
   ```

3. **Build whisper.cpp**:
   ```bash
   make build-whisper
   ```

4. **Download model**:
   ```bash
   make download-model
   ```

5. **Start services separately**:
   ```bash
   # Terminal 1: Start whisper-server
   make run-whisper
   
   # Terminal 2: Start FastAPI
   make run
   ```

## API Documentation

### POST /transcribe

Transcribe an audio or video file to text (standard multipart upload).

**Request**:
- Method: POST
- Content-Type: multipart/form-data
- Body: file field with audio/video file

**Response**:
```json
{
  "text": "transcribed text content",
  "language": "detected_language_code", 
  "duration": 123.45,
  "confidence": 0.95
}
```

### POST /transcribe-raw

Transcribe raw audio data (iOS Shortcuts compatible).

**Request**:
- Method: POST
- Content-Type: audio/mp3, audio/wav, etc. (specify actual format)
- Body: Raw binary audio data

**iOS Shortcuts Usage**:
```
1. Get file from Files app or record audio
2. Use "Get Contents of URL" action:
   - URL: http://your-server:8000/transcribe-raw
   - Method: POST
   - Headers: Content-Type = audio/mp3 (or your format)
   - Request Body: Choose "File" and select your audio
```

**Response**: Same JSON format as /transcribe

**Error Response**:
```json
{
  "detail": "error description"
}
```

### GET /health

Check service health status.

**Response**:
```json
{
  "status": "healthy",
  "whisper_server": true,
  "whisper_server_url": "http://localhost:9000"
}
```

### GET /

Get API information and available endpoints.

## Configuration

Environment variables can be set in `.env` file:

```env
# API server configuration
API_PORT=8000
API_HOST=0.0.0.0

# Whisper server configuration
WHISPER_SERVER_HOST=localhost
WHISPER_SERVER_PORT=9000

# Alternative: Use complete URL (overrides individual components)
# WHISPER_SERVER_URL=http://localhost:9000

# File handling configuration
MAX_FILE_SIZE_MB=100
TEMP_DIR=/tmp/whisper-wrap
LOG_LEVEL=INFO
UPLOAD_TIMEOUT_SECONDS=30
```

### Port Configuration

You can customize the ports used by both services:

**API Server Ports:**
- `API_PORT`: Port for the FastAPI server (default: 8000)
- `API_HOST`: Host interface to bind to (default: 0.0.0.0)

**Whisper Server Ports:**
- `WHISPER_SERVER_PORT`: Port for the whisper-server (default: 9000)
- `WHISPER_SERVER_HOST`: Host for the whisper-server (default: localhost)

**Docker Port Configuration:**
```bash
# Set custom ports via environment variables
API_PORT=9001 WHISPER_SERVER_PORT=9002 docker-compose up --build

# Or create a .env file:
echo "API_PORT=9001" > .env
echo "WHISPER_SERVER_PORT=9002" >> .env
docker-compose up --build
```

**Makefile Port Configuration:**
```bash
# Start with custom ports
API_PORT=9001 WHISPER_SERVER_PORT=9002 make dev

# Or export environment variables
export API_PORT=9001
export WHISPER_SERVER_PORT=9002
make dev
```

## Development

### Available Make Targets

```bash
make help               # Show all available targets
make setup              # Complete setup (check system deps + install + build + download model)
make check-system-deps  # Check required system dependencies
make install-system-deps# Install system dependencies (macOS/Linux)
make install            # Install Python dependencies
make clone-whisper      # Clone whisper.cpp repository to parent directory  
make build-whisper      # Build whisper.cpp
make download-model     # Download whisper model
make test               # Run test suite
make lint               # Run code linting
make format             # Format code
make run                # Start FastAPI server only
make run-whisper        # Start whisper-server only
make dev                # Start both services (development mode)
make clean              # Clean build artifacts
make docker             # Build and run with Docker Compose
```

### Running Tests

```bash
make test
```

### Code Quality

```bash
make lint
make format
```

### Project Structure

```
parent-directory/
├── whisper.cpp/             # Cloned whisper.cpp repository (auto-downloaded)
└── whisper-wrap/
    ├── app/
    │   ├── main.py          # FastAPI application
    │   ├── config.py        # Configuration management
    │   ├── api/
    │   │   └── transcribe.py # API endpoints
    │   └── services/
    │       ├── files.py     # File management
    │       ├── converter.py # Audio conversion
    │       └── whisper.py   # Whisper client
    ├── tests/               # Test suite
    ├── .env.example         # Environment template
    ├── pyproject.toml       # Project configuration
    └── README.md
```

## Supported Formats

**Audio**: mp3, wav, m4a, flac, ogg, aac, wma
**Video**: mp4, avi, mov, mkv (audio extraction)

## Whisper Model Information

**Model**: `ggml-large-v3-turbo-q8_0` (default)
- **Size**: ~1.5GB download
- **Quality**: High accuracy, optimized for speed
- **Languages**: 100+ languages supported including:
  - **Tier 1** (Excellent): English, Spanish, French, German, Italian, Portuguese, Dutch, Russian
  - **Tier 2** (Very Good): Japanese, Chinese, Korean, Arabic, Hindi, Turkish, Polish
  - **Tier 3** (Good): 80+ additional languages with varying quality
  
**Performance Characteristics**:
- **Transcription Speed**: ~2-4x real-time (varies by hardware)
- **Memory Usage**: ~2-4GB RAM during processing
- **CPU Usage**: Multi-threaded, scales with available cores
- **Language Detection**: Automatic language detection included

**Audio Quality Guidelines**:
- **Best**: Clear speech, minimal background noise, 16kHz+ sample rate
- **Good**: Podcast/call quality, some background noise acceptable
- **Fair**: Compressed audio, noisy environments (accuracy may vary)

## Error Handling

The API handles various error conditions:

- **413**: File too large (exceeds MAX_FILE_SIZE_MB)
- **415**: Unsupported file format
- **422**: Invalid request (missing file, empty filename)
- **500**: Server errors (ffmpeg failure, whisper-server connectivity)

## Performance

**Transcription Timing Estimates**:
- **1 minute audio**: ~15-30 seconds processing time
- **10 minute audio**: ~2-5 minutes processing time  
- **1 hour audio**: ~15-30 minutes processing time

> [!TIP]
> **Docker Performance**: These estimates apply to both native and Docker deployments. ARM systems (Mac/Apple Silicon) achieve similar performance through CPU optimization despite lacking GPU acceleration in Docker containers.

**System Limits**:
- **File Size**: 100MB default (configurable via MAX_FILE_SIZE_MB)
- **Timeout**: 30 seconds default (configurable via UPLOAD_TIMEOUT_SECONDS)
- **Concurrent Requests**: Single-threaded whisper-server (queue requests)
- **Memory**: Peak usage ~4GB during large file processing

**Optimization**:
- **Conversion**: Automatic to 16kHz mono WAV for optimal whisper performance  
- **Cleanup**: Automatic temporary file removal after processing
- **Caching**: No transcription caching (each request processed fresh)

## Production Deployment

### Docker Deployment

> [!IMPORTANT]
> **GPU Acceleration**: Docker containers cannot access GPU acceleration on ARM systems (Mac/Apple Silicon). The service uses CPU-only processing with optimized NEON instructions, providing excellent performance but without GPU benefits.

**Quick Docker Setup**:
```bash
# Build and run with Docker Compose (recommended)
make docker

# Or manually:
docker build -t whisper-wrap:latest .
docker run -p 8000:8000 whisper-wrap:latest

# Check running containers:
docker ps
```

**Docker Compose** (recommended):
```yaml
services:
  whisper-wrap:
    build: .
    image: whisper-wrap:latest          # Consistent image naming
    container_name: whisper-wrap        # Predictable container name
    ports:
      - "8000:8000"
    environment:
      - MAX_FILE_SIZE_MB=200
      - LOG_LEVEL=INFO
      - UPLOAD_TIMEOUT_SECONDS=60
    volumes:
      - whisper_models:/whisper.cpp/models  # Persist models across restarts
    restart: unless-stopped

volumes:
  whisper_models:
    driver: local
```

**Volume Strategy**:
- **✅ Models persisted**: 1.5GB whisper model survives container restarts
- **✅ Temp files ephemeral**: Automatic cleanup prevents disk bloat  
- **✅ Fast restarts**: No need to re-download models

**Note**: The Docker image includes both whisper-wrap and whisper.cpp in a single container for simplicity. Both services start automatically.

### Production Considerations

**Resource Planning**:
1. **Memory**: Allocate 6-8GB RAM for safe operation
2. **CPU**: Multi-core systems provide better performance  
3. **Storage**: Monitor temp directory disk usage
4. **Network**: Consider file upload bandwidth requirements

**Configuration**:
1. Set appropriate file size limits (`MAX_FILE_SIZE_MB`)
2. Configure logging level (`LOG_LEVEL=INFO` for production)
3. Set up monitoring for `/health` endpoint
4. Configure reverse proxy (nginx/Apache) for SSL/load balancing

**Security**:
1. **Input Validation**: File type and size limits enforced
2. **Temporary Files**: Automatic cleanup prevents disk exhaustion
3. **Network**: Run behind reverse proxy, block direct whisper-server access
4. **Environment**: Use `.env` file for sensitive configuration

**Monitoring**:
1. **Health Checks**: `GET /health` endpoint for load balancer health checks
2. **Logs**: Monitor for ffmpeg errors, whisper-server connectivity issues
3. **Metrics**: Track request rate, processing time, error rates
4. **Disk Space**: Monitor temp directory usage

## Troubleshooting

**whisper-server connection failed**:
- Verify whisper-server is running on configured port
- Check WHISPER_SERVER_URL in configuration

**System dependencies missing**:
- Run `make check-system-deps` to see what's missing
- Run `make install-system-deps` for automatic installation
- Or install manually (see Prerequisites section)

**ffmpeg not found**:
- Install ffmpeg system dependency
- Verify ffmpeg is in system PATH

**libmagic import error**:
- Install libmagic system dependency  
- Check with: `python3 -c "import magic"`

**Performance issues**:
- Check available RAM (whisper needs 2-4GB)
- Monitor CPU usage during transcription
- Verify disk space for temporary files
- Consider shorter audio files for testing

**Audio quality issues**:
- Ensure audio is clear with minimal background noise
- Check supported formats list
- Try converting to WAV format first
- Verify file isn't corrupted or empty

**Docker build issues**:
- First build takes 10-15 minutes (downloads and compiles whisper.cpp)
- Requires ~3GB disk space for final image
- Ensure Docker has sufficient memory (4GB+ recommended)
- Build includes downloading 1.5GB whisper model
- **Multi-Architecture Support**: Auto-detects Intel/AMD (x86_64) vs ARM64 and optimizes accordingly
- **CPU Optimizations**: Enables AVX/AVX2 for Intel/AMD, NEON for ARM systems
- **Verify Architecture**: Check build with `docker run --rm whisper-wrap:latest uname -m`
- **Image Management**: All builds create consistent `whisper-wrap:latest` image name

> [!WARNING]
> **ARM/Mac GPU Limitation**: Docker containers on ARM architecture (including Apple Silicon Macs) cannot access GPU acceleration for whisper models. The service will run using CPU-only processing, which is still fast but slower than GPU-accelerated setups on dedicated hardware.

> [!NOTE]
> **Performance on ARM**: Despite the lack of GPU acceleration, ARM64 processors (especially Apple Silicon) provide excellent CPU performance for whisper.cpp with NEON optimizations. Expect transcription speeds of 2-4x real-time on modern ARM systems.

## Common Use Cases

**iOS Shortcuts Integration**:
```
Use "Get Contents of URL" with:
- URL: http://your-server:8000/transcribe-raw
- Method: POST  
- Headers: Content-Type = audio/m4a
- Body: Select your recorded audio file
```

**Batch Processing** (command line):
```bash
# Process multiple files
for file in *.mp3; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@$file" \
       -o "${file%.mp3}.json"
done
```

**API Integration** (Python):
```python
import httpx

# Transcribe audio file
with open("audio.mp3", "rb") as f:
    response = httpx.post(
        "http://localhost:8000/transcribe-raw",
        headers={"Content-Type": "audio/mp3"},
        content=f.read()
    )
    transcription = response.json()
    print(transcription["text"])
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.