# API Documentation

[English](API.md) | **繁體中文**

whisper-wrap 轉寫服務的完整 API 參考。

## Base URL

```
http://localhost:8000
```

## Endpoints

### POST /transcribe

統一的轉寫端點。Handler 會依 `Content-Type` 分流：

- `multipart/form-data` — 讀取 `file` 表單欄位（網頁/CLI 客戶端）。
- `audio/*` 或 `application/octet-stream` — 讀取原始 request body
  （iOS Shortcuts、行動 app、嵌入式客戶端）。
- 其他類型 — HTTP 415 Unsupported Media Type。

**Query 參數：**
- `language`（預設 `"auto"`）— 傳遞給模型的語言提示。
- `prompt`（選填）— 初始 prompt 種子；未指定時 wrapper 會套用內建的雙語標點 prompt。

**範例**：

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

**iOS Shortcuts 使用方式：**

1. 從「檔案」app 取得音檔或錄製音訊。
2. 使用「取得 URL 內容」動作：
   - URL：`http://your-server:8000/transcribe`
   - Method：POST
   - Headers：`Content-Type = audio/m4a`（或對應格式）
   - Request Body：選擇「File」並指定音檔。

**Response**：

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

以音檔或文字提問；由 Gemini 產生答案。

- Body：與 `/transcribe` 相同的 `Content-Type` 分流，外加
  `application/json {"text": "..."}` 可跳過轉寫步驟。
- Query：`stream`（`true` 啟用 SSE）、`language`、`prompt`（僅音檔模式）。

**Blocking response**（預設）：

```json
{
  "transcript": "what's the weather today",
  "answer": "Sunny with a high of 28°C..."
}
```

對於 JSON 文字路徑，`transcript` 為 `null`。

**Streaming response**（`?stream=true`）：

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

失敗情況：
- 驗證錯誤（JSON 格式錯誤、缺少 `file`、零位元組 body）→ 在 SSE framing 開始前回傳 HTTP 400。
- 缺少 `GEMINI_API_KEY` → 阻塞式回傳 HTTP 502；串流則發出單一
  `event: error`，前面不會有 transcript 事件。
- LLM 呼叫前的 STT 失敗（串流）→ `event: error`，前面不會有 transcript 事件。
- 串流開始後的 LLM 失敗 → 以 `event: error` 終止。

### WS /listen

透過 WebSocket 進行即時字幕。送入 16 kHz 單聲道 `pcm_s16le` 音訊作為 binary frame
（每個 frame 200 B – 64 KiB；建議每個 frame 約 250 ms）。接收 JSON 文字 frame：

```json
{"type": "partial", "text": "...", "start_ms": 0, "end_ms": 1800}
{"type": "final",   "text": "...", "start_ms": 0, "end_ms": 2400}
```

時間戳為相對於 WebSocket 連線開始的時間（單調不遞減）。一個連線可承載多個語句；
在語句進行中關閉 socket 會丟棄進行中的緩衝區（不會收到 `final` 事件）。

### GET /status

服務健康狀態、已載入模型詳情與 LLM 設定。回傳 `status="ok"` 且
`model.loaded=true`（lifespan 會阻塞啟動直到模型載入完成）。

**Response**：

```json
{
  "status": "ok",
  "version": "2.0.0",
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

API 發現端點 — 列出所有已註冊的 endpoint。

**Response**：

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

所有端點的錯誤回應格式如下：

```json
{
  "detail": "error description"
}
```

### Common Error Codes

- **400**：Bad request（請求格式錯誤）
- **413**：檔案過大（超過 MAX_FILE_SIZE_MB）
- **415**：不支援的檔案格式
- **422**：請求無效（缺少 file、檔名為空）
- **500**：伺服器錯誤（ffmpeg 失敗、in-process 模型錯誤）
- **502**：LLM 上游錯誤（Gemini API 無法連線或缺少憑證）

## Supported Formats

**Audio**：mp3, wav, m4a, flac, ogg, aac, wma
**Video**：mp4, avi, mov, mkv（會抽取音軌）

## Configuration

透過環境變數設定 API：

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

**現成可用的捷徑**：
- 📱 [ASR](https://www.icloud.com/shortcuts/cc6e3b42e9c743ec9d15db4c30d0c205) — 錄音 → `/transcribe` → 複製到剪貼簿
- 📱 [ASR-Ask](https://www.icloud.com/shortcuts/02d03d53364e49bab0542a2a6daa3cb6) — 錄音 → `/ask` → 唸出 Gemini 回答

匯入時會問你 server URL（預設 `localhost`），share 出去的檔案不會嵌入你的真實 endpoint。

**手動設定**：
1. 錄製音訊（或從輸入取得檔案）
2. 取得 URL 內容：
   - URL：http://your-server:8000/transcribe
   - Method：POST
   - Headers：Content-Type = audio/m4a
   - Request Body：[步驟 1 的音檔]
3. 從 URL 內容取得 Dictionary
4. 取得 Dictionary 中 "text" 對應的值
5. 複製到剪貼簿（複製轉寫結果文字）
6. 顯示結果（顯示轉寫文字）

**設定範例**：
- **本機網路**：`http://192.168.1.100:8000/transcribe`
- **自訂 Port**：`http://192.168.1.100:12000/transcribe`
- **遠端伺服器**：`https://your-domain.com/transcribe`

## Rate Limiting

目前 API 有以下限制：
- **檔案大小**：預設 100MB（可透過 MAX_FILE_SIZE_MB 設定）
- **逾時**：預設 30 秒（可透過 UPLOAD_TIMEOUT_SECONDS 設定）
- **併發請求**：單一 in-process 模型 — 同時湧入多個請求會排隊處理。建議在前面放一層 reverse proxy 控制併發。

## Performance Considerations

- **轉寫速度**：約 2-4 倍即時（依硬體而異）
- **記憶體用量**：處理期間約 2-4GB RAM
- **最佳音訊**：16kHz 單聲道 WAV 格式（會自動轉換）
- **語言偵測**：自動進行，已知語言時也可明確指定

## Security

- **輸入驗證**：強制檢查檔案類型與大小上限
- **暫存檔**：自動清理避免磁碟耗盡
- **網路**：建議在 reverse proxy 後執行以提供 SSL/驗證
- **環境**：使用 `.env` 檔案存放敏感設定
