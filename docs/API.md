# API Documentation

**English** | [繁體中文](API.zh-TW.md)

Complete API reference for whisper-wrap transcription service.

## Base URL

```
http://localhost:8000
```

## Endpoints

### POST /transcribe

Unified transcription endpoint. The handler branches on `Content-Type`:

- `multipart/form-data` — reads the `file` form field (web/CLI clients).
- `audio/*` or `application/octet-stream` — reads the raw request body
  (iOS Shortcuts, mobile apps, embedded clients).
- Anything else — HTTP 415 Unsupported Media Type.

**Query params:**
- `language` (default `"auto"`) — language hint forwarded to the model.
- `prompt` (optional) — initial prompt seed; the wrapper applies a built-in
  bilingual punctuation prompt when this is omitted.

**Examples**:

```bash
# Multipart upload
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@your-audio-file.mp3"

# Raw audio body (iOS Shortcuts)
curl -X POST "http://localhost:8000/transcribe" \
     -H "Content-Type: audio/mp3" \
     --data-binary "@your-audio-file.mp3"

# With language hint
curl -X POST "http://localhost:8000/transcribe?language=zh" \
     -H "Content-Type: audio/wav" \
     --data-binary "@audio.wav"
```

**iOS Shortcuts usage:**

1. Get file from Files app or record audio.
2. Use "Get Contents of URL" action:
   - URL: `http://your-server:8000/transcribe`
   - Method: POST
   - Headers: `Content-Type = audio/m4a` (or your format)
   - Request Body: choose "File" and select your audio.

**Response**:

```json
{
  "text": "transcribed text content",
  "language": "en",
  "segments": [
    {"start": 0.0, "end": 1.5, "text": "first segment"},
    {"start": 1.5, "end": 3.2, "text": "second segment"}
  ]
}
```

### POST /ask

Audio or text question; Gemini-generated answer.

- Body: same `Content-Type` matrix as `/transcribe`, plus
  `application/json {"text": "..."}` to skip transcription.
- Query: `stream` (`true` for SSE), `language`, `prompt` (audio mode only).

**Blocking response** (default):

```json
{
  "transcript": "what's the weather today",
  "answer": "Sunny with a high of 28°C..."
}
```

For the JSON text path, `transcript` is `null`.

**Streaming response** (`?stream=true`):

```
event: transcript
data: {"text": "what's the weather today"}

event: token
data: {"text": "Sunny "}

event: token
data: {"text": "with a high of 28°C..."}

event: done
data: {"finish_reason": "stop"}
```

Failure modes:
- Validation error (malformed JSON, missing `file`, zero-byte body) → HTTP 400
  before any SSE framing begins.
- Missing `GEMINI_API_KEY` → blocking returns HTTP 502; streaming emits a
  single `event: error` with no preceding transcript event.
- STT failure before LLM call (streaming) → `event: error` with no preceding
  transcript event.
- LLM failure after streaming has started → terminating `event: error`.

### WS /listen

Live captioning over WebSocket. Send 16 kHz mono `pcm_s16le` audio as binary
frames (200 B – 64 KiB per frame; ~250 ms per frame recommended). Receive
JSON text frames:

```json
{"type": "partial", "text": "...", "start_ms": 0, "end_ms": 1800}
{"type": "final",   "text": "...", "start_ms": 0, "end_ms": 2400}
```

Timestamps are relative to the WebSocket connection start (monotonically
non-decreasing). A single connection may carry multiple utterances; closing
the socket mid-utterance discards the in-flight buffer (no `final` event).

### POST /transcribe/meeting

Long-form meeting analysis with speaker diarization (WhisperX + pyannote).
Asynchronous: the endpoint returns HTTP **202** with a job handle; clients
poll `GET /transcribe/meeting/{job_id}` until `status == "done"`.

The endpoint is opt-in: see the README "Meeting Mode" section for
installation (`uv sync --extra meeting`, HF user agreements, `HF_TOKEN`).
Until prerequisites are met it returns HTTP **503** with a typed reason.

**Request**:

- `Content-Type`: same dispatch as `/transcribe` —
  `multipart/form-data` (`file` field), raw `audio/*`, or
  `application/octet-stream`.
- Query parameters (all optional):
  - `language` — ISO 639-1 code; omit for auto-detection.
  - `num_speakers` — exact speaker count when known.
  - `min_speakers` / `max_speakers` — speaker-count bounds.
  - `enable_word_timestamps` — boolean (default `true`); set `false` to
    skip the alignment stage and omit per-word timestamps.

**202 Accepted** response:

```json
{
  "job_id": "01JFA9YS3Q4VRD3M2K6V0YZ8AB",
  "status_url": "/transcribe/meeting/01JFA9YS3Q4VRD3M2K6V0YZ8AB"
}
```

**Error responses**:

