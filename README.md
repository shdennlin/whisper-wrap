# whisper-wrap

FastAPI wrapper for whisper.cpp with universal audio format support.

## Features

- **Universal Format Support**: Accepts any audio/video format (mp3, wav, m4a, flac, ogg, aac, mp4, avi, mov, mkv)
- **Automatic Conversion**: Uses ffmpeg to convert files to WAV format for whisper
- **Simple REST API**: Single endpoint for transcription with JSON responses
- **Automatic Cleanup**: Manages temporary files automatically
- **Health Monitoring**: Built-in health checks for service monitoring
- **Production Ready**: Built with FastAPI for performance and reliability

## Prerequisites

1. **System Dependencies**:
   - ffmpeg (for audio conversion)
   - libmagic (for file type detection)

   On macOS with Homebrew:
   ```bash
   brew install ffmpeg libmagic
   ```

2. **whisper-server**: whisper.cpp will be automatically downloaded
   ```bash
   # All setup is handled by the Makefile
   # See Quick Start section below
   ```

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
   # Standard multipart upload
   curl -X POST "http://localhost:8000/transcribe" \
        -F "file=@your-audio-file.mp3"
   
   # Raw binary upload (iOS Shortcuts style)  
   curl -X POST "http://localhost:8000/transcribe-raw" \
        -H "Content-Type: audio/mp3" \
        --data-binary "@your-audio-file.mp3"
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
WHISPER_SERVER_URL=http://localhost:9000
MAX_FILE_SIZE_MB=100
TEMP_DIR=/tmp/whisper-wrap
LOG_LEVEL=INFO
UPLOAD_TIMEOUT_SECONDS=30
```

## Development

### Available Make Targets

```bash
make help          # Show all available targets
make setup         # Complete setup (clone + install + build + download model)
make install       # Install Python dependencies
make clone-whisper # Clone whisper.cpp repository to parent directory
make build-whisper # Build whisper.cpp
make download-model # Download whisper model
make test          # Run test suite
make lint          # Run code linting
make format        # Format code
make run           # Start FastAPI server only
make run-whisper   # Start whisper-server only
make dev           # Start both services (development mode)
make clean         # Clean build artifacts
make docker        # Build and run with Docker Compose
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

## Error Handling

The API handles various error conditions:

- **413**: File too large (exceeds MAX_FILE_SIZE_MB)
- **415**: Unsupported file format
- **422**: Invalid request (missing file, empty filename)
- **500**: Server errors (ffmpeg failure, whisper-server connectivity)

## Performance

- **File Size Limit**: 100MB default (configurable)
- **Timeout**: 30 seconds default (configurable)  
- **Conversion**: Automatic to 16kHz mono WAV for optimal whisper performance
- **Cleanup**: Automatic temporary file removal after processing

## Production Deployment

For production use:

1. Set appropriate resource limits
2. Configure logging level
3. Set up monitoring for /health endpoint
4. Ensure whisper-server reliability
5. Configure reverse proxy if needed

## Troubleshooting

**whisper-server connection failed**:
- Verify whisper-server is running on configured port
- Check WHISPER_SERVER_URL in configuration

**ffmpeg not found**:
- Install ffmpeg system dependency
- Verify ffmpeg is in system PATH

**libmagic import error**:
- Install libmagic system dependency
- On macOS: `brew install libmagic`