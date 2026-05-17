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
import { loadLocale, t } from "./i18n";
import { MicPipeline } from "./capture/mic-pipeline";
import { ListenSocket, type ListenEvent } from "./capture/listen-socket";
import { BatchRecorder, DEFAULT_MAX_DURATION_MS } from "./capture/batch-recorder";
import { DualRecorder } from "./capture/dual-recorder";
import { LiveTimeoutManager, type LiveTimeoutReason } from "./capture/live-timeout";
import { AudioStore } from "./storage/audio-store";
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

// Resolve locale before any component reads strings.
loadLocale();

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("missing #app root");
root.replaceChildren();

// ---- Layout shell ----------------------------------------------------------
const header = el("header", "app-header");
const title = el("h1");
title.textContent = t("app.appName");
const indicatorHost = el("div");
const settingsToggle = button(`⚙︎ ${t("common.settings")}`);
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
answerHost.textContent = t("app.answerPlaceholder");
main.append(captureHost, transcriptHost, actionsHost, answerHost);

const aside = el("aside", "aside");
const historyHost = el("section");
aside.append(historyHost);

// Settings live in a modal overlay so they don't displace the recording UI.
const settingsModal = el("div", "modal-backdrop");
settingsModal.hidden = true;
settingsModal.setAttribute("role", "dialog");
settingsModal.setAttribute("aria-modal", "true");
settingsModal.setAttribute("aria-label", t("settings.title"));
const settingsDialog = el("div", "modal-dialog");
const settingsHeader = el("div", "modal-header");
const settingsTitle = el("h2");
settingsTitle.textContent = t("settings.title");
const settingsClose = button("✕");
settingsClose.className = "modal-close";
settingsClose.setAttribute("aria-label", t("settings.closeAria"));
settingsHeader.append(settingsTitle, settingsClose);
const settingsHost = el("section");
settingsDialog.append(settingsHeader, settingsHost);
settingsModal.append(settingsDialog);

root.append(header, main, aside, settingsModal);

// ---- Insecure-origin banner (above header) ---------------------------------
if (!window.isSecureContext && window.location.hostname !== "localhost") {
  const banner = el("div", "banner");
  banner.textContent = t("app.insecureBanner");
  root.insertBefore(banner, header);
}

// ---- State and components --------------------------------------------------
const settings0 = loadSettings();
const store = new HistoryStore();
store.setRetention(settings0.retention);

const audioStore = new AudioStore();
let audioStoreWarned = false; // Toast once per page lifetime if IDB unavailable.

const transcript = new TranscriptView(transcriptHost);

const backendIndicator = new BackendIndicator(indicatorHost);

const settingsPanel = new SettingsPanel({
  root: settingsHost,
  enumerateDevices: async () => navigator.mediaDevices.enumerateDevices(),
  onChange: (s) => store.setRetention(s.retention),
  clearAllAudio: async () => audioStore.clear(),
  onToast: (text) => toast(text),
});

const history = new HistoryPanel({
  root: historyHost,
  store,
  getAudio: (id) => audioStore.get(id),
  reAsrDeps: {
    transcribe: async (blob, opts) => {
      const form = new FormData();
      form.append("file", blob, `re-asr.${mimeToExt(blob.type)}`);
      if (opts.prompt) form.append("prompt", opts.prompt);
      if (opts.language) form.append("language", opts.language);
      const r = await fetch(backendUrl("/transcribe"), { method: "POST", body: form });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { text: string };
      return body.text ?? "";
    },
    appendActionRun: (sessionId, run) => store.appendActionRun(sessionId, run),
  },
  reAsrDefaults: () => ({
    prompt: "",
    language: "",
    languages: RE_ASR_LANGUAGE_OPTIONS,
  }),
});

/**
 * Language options for the re-ASR form. Whisper accepts ISO codes like
 * "en", "zh", "ja"; we list the most-used ones plus "" for auto-detect.
 * The list is small on purpose — the form is for tweaking, not for picking
 * an unfamiliar language.
 */
