/**
 * whisper-wrap PWA application entry.
 *
 * UX: two large ModeCards in the idle state. Tapping a card both picks the
 * capture mode (Batch via MediaRecorder + POST /transcribe; Live via WS
 * /listen) and begins recording in one click. While a recording is active,
 * the cards swap for a RecordingBar with stop button + tenths-of-second
 * timer + (for Live) the connection indicator. A HealthMonitor pings
 * GET /status on load, on visibility-change, every 30 s, and right before
 * each record click; the cards disable themselves whenever the backend
 * isn't reachable so we never record audio with nowhere to send it. Batch
 * uploads that fail surface a retry/download prompt so the blob isn't lost.
 */

import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { MicPipeline } from "./capture/mic-pipeline";
import { ListenSocket, type ListenEvent } from "./capture/listen-socket";
import { BatchRecorder, DEFAULT_MAX_DURATION_MS } from "./capture/batch-recorder";
import {
  loadCaptureMode,
  saveCaptureMode,
  type CaptureMode,
} from "./capture/mode-store";
import { HealthMonitor } from "./health/health-monitor";
import { TranscriptView } from "./ui/transcript-view";
import { ConnectionIndicator } from "./ui/connection-indicator";
import { ActionsBar, type ActionTemplate } from "./ui/actions-bar";
import { SettingsPanel, loadSettings } from "./ui/settings-panel";
import { HistoryPanel } from "./ui/history-panel";
import { ModeCard } from "./ui/mode-card";
import { RecordingBar } from "./ui/recording-bar";
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
const recordingHost = el("div", "recording-active");
recordingHost.hidden = true;
const uploadRetryHost = el("div", "upload-retry");
uploadRetryHost.hidden = true;
captureHost.append(cardsHost, recordingHost, uploadRetryHost);

const settingsHost = el("section");
settingsHost.hidden = true;
const transcriptHost = el("section");
const actionsHost = el("section");
const answerHost = el("section", "answer-pane");
answerHost.textContent = "（按下停止後選一個 AI 動作，回應會出現在這）";
main.append(captureHost, settingsHost, transcriptHost, actionsHost, answerHost);

const aside = el("aside", "aside");
const historyHost = el("section");
aside.append(historyHost);

root.append(header, main, aside);

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
  getTranscript: () => transcript.getFinals().map((f) => f.text).join("\n"),
});
void actionsBar.load();

// ---- Mode cards ------------------------------------------------------------
const batchCard = new ModeCard({
  mode: "batch",
  icon: "●",
  label: "Batch",
  description: "錄完一次轉錄，準確度高",
  onClick: () => startRecording("batch").catch(reportError),
});
const liveCard = new ModeCard({
  mode: "live",
  icon: "◉",
  label: "Live",
  description: "邊講邊出字幕",
  onClick: () => startRecording("live").catch(reportError),
});
cardsHost.append(batchCard.root, liveCard.root);

// ---- Recording bar (replaces cards while recording) ------------------------
const recordingBar = new RecordingBar({
  root: recordingHost,
  onStop: () => stopRecording().catch(reportError),
});

const wsIndicator = new ConnectionIndicator(recordingBar.slot, () => {
  if (currentMode === "live") void startRecording("live").catch(reportError);
});

settingsToggle.addEventListener("click", () => {
  settingsHost.hidden = !settingsHost.hidden;
  settingsHost.classList.toggle("is-open", !settingsHost.hidden);
});

// ---- Health monitor --------------------------------------------------------
const healthMonitor = new HealthMonitor({
  url: backendUrl("/status"),
  onStateChange: (state) => {
    backendIndicator.setState(state);
    const disabled = state !== "ok";
    const title = disabled ? "後端未連線；恢復後可重試" : undefined;
    batchCard.setDisabled(disabled, title);
    liveCard.setDisabled(disabled, title);
  },
});
healthMonitor.start();

// ---- Recording lifecycle ---------------------------------------------------
let mic: MicPipeline | null = null;
let sock: ListenSocket | null = null;
let batch: BatchRecorder | null = null;
let currentSessionId: string | null = null;
let currentMode: CaptureMode = loadCaptureMode();
let recordingStartedAt = 0;
const settings = settingsPanel.getSettings();

async function startRecording(mode: CaptureMode): Promise<void> {
  // Final pre-flight before we open the mic.
  const health = await healthMonitor.checkNow();
  if (health !== "ok") {
    toast("後端離線，無法開始錄音");
    return;
  }

  currentMode = mode;
  saveCaptureMode(mode);
  showRecordingBar(mode);
  hideRetryPrompt();
  transcript.clear();
  answerHost.textContent = "";
  recordingStartedAt = Date.now();

  if (mode === "live") {
    currentSessionId = store.startSession();
    history.render();
    wsIndicator.root.hidden = false;
    wsIndicator.setState("idle");
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/listen`;
    sock = new ListenSocket({ url: wsUrl, onEvent: handleListenEvent });
    sock.start();
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
    wsIndicator.root.hidden = true;
    try {
      batch = new BatchRecorder({
        deviceId: settings.deviceId ?? undefined,
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        onAutoStop: () => toast("已達 10 分鐘上限，自動停止錄音"),
      });
      await batch.start();
    } catch (e) {
      micPermissionModal(e instanceof Error ? e.message : String(e));
      hideRecordingBar();
    }
  }
}

async function stopRecording(): Promise<void> {
  if (currentMode === "live") {
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
      }
      history.render();
    }
    currentSessionId = null;
    hideRecordingBar();
    return;
  }

  if (!batch) {
    hideRecordingBar();
    return;
  }
  recordingBar.showProcessing();
  let recording;
  try {
    recording = await batch.stop();
  } catch (e) {
    toast(`錄音失敗：${e instanceof Error ? e.message : String(e)}`);
    batch = null;
    hideRecordingBar();
    return;
  }
  batch = null;
  if (recording.durationMs < MIN_USABLE_DURATION_MS) {
    toast(`錄音過短（${formatBriefDuration(recording.durationMs)}），未儲存`);
    hideRecordingBar();
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
    store.appendFinal(sessionId, {
      text,
      start_ms: 0,
      end_ms: durationMs,
    });
    store.stopSession(sessionId);
    transcript.appendFinal({
      text,
      start_ms: 0,
      end_ms: durationMs,
    });
    currentSessionId = sessionId;
    history.render();
    hideRecordingBar();
    hideRetryPrompt();
  } catch (e) {
    hideRecordingBar();
    showRetryPrompt({
      blob,
      mimeType,
      durationMs,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
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
    const p = pendingUpload;
    hideRetryPrompt();
    showRecordingBar(currentMode);
    recordingBar.showProcessing();
    await processBatchRecording(p.blob, p.mimeType, p.durationMs);
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

function showRecordingBar(mode: CaptureMode): void {
  cardsHost.hidden = true;
  recordingHost.hidden = false;
  recordingBar.start(mode);
}

function hideRecordingBar(): void {
  recordingBar.reset();
  recordingHost.hidden = true;
  cardsHost.hidden = false;
}

async function uploadForTranscription(
  blob: Blob,
  mimeType: string,
): Promise<string> {
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
      break;
    case "partial":
      if (loadSettings().showPartials) transcript.setPartial(e.text);
      break;
    case "final":
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
