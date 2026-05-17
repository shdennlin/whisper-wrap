/**
 * Translation dictionaries.
 *
 * English ("en") is the source of truth and the default locale when no user
 * preference is stored. Add new keys here first, then mirror them in every
 * other locale. The TypeScript types in ./index.ts force exhaustiveness.
 *
 * Placeholders use `{name}` and are substituted at lookup time by t().
 */

export const STRINGS = {
  en: {
    "common.copy": "Copy",
    "common.retry": "Retry",
    "common.settings": "Settings",
    "common.close": "Close",
    "common.dismiss": "Dismiss",
    "common.delete": "Delete",

    "theme.toggleAriaToLight": "Switch to light mode",
    "theme.toggleAriaToDark": "Switch to dark mode",
    "theme.labelLight": "Light",
    "theme.labelDark": "Dark",

    "connection.idle": "Not connected",
    "connection.open": "Connected",
    "connection.reconnecting": "Reconnecting…",
    "connection.failed": "Connection failed",
    "connection.retry": "Retry",

    "backend.checking": "Checking…",
    "backend.ok": "Connected",
    "backend.down": "Backend offline",
    "backend.disabledTitle": "Backend offline — retry when restored",

    "llmIndicator.title": "Active AI model: {model}",
    "llmIndicator.notConfigured": "AI: not configured",
    "llmIndicator.notConfiguredTitle":
      "Gemini API key is not set on the server — chip actions will return 502.",

    "modeCard.batchLabel": "Batch",
    "modeCard.batchDesc": "Record then transcribe — higher accuracy",
    "modeCard.liveLabel": "Live",
    "modeCard.liveDesc": "Streaming captions",
    "modeCard.pause": "Pause",
    "modeCard.resume": "Resume",
    "modeCard.discard": "Discard recording",
    "modeCard.discardConfirm": "Confirm?",
    "modeCard.discardConfirmTitle": "Click again to discard (within 3 s)",
    "modeCard.processing": "Processing…",
    "modeCard.confirmingFinal": "Confirming last segment…",
    "modeCard.startAria": "Start {label} recording",
    "modeCard.stopAria": "Click to stop recording ({label})",
    "modeCard.processingAria": "Processing",
    "modeCard.recordingInProgress": "Cannot switch modes while recording",
    "modeCard.processingInProgress": "Cannot switch modes while processing",

    "transcript.title": "Transcript",
    "transcript.copyTitle": "Copy current transcript",
    "transcript.copied": "Copied ✓",
    "transcript.copyFailed": "Copy failed",

    "history.title": "Sessions ({count})",
    "history.empty": "No sessions yet. Press record to start your first.",
    "history.recording": "Recording",
    "history.charsSuffix": " chars",
    "history.expand": "Expand",
    "history.aiResponse": "AI response",
    "history.exportSrt": "Export SRT",
    "history.exportVtt": "Export VTT",
    "history.exportTxt": "Export TXT",

    "actions.requestFailedWithMessage": "(Request failed: {error})",
    "actions.requestFailed": "(Request failed)",
    "actions.passthroughLabel": "Send as-is",
    "actions.miscCategoryLabel": "Misc",
    "actions.sectionHeading": "AI Enhance",
    "actions.showDescriptionsLabel": "Show descriptions",

    "answer.title": "AI response",
    "answer.processing": "Processing…",
    "answer.copyTitle": "Copy AI response",
    "answer.copied": "Copied ✓",
    "answer.copyFailed": "Copy failed",

    "settings.title": "Settings",
    "settings.closeAria": "Close settings",
    "settings.mic": "Microphone",
    "settings.micAuto": "(System default)",
    "settings.backendUrl": "Backend URL",
    "settings.showPartials": "Show partials",
    "settings.autoScroll": "Auto-scroll to bottom",
    "settings.autoCopy": "Auto-copy transcript when recording ends",
    "settings.autoCopyAnswer": "Auto-copy AI response when it arrives",
    "settings.retention": "History retention",
    "settings.language": "Language",
    "settings.liveSection": "Live mode auto-stop",
    "settings.liveIdleLabel": "Stop after N minutes idle (0 = never)",
    "settings.liveIdleHint":
      "Auto-stop after this long with no new caption — handy when you forget to stop after a meeting.",
    "settings.liveMaxLabel": "Maximum recording length (minutes, 0 = never)",
    "settings.liveMaxHint":
      "Hard cap counted from start. Default 4 h.",

    "app.appName": "whisper-wrap",
    "app.answerPlaceholder":
      "(Press stop, then pick an AI action; the response appears here)",
    "app.insecureBanner":
      "Not HTTPS or localhost — the microphone API will not work. See docs/HTTPS-TAILSCALE.md for Tailscale cert setup.",
    "app.micPermissionDenied":
      "Microphone access denied: {detail}. Allow microphone in browser settings and retry.",
    "app.newVersionReady": "New version ready. Refresh the page to apply.",
    "app.errorPrefix": "Error: {message}",

    "toast.backendOffline": "Backend offline, cannot start recording",
    "toast.tooShortNotSaved": "Recording too short ({duration}), not saved",
    "toast.recordFailed": "Recording failed: {error}",
    "toast.transcribeFailed": "Transcription failed: {error}",
    "toast.discarded": "Recording discarded",
    "toast.autoCopied": "Transcript auto-copied to clipboard",
    "toast.answerAutoCopied": "AI response auto-copied to clipboard",
    "toast.autoStopMax":
      "Reached {minutes}-minute limit, auto-stopped recording",
    "toast.autoStopIdle":
      "Idle for {minutes} minutes, auto-stopped recording",
    "toast.tenMinReached":
      "Reached 10-minute limit, auto-stopped recording",

    "uploadRetry.message":
      "Transcription failed ({duration} recording): {error}",
    "uploadRetry.retry": "Retry",
    "uploadRetry.downloadWebm": "Download .webm",
    "uploadRetry.dismiss": "Dismiss",
  },

  "zh-TW": {
    "common.copy": "複製",
    "common.retry": "重試",
    "common.settings": "設定",
    "common.close": "關閉",
    "common.dismiss": "略過",
    "common.delete": "刪除",

    "theme.toggleAriaToLight": "切換到淺色模式",
    "theme.toggleAriaToDark": "切換到深色模式",
    "theme.labelLight": "淺色",
    "theme.labelDark": "深色",

    "connection.idle": "未連線",
    "connection.open": "已連線",
    "connection.reconnecting": "重連中…",
    "connection.failed": "連線失敗",
    "connection.retry": "重試",

    "backend.checking": "檢查中…",
    "backend.ok": "已連線",
    "backend.down": "後端離線",
    "backend.disabledTitle": "後端未連線；恢復後可重試",

    "llmIndicator.title": "目前使用的 AI 模型：{model}",
    "llmIndicator.notConfigured": "AI：未設定",
    "llmIndicator.notConfiguredTitle":
      "伺服器未設定 Gemini API key — 點 chip 會回 502。",

    "modeCard.batchLabel": "Batch",
    "modeCard.batchDesc": "錄完一次轉錄，準確度高",
    "modeCard.liveLabel": "Live",
    "modeCard.liveDesc": "邊講邊出字幕",
    "modeCard.pause": "暫停",
    "modeCard.resume": "繼續",
    "modeCard.discard": "捨棄錄音",
    "modeCard.discardConfirm": "確定?",
    "modeCard.discardConfirmTitle": "再按一次確認捨棄（3 秒內）",
    "modeCard.processing": "處理中…",
    "modeCard.confirmingFinal": "確認最後一段…",
    "modeCard.startAria": "開始 {label} 錄音",
    "modeCard.stopAria": "點此停止錄音（{label}）",
    "modeCard.processingAria": "處理中",
    "modeCard.recordingInProgress": "錄音中無法切換模式",
    "modeCard.processingInProgress": "處理中無法切換模式",

    "transcript.title": "逐字稿",
    "transcript.copyTitle": "複製目前的逐字稿",
    "transcript.copied": "已複製 ✓",
    "transcript.copyFailed": "複製失敗",

    "history.title": "對話記錄（{count}）",
    "history.empty": "尚無記錄。按錄音鍵開始第一段。",
    "history.recording": "錄音中",
    "history.charsSuffix": " 字",
    "history.expand": "展開內容",
    "history.aiResponse": "AI 回應",
    "history.exportSrt": "匯出 SRT",
    "history.exportVtt": "匯出 VTT",
    "history.exportTxt": "匯出 TXT",

    "actions.requestFailedWithMessage": "（請求失敗：{error}）",
    "actions.requestFailed": "（請求失敗）",
    "actions.passthroughLabel": "直接送",
    "actions.miscCategoryLabel": "其他",
    "actions.sectionHeading": "AI 增強",
    "actions.showDescriptionsLabel": "顯示說明",

    "answer.title": "AI 回應",
    "answer.processing": "處理中…",
    "answer.copyTitle": "複製 AI 回應",
    "answer.copied": "已複製 ✓",
    "answer.copyFailed": "複製失敗",

    "settings.title": "設定",
    "settings.closeAria": "關閉設定",
    "settings.mic": "麥克風裝置",
    "settings.micAuto": "（系統預設）",
    "settings.backendUrl": "後端位址",
    "settings.showPartials": "顯示 partial",
    "settings.autoScroll": "自動捲到最底",
    "settings.autoCopy": "錄音結束自動複製逐字稿",
    "settings.autoCopyAnswer": "AI 回應產生時自動複製",
    "settings.retention": "對話記錄保留筆數",
    "settings.language": "語言",
    "settings.liveSection": "Live 模式自動停止",
    "settings.liveIdleLabel": "閒置幾分鐘自動停止（0 = 永不）",
    "settings.liveIdleHint":
      "持續這麼久沒有新字幕就自動停止錄音 — 適合會議結束忘記按停。",
    "settings.liveMaxLabel": "最長錄音上限（分鐘，0 = 永不）",
    "settings.liveMaxHint":
      "保命用 hard cap，從按下開始算到這個分鐘數一定停。預設 4 小時。",

    "app.appName": "whisper-wrap",
    "app.answerPlaceholder": "（按下停止後選一個 AI 動作，回應會出現在這）",
    "app.insecureBanner":
      "目前不是 HTTPS 或 localhost — 麥克風 API 無法使用。請參考 docs/HTTPS-TAILSCALE.md 設定 Tailscale cert。",
    "app.micPermissionDenied":
      "麥克風存取失敗：{detail}。請在瀏覽器設定允許麥克風後重試。",
    "app.newVersionReady": "新版本已就緒，重新整理頁面以套用。",
    "app.errorPrefix": "錯誤：{message}",

    "toast.backendOffline": "後端離線，無法開始錄音",
    "toast.tooShortNotSaved": "錄音過短（{duration}），未儲存",
    "toast.recordFailed": "錄音失敗：{error}",
    "toast.transcribeFailed": "轉錄失敗：{error}",
    "toast.discarded": "已捨棄錄音",
    "toast.autoCopied": "逐字稿已自動複製到剪貼簿",
    "toast.answerAutoCopied": "AI 回應已自動複製到剪貼簿",
    "toast.autoStopMax": "已達 {minutes} 分鐘上限，自動停止錄音",
    "toast.autoStopIdle": "已閒置 {minutes} 分鐘，自動停止錄音",
    "toast.tenMinReached": "已達 10 分鐘上限，自動停止錄音",

    "uploadRetry.message": "轉錄失敗（{duration} 錄音）：{error}",
    "uploadRetry.retry": "重試",
    "uploadRetry.downloadWebm": "下載 .webm",
    "uploadRetry.dismiss": "略過",
  },
} as const;