const RE_ASR_LANGUAGE_OPTIONS = [
  { value: "", label: t("settings.micAuto") },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
];

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
  label: t("modeCard.batchLabel"),
  description: t("modeCard.batchDesc"),
  pauseSupported: true,
  onStart: () => startRecording("batch").catch(reportError),
  onStop: () => stopRecording().catch(reportError),
  onPauseResume: () => togglePause().catch(reportError),
  onDiscard: () => discardRecording().catch(reportError),
});
const liveCard = new ModeCard({
  mode: "live",
  icon: "◉",
  label: t("modeCard.liveLabel"),
  description: t("modeCard.liveDesc"),
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
    const title = disabled ? t("backend.disabledTitle") : undefined;
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
let dual: DualRecorder | null = null; // Parallel compressed-audio recorder (Live only).
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

/**
 * One-shot resolver woken up by the next `final` event during a graceful
 * Live stop. Cleared after firing (or after the timeout expires) so it
 * never carries across recordings.
 */
let pendingStopFinalResolver: (() => void) | null = null;

/** 250 ms silent PCM frame at 16 kHz mono int16, used to coax the server's
 *  VAD into endpointing the in-flight utterance on a graceful Live stop. */
const SILENT_FRAME_BYTES = 4000 * 2;
/** Push 2 s of silence (8 × 250 ms) on stop; long enough to clear any sane
 *  end-of-utterance VAD window. */
const GRACEFUL_STOP_SILENCE_FRAMES = 8;
/** Hard ceiling on how long we wait for the final after pressing stop. */
const GRACEFUL_STOP_TIMEOUT_MS = 3000;
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
    toast(t("toast.backendOffline"));
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
  otherCard().setDisabled(true, t("modeCard.recordingInProgress"));

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
            ? t("toast.autoStopIdle", { minutes: liveSettings.liveIdleMinutes })
            : t("toast.autoStopMax", { minutes: liveSettings.liveMaxMinutes }),
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
      // Attach a parallel MediaRecorder to the same MediaStream so we can
      // persist a compressed copy of the audio for replay / re-ASR. Honours
      // the audio.save Setting — when off, DualRecorder is constructed but
      // skips the actual recording (start() is a no-op, stop() resolves with
      // blob: null) so callers don't have to branch on the toggle.
      const live = settingsPanel.getSettings();
      const stream = mic.getStream();
      if (stream) {
        dual = new DualRecorder(stream, "live", live.audioSave !== false);
        dual.start();
      }
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
        onAutoStop: () => toast(t("toast.tenMinReached")),
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
    if (nextState === "paused") {
      mic.pause();
      dual?.pause();
    } else if (nextState === "recording") {
      mic.resume();
      dual?.resume();
    }
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
    // Tear down the parallel recorder; whatever blob it has built up is
    // dropped because we never write it to AudioStore on the discard path.
    await dual?.stop();
    dual = null;
    if (currentSessionId) {
      store.deleteSession(currentSessionId);
      history.render();
    }
    currentSessionId = null;
    toast(t("toast.discarded"));
    resetIdle();
    return;
  }
  if (batch) {
    await batch.discard();
    batch = null;
  }
  toast(t("toast.discarded"));
  resetIdle();
}

