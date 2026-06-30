# Troubleshooting Guide

[English](TROUBLESHOOTING.md) | **繁體中文**

whisper-wrap 部署與運作時常見問題與解決方法。

## 快速診斷

從這些基本檢查開始：

```bash
# Check system dependencies
make check-system-deps

# Test API health (status returns the loaded model and uptime)
curl http://localhost:8000/status

# Start the server (single Rust engine process; loads the model on startup)
make dev
```

## 常見問題

### 啟動時模型載入失敗

**症狀**：伺服器在啟動過程中結束；log 中包含
`Failed to load WhisperModel from <path>: ...`。

**原因與修正**：
- CT2 目錄不存在或不完整（缺少 `model.bin` + `tokenizer.json` /
  `vocabulary.json`）。請重新執行 `make download-model MODEL=<name>`。
- `MODEL_DIR` 設定為不存在的路徑。請清除該環境變數以回退到
  `MODEL_NAME`，或修正路徑。
- 在 Apple Silicon CPU 上設定 `COMPUTE_TYPE=int8_float16` 並從 CTranslate2
  收到 `ValueError`。請改用 `COMPUTE_TYPE=default` — 儲存格式
  `int8_float16` 在 Mac CPU 計算路徑上並非 1:1 對應。

**檢查已安裝的內容**：
```bash
make models                    # Registry entries + install status
ls models/<entry.local_dir>/   # Should contain model.bin + tokenizer.json
```

### 系統依賴缺失

**症狀**：`make check-system-deps` 顯示缺少依賴

**解決方法**：
- 執行 `make install-system-deps` 進行自動安裝
- 或手動安裝（見下方）

**手動安裝**：
```bash
# macOS
brew install ffmpeg libmagic

# Ubuntu/Debian
sudo apt-get install ffmpeg libmagic1 libmagic-dev

# RHEL/CentOS
sudo yum install ffmpeg file-devel

# Arch Linux
sudo pacman -S ffmpeg file
```

### 找不到 ffmpeg

**症狀**：音訊轉換失敗，`ffmpeg: command not found`

**解決方法**：
- 安裝 ffmpeg 系統依賴
- 確認 ffmpeg 在系統 PATH 中：`which ffmpeg`
- 若安裝於非標準位置，請將 ffmpeg 加入 PATH

### libmagic 匯入錯誤

**症狀**：`ImportError: failed to find libmagic`

**解決方法**：
- 安裝 libmagic 系統依賴
- 用以下指令檢查：`python3 -c "import magic"`
- macOS：`brew install libmagic`
- Ubuntu：`sudo apt-get install libmagic1 libmagic-dev`

### 效能問題

**症狀**：轉寫速度慢、資源使用率高

**診斷**：
```bash
# Check available RAM
free -h  # Linux
vm_stat | grep "Pages free"  # macOS

# Check CPU usage during transcription
top -p $(pgrep -f whisper-wrap-server)

# Check disk space
df -h
```

**解決方法**：
- 確保有 4GB 以上可用 RAM（whisper 需要 2-4GB）
- 在轉寫過程中監控 CPU 使用率
- 確認暫存檔案有足夠的磁碟空間
- 測試時考慮使用較短的音訊檔
- 使用較快的儲存裝置（建議 SSD）

### 音訊品質問題

**症狀**：轉寫準確度差、文字錯亂

**解決方法**：
- 確保音訊清晰、背景雜音極少
- 檢查支援的格式清單
- 嘗試先轉換為 WAV 格式
- 確認檔案沒有損毀或為空
- 用高品質音訊樣本進行測試

**音訊前處理**：
```bash
# Convert to optimal format
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav

# Check audio properties
ffprobe input.mp3
```

### Docker 建置問題

**症狀**：Docker build 失敗、build 時間過長

**常見原因與解決方法**：
- **Build 時間長**：首次 build 需 10-15 分鐘（屬正常）
- **磁碟空間**：最終 image 需要約 3GB 磁碟空間
- **記憶體**：確保 Docker 有足夠記憶體（建議 4GB 以上）
- **下載時間**：Build 過程包含下載 1.5GB 的 whisper 模型

