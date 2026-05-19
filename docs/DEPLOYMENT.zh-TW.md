# Deployment Guide

[English](DEPLOYMENT.md) | **繁體中文**


在 Mac mini（或任何長時間開機的 Mac）上將 whisper-wrap 作為 24/7 服務運行的完整部署流程。涵蓋全新機器安裝、透過 launchd 開機自動啟動、log 管理與遠端存取。

若是 Linux，請將 launchd 段落換成 systemd unit（文末有範例）。其餘流程跨平台通用。

> **威脅模型**：whisper-wrap 預設**沒有驗證、沒有 TLS、沒有速率限制**。
> 請在可信任的區網內運行，或放在 Tailscale / reverse proxy 之後。詳見
> `docs/INSTALLATION.zh-TW.md` 文末的安全性說明。

---

## 1. 前置需求（一次性，全新 Mac）

```bash
# Homebrew (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# System deps
brew install ffmpeg libmagic

# Python package manager
curl -fsSL https://astral.sh/uv/install.sh | sh

# JS bundler (for the PWA)
curl -fsSL https://bun.sh/install | bash
```

在新的 shell 中驗證：

```bash
which uv ffmpeg bun
python3 -c "import magic"   # libmagic check
```

## 2. Clone + 首次設定

```bash
git clone <your-repo-url> whisper-wrap
cd whisper-wrap
make setup
```

`make setup` 會執行三個步驟：

1. `uv sync` — 安裝 Python 相依套件（whisper 後端、FastAPI 等）
2. 下載預設模型（`breeze-asr-25` ≈ 1.5 GB）
3. `bun run build` — 將 PWA bundle 輸出至 `app/static/app/`

依下載速度約需 5-15 分鐘。若任何步驟失敗，可個別執行以定位問題（`make install`、`make download-default-model`、`make build-frontend`）。

## 3. 最小配置

複製並編輯環境變數範本：

```bash
cp .env.example .env
$EDITOR .env
```

重要的三行：

```env
API_PORT=8000             # change if 8000 is taken
API_HOST=0.0.0.0          # 127.0.0.1 = localhost-only; 0.0.0.0 = LAN-reachable
GEMINI_API_KEY=AIza...    # leave blank if you don't need /ask
```

其他設定都有合理的預設值。

## 4. 前景測試

```bash
make dev
```

macOS 首次啟動需 10-30 秒讓 Core ML 編譯 `.mlmodelc` encoder（每秒會有一筆 INFO log）。之後的啟動會很快。

在瀏覽器開啟 `http://localhost:<API_PORT>/app/`。錄一段短音訊，觀察歷史記錄面板填入內容。

接著 `Ctrl-C` 停止。

## 5. 透過 launchd 開機自動啟動（Mac）

```bash
make install-launchd
```

這會：

1. 將 `scripts/com.whisper-wrap.plist.template` 填入實際的 `WORKDIR`、
   `HOME` 與 `PATH`，輸出到
   `~/Library/LaunchAgents/com.whisper-wrap.plist`。
2. 透過 `launchctl load` 載入。服務會立即啟動，並在每次登入時自動啟動。
3. `KeepAlive` 會在當機後自動重啟,但不會在主動 `launchctl unload` 後重啟。

確認運行中：

```bash
make launchd-status
# Output like:
# 12345  0  com.whisper-wrap

curl http://localhost:8000/status | jq
```

追蹤 log：

```bash
make launchd-logs
# Streams ~/Library/Logs/whisper-wrap/stdout.log + stderr.log
```

停止 / 移除：

```bash
make uninstall-launchd
```

這會卸載 launchd agent 並移除 plist；`~/Library/Logs/whisper-wrap/` 中的 log 檔案會保留。

### 常見的 launchd 陷阱

| 症狀 | 可能原因 | 修正方式 |
| - | - | - |
| 安裝後 `make launchd-status` 沒有輸出 | plist 被拒（XML 錯誤 / 路徑錯誤） | `plutil ~/Library/LaunchAgents/com.whisper-wrap.plist` 驗證 |
| 程序不斷快速重啟 | `make run` / `make run-https` 啟動時當機（模型缺失、cert 路徑錯誤或被引號包住、`.env` 錯誤） | `tail -F ~/Library/Logs/whisper-wrap/stderr.log` |
| 更新的 `.env` 未生效 | launchd 在載入時就快照了環境變數 | `make uninstall-launchd && make install-launchd` |
| 程式碼變更後想重啟 | 重新載入以套用新的內容 | `make uninstall-launchd && make install-launchd` |

## 6. 遠端存取（選用）

### 同一區網

`API_HOST=0.0.0.0` + 透過 `http://<mac-mini-ip>:<API_PORT>/app/` 存取是最簡單的方式。iPhone Shortcut + open-webui 都可以用同樣的 URL。

### 任何地方（Tailscale + HTTPS）

在 `localhost` 之外,PWA 需要 HTTPS 才能使用 service worker 與麥克風。
完整流程請見 `docs/HTTPS-TAILSCALE.zh-TW.md`。簡短版本：

```bash
sudo tailscale cert <hostname>.<tailnet>.ts.net   # one-time per Mac
# 加到 .env（不要引號、不要 export — Make 的 include 會把引號當值的一部分）：
#   WHISPER_CERT=/abs/path/to/<hostname>.<tailnet>.ts.net.crt
#   WHISPER_KEY=/abs/path/to/<hostname>.<tailnet>.ts.net.key
make run-https     # 生產用（開發時用 `make dev-https` 帶 --reload）
```

預設的 plist template（`scripts/com.whisper-wrap.plist.template`）已經呼叫 `make run-https`,因此只要 `.env` 設好 `WHISPER_CERT` / `WHISPER_KEY`,`make install-launchd` 就會自動以 HTTPS 啟動。若想留在純 HTTP,在安裝前把 template 最後的 `<string>` 改為 `exec make run`。

## 7. iPhone Shortcut 整合

auto-session-logger 功能讓**每一次**對 `/transcribe` 與 `/ask` 的呼叫預設都會進入 PWA 歷史記錄。Shortcut 的建立方式請參考主 README 的 *iOS Shortcuts Integration* 段落。URL 直接用
`http://<mac>:<port>`(若有設定 Tailscale HTTPS 則為 `https://<hostname>.<tailnet>.ts.net:<port>`)即可。

若要讓某個 Shortcut 呼叫不被記錄(例如想呼叫 `/transcribe` 但不記錄),在 URL 後加上 `?log=false`。

## 8. 更新流程

```bash
git pull
make install            # re-sync Python deps if pyproject.toml changed
make build-frontend     # rebuild PWA if frontend/ changed
make uninstall-launchd  # bounce the service to pick up the new tree
make install-launchd
```

## 9. Linux 對應方式(systemd,範例)

`/etc/systemd/system/whisper-wrap.service`：

```ini
[Unit]
Description=whisper-wrap transcription service
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/whisper-wrap
Environment=PATH=/home/youruser/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/make run
Restart=on-failure
RestartSec=30
StandardOutput=append:/var/log/whisper-wrap/stdout.log
StandardError=append:/var/log/whisper-wrap/stderr.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/log/whisper-wrap
sudo chown youruser /var/log/whisper-wrap
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-wrap
sudo systemctl status whisper-wrap
journalctl -u whisper-wrap -f
```

## 10. 解除安裝

```bash
# Stop autostart
make uninstall-launchd

# Remove logs (optional)
rm -rf ~/Library/Logs/whisper-wrap

# Remove the project + models (CAREFUL — deletes the SQLite history too)
cd ..
rm -rf whisper-wrap
```
