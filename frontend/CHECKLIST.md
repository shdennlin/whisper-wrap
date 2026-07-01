# PWA manual verification checklist

在 umbrella 根目錄（whisper-wrap 的上層）執行 `make dev`（Vite HMR + engine），
開啟 `http://localhost:5173/app/`，確認 App Shell 正確接線。純前端工作也可改用
`cd whisper-wrap/frontend && bun run dev`（Vite 在 :5173，API 代理到 engine 的
:12000）。SW／離線相關項目需改用 production bundle：`make server`（或 `make up`），
engine 會在 API_PORT 12000 直接 serve `/app/`。

## Golden path（localhost, http）

1. 在 Chrome 或 Safari 開啟 `http://localhost:5173/app/`。
2. ✓ App Shell 載入：左側 sidebar 有 Home／Library／Models／Settings 導覽項，
   工具列有 Search（⌘K）與 model pill。
3. ✓ 工具列的後端狀態指示器先顯示「檢查中…」，連上 engine（API_PORT 12000）後
   變成「已連線」。
4. ✓ 點 sidebar 的 Library，空狀態顯示「沒有項目」（首次啟動）。Home 的活動區則
   顯示「還沒有錄音 …」。
5. 回到 Home，點中央的 hero 錄音按鈕（aria-label「開始錄音」）。瀏覽器跳出麥克風
   權限請求，按允許。
6. ✓ 錄音層出現 recbar（閃爍紅點 + 計時器）。開始說一句話（即時字幕需在 Home 開啟
   「即時字幕」開關；錄音中也可在 recbar 切換）。
7. ✓ 「LIVE 草稿」區出現灰色斜體的 partial 行，隨著你說話即時更新。
8. ✓ silero-vad 收斷一句後，partial 變成帶 `mm:ss` 時間戳的黑色 final 行。
9. ✓ 錄音期間，工具列出現「REC mm:ss」pill。
10. 點「⏹ 結束並儲存」。
11. ✓ 錄音層進入處理中 → 「錄音完成」done 視圖；工具列的 REC pill 消失；新項目
    出現在 Library／sidebar 的最近項目（含時長）。
12. ✓ done 視圖（或之後在項目 Detail）有「✨ AI 加工」按鈕；點它開啟分類式的
    AI 動作選擇 modal（含「直接送」等動作）。
13. 在 modal 中選一個動作（例如整理重點）。需先在 Settings → AI 供應商 設定好
    供應商與 API 金鑰。
14. ✓ modal 的「AI 回應」區渲染出 AI 回覆；該次動作會記錄成一筆 ai run，可在
    項目 Detail 的「處理紀錄」看到。

## SRT export（Meeting 模式）

> SRT 匯出在 v3 屬於 Meeting（會議）模式；快速／即時錄音的 Detail 不提供匯出。

1. 在 Home 點「錄會議」capsule，上傳一個會議音檔，等待分析完成。
2. ✓ 結果下方的匯出列出現 `SRT` / `VTT` / `TXT · 對話` / `TXT · 逐字稿` / `JSON`
   按鈕。
3. 點 `SRT`。
4. ✓ 下載一個 `.srt` 檔（檔名 `meeting.srt`），內容為合法 SRT（逗號 `,` 毫秒
   分隔、cue 之間空一行，每段帶講者標籤）。

## Offline shell

1. PWA 載入後，停掉 engine（在跑 `make dev`／`make server` 的終端按 `Ctrl-C`）。
2. 不要重新整理（server 已關會載入失敗）；保持分頁開著，直接嘗試錄音。
3. ✓ 工具列後端指示器轉為「後端離線」；按錄音跳出 toast「後端離線，無法開始錄音」，
   但 App Shell（sidebar 導覽 + 已快取的畫面）仍然可見。
4. ✓ 離線前已載入的 Library 項目（仍在記憶體 cache 中）可開啟到 Detail、複製逐字稿。
   注意（v3 設計使然，非 bug）：歷史改由後端 `/v1/sessions` REST + 記憶體 cache 提供，
   `HistoryStore` 不再寫 localStorage。因此**離線冷啟動或重新整理後，Library 會是空的**
   （沒有持久化的離線歷史）。若要「離線也能看歷史」，需另立 change 補持久化快取
   （indexedDB），不在現行範圍。

## Insecure-origin banner

1. 從同網段的手機開啟 `http://<mac-mini-LAN-IP>:12000/app/`（以 `make server`
   對外提供 production bundle；engine 在 API_PORT 12000）。
2. ✓ 頁面頂端出現黃色 banner，提到 HTTPS／Tailscale（「目前不是 HTTPS 或
   localhost — 麥克風 API 無法使用 …」）。
3. ✓ 按錄音會出現麥克風權限類的錯誤。
4. 要讓手機可用，請依 `docs/HTTPS-TAILSCALE.md`（`tailscale cert …`）設定 HTTPS
   後再從手機開啟。

## Service worker update

1. 先用 `make build-frontend` 建一次 PWA，並以 `make server` 載入（service worker
   只在 production bundle 啟用，Vite dev 沒有）。
2. 編輯 `frontend/src/main.ts`（例如改頁面標題），重新 `make build-frontend`，再
   重新整理分頁。
3. ✓ 出現帶「更新」按鈕的 toast（文字「新版本可用」）。
4. 點「更新」→ 觸發 skipWaiting 並自動重新載入新 bundle。

## Mic-permission denied

1. 按錄音，出現權限請求時選拒絕。
2. ✓ 頁面頂端出現 banner 說明失敗（「麥克風存取失敗：…。請在瀏覽器設定允許麥克風
   後重試。」）；錄音不會開始。
3. 在瀏覽器設定允許麥克風後，不需重新整理即可再次錄音成功。
