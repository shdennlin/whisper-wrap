# HTTPS via Tailscale cert

[English](HTTPS-TAILSCALE.md) | **繁體中文**

PWA 需要 HTTPS 或 `localhost` 才能使用瀏覽器的麥克風 API。Localhost
可以直接使用；若要從手機或區網上其他機器存取 PWA,
你需要為 whisper-wrap 主機準備一張受信任的 HTTPS 憑證。Tailscale
會自動為你 tailnet 中的機器簽發 Let's Encrypt 憑證,這是單台 Mac
部署最簡單的做法。

本文件假設你已經能在 `http://localhost:8000` 跑起 whisper-wrap。

## 一次性的 Tailscale Admin Console 設定

1. 前往 <https://login.tailscale.com/admin/dns>。
2. **MagicDNS** — 確認已啟用。你的機器會擁有像
   `mac-mini.tailXXXXX.ts.net` 這樣的主機名稱(`tailXXXXX` 部分是你的 tailnet 名稱)。
3. 捲動到 **HTTPS Certificates** → 點擊 **Enable**。這會授權
   Tailscale 為你的 tailnet 擔任 Let's Encrypt ACME 代理。

每個 tailnet 只需要做一次。

## 在 Mac mini 上取得憑證

```bash
# Find the machine's tailnet hostname (look for the *.ts.net entry).
tailscale status | head -3

# Replace mac-mini.tailXXXXX.ts.net with your actual hostname.
sudo tailscale cert mac-mini.tailXXXXX.ts.net
```

這會在目前的目錄寫入兩個檔案:

- `mac-mini.tailXXXXX.ts.net.crt` — 由 Let's Encrypt 簽署的憑證
- `mac-mini.tailXXXXX.ts.net.key` — 私鑰

憑證效期為 90 天。續發方式請見下方說明。

## 以 HTTPS 執行 whisper-wrap

```bash
export WHISPER_CERT="$PWD/mac-mini.tailXXXXX.ts.net.crt"
export WHISPER_KEY="$PWD/mac-mini.tailXXXXX.ts.net.key"
make dev-https
```

`make dev-https` 會以 `--reload --ssl-certfile` / `--ssl-keyfile` 指向這些環境變數來執行 uvicorn,適合**開發**時使用。**生產環境**(無 reload)請改用 `make run-https`。兩者共用同一個憑證存在性檢查 — 若任一環境變數未設定或指向不存在的檔案,target 會以明確訊息失敗。

接著你 tailnet 上任何機器 — 包含手機 — 都能開啟:

```
https://mac-mini.tailXXXXX.ts.net:8000/app/
```

憑證會被自動視為受信任的(所有 Tailscale 客戶端都信任 Let's Encrypt
根憑證)。瀏覽器不會顯示警告,而且由於 origin 為 HTTPS,
`navigator.mediaDevices` 也能正常運作。

## 自動續發(launchd,每 60 天)

將下方內容存成 `~/Library/LaunchAgents/com.whisper-wrap.cert-renew.plist`,
並把 hostname 與路徑替換成你的設定:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whisper-wrap.cert-renew</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/tailscale</string>
    <string>cert</string>
    <string>mac-mini.tailXXXXX.ts.net</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR-USERNAME/path/to/whisper-wrap</string>
  <key>StartInterval</key>
  <integer>5184000</integer>  <!-- 60 days in seconds -->
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/whisper-wrap-cert-renew.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/whisper-wrap-cert-renew.err</string>
</dict>
</plist>
```

接著執行:

```bash
launchctl load ~/Library/LaunchAgents/com.whisper-wrap.cert-renew.plist
```

此 agent 會在載入時執行一次,之後每 60 天重新執行一次 `tailscale cert`,
工作目錄為你的 whisper-wrap 資料夾。新簽發的憑證會原地覆寫舊的;
之後重啟 whisper-wrap(launchd 部署用 `make uninstall-launchd && make install-launchd`;手動跑的話 Ctrl-C 後重跑 `make dev-https` / `make run-https`,或等下次重啟時自然套用新憑證)。

## 疑難排解

| 症狀 | 解法 |
| - | - |
| `tailscale cert` 顯示 HTTPS 已停用 | 重新檢查上面的 Admin Console 步驟,並等候約 30 秒讓設定生效。 |
| 瀏覽器在 `https://...ts.net:8000/app/` 出現憑證警告 | 確認存取該 URL 的機器已登入同一個 tailnet。不在 tailnet 中的機器不會把該憑證視為受信任的。 |
| `make dev-https` / `make run-https` 出現 "WHISPER_CERT path does not exist" 錯誤 | 憑證檔案被刪除或改名,**或**`.env` 用引號把路徑包住(Make 的 `include` 會把引號當值的一部分,要拿掉) — 重新執行 `sudo tailscale cert <host>` 並/或移除 `.env` 中路徑外圍的 `"…"`。 |
| 手機連不到 Mac mini 的 tailnet IP | 檢查 `tailscale status` — 手機(Tailscale app)需要開啟並連線。 |
| 憑證過期(90 天後)且續發未執行 | 手動執行 `tailscale cert <host>`,接著用 `launchctl list \| grep whisper-wrap` 確認 agent 已載入。 |

## 回到只用 localhost 的設定

`make dev`(不含 `-https` 後綴)會讓所有東西維持在純 `http://localhost:8000`。
PWA 仍可從 Mac mini 自己的瀏覽器使用;只是在你重新啟用 HTTPS 之前,
無法從手機或其他機器存取。
