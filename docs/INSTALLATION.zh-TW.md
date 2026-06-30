# Installation Guide

[English](INSTALLATION.md) | **繁體中文**


whisper-wrap 完整安裝指南，包含系統需求與相依套件。

> **部署範圍：僅限區網 / localhost。**
> whisper-wrap v2 並未內建任何身份驗證、流量限制或傳輸層加密。
> `GET /status` 會暴露已載入的模型名稱／路徑與執行階段組態，但不包含任何
> 憑證資訊。若要對外公開（public-internet），請在反向代理（Caddy、nginx、
> Cloudflare Tunnel）終結 TLS 並進行請求認證，或將服務置於 VPN / Tailscale
> 邊界之後。當主機具備對外網路介面時，請綁定到 `127.0.0.1`（而非
> `0.0.0.0`）。

## 後端選擇（v2.1）

whisper-wrap v2.1 內建兩種後端，並於啟動時擇一使用：

| 平台         | 預設後端                | 變體 `format`    | 加速方式                                   |
| ------------ | ----------------------- | ---------------- | ------------------------------------------ |
| macOS        | `pywhispercpp`          | `ggml`           | Apple Neural Engine（Core ML）             |
| Linux        | `faster-whisper`        | `ct2`            | 透過 CTranslate2 使用 CPU / CUDA（尚未測試）|

> ⚠ Linux CUDA 路徑**尚未經過 end-to-end 測試**。Code 路徑存在、
> faster-whisper 本身支援透過 CTranslate2 走 CUDA，但維護者目前只
> 在 macOS Apple Silicon 上驗證過。如果你在 CUDA 主機上實際跑過，
> 歡迎開 issue 回報。

可使用 `BACKEND_FORMAT=ct2` 或 `BACKEND_FORMAT=ggml` 進行覆寫：

- `BACKEND_FORMAT=ct2` 於所有平台皆支援。
- `BACKEND_FORMAT=ggml` 僅支援 macOS — `pywhispercpp` 相依套件帶有
  `sys_platform == 'darwin'` 標記，因此 Linux 安裝無法解析 ggml 後端，
  啟動時會明確報錯。

### Core ML 首次執行編譯（macOS, ggml 後端）

當 Core ML 編碼器首次於某台主機載入時，執行階段會將內附的 `.mlmodelc`
編譯為 ANE 最佳化形式，通常需 10-30 秒。lifespan 會阻擋啟動直到編譯完成，
並每秒輸出一筆 INFO log 顯示經過秒數。同一主機後續啟動會重複使用快取的
已編譯編碼器，並在一般 CT2 模型載入時間範圍內進入 ready 狀態。

### silero-vad 模型快取（v2.2）

伺服器首次啟動時會下載一份約 1 MB 的 silero-vad TorchScript 模型到
`~/.cache/torch/hub/snakers4_silero-vad/`。之後的啟動會從快取離線讀取。
對於斷網主機（air-gapped），請先在有網路時執行伺服器一次以預熱快取
（或從其他機器複製整個快取目錄）。

若完全未安裝 `silero-vad`，伺服器會輸出一筆 INFO log
`silero-vad unavailable, falling back to rms`，並繼續使用 v2.1 的
RMS 能量偵測器。設定 `VAD_BACKEND=rms` 可顯式停用且不輸出該 log；
設定 `VAD_BACKEND=silero` 則會在套件缺失時直接 fail fast（適合用於
production-config 稽核）。

### 從原始碼建置具備 Core ML 的 pywhispercpp

macOS 上發佈的 `pywhispercpp` wheels 已內建 Core ML 支援，無需額外處理。
若你需要從原始碼建置（例如使用自訂 Python 建置版本），請設定
`WHISPER_COREML=1` 環境變數，讓底層的 `libwhisper` 啟用 Core ML
編碼器路徑：

```bash
WHISPER_COREML=1 uv sync
```

若沒有設定該旗標，在 macOS 上仍可成功 import 套件，但 ggml 後端會
靜默回退為僅 CPU 的 ggml 解碼，並輸出單一 WARNING log 說明原因。

## 模型目錄結構（v2）

模型放置於 `./models/<entry.local_dir>/`，採用 CTranslate2 目錄結構。
該目錄會在 clone 時透過 `models/.gitkeep` 建立；已下載的檔案則被
gitignore 排除。`make download-model MODEL=<name>` 使用 `hf download`
來填充該目錄。

### v1 內建項目的移除

