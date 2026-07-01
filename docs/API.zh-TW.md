# API 參考

[English](API.md) | **繁體中文**

whisper-wrap 引擎提供 HTTP/WebSocket/SSE API，涵蓋轉寫、即時字幕、會議工作、
歷史記錄、模型管理，以及 LLM 問答。

**權威、機器可讀的合約**是 OpenAPI 3.1 文件——本頁只是指向它的指標。請勿在此
手動維護端點清單，那會失去同步。該文件由 router 自身產生，因此永遠與執行中的
程式碼一致。

## OpenAPI 合約

- **簽入的產物：** 本目錄下的 [`openapi.json`](openapi.json)——完整的 OpenAPI 3.1
  規格，涵蓋每個路由（路徑、參數、請求／回應形狀、錯誤回應，以及 `engine_token`
  安全機制）。可餵給用戶端產生器、API explorer，或匯入 Postman／Insomnia。
- **互動式 explorer（僅開發建置）：** debug 建置會在 **`GET /docs`** 提供
  [Scalar](https://scalar.com) UI，並在 **`GET /openapi.json`** 提供原始規格。
  這兩個路由在 release 建置（`make server`／`make desktop`）中會被編譯移除，因此
  已發佈的執行檔對兩者都回傳 `404`——請改讀簽入的 `openapi.json`。

  > 在 `make dev` 下，請走**引擎自己的連接埠**（`API_PORT`，dev 迴圈預設為
  > `12000`）——例如 `http://localhost:12000/docs`——而非 Vite 開發伺服器的
  > `:5173`。Vite 在 `/app/` 下提供 PWA，且只代理前端會呼叫的 API 路由；
  > `/docs` 與 `/openapi.json` 不在該白名單內，所以 `:5173/docs` 無法連到引擎。

變更任何路由或 schema 後，重新產生簽入的產物：

```bash
cd engine
cargo run -p whisper-wrap-server --bin whisper-wrap-server -- --dump-openapi ../docs/openapi.json
```

若 `openapi.json` 與 router 失去同步，golden-file 測試會讓 CI 失敗。

## Base URL

```
http://localhost:8000
```

連接埠為 `API_PORT`（預設 `8000`）；主機為 `API_HOST`（預設 `0.0.0.0`）。

## 認證

認證是**選用的**，預設關閉。當引擎以非空的 `ENGINE_TOKEN` 啟動（桌面殼層會為其
sidecar 設定此值）時，除了 `GET /`、`GET /status`、`GET /openapi.json`、
`GET /docs` 與 `/app/*` bundle 之外的每個路由都需要 token，以下列**其一**呈現：

- `Authorization: Bearer <token>` 標頭，**或**
- `engine_token` cookie（`/app` 回應會為 webview 設定此 cookie）。

沒有有效 token 時，這些路由回傳 `401`。當 `ENGINE_TOKEN` 未設定（自架／網頁）時，
此閘門為停用狀態，所有路由皆開放。

## 設定（環境變數）

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `API_PORT` | `8000` | HTTP 監聽連接埠 |
| `API_HOST` | `0.0.0.0` | HTTP 監聽主機 |
| `ENGINE_TOKEN` | _(未設定)_ | 設定後啟用認證閘門 |
| `DATA_DIR` | `data` | 歷史 DB 與儲存的音訊 |
| `MODELS_DIR` | `models` | 下載的模型權重 |
| `MODEL_NAME` | `breeze-asr-25` | 開機時的作用中 ASR 模型 |
| `MAX_FILE_SIZE_MB` | `100` | 上傳大小上限 |

完整清單（LLM 供應商、語者分離路徑、會議工作限制等）請見
`engine/core/src/config.rs`。
