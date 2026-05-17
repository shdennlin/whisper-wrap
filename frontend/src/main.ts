/**
 * whisper-wrap PWA application entry.
 *
 * UX: two ModeCards in the idle state. Tapping a card both selects the
 * capture mode (Batch via MediaRecorder + POST /transcribe; Live via WS
 * /listen) and starts recording. While a recording is active the same card
 * morphs in place to show a live timer, a pause/resume control (Batch only),
 * and a discard control; clicking the card body stops & saves. The other
 * card disables itself so the user can't switch modes mid-recording.
 *
 * Cross-cutting:
 *   - HealthMonitor pings GET /status on load, on visibilitychange, every
 *     30 s while idle, and right before each start so we never record audio
 *     with nowhere to upload it.
 *   - Batch uploads that fail surface an in-page retry/download prompt so
 *     the captured blob isn't lost to a transient backend hiccup.
 *   - When the autoCopy setting is on (default), the transcript is copied
 *     to the clipboard the moment finals are committed.
 */

import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { MicPipeline } from "./capture/mic-pipeline";
import { ListenSocket, type ListenEvent } from "./capture/listen-socket";
import { BatchRecorder, DEFAULT_MAX_DURATION_MS } from "./capture/batch-recorder";
import { LiveTimeoutManager, type LiveTimeoutReason } from "./capture/live-timeout";
import {
  loadCaptureMode,
  saveCaptureMode,
  type CaptureMode,
} from "./capture/mode-store";
import { HealthMonitor } from "./health/health-monitor";
import { TranscriptView, copyToClipboard } from "./ui/transcript-view";
import { ConnectionIndicator } from "./ui/connection-indicator";
import { ActionsBar, type ActionTemplate } from "./ui/actions-bar";
import { SettingsPanel, loadSettings } from "./ui/settings-panel";
import { HistoryPanel } from "./ui/history-panel";
import { ModeCard } from "./ui/mode-card";
import { BackendIndicator } from "./ui/backend-indicator";
import {
  HistoryStore,
  MIN_USABLE_DURATION_MS,
} from "./storage/history-store";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("missing #app root");
root.replaceChildren();

// ---- Layout shell ----------------------------------------------------------
const header = el("header", "app-header");
const title = el("h1");
title.textContent = "whisper-wrap";
const indicatorHost = el("div");
const settingsToggle = button("⚙︎ 設定");
header.append(title, indicatorHost, settingsToggle);

const main = el("main", "main-pane");

const captureHost = el("section", "capture-host");
const cardsHost = el("div", "mode-cards");
const wsIndicatorHost = el("div", "ws-indicator-host");
wsIndicatorHost.hidden = true;
const uploadRetryHost = el("div", "upload-retry");
uploadRetryHost.hidden = true;
captureHost.append(cardsHost, wsIndicatorHost, uploadRetryHost);

const transcriptHost = el("section");
const actionsHost = el("section");
const answerHost = el("section", "answer-pane");
answerHost.textContent = "（按下停止後選一個 AI 動作，回應會出現在這）";
main.append(captureHost, transcriptHost, actionsHost, answerHost);

const aside = el("aside", "aside");
const historyHost = el("section");
aside.append(historyHost);

// Settings live in a modal overlay so they don't displace the recording UI.
const settingsModal = el("div", "modal-backdrop");
settingsModal.hidden = true;
settingsModal.setAttribute("role", "dialog");
settingsModal.setAttribute("aria-modal", "true");
settingsModal.setAttribute("aria-label", "設定");
const settingsDialog = el("div", "modal-dialog");
const settingsHeader = el("div", "modal-header");
const settingsTitle = el("h2");
settingsTitle.textContent = "設定";
const settingsClose = button("✕");
settingsClose.className = "modal-close";
settingsClose.setAttribute("aria-label", "關閉設定");
settingsHeader.append(settingsTitle, settingsClose);
const settingsHost = el("section");
settingsDialog.append(settingsHeader, settingsHost);
settingsModal.append(settingsDialog);

root.append(header, main, aside, settingsModal);