| HTTP | Body | When |
| ---- | ---- | ---- |
| 400 | `{"error":"invalid_audio","reason":"..."}` | libmagic rejects the upload as non-audio. |
| 400 | `{"error":"invalid_speaker_range","reason":"max_speakers must be >= min_speakers"}` | Speaker bounds are inconsistent or non-positive. |
| 413 | `File too large. Maximum size: 100MB` | Body exceeds `MAX_FILE_SIZE_MB`. |
| 415 | `Unsupported Content-Type: ...` | Body Content-Type not in the dispatch list. |
| 503 | `{"error":"meeting_unavailable","reason":"meeting extras not installed"}` | `whisperx`/`pyannote.audio` not importable. |
| 503 | `{"error":"meeting_unavailable","reason":"HF_TOKEN is not configured"}` | `HF_TOKEN` env unset/empty. |
| 503 | `{"error":"meeting_unavailable","reason":"model <name> has no ct2 variant"}` | Registry lacks a `format: ct2` variant for the active model. |
| 503 | `{"error":"meeting_unavailable","reason":"model <name> ct2 variant is not downloaded; run make download-model MODEL=<name>"}` | CT2 directory missing on disk. |

### GET /transcribe/meeting/{job_id}

Poll a previously created meeting job. Returns the current state plus the
final `MeetingResult` once `status == "done"`.

**Response shapes** (by `status`):

```json
// Pending or running
{"status":"running","progress":0.4,"stage":"align","result":null}

// Done
{"status":"done","progress":1.0,"stage":"complete",
 "result":{
   "language":"zh",
   "duration_seconds":1823.4,
   "speakers":["SPEAKER_00","SPEAKER_01"],
   "segments":[
     {"speaker":"SPEAKER_00","start":0.52,"end":4.18,
      "text":"今天會議的主題是…",
      "words":[{"word":"今天","start":0.52,"end":0.91}, ...]}
   ]
 }}

// Error
{"status":"error","stage":"diarize","progress":0.7,
 "error":{"code":"diarize_failed","message":"<reason>"},
 "result":null}
```

`stage` is one of `pending` / `asr` / `align` / `diarize` / `complete`.
`error.code` is one of `asr_failed` / `align_failed` / `diarize_failed` /
`pipeline_failed`.

**404** is returned when the `job_id` is unknown — either it was never
issued or it has been evicted (default TTL 1 h; default capacity 20 jobs).

**Notes**:

- Word lists are omitted entirely when the request used
  `enable_word_timestamps=false`.
- `segments[i].start <= segments[i+1].start` (non-decreasing).
- Only one job runs at a time per process; concurrent submissions queue
  and report `status: "pending"` until the lock is free.

### GET /status

Service health, loaded model details, and LLM configuration. Returns
`status="ok"` and `model.loaded=true` (the lifespan blocks startup until the
model is loaded).

**Response**:

```json
{
  "status": "ok",
  "version": "2.1.0",
  "uptime_seconds": 1234,
  "model": {
    "name": "breeze-asr-25",
    "path": "models/breeze-asr-25",
    "compute_type": "default",
    "device": "auto",
    "loaded": true,
    "load_time_ms": 6320
  },
  "gemini": {
    "configured": true,
    "model": "gemini-3.1-flash-lite"
  }
}
```

### GET /

API discovery — lists every registered endpoint.

**Response**:

```json
{
  "endpoints": [
    {"method": "POST", "path": "/transcribe", "description": "..."},
    {"method": "WS",   "path": "/listen",     "description": "..."},
    {"method": "POST", "path": "/ask",        "description": "..."},
    {"method": "GET",  "path": "/status",     "description": "..."},
    {"method": "GET",  "path": "/",           "description": "..."}
  ]
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
- **500**: Server errors (ffmpeg failure, in-process model error)
- **502**: LLM upstream error (Gemini API unreachable or missing credentials)

## Supported Formats

**Audio**: mp3, wav, m4a, flac, ogg, aac, wma
**Video**: mp4, avi, mov, mkv (audio extraction)

## Configuration

Configure the API via environment variables:

```env
# API server
API_PORT=8000
API_HOST=0.0.0.0

# Model
MODEL_NAME=breeze-asr-25
COMPUTE_TYPE=default
DEVICE=auto

# Gemini (for /ask)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite

# File handling
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
        "http://localhost:8000/transcribe",
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
const response = await fetch('http://localhost:8000/transcribe', {
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

**Ready-to-Use Shortcuts**:
- 📱 [ASR](https://www.icloud.com/shortcuts/cc6e3b42e9c743ec9d15db4c30d0c205) — record → `/transcribe` → clipboard
- 📱 [ASR-Ask](https://www.icloud.com/shortcuts/02d03d53364e49bab0542a2a6daa3cb6) — record → `/ask` → spoken Gemini answer

On import each shortcut prompts for your server URL (default `localhost`); your endpoint is not embedded in the shared file.

**Manual Setup**:
1. Record Audio (or Get File from input)
2. Get Contents of URL:
   - URL: http://your-server:8000/transcribe
   - Method: POST  
   - Headers: Content-Type = audio/m4a
   - Request Body: [Audio file from step 1]
3. Get Dictionary from Contents of URL
4. Get Dictionary Value for "text"
5. Copy to Clipboard (copies transcribed text)
6. Show Result (displays the transcribed text)

**Configuration Examples**:
- **Local Network**: `http://192.168.1.100:8000/transcribe`
- **Custom Port**: `http://192.168.1.100:12000/transcribe`
- **Remote Server**: `https://your-domain.com/transcribe`

## Rate Limiting

Currently, the API has the following limits:
- **File Size**: 100MB default (configurable via MAX_FILE_SIZE_MB)
- **Timeout**: 30 seconds default (configurable via UPLOAD_TIMEOUT_SECONDS)
- **Concurrent Requests**: Single in-process model — requests queue if many arrive at once. Place a reverse proxy in front for concurrency control.

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