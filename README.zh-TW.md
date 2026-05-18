# whisper-wrap

[English](README.md) | **繁體中文**


單一 process 的 FastAPI 伺服器，提供「**in-process 音訊轉寫、即時字幕，以及由 Gemini 支援的 Q&A**」。

v2.1 在同一個 codebase 中內建兩種 Whisper backend，並依據主機 OS 在啟動時自動挑選其一：

- **macOS** — [`pywhispercpp`](https://github.com/absadiki/pywhispercpp)（whisper.cpp 的 binding），並透過 Core ML encoder 在 Apple Neural Engine 上執行。在 macOS 上 CTranslate2 沒有 Metal/Core ML 路徑會 fallback 到 CPU；pywhispercpp + Core ML 路徑透過 ANE 在 Apple Silicon 上可達 5-7× real-time。
- **Linux** — [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper)（CTranslate2）。為未來的 GPU 部署保留 CPU/CUDA 路徑。

兩種 backend 都實作同一個 `WhisperBackend` Protocol；`/transcribe`、`/ask`、以及 `WS /listen` 這些 endpoint 並不會知道目前載入的是哪一個。可用 `BACKEND_FORMAT=ct2` 或 `BACKEND_FORMAT=ggml` 覆寫自動選擇。

> **測試覆蓋範圍**：macOS（Apple Silicon）走 ggml + Core ML 是主要開發環境，會持續驗證。Linux CUDA 路徑與 Docker image **目前都尚未測試過** — code 存在但沒有 end-to-end 驗證過。如果你有實際跑過，歡迎開 issue 回報哪些 work、哪些 broken。

## 🚀 Quick Start

### 前置需求（新機器上一次性安裝）

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

### 開始執行

```bash
# 安裝相依套件 + 下載預設模型 + 建置 PWA（5-15 分鐘）
make setup

# 啟動伺服器（前景執行；按 Ctrl-C 結束）
make dev

# 測試轉寫
curl -X POST http://localhost:8000/transcribe \
     -F "file=@your-audio-file.mp3"
```

開啟 `http://localhost:8000/app/` 進入 PWA，`http://localhost:8000/status` 查看健康狀態。

**想要開機自動啟動 + 崩潰自動恢復？** 請參閱 [docs/DEPLOYMENT.zh-TW.md](docs/DEPLOYMENT.zh-TW.md) — macOS 上執行 `make install-launchd`，Linux 則有 systemd unit 範例。

## ✨ 功能特色

- **雙 in-process backend**（v2.1）：macOS 上使用 pywhispercpp + Core ML/ANE，Linux 上使用 faster-whisper + CTranslate2。沒有 subprocess、也不需要第二個 port。在 Mac mini 上透過 Apple Neural Engine，`WS /listen` 的 partial latency 從 ~3-5 秒降至 <1 秒。
- **統一的 `/transcribe`**：以 Content-Type 分派，在單一 endpoint 內處理 multipart 上傳、原始 `audio/*` body，以及來自 iOS Shortcuts 的 `application/octet-stream`。
- **`/ask` 支援可選的 SSE 串流**：輸入音訊或文字，輸出 Gemini 的回覆。`?stream=true` 會回傳 `text/event-stream`，事件依序為 `transcript` → `token*` → `done`。
- **`/listen` WebSocket**：即時字幕 — 輸入 16 kHz mono `pcm_s16le` 音框，輸出帶 timestamp 的 `partial`/`final` 事件。v2.1 新增 partial-consensus filter（簡化版 LocalAgreement-2），讓 `partial` 文字不再於每次推論間反覆抖動。v2.2 將原本的 RMS-energy VAD 換成 [silero-vad](https://github.com/snakers4/silero-vad)（neural，並保留 RMS fallback），讓 utterance 端點偵測在環境噪音與小聲說話下都更穩定。
- **豐富的 `/status`**：載入的模型細節、runtime device、compute type、Gemini 設定、uptime — 對於一眼分辨 Mac mini 與 GPU 部署非常實用。
- **支援 variants 的模型 registry**（v2.1）：`registry/models.yaml` 提供 `breeze-asr-25`，同時包含 `ct2` 與 `ggml` 兩種 variant（`q6_k` quantisation + 內附的 `.mlmodelc` Core ML encoder），另有 `large-v3-turbo` 作為多語 fallback。`make download-model MODEL=<name>` 會抓取該模型的所有 variant。
- **iOS Shortcuts 開箱即用**：附帶的捷徑可一鍵語音轉寫。

## 🏗️ 架構

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

## 📱 iOS Shortcuts 整合

**現成可用的捷徑**：📱 **[下載 ASR Shortcut](https://www.icloud.com/shortcuts/698627e2c3934b3e996426b64a943742)**

<img src="docs/ios-shortcuts-workflow.jpeg" alt="iOS Shortcuts Workflow" width="400">

此捷徑提供完整的語音轉寫流程：
- 🎙️ **錄音**：點一下即可錄製語音備忘
- 🌐 **自動轉寫**：將音訊送到你的 whisper-wrap 伺服器
- 📝 **顯示結果**：立即顯示轉寫文字
- 📋 **複製到剪貼簿**：自動複製，方便貼到任何地方
- ⚙️ **可設定**：在捷徑設定中輕鬆指定伺服器 URL

**設定步驟**：安裝捷徑 → 設定伺服器 URL → 用語音錄音測試

## 🔧 API Endpoints

### POST /transcribe
支援 multipart 檔案上傳、原始 `audio/*` body、或 `application/octet-stream` — handler 會依 `Content-Type` 分派：

```bash
# Multipart（web/CLI 客戶端）
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@audio.mp3"

# 原始 body（iOS Shortcuts）
curl -X POST "http://localhost:8000/transcribe" \
     -H "Content-Type: audio/mp3" \
     --data-binary "@audio.mp3"
```

**回應**：
```json
{
  "text": "transcribed text content",
  "language": "en", 
  "duration": 123.45,
  "confidence": 0.95
}
```

### OpenAI Whisper 相容介面（v2.3）

為了讓任何 OpenAI-Whisper 相容的 client（open-webui、LibreChat、OpenAI SDK 等）能直接無痛使用，whisper-wrap 提供：

| Method | Path                          | 說明                                                                      |
| ------ | ----------------------------- | ------------------------------------------------------------------------ |
| POST   | `/v1/audio/transcriptions`    | OpenAI 相容的音訊轉寫 endpoint                                              |
| POST   | `/v1/audio/translations`      | OpenAI 相容的音訊翻譯 endpoint（輸出：英文）                                  |
| GET    | `/v1/models`                  | OpenAI 相容的模型目錄（列出目前 whisper-wrap 載入的模型）                     |

`response_format` 接受 `json`（預設）、`text`、`srt`、`verbose_json`、`vtt`。`model` 欄位僅供參考 — whisper-wrap 每個 process 只載入一個模型；任何非空值都會被接受，若不是 OpenAI 別名或目前模型名稱，會輸出一筆 WARNING log。

```bash
# 直接拿 OpenAI SDK 來用的範例（Python）
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="any")
with open("audio.mp3", "rb") as f:
    print(client.audio.transcriptions.create(model="whisper-1", file=f).text)
```

open-webui 的 Docker 設定請參閱 [`docs/INSTALLATION.zh-TW.md`](docs/INSTALLATION.zh-TW.md#openai-compatible-front-ends-open-webui)。

### 內建 PWA：即時字幕 client（v2.4）

whisper-wrap 內附一個用 Vite 建置、可安裝的 Progressive Web App，掛載在 `/app/`。它會擷取瀏覽器麥克風、把 16 kHz PCM 串流送到 `WS /listen`、即時把 partial 轉成 final 字幕渲染出來、把最近 20 個 session 保存在 `localStorage`，並且讓你能透過 `POST /ask` 對 transcript 執行預先定義好的 Action 範本（定義於 `registry/actions.yaml`，透過 `GET /actions` 對外）。

| Method | Path | 說明 |
| ------ | ---- | --- |
| GET    | `/app/`    | PWA 即時字幕 client（用瀏覽器開啟、可加入主畫面安裝） |
| GET    | `/actions` | Action 範本 registry（由 PWA 的 chip bar 使用） |

```bash
make build-frontend     # 一次性：產生 app/static/app/
make dev                # 同時提供 whisper-wrap 與 PWA，網址 http://localhost:8000/app/
```

只要你拿到 Tailscale 的憑證，執行 `make dev-https` 後就可以從手機透過 tailnet 連進來 — 請參閱 [`docs/HTTPS-TAILSCALE.zh-TW.md`](docs/HTTPS-TAILSCALE.zh-TW.md)。

## 🤖 模型管理

whisper-wrap 在 registry 中內附兩個模型。每個模型有一個或多個「**變體**」（對應特定 backend 的封裝）— `make download-model MODEL=<name>` 會抓取該模型宣告的所有變體。

| 模型 | 大小 | 語言 | 說明 |
|-------|------|-----------|-------------|
| **`breeze-asr-25`** ✅ 預設 | 1.5-2.0 GB | zh-TW, en | MediaTek Breeze ASR 25 — 台灣中文 + 英文混合語碼 |
| `large-v3-turbo` | 1.6 GB | 多語 | OpenAI Whisper large-v3-turbo — 多語 fallback |

### 來源（Hugging Face）

| 模型 | 變體 | Backend | 量化 / Compute | 大小 | Hugging Face repo |
|-------|---------|---------|----------------|------|-------------------|
| `breeze-asr-25` | `ct2` | faster-whisper（Linux 預設） | `int8_float16` | ~1.5 GB | [shdennlin/breeze-asr-25-ct2](https://huggingface.co/shdennlin/breeze-asr-25-ct2) |
| `breeze-asr-25` | `ggml` | pywhispercpp + Core ML（macOS 預設） | `q6_k` | ~1.5 GB | [shdennlin/breeze-asr-25-ggml](https://huggingface.co/shdennlin/breeze-asr-25-ggml) |
| `large-v3-turbo` | `ct2` | faster-whisper | `int8_float16` | ~1.6 GB | [Systran/faster-whisper-large-v3-turbo](https://huggingface.co/Systran/faster-whisper-large-v3-turbo) |

**量化 / Compute 說明**：
- `q6_k` — whisper.cpp 6-bit K-quants。檔案約為原始 FP16 的 37%，品質接近無損。ggml 變體同時包含一個 Core ML `.mlmodelc` encoder，用來在 ANE 上加速。
- `int8_float16` — CTranslate2 mixed precision：int8 權重 + float16 啟動值。在 CUDA 上是 CT2 的標準路徑。Apple Silicon CPU 跑 ct2 時會自動 fallback 到 `default`——`COMPUTE_TYPE` 環境變數在那個情境下沒有效果。

**上游來源**：`shdennlin/breeze-asr-25-*` 是基於 MediaTek 原版 Breeze ASR 25 進行量化 + 格式轉換後的版本。`Systran/faster-whisper-large-v3-turbo` 則是 OpenAI [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo) 的 CT2 重新封裝版。

若想加入其他模型（例如 `large-v3`、`medium`、`base`），在 `registry/models.yaml` 內新增一個項目，指向任意 CT2 格式的 Hugging Face repo 即可。請參考該檔案最上方的 schema 註解。建議的 CT2 repo：[`Systran/faster-whisper-large-v3`](https://huggingface.co/Systran/faster-whisper-large-v3)、[`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium)、[`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base)。

```bash
# 列出 registry 內所有項目與安裝狀態
make models

# 下載某個模型的所有變體
make download-model MODEL=breeze-asr-25

# 切換目前使用的模型（若尚未下載會拒絕）
make set-model MODEL=breeze-asr-25

# 從磁碟刪除模型（不會移除 registry 中的項目）
make delete-model MODEL=large-v3-turbo
```

## ⚙️ 設定

建立 `.env` 檔案以做自訂設定（完整清單請見 `.env.example`）：

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

# Transcription post-process filter
# FILTER_EMPTY_ENABLED=true
# FILTER_MIN_DURATION_MS=500
```

### 轉寫後處理 filter

Whisper 偶爾會對噪音輸入回傳空字串或純標點（例如 `。`、`。。。`）。這個後處理 filter「**預設為啟用**」，會在所有轉寫介面上抑制這類結果：

- `WS /listen` — 被丟棄的 utterance 不會送出 `final` JSON frame。
- `POST /transcribe` — 回應 body 變成 `{"text": ""}`。
- `POST /ask` — 回傳 HTTP `400 {"error": "no_speech_detected"}`，且「**不會呼叫 Gemini**」，避免在噪音輸入上浪費 token。串流版本會送出一個 `event: error` frame 然後關閉。
- `POST /v1/audio/transcriptions` 與 `POST /v1/audio/translations` — 保持 OpenAI 的回應 schema：`text: ""`（在 `verbose_json` 模式下另加 `segments: []`）；不會新增自訂欄位。

可用兩個環境變數調整 filter 行為：

- `FILTER_EMPTY_ENABLED`（預設 `true`）— 設為 `false` 可停用，例如在診斷為什麼某個實際的 utterance 被丟掉時。
- `FILTER_MIN_DURATION_MS`（預設 `500`）— `/listen` 上短於此長度的語音會被丟棄。若單一 CJK 字元被過濾掉，可調降到 `300`。

每次丟棄都會以 `INFO` 等級寫一筆結構化的 `transcription_filtered` 記錄（`extra` 欄位包含：`endpoint`、`reason`、`response_format`/`stream`、`raw_text_len`），方便維運人員 grep 伺服器 log 來確認 filter 是否如預期運作。

## 🐳 Docker 部署

> ⚠ **尚未測試**。Dockerfile 跟 `make docker` target 在 repo 裡是有的，但沒有
> 真的 end-to-end 跑過。ARM Mac 在 Docker 內也吃不到 Metal/Neural Engine
> （CT2 會 fallback 到 CPU、ggml 在容器內不會動)。如果你跑成功了，歡迎開 issue。

```bash
# 用 Docker 快速啟動（使用預設模型：breeze-asr-25）
make docker

# 用指定模型 build
docker build --build-arg MODEL_NAME=breeze-asr-25 -t whisper-wrap:latest .
docker run -p 8000:8000 whisper-wrap:latest
```

## 🛠️ 開發

```bash
make help               # 列出所有可用的 target
make setup              # 完整設定（第一次使用）
make dev                # 啟動開發環境
make test               # 執行測試套件
make lint               # 程式碼品質檢查
```

## 📚 文件

- **[安裝指引](docs/INSTALLATION.zh-TW.md)** - 系統需求、相依套件、設定流程
- **[部署指引](docs/DEPLOYMENT.zh-TW.md)** - Mac mini 端到端方案、launchd 開機自動啟動、log 管理
- **[API 文件](docs/API.zh-TW.md)** - 完整 API 參考與範例
- **[透過 Tailscale 使用 HTTPS](docs/HTTPS-TAILSCALE.zh-TW.md)** - 讓手機在具備麥克風權限的情況下連到 PWA
- **[疑難排解](docs/TROUBLESHOOTING.zh-TW.md)** - 常見問題與解法

## 🎯 常見使用情境

- **語音備忘**：用 iOS Shortcuts 立即語音轉文字
- **台灣中文**：用 Breeze ASR 25 處理 zh-TW + 英文混合語碼
- **批次處理**：用命令列處理多個音訊檔
- **API 整合**：把轉寫功能嵌入你的應用程式
- **多語支援**：100+ 種語言、自動偵測

## 📊 效能

- **速度**：~2-4x real-time 轉寫
- **記憶體**：處理過程中 2-4GB RAM
- **格式**：支援所有主流音訊／影片格式
- **語言**：100+ 種語言，分層品質

## 💡 快速範例

**Python 整合**：
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

**批次處理**：
```bash
for file in *.mp3; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@$file" \
       -o "${file%.mp3}.json"
done
```

## 🔍 系統需求

- **RAM**：最低 4GB，建議 8GB 以上
- **Python**：3.8+
- **相依套件**：ffmpeg、libmagic、cmake
- **平台**：macOS、Linux、Windows（WSL2）

## 🆘 需要協助？

- **快速排查**：請看 [疑難排解](docs/TROUBLESHOOTING.zh-TW.md)
- **安裝相關**：請看 [安裝指引](docs/INSTALLATION.zh-TW.md)
- **API 問題**：請參閱 [API 文件](docs/API.zh-TW.md)
- **部署相關**：請依循 [部署指引](docs/DEPLOYMENT.zh-TW.md)

## 🙏 致謝

本專案建立在以下優秀作品之上：
- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** by SYSTRAN — 基於 CTranslate2 的 Whisper runtime，是 v2 in-process backend 的核心
- **[CTranslate2](https://github.com/OpenNMT/CTranslate2)** by OpenNMT — Transformer 模型的高效能推論引擎
- **[OpenAI Whisper](https://github.com/openai/whisper)** — 原始的語音辨識模型與研究
- **[Breeze ASR 25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)** by [MediaTek Research](https://github.com/MediaTek-Research) — 台灣中文 + 英文混合語碼 ASR 模型
- **[Google Gemini](https://ai.google.dev/)** — `/ask` 所使用的 LLM backend

v1 是以 `whisper.cpp` 為核心建構（作為歷史脈絡保留在 `CHANGELOG.md` 中）；v2 改用 faster-whisper / CTranslate2，提供單一 process 的伺服器。

## 📄 授權

本專案以 MIT License 授權 — 詳情請見 [LICENSE](LICENSE) 檔案。