v1 GGML registry 內建 `large-v3-turbo-q8`、`large-v3`、`medium`、`base`
以及 GGML 版本的 `breeze-asr-25`。v2 僅內建 **`breeze-asr-25`**（預設，
CT2 `int8_float16`，來源
[shdennlin/breeze-asr-25-ct2](https://huggingface.co/shdennlin/breeze-asr-25-ct2)，
另含 ggml 變體
[shdennlin/breeze-asr-25-ggml](https://huggingface.co/shdennlin/breeze-asr-25-ggml)）
與 **`large-v3-turbo`**（來源
[Systran/faster-whisper-large-v3-turbo](https://huggingface.co/Systran/faster-whisper-large-v3-turbo)）。
若你原本依賴已移除的項目，請在本機 `registry/models.yaml` 中加入對應的
CT2 條目。建議的替代項目：

| v1（GGML）            | v2（CT2）repo                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `large-v3-turbo-q8`   | [`Systran/faster-whisper-large-v3-turbo`](https://huggingface.co/Systran/faster-whisper-large-v3-turbo)                   |
| `large-v3`            | [`Systran/faster-whisper-large-v3`](https://huggingface.co/Systran/faster-whisper-large-v3)                               |
| `medium`              | [`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium)                                   |
| `base`                | [`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base)                                       |

## 系統需求

### 硬體需求
- **記憶體**：最低 4GB，建議 8GB 以上（CT2 Whisper 模型常駐記憶體）
- **磁碟空間**：約 2GB 可用空間（Python 相依套件 + 1.5GB Breeze CT2 模型）
- **CPU**：建議多核心以加速轉寫

### 軟體需求
- **Python**：3.10 或更高版本
- **uv**：快速的 Python 套件管理工具（[安裝指南](https://github.com/astral-sh/uv)）
- **ffmpeg**：音訊格式轉換
- **libmagic**：MIME 偵測
- **hf**（或 **huggingface-cli**）：以 Python 相依套件方式安裝，由模型管理器使用
- **Bun 1.1+**（僅 build-time 需要）：`make build-frontend` 編譯
  v2.4 PWA bundle（Vite + TypeScript）時需要。安裝方式：
  `curl -fsSL https://bun.sh/install | bash`。執行階段不需要；bundle
  已預先打包在 `app/static/app/` 並由引擎提供服務。

### 作業系統
- macOS 10.15+（Intel / Apple Silicon）
- Ubuntu 18.04+ / Debian 10+
- RHEL/CentOS 7+ / Fedora 30+
- Arch Linux（current）
- Windows 10+（建議使用 WSL2）

### CPU 架構
- **x86_64（Intel/AMD）**：完整支援，含 AVX/AVX2 最佳化
- **ARM64（Apple Silicon）**：原生支援，含 NEON 最佳化
- **Generic**：其他架構的 fallback 支援

## 自動安裝（建議）

setup 流程會自動檢查並安裝相依套件：

```bash
# 檢查需要哪些套件
make check-system-deps

# 安裝缺少的系統相依套件
make install-system-deps

# 完整 setup
make setup
```

**Setup 耗時**：首次安裝預期需 10-30 分鐘（取決於網路速度）

## 手動安裝

若你偏好手動安裝：

### 1. 系統相依套件

安裝所需的系統套件：

**macOS（Homebrew）**：
```bash
brew install ffmpeg libmagic
```

**Ubuntu/Debian**：
```bash
sudo apt-get update
sudo apt-get install ffmpeg libmagic1 libmagic-dev
```

**RHEL/CentOS**：
```bash
sudo yum install ffmpeg file-devel
```

**Arch Linux**：
```bash
sudo pacman -S ffmpeg file
```

### 2. Python 相依套件

```bash
make install
```

### 3. 下載 ASR 模型

```bash
# 下載預設 registry 條目（Breeze ASR 25, CT2 int8_float16）
make download-default-model

# 或指定特定條目：
make download-model MODEL=large-v3-turbo
```

### 4. 啟動伺服器

```bash
make up         # 先編譯 PWA bundle，再 build + 執行引擎伺服器
make server     # release build + 執行引擎伺服器
make dev        # hot-reload 開發迴圈（Vite HMR + 引擎）
```

## 驗證安裝

測試安裝結果：

```bash
# 檢查系統相依套件
make check-system-deps

# 測試 API
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test-audio.mp3"

# 檢查健康狀態
curl http://localhost:8000/health
```

## OpenAI 相容前端（open-webui）

whisper-wrap 提供 OpenAI Whisper 相容介面：
`POST /v1/audio/transcriptions`、`POST /v1/audio/translations`、
與 `GET /v1/models`。任何 OpenAI-Whisper 相容用戶端（LibreChat、open-webui、
OpenAI 官方 Python / TypeScript SDK，或 OpenAI 文件中的 curl 範例）只要將
base URL 指向 `http://<whisper-wrap-host>:8000/v1`，就能把 whisper-wrap
當作 STT 後端使用 — 不需任何 per-tool adapter 程式碼。

標準範例使用 [open-webui](https://github.com/open-webui/open-webui)：

```bash
# 以 Docker 執行 open-webui，並在 http://localhost:3000 提供服務
docker run -p 3000:8080 ghcr.io/open-webui/open-webui:main
```

接著在 open-webui 中：

1. **Settings → Audio → Speech-to-Text → API Base URL** → 設定為
   `http://<whisper-wrap-host>:8000/v1`
2. **API Key** → 任何非空值皆可（whisper-wrap 接受但忽略
   `Authorization` header — 請參閱下方的安全性說明）
3. **Model** → 任意值皆可；whisper-wrap 每個程序僅載入一個模型，
   因此該欄位僅為參考。保留別名（`whisper-1`、`gpt-4o-transcribe`、
   `gpt-4o-mini-transcribe`）會被靜默接受；其他值會在伺服器端輸出
   一筆 WARNING log，但仍以當前 active 模型提供服務。

> **預設僅限區網。** whisper-wrap 預設綁定到 `API_HOST=127.0.0.1`。
> 若 open-webui 執行於不同機器（或執行在同一台機器的 Docker 容器中
> 並透過 routable IP 連線到主機），請在 `.env` 中設定
> `API_HOST=0.0.0.0`，讓伺服器接受 localhost 以外的連線。OpenAI 相容
> 層級「不」強制 bearer-token 驗證 — 若要在受信任區網之外公開
> whisper-wrap，請務必置於反向代理、VPN 或 Tailscale 邊界之後。

## 內建 PWA 安裝（v2.4 live-captioning 用戶端）

`make setup` 會自動執行 `make build-frontend`。若你只想重新編譯 PWA
bundle 而不重新下載模型，請使用：

```bash
make build-frontend     # 輸出至 app/static/app/
make dev                # 接著開啟 http://localhost:8000/app/
```

PWA 於 localhost 不需 HTTPS 即可運作。若要從手機透過 tailnet 連線，
請參閱 [`HTTPS-TAILSCALE.zh-TW.md`](HTTPS-TAILSCALE.zh-TW.md)。簡要版本：

```bash
# 一次性設定
sudo tailscale cert mac-mini.tailXXXXX.ts.net

# 每個 session
export WHISPER_CERT="$PWD/mac-mini.tailXXXXX.ts.net.crt"
export WHISPER_KEY="$PWD/mac-mini.tailXXXXX.ts.net.key"
make dev-https          # 提供 https://mac-mini.tailXXXXX.ts.net:8000/app/
```

手動驗證步驟詳見 `frontend/CHECKLIST.md`。

## Whisper 模型資訊

**模型**：`ggml-large-v3-turbo-q8_0`（預設）
- **大小**：約 1.5GB 下載
- **品質**：高準確度，針對速度最佳化
- **語言**：支援 100+ 語言，包含：
  - **Tier 1**（優秀）：英文、西班牙文、法文、德文、義大利文、葡萄牙文、荷蘭文、俄文
  - **Tier 2**（非常好）：日文、中文、韓文、阿拉伯文、印地文、土耳其文、波蘭文
  - **Tier 3**（良好）：另外 80+ 語言，品質有所不同

## 效能特性

- **轉寫速度**：約即時 2-4 倍（視硬體而定）
- **記憶體使用**：處理期間約 2-4GB RAM
- **CPU 使用**：多執行緒，依可用核心數擴展
- **語言偵測**：內建自動語言偵測

## 音訊品質建議

- **最佳**：清晰語音、極少背景噪音、16kHz 以上取樣率
- **良好**：Podcast / 通話品質，可接受部分背景噪音
- **普通**：壓縮音訊、吵雜環境（準確度可能浮動）

## 安裝疑難排解

### 常見問題

**系統相依套件缺失**：
- 執行 `make check-system-deps` 查看缺少哪些套件
- 執行 `make install-system-deps` 自動安裝

**找不到 ffmpeg**：
- 安裝 ffmpeg 系統相依套件
- 確認 ffmpeg 已在系統 PATH 中

**libmagic import 錯誤**：
- 安裝 libmagic 系統相依套件
- 以 `python3 -c "import magic"` 驗證

**找不到 cmake**：
- 透過系統套件管理工具安裝 cmake
- 以 `cmake --version` 驗證

**ARM 系統建置失敗**：
- 確認 cmake 為最新版本
- 確認建置工具已正確安裝

### 效能問題

**轉寫速度慢**：
- 檢查可用 RAM（whisper 需要 2-4GB）
- 轉寫期間監控 CPU 使用率
- 確認暫存檔案有足夠磁碟空間
- 測試時可考慮使用較短的音訊檔

**音訊品質問題**：
- 確認音訊清晰且背景噪音極少
- 確認音訊格式在支援清單中
- 嘗試先轉換為 WAV 格式
- 確認檔案未損毀或為空

### 取得協助

若遇到本文件未涵蓋的問題：

1. 參閱 [Troubleshooting Guide](TROUBLESHOOTING.zh-TW.md)
2. 重新檢視系統需求
3. 確認所有相依套件已安裝
4. 先以簡單的音訊檔測試