**Docker 特定診斷**：
```bash
# Check Docker resources
docker system info

# Clean up Docker
docker system prune -f

# Build with verbose output
docker build --no-cache -t whisper-wrap:latest .

# Check running containers
docker ps
```

### 架構特定問題

**ARM／Apple Silicon（M1/M2）**：
- **GPU 限制**：Docker 容器無法存取 GPU 加速
- **效能**：使用 CPU 處理搭配 NEON 最佳化仍有出色表現
- **Build 時間**：由於需要編譯，可能較久

**x86_64（Intel/AMD）**：
- **最佳化**：自動支援 AVX/AVX2
- **效能**：通常為最快的轉寫速度

**確認**：
```bash
# Check architecture
uname -m

# Verify Docker architecture
docker run --rm whisper-wrap:latest uname -m
```

### Port 設定問題

**症狀**：服務無法存取、port 衝突

**解決方法**：
- 檢查 `.env` 中的 port 設定
- 確認 port 沒有被佔用：`lsof -i :8000`
- 確保 port 在有效範圍內（1-65535）
- 檢查防火牆設定

**Port 除錯**：
```bash
# Check what's using port 8000
lsof -i :8000

# Test port connectivity
curl -I http://localhost:8000/health

# Check Makefile port loading
make -n run  # Shows what ports would be used
```

## 錯誤代碼參考

### HTTP 錯誤代碼

- **400 Bad Request**：請求格式錯誤，請檢查請求格式
- **413 Payload Too Large**：檔案超過 `MAX_FILE_SIZE_MB` 限制
- **415 Unsupported Media Type**：不支援的檔案格式
- **422 Unprocessable Entity**：缺少檔案或檔名無效
- **500 Internal Server Error**：伺服器錯誤，請檢查 log

### 服務特定錯誤

**In-process 模型錯誤**：
- 啟動時 `WhisperLoadError` → CT2 目錄缺失或不完整；執行 `make download-model MODEL=<name>`
- 500 `WhisperTranscriptionError` → 推論當機；請檢查伺服器 log 中底層的 CT2 / ffmpeg 錯誤
- 502 LLM 錯誤 → `/ask` 失敗，因為 `GEMINI_API_KEY` 未設定，或 Gemini upstream 無法連線

**ffmpeg 錯誤**：
- Command not found → 安裝 ffmpeg
- Conversion failed → 檢查輸入檔案格式
- Permission denied → 檢查檔案權限

## 除錯工具

### 啟用除錯 log

```bash
# Set debug level in .env
echo "LOG_LEVEL=DEBUG" >> .env

# Restart services
make dev
```

### 檢查 log

```bash
# Watch API logs
make server  # Shows engine logs (model load + per-request lines)
```

### 用簡單檔案測試

```bash
# Test with a simple audio file
curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test.wav"

# Test health endpoint
curl http://localhost:8000/health
```

## 效能監控

### 資源使用率

```bash
# Monitor memory usage
watch -n 1 'free -h'

# Monitor CPU usage
htop

# Monitor disk usage
df -h
watch -n 1 'du -sh /tmp/whisper-wrap'
```

### 效能測試

```bash
# Test transcription speed
time curl -X POST "http://localhost:8000/transcribe" \
     -F "file=@test-1min.mp3"

# Test multiple concurrent requests
for i in {1..5}; do
  curl -X POST "http://localhost:8000/transcribe" \
       -F "file=@test.mp3" &
done
wait
```

## 取得協助

若問題仍未解決：

1. **檢查文件**：閱讀 [安裝](INSTALLATION.zh-TW.md) 與 [API](API.zh-TW.md) 指南
2. **搜尋 issues**：在專案 repository 中尋找類似問題
3. **收集資訊**：包含系統資訊、錯誤訊息與 log
4. **測試最小案例**：先用簡單的音訊檔測試
5. **環境細節**：包含 OS、架構與依賴版本

### 應包含的有用資訊

```bash
# System information
uname -a
python3 --version
ffmpeg -version
cmake --version

# Service status
curl -s http://localhost:8000/health | jq
make check-system-deps

# Resource usage
free -h
df -h
```