async function stopRecording(): Promise<void> {
  if (currentMode === "live") {
    // Graceful Live stop: keep the WS open, pause the real mic, push a short
    // burst of silence frames so the server's silero-VAD endpoints the
    // pending utterance, and wait briefly for one more `final` event.
    if (sock && mic) {
      activeCard().showProcessing(t("modeCard.confirmingFinal"));
      mic.pause();
      sendSilenceFrames(sock, GRACEFUL_STOP_SILENCE_FRAMES);
      await waitForNextFinalOr(GRACEFUL_STOP_TIMEOUT_MS);
    }

    // After the graceful wait, flush any remaining in-flight partial.
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
    // Stop the parallel recorder concurrently with the mic / sock — the
    // returned blob is what we persist to AudioStore. Capture it BEFORE
    // resetting `dual` so a late-arriving `stop` event still resolves.
    const dualStop = dual ? dual.stop() : Promise.resolve(null);
    await mic?.stop();
    mic = null;
    sock?.stop();
    sock = null;
    if (currentSessionId) {
      store.stopSession(currentSessionId);
      const session = store.list().find((s) => s.id === currentSessionId);
      const dur = Date.now() - recordingStartedAt;
      let sessionDeleted = false;
      if (
        session &&
        session.ended_at !== null &&
        dur < MIN_USABLE_DURATION_MS &&
        session.finals.length === 0
      ) {
        store.deleteSession(currentSessionId);
        sessionDeleted = true;
        toast(t("toast.tooShortNotSaved", { duration: formatBriefDuration(dur) }));
      } else if (session && session.finals.length > 0) {
        await maybeAutoCopy();
      }
      // Best-effort: await the parallel-recorder blob and persist it. Skip
      // when the session was already dropped (no point keeping orphan audio).
      // Persistence failures MUST NOT bubble to the user — recording already
      // succeeded.
      const recording = await dualStop.catch(() => null);
      if (
        !sessionDeleted &&
        recording &&
        recording.blob &&
        recording.blob.size > 0
      ) {
        await persistAudio(currentSessionId, recording.blob, recording.duration_ms);
      }
      history.render();
    }
    dual = null;
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
    toast(t("toast.recordFailed", { error: e instanceof Error ? e.message : String(e) }));
    batch = null;
    resetIdle();
    return;
  }
  batch = null;
  if (recording.durationMs < MIN_USABLE_DURATION_MS) {
    toast(t("toast.tooShortNotSaved", { duration: formatBriefDuration(recording.durationMs) }));
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
    // Persist the captured blob so the user can replay or re-transcribe it
    // later. Honours the audio.save Setting; errors are isolated from the
    // upload-success path.
    if (loadSettings().audioSave !== false) {
      await persistAudio(sessionId, blob, durationMs);
    }
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

/**
 * Best-effort write of `blob` to the AudioStore for `sessionId`, plus a flag
 * on the history record so the player can later distinguish "audio expired"
 * (was saved, then evicted) from "audio missing" (never saved). Eviction
 * toasts the count when at least one record was dropped. IDB unavailable
 * (private browsing, quota exhausted, etc.) is non-fatal: one warning per
 * page lifetime, then proceed without persistence.
 */
async function persistAudio(
  sessionId: string,
  blob: Blob,
  durationMs: number,
): Promise<void> {
  try {
    await audioStore.put(sessionId, blob, durationMs);
    store.markAudioSaved(sessionId);
    const evicted = audioStore.lastEvictionCount();
    if (evicted > 0) {
      toast(t("audio.evicted", { count: evicted }));
    }
  } catch (e) {
    if (!audioStoreWarned) {
      audioStoreWarned = true;
      toast(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function maybeAutoCopy(): Promise<void> {
  if (!loadSettings().autoCopy) return;
  const text = transcript.getText();
  if (!text) return;
  const ok = await copyToClipboard(text);
  if (ok) toast(t("toast.autoCopied"));
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
  message.textContent = t("uploadRetry.message", {
    duration: formatBriefDuration(p.durationMs),
    error: p.errorMessage,
  });
  const retryBtn = button(t("uploadRetry.retry"));
  retryBtn.addEventListener("click", async () => {
    if (!pendingUpload) return;
    const u = pendingUpload;
    hideRetryPrompt();
    activeCard().start();
    activeCard().showProcessing();
    otherCard().setDisabled(true, t("modeCard.processingInProgress"));
    await processBatchRecording(u.blob, u.mimeType, u.durationMs);
  });
  const downloadBtn = button(t("uploadRetry.downloadWebm"));
  downloadBtn.addEventListener("click", () => {
    if (!pendingUpload) return;
    downloadBlob(
      pendingUpload.blob,
      `whisper-wrap-failed-${Date.now()}.${mimeToExt(pendingUpload.mimeType)}`,
    );
  });
  const dismissBtn = button(t("uploadRetry.dismiss"));
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
  const title = healthy ? undefined : t("backend.disabledTitle");
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
      wsIndicatorHost.hidden = e.state === "open" || e.state === "idle";
      break;
    case "partial":
      lastLivePartialText = e.text;
      if (loadSettings().showPartials) transcript.setPartial(e.text);
      break;
    case "final":
      lastLivePartialText = "";
      pendingStopFinalResolver?.();
      pendingStopFinalResolver = null;
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
    toast(t("app.newVersionReady"));
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
  const tNode = el("div", "toast");
  tNode.textContent = message;
  document.body.appendChild(tNode);
  setTimeout(() => tNode.remove(), 4000);
}

function micPermissionModal(detail: string): void {
  const modal = el("div", "banner");
  modal.textContent = t("app.micPermissionDenied", { detail });
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

function sendSilenceFrames(socket: ListenSocket, frameCount: number): void {
  for (let i = 0; i < frameCount; i++) {
    socket.send(new ArrayBuffer(SILENT_FRAME_BYTES));
  }
}

function waitForNextFinalOr(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    pendingStopFinalResolver = settle;
    setTimeout(() => {
      if (pendingStopFinalResolver === settle) pendingStopFinalResolver = null;
      settle();
    }, timeoutMs);
  });
}

function reportError(e: unknown): void {
  console.error(e);
  toast(t("app.errorPrefix", { message: e instanceof Error ? e.message : String(e) }));
}
