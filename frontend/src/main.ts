/**
 * whisper-wrap PWA application entry.
 *
 * Wires together the capture pipeline, transcript view, actions bar, settings
 * panel, history panel, and service worker registration. Surfaces three
 * documented failure modes:
 *   - mic permission denied → modal
 *   - insecure origin (non-HTTPS, non-localhost) → top-of-page banner
 *   - WebSocket connect exhausted → red indicator + Retry button
 */

import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { MicPipeline } from "./capture/mic-pipeline";
import { ListenSocket, type ListenEvent } from "./capture/listen-socket";
import { TranscriptView } from "./ui/transcript-view";
import { ConnectionIndicator } from "./ui/connection-indicator";
import { ActionsBar, type ActionTemplate } from "./ui/actions-bar";
import { SettingsPanel, loadSettings } from "./ui/settings-panel";
import { HistoryPanel } from "./ui/history-panel";
import { HistoryStore } from "./storage/history-store";

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
const recordBtn = button("⏺ 開始錄音");
const stopBtn = button("⏹ 停止");
stopBtn.disabled = true;
controls.append(recordBtn, stopBtn);

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
  // Manual retry after exhaustion: re-create the socket.
  startRecording().catch(reportError);
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

// ---- Recording lifecycle ---------------------------------------------------
let mic: MicPipeline | null = null;
let sock: ListenSocket | null = null;
let currentSessionId: string | null = null;
const settings = settingsPanel.getSettings();

recordBtn.addEventListener("click", () => startRecording().catch(reportError));
stopBtn.addEventListener("click", () => stopRecording().catch(reportError));
settingsToggle.addEventListener("click", () => {
  settingsHost.hidden = !settingsHost.hidden;
  settingsHost.classList.toggle("is-open", !settingsHost.hidden);
});

async function startRecording(): Promise<void> {
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  transcript.clear();
  answerHost.textContent = "";
  currentSessionId = store.startSession();
  history.render();

  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${window.location.host}/listen`;
  sock = new ListenSocket({
    url: wsUrl,
    onEvent: handleListenEvent,
  });
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
}

async function stopRecording(): Promise<void> {
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  await mic?.stop();
  mic = null;
  sock?.stop();
  sock = null;
  if (currentSessionId) {
    store.stopSession(currentSessionId);
    history.render();
  }
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

function reportError(e: unknown): void {
  console.error(e);
  toast(`錯誤：${e instanceof Error ? e.message : String(e)}`);
}
