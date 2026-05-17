/**
 * whisper-wrap PWA application entry.
 *
 * Wires the capture pipeline (Live via WS /listen or Batch via MediaRecorder +
 * POST /transcribe), transcript view, mode switcher, actions bar, settings
 * panel, history panel, and service worker registration. Surfaces documented
 * failure modes: mic permission denied, insecure origin (non-HTTPS,
 * non-localhost), WebSocket connect exhausted.
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
import { TranscriptView } from "./ui/transcript-view";
import { ConnectionIndicator } from "./ui/connection-indicator";
import { ActionsBar, type ActionTemplate } from "./ui/actions-bar";
import { SettingsPanel, loadSettings } from "./ui/settings-panel";
import { HistoryPanel } from "./ui/history-panel";
import { ModeSwitcher } from "./ui/mode-switcher";
import { RecordButton } from "./ui/record-button";
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

const controls = el("div", "controls");
const modeHost = el("div");
const recordHost = el("div");
controls.append(modeHost, recordHost);

const settingsHost = el("section");
settingsHost.hidden = true;
const transcriptHost = el("section");
const actionsHost = el("section");
const answerHost = el("section", "answer-pane");
answerHost.textContent = "（按下停止後選一個 AI 動作，回應會出現在這）";
main.append(controls, settingsHost, transcriptHost, actionsHost, answerHost);

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
const indicator = new ConnectionIndicator(indicatorHost, () => {
  if (mode === "live") void startRecording().catch(reportError);
});

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

// ---- Mode + record-button wiring ------------------------------------------
let mode: CaptureMode = loadCaptureMode();
const modeSwitcher = new ModeSwitcher({
  root: modeHost,
  initial: mode,
  onChange: (next) => {
    mode = next;
    saveCaptureMode(next);
    indicator.setState("idle");
  },
});

const recordButton = new RecordButton({
  root: recordHost,
  onClick: () => {
    if (recordButton.getState() === "idle") {
      startRecording().catch(reportError);
    } else if (recordButton.getState() === "recording") {
      stopRecording().catch(reportError);
    }
  },
});

settingsToggle.addEventListener("click", () => {
  settingsHost.hidden = !settingsHost.hidden;
  settingsHost.classList.toggle("is-open", !settingsHost.hidden);
});

// ---- Recording lifecycle ---------------------------------------------------
let mic: MicPipeline | null = null;
let sock: ListenSocket | null = null;
let batch: BatchRecorder | null = null;
let currentSessionId: string | null = null;
let recordingStartedAt = 0;
const settings = settingsPanel.getSettings();

async function startRecording(): Promise<void> {
  recordButton.setState("recording");
  modeSwitcher.setDisabled(true);
  transcript.clear();
  answerHost.textContent = "";
  recordingStartedAt = Date.now();

  if (mode === "live") {
    currentSessionId = store.startSession();
    history.render();
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
    // Batch: record fully on-device, transcribe on stop.
    currentSessionId = null;
    indicator.setState("idle");
    try {
      batch = new BatchRecorder({
        deviceId: settings.deviceId ?? undefined,
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        onAutoStop: () => toast("已達 10 分鐘上限，自動停止錄音"),
      });
      await batch.start();
    } catch (e) {
      micPermissionModal(e instanceof Error ? e.message : String(e));
      resetIdleSync();
    }
  }
}

async function stopRecording(): Promise<void> {
  if (mode === "live") {
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
    resetIdleSync();
    return;
  }

  if (!batch) {
    resetIdleSync();
    return;
  }
  recordButton.setState("processing");
  let recording;
  try {
    recording = await batch.stop();
  } catch (e) {
    toast(`錄音失敗：${e instanceof Error ? e.message : String(e)}`);
    batch = null;
    resetIdleSync();
    return;
  }
  batch = null;
  if (recording.durationMs < MIN_USABLE_DURATION_MS) {
    toast(`錄音過短（${formatBriefDuration(recording.durationMs)}），未儲存`);
    resetIdleSync();
    return;
  }

  try {
    const text = await uploadForTranscription(recording.blob, recording.mimeType);
    const sessionId = store.startSession();
    store.appendFinal(sessionId, {
      text,
      start_ms: 0,
      end_ms: recording.durationMs,
    });
    store.stopSession(sessionId);
    transcript.appendFinal({
      text,
      start_ms: 0,
      end_ms: recording.durationMs,
    });
    currentSessionId = sessionId;
    history.render();
  } catch (e) {
    toast(`轉錄失敗：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    resetIdleSync();
  }
}

function resetIdleSync(): void {
  recordButton.setState("idle");
  modeSwitcher.setDisabled(false);
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
      indicator.setState(e.state);
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

function reportError(e: unknown): void {
  console.error(e);
  toast(`錯誤：${e instanceof Error ? e.message : String(e)}`);
}