// ---- Insecure-origin banner (above header) ---------------------------------
if (!window.isSecureContext && window.location.hostname !== "localhost") {
  const banner = el("div", "banner");
  banner.textContent =
    "目前不是 HTTPS 或 localhost — 麥克風 API 無法使用。請參考 docs/HTTPS-TAILSCALE.md 設定 Tailscale cert。";
  root.insertBefore(banner, header);
}

// ---- State and components --------------------------------------------------
const settings0 = loadSettings();
const store = new HistoryStore();
store.setRetention(settings0.retention);

const transcript = new TranscriptView(transcriptHost);

const backendIndicator = new BackendIndicator(indicatorHost);

const settingsPanel = new SettingsPanel({
  root: settingsHost,
  enumerateDevices: async () => navigator.mediaDevices.enumerateDevices(),
  onChange: (s) => store.setRetention(s.retention),
});

const history = new HistoryPanel({ root: historyHost, store });

const actionsBar = new ActionsBar({
  root: actionsHost,
  fetchActions: async () => {
    const r = await fetch(backendUrl("/actions"));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { actions: ActionTemplate[] };
    return body.actions;
  },
  postAsk: async (prompt) => {
    const r = await fetch(backendUrl("/ask"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { answer: string };
  },
  onAnswer: (run) => {
    if (currentSessionId) {
      store.appendActionRun(currentSessionId, run);
    }
    answerHost.textContent = run.answer;
    history.render();
  },
  onWarn: (msg) => toast(`⚠ ${msg}`),
  getTranscript: () => transcript.getText(),
});
void actionsBar.load();

// ---- Mode cards (morph in place) ------------------------------------------
const batchCard = new ModeCard({
  mode: "batch",
  icon: "●",
  label: "Batch",
  description: "錄完一次轉錄，準確度高",
  pauseSupported: true,
  onStart: () => startRecording("batch").catch(reportError),
  onStop: () => stopRecording().catch(reportError),
  onPauseResume: () => togglePause().catch(reportError),
  onDiscard: () => discardRecording().catch(reportError),
});
const liveCard = new ModeCard({
  mode: "live",
  icon: "◉",
  label: "Live",
  description: "邊講邊出字幕",
  pauseSupported: true,
  onStart: () => startRecording("live").catch(reportError),
  onStop: () => stopRecording().catch(reportError),
  onPauseResume: () => togglePause().catch(reportError),
  onDiscard: () => discardRecording().catch(reportError),
});
cardsHost.append(batchCard.root, liveCard.root);

const wsIndicator = new ConnectionIndicator(wsIndicatorHost, () => {
  if (currentMode === "live") void startRecording("live").catch(reportError);
});

function openSettings(): void {
  settingsModal.hidden = false;
  document.addEventListener("keydown", onSettingsKey);
}
function closeSettings(): void {
  settingsModal.hidden = true;
  document.removeEventListener("keydown", onSettingsKey);
}
function onSettingsKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeSettings();
}
settingsToggle.addEventListener("click", () => openSettings());
settingsClose.addEventListener("click", () => closeSettings());
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

// ---- Health monitor --------------------------------------------------------
const healthMonitor = new HealthMonitor({
  url: backendUrl("/status"),
  onStateChange: (state) => {
    backendIndicator.setState(state);
    const disabled = state !== "ok";
    const title = disabled ? "後端未連線；恢復後可重試" : undefined;
    // Only disable cards that are currently idle — never yank a card out
    // from under an in-progress recording.
    if (batchCard.getState() === "idle") batchCard.setDisabled(disabled, title);
    if (liveCard.getState() === "idle") liveCard.setDisabled(disabled, title);
  },
});
healthMonitor.start();

// ---- Recording lifecycle ---------------------------------------------------
let mic: MicPipeline | null = null;
let sock: ListenSocket | null = null;
let batch: BatchRecorder | null = null;
let liveTimeout: LiveTimeoutManager | null = null;
let currentSessionId: string | null = null;
let currentMode: CaptureMode = loadCaptureMode();
let recordingStartedAt = 0;
/**
 * Latest in-flight partial text for the active Live session, tracked
 * independently of the UI so it survives even when the user has
 * `showPartials` off in Settings (the partial wouldn't be displayed and so
 * `transcript.getPartial()` would return an empty string at stop time).
 * Cleared whenever the server promotes a partial to a final.
 */
let lastLivePartialText = "";
const settings = settingsPanel.getSettings();

function activeCard(): ModeCard {
  return currentMode === "batch" ? batchCard : liveCard;
}

function otherCard(): ModeCard {
  return currentMode === "batch" ? liveCard : batchCard;
}

async function startRecording(mode: CaptureMode): Promise<void> {
  const health = await healthMonitor.checkNow();
  if (health !== "ok") {
    toast("後端離線，無法開始錄音");
    return;
  }

  currentMode = mode;
  saveCaptureMode(mode);
  hideRetryPrompt();
  transcript.clear();
  answerHost.textContent = "";
  recordingStartedAt = Date.now();
  lastLivePartialText = "";

  activeCard().start();
  otherCard().setDisabled(true, "錄音中無法切換模式");

  if (mode === "live") {
    currentSessionId = store.startSession();
    history.render();
    // WS row stays hidden while everything is fine; the connection indicator
    // surfaces itself only on reconnecting / failed states (see handler below).
    wsIndicatorHost.hidden = true;
    wsIndicator.setState("idle");
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/listen`;
    sock = new ListenSocket({ url: wsUrl, onEvent: handleListenEvent });
    sock.start();
    // Idle / hard-cap auto-stop. Reads the latest settings each time so the
    // user can tune the values mid-session.
    const liveSettings = settingsPanel.getSettings();
    liveTimeout = new LiveTimeoutManager({
      idleMinutes: liveSettings.liveIdleMinutes,
      maxMinutes: liveSettings.liveMaxMinutes,
      onTimeout: (reason: LiveTimeoutReason) => {
        toast(
          reason === "idle"
            ? `已閒置 ${liveSettings.liveIdleMinutes} 分鐘，自動停止錄音`
            : `已達 ${liveSettings.liveMaxMinutes} 分鐘上限，自動停止錄音`,
        );
        void stopRecording().catch(reportError);
      },
    });
    liveTimeout.start();
    try {
      mic = new MicPipeline({
        deviceId: settings.deviceId ?? undefined,
        onFrame: (frame) => sock?.send(frame),
      });
      await mic.start();
    } catch (e) {
      micPermissionModal(e instanceof Error ? e.message : String(e));
      await stopRecording();
    }
  } else {
    currentSessionId = null;
    wsIndicatorHost.hidden = true;
    try {
      batch = new BatchRecorder({
        deviceId: settings.deviceId ?? undefined,
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        onAutoStop: () => toast("已達 10 分鐘上限，自動停止錄音"),
      });
      await batch.start();
    } catch (e) {
      micPermissionModal(e instanceof Error ? e.message : String(e));
      resetIdle();
    }
  }
}

async function togglePause(): Promise<void> {
  const nextState = activeCard().togglePause();
  if (currentMode === "batch" && batch) {
    if (nextState === "paused") batch.pause();
    else if (nextState === "recording") batch.resume();
  } else if (currentMode === "live" && mic) {
    if (nextState === "paused") mic.pause();
    else if (nextState === "recording") mic.resume();
    // Pause/resume counts as user activity — push the idle timer forward.
    liveTimeout?.onActivity();
  }
}

async function discardRecording(): Promise<void> {
  if (currentMode === "live") {
    liveTimeout?.stop();
    liveTimeout = null;
    await mic?.stop();
    mic = null;
    sock?.stop();
    sock = null;
    if (currentSessionId) {
      store.deleteSession(currentSessionId);
      history.render();
    }
    currentSessionId = null;
    toast("已捨棄錄音");
    resetIdle();
    return;
  }
  if (batch) {
    await batch.discard();
    batch = null;
  }
  toast("已捨棄錄音");
  resetIdle();
}

async function stopRecording(): Promise<void> {
  if (currentMode === "live") {
    // Capture any partial that's still in flight but hasn't been promoted
    // to a final yet — otherwise pressing stop right after speaking would
    // lose the last utterance. We read from `lastLivePartialText` (not
    // `transcript.getPartial()`) so the flush still works when the user has
    // `showPartials` disabled in Settings. The synthesized timestamp comes
    // from elapsed wall-clock so the row slots in chronologically.
    const partial = lastLivePartialText.trim();
    if (partial && currentSessionId) {
      const ts = Math.max(0, Date.now() - recordingStartedAt);
      store.appendFinal(currentSessionId, {
        text: partial,
        start_ms: ts,
        end_ms: ts,
      });
      transcript.appendFinal({
        text: partial,
        start_ms: ts,
        end_ms: ts,
        kind: "live",
      });
    }

    liveTimeout?.stop();
    liveTimeout = null;
    await mic?.stop();
    mic = null;
    sock?.stop();
    sock = null;
    if (currentSessionId) {
      store.stopSession(currentSessionId);
      const session = store.list().find((s) => s.id === currentSessionId);
      const dur = Date.now() - recordingStartedAt;
      if (
        session &&
        session.ended_at !== null &&
        dur < MIN_USABLE_DURATION_MS &&
        session.finals.length === 0
      ) {
        store.deleteSession(currentSessionId);
        toast(`錄音過短（${formatBriefDuration(dur)}），未儲存`);
      } else if (session && session.finals.length > 0) {
        await maybeAutoCopy();
      }
      history.render();
    }
    currentSessionId = null;
    resetIdle();
    return;
  }

  if (!batch) {
    resetIdle();
    return;
  }
  activeCard().showProcessing();
  let recording;
  try {
    recording = await batch.stop();
  } catch (e) {
    toast(`錄音失敗：${e instanceof Error ? e.message : String(e)}`);
    batch = null;
    resetIdle();
    return;
  }
  batch = null;
  if (recording.durationMs < MIN_USABLE_DURATION_MS) {
    toast(`錄音過短（${formatBriefDuration(recording.durationMs)}），未儲存`);
    resetIdle();
    return;
  }
  await processBatchRecording(recording.blob, recording.mimeType, recording.durationMs);
}

async function processBatchRecording(
  blob: Blob,
  mimeType: string,
  durationMs: number,
): Promise<void> {
  try {
    const text = await uploadForTranscription(blob, mimeType);
    const sessionId = store.startSession();
    store.appendFinal(sessionId, { text, start_ms: 0, end_ms: durationMs });
    store.stopSession(sessionId);
    transcript.appendFinal({
      text,
      start_ms: 0,
      end_ms: durationMs,
      kind: "batch",
    });
    currentSessionId = sessionId;
    history.render();
    await maybeAutoCopy();
    resetIdle();
    hideRetryPrompt();
  } catch (e) {
    resetIdle();
    showRetryPrompt({
      blob,
      mimeType,
      durationMs,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
}

async function maybeAutoCopy(): Promise<void> {
  if (!loadSettings().autoCopy) return;
  const text = transcript.getText();
  if (!text) return;
  const ok = await copyToClipboard(text);
  if (ok) toast("逐字稿已自動複製到剪貼簿");
}

interface PendingUpload {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  errorMessage: string;
}

let pendingUpload: PendingUpload | null = null;

function showRetryPrompt(p: PendingUpload): void {
  pendingUpload = p;
  uploadRetryHost.replaceChildren();

  const message = el("span", "msg");
  message.textContent = `轉錄失敗（${formatBriefDuration(p.durationMs)} 錄音）：${p.errorMessage}`;
  const retryBtn = button("重試");
  retryBtn.addEventListener("click", async () => {
    if (!pendingUpload) return;
    const u = pendingUpload;
    hideRetryPrompt();
    activeCard().start();
    activeCard().showProcessing();
    otherCard().setDisabled(true, "處理中無法切換模式");
    await processBatchRecording(u.blob, u.mimeType, u.durationMs);
  });
  const downloadBtn = button("下載 .webm");
  downloadBtn.addEventListener("click", () => {
    if (!pendingUpload) return;
    downloadBlob(
      pendingUpload.blob,
      `whisper-wrap-failed-${Date.now()}.${mimeToExt(pendingUpload.mimeType)}`,
    );
  });
  const dismissBtn = button("略過");
  dismissBtn.addEventListener("click", () => hideRetryPrompt());

  uploadRetryHost.append(message, retryBtn, downloadBtn, dismissBtn);
  uploadRetryHost.hidden = false;
}

function hideRetryPrompt(): void {
  pendingUpload = null;
  uploadRetryHost.hidden = true;
  uploadRetryHost.replaceChildren();
}

function resetIdle(): void {
  batchCard.reset();
  liveCard.reset();
  // Re-apply current health gating so cards reflect the latest backend state.
  const healthy = healthMonitor.getState() === "ok";
  const title = healthy ? undefined : "後端未連線；恢復後可重試";
  batchCard.setDisabled(!healthy, title);
  liveCard.setDisabled(!healthy, title);
  wsIndicatorHost.hidden = true;
}

async function uploadForTranscription(blob: Blob, mimeType: string): Promise<string> {
  const r = await fetch(backendUrl("/transcribe"), {
    method: "POST",
    headers: { "content-type": mimeType || "application/octet-stream" },
    body: blob,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.json()) as { text: string };
  return body.text ?? "";
}

function handleListenEvent(e: ListenEvent): void {
  switch (e.type) {
    case "state":
      wsIndicator.setState(e.state);
      // Surface the WS row only when there's something to act on; healthy
      // ("open") and pre-flight ("idle") states are noise during a normal
      // Live recording.
      wsIndicatorHost.hidden = e.state === "open" || e.state === "idle";
      break;
    case "partial":
      // Always track the latest partial text in memory, even if the user has
      // partials hidden in Settings; the stop-time flush reads this so the
      // last utterance survives the disconnect.
      lastLivePartialText = e.text;
      if (loadSettings().showPartials) transcript.setPartial(e.text);
      break;
    case "final":
      // The server confirmed the in-flight buffer; the partial slot is
      // consumed, nothing left to flush at stop time.
      lastLivePartialText = "";
      if (currentSessionId) {
        store.appendFinal(currentSessionId, {
          text: e.text,
          start_ms: e.start_ms,
          end_ms: e.end_ms,
        });
      }
      transcript.appendFinal({
        text: e.text,
        start_ms: e.start_ms,
        end_ms: e.end_ms,
      });
      if (loadSettings().autoScroll) {
        transcript.root.scrollTop = transcript.root.scrollHeight;
      }
      history.render();
      // Each confirmed final counts as activity — reset the idle timer.
      liveTimeout?.onActivity();
      break;
    case "error":
      toast(`⚠ ${e.message}`);
      break;
  }
}

// ---- Service worker --------------------------------------------------------
registerSW({
  onNeedRefresh() {
    toast("新版本已就緒，重新整理頁面以套用。");
  },
  onOfflineReady() {
    // No banner — the offline shell case is documented in INSTALLATION.md.
  },
});

// ---- Helpers ---------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  return b;
}

function backendUrl(path: string): string {
  const base = loadSettings().backendUrl || window.location.origin;
  return base.replace(/\/$/, "") + path;
}

function toast(message: string): void {
  const t = el("div", "toast");
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function micPermissionModal(detail: string): void {
  const modal = el("div", "banner");
  modal.textContent = `麥克風存取失敗：${detail}。請在瀏覽器設定允許麥克風後重試。`;
  root!.insertBefore(modal, root!.firstChild);
}

function formatBriefDuration(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const sec = Math.floor(tenths / 10);
  const dec = tenths % 10;
  return `${sec}.${dec}s`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mimeToExt(mime: string): string {
  if (mime.startsWith("audio/webm")) return "webm";
  if (mime.startsWith("audio/mp4")) return "m4a";
  if (mime.startsWith("audio/ogg")) return "ogg";
  return "bin";
}

function reportError(e: unknown): void {
  console.error(e);
  toast(`錯誤：${e instanceof Error ? e.message : String(e)}`);
}
