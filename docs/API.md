# API Documentation

Complete API reference for whisper-wrap transcription service.

## Base URL

```
http://localhost:8000
```

## Endpoints

### POST /transcribe

Transcribe an audio or video file to text (standard multipart upload).

**Request**:
- Method: POST
- Content-Type: multipart/form-data
- Body: file field with audio/video file

**Example**:
```bash
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@your-audio-file.mp3"
```

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

**Example**:
```bash
curl -X POST "http://localhost:8000/transcribe-raw" \
     -H "Content-Type: audio/mp3" \
     --data-binary "@your-audio-file.mp3"
```

**iOS Shortcuts Usage**:
1. Get file from Files app or record audio
2. Use "Get Contents of URL" action:
   - URL: http://your-server:8000/transcribe-raw
   - Method: POST
   - Headers: Content-Type = audio/mp3 (or your format)
   - Request Body: Choose "File" and select your audio

**Response**: Same JSON format as /transcribe

### GET /health

Check service health status.

**Request**:
- Method: GET
- No parameters required

**Example**:
```bash
curl http://localhost:8000/health
```

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

**Request**:
- Method: GET
- No parameters required

**Example**:
```bash
curl http://localhost:8000/
```

**Response**:
```json
{
  "name": "whisper-wrap",
  "version": "1.0.0",
  "description": "FastAPI wrapper for whisper.cpp with universal audio format support",
  "endpoints": {
    "transcribe": "POST /transcribe - Upload audio file for transcription (multipart/form-data)",
    "transcribe-raw": "POST /transcribe-raw - Send raw audio data for transcription (iOS Shortcuts compatible)",
    "health": "GET /health - Service health status"
  }
}
```

## Error Responses

All endpoints return error responses in this format:

```json
{
  "detail": "error description"
}
```

### Common Error Codes

- **400**: Bad request (malformed request)
- **413**: File too large (exceeds MAX_FILE_SIZE_MB)
- **415**: Unsupported file format
- **422**: Invalid request (missing file, empty filename)
- **500**: Server errors (ffmpeg failure, whisper-server connectivity)

## Supported Formats

**Audio**: mp3, wav, m4a, flac, ogg, aac, wma
**Video**: mp4, avi, mov, mkv (audio extraction)

## Configuration

Configure the API via environment variables:

```env
# API server configuration
API_PORT=8000
API_HOST=0.0.0.0

# Whisper server configuration
WHISPER_SERVER_HOST=localhost
WHISPER_SERVER_PORT=9000

# File handling configuration
MAX_FILE_SIZE_MB=100
TEMP_DIR=/tmp/whisper-wrap
LOG_LEVEL=INFO
UPLOAD_TIMEOUT_SECONDS=30
```

## Integration Examples

### Python with httpx

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

### Python with requests

```python
import requests

# Multipart upload
with open("audio.mp3", "rb") as f:
    response = requests.post(
        "http://localhost:8000/transcribe",
        files={"file": f}
    )
    transcription = response.json()
    print(transcription["text"])
```

### JavaScript/Node.js

```javascript
const fs = require('fs');
const fetch = require('node-fetch');

// Raw binary upload
const audioBuffer = fs.readFileSync('audio.mp3');
const response = await fetch('http://localhost:8000/transcribe-raw', {
    method: 'POST',
    headers: {
        'Content-Type': 'audio/mp3'
    },
    body: audioBuffer
});

const transcription = await response.json();
console.log(transcription.text);
```

### Batch Processing

```bash
# Process multiple files
for file in *.mp3; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@$file" \
       -o "${file%.mp3}.json"
done
```

### iOS Shortcuts Integration

**Ready-to-Use Shortcut**: 📱 **[Download ASR Shortcut](https://www.icloud.com/shortcuts/698627e2c3934b3e996426b64a943742)**

**Manual Setup**:
1. Record Audio (or Get File from input)
2. Get Contents of URL:
   - URL: http://your-server:8000/transcribe-raw
   - Method: POST  
   - Headers: Content-Type = audio/m4a
   - Request Body: [Audio file from step 1]
3. Get Dictionary from Contents of URL
4. Get Dictionary Value for "text"
5. Copy to Clipboard (copies transcribed text)
6. Show Result (displays the transcribed text)

**Configuration Examples**:
- **Local Network**: `http://192.168.1.100:8000/transcribe-raw`
- **Custom Port**: `http://192.168.1.100:12000/transcribe-raw`
- **Remote Server**: `https://your-domain.com/transcribe-raw`

## Rate Limiting

Currently, the API has the following limits:
- **File Size**: 100MB default (configurable via MAX_FILE_SIZE_MB)
- **Timeout**: 30 seconds default (configurable via UPLOAD_TIMEOUT_SECONDS)
- **Concurrent Requests**: Single-threaded whisper-server (requests are queued)

## Performance Considerations

- **Transcription Speed**: ~2-4x real-time (varies by hardware)
- **Memory Usage**: ~2-4GB RAM during processing
- **Optimal Audio**: 16kHz mono WAV format (automatic conversion applied)
- **Language Detection**: Automatic, but you can specify language if known

## Security

- **Input Validation**: File type and size limits enforced
- **Temporary Files**: Automatic cleanup prevents disk exhaustion
- **Network**: Recommend running behind reverse proxy for SSL/authentication
- **Environment**: Use `.env` file for sensitive configuration