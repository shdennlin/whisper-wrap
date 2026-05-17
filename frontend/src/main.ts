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
import {
  applyTheme,
  getTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
  type ResolvedTheme,
} from "./theme";
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
import {
  ActionsBar,
  type ActionTemplate,
  type ActionsResponse,
  type Category,
} from "./ui/actions-bar";
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
// Resolve theme before first paint so the page doesn't flash the OS default
// when the user has explicitly chosen the opposite. applyTheme() writes
// `data-theme` on <html> and updates the <meta theme-color> tag.
loadTheme();
applyTheme();

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("missing #app root");
root.replaceChildren();

// ---- Layout shell ----------------------------------------------------------
const header = el("header", "app-header");
const title = el("h1");
title.textContent = t("app.appName");
const indicatorHost = el("div");
// Theme toggle: a two-state button that flips between light and dark. We
// don't expose a "system" option in the UI — it's the implicit default for
// first-time visitors (stored as no key in localStorage), but once the user
// clicks the toggle they get a sticky explicit pick. Same icon+label shape as
// the settings button so the narrow-viewport CSS hides both labels uniformly.
const themeToggle = document.createElement("button");
themeToggle.type = "button";
themeToggle.className = "theme-toggle";
const themeIcon = document.createElement("span");
themeIcon.setAttribute("aria-hidden", "true");
const themeLabel = document.createElement("span");
themeLabel.className = "header-button-label";
themeToggle.append(themeIcon, " ", themeLabel);
function paintThemeButton(resolved: ResolvedTheme): void {
  // Icon shows what the page currently *is*; the aria-label / tooltip
  // describes what clicking does (i.e. the opposite). Mirrors GitHub /
  // Vercel / macOS behaviour where the icon is a status indicator.
  if (resolved === "dark") {
    themeIcon.textContent = "🌙";
    themeLabel.textContent = t("theme.labelDark");
    themeToggle.setAttribute("aria-label", t("theme.toggleAriaToLight"));
    themeToggle.title = t("theme.toggleAriaToLight");
  } else {
    themeIcon.textContent = "☀︎";
    themeLabel.textContent = t("theme.labelLight");
    themeToggle.setAttribute("aria-label", t("theme.toggleAriaToDark"));
    themeToggle.title = t("theme.toggleAriaToDark");
  }
}
paintThemeButton(resolveTheme());
themeToggle.addEventListener("click", () => {
  // From any current state, jump to the explicit opposite of what's painted.
  // This collapses the tri-state model (light/dark/system) into a simple
  // two-state toggle for the user: one click moves you to the other palette
  // and pins the choice.
  const next = resolveTheme(getTheme()) === "dark" ? "light" : "dark";
  saveTheme(next);
  const resolved = applyTheme(next);
  paintThemeButton(resolved);
});
// Settings button: icon + text. The text span is hidden by the narrow-viewport
// CSS so mobile gets a clean icon-only button while desktop still labels it.
const settingsToggle = document.createElement("button");
settingsToggle.type = "button";
settingsToggle.setAttribute("aria-label", t("common.settings"));
const settingsIcon = document.createElement("span");
settingsIcon.textContent = "⚙︎";
settingsIcon.setAttribute("aria-hidden", "true");
const settingsLabel = document.createElement("span");
settingsLabel.className = "header-button-label";
settingsLabel.textContent = t("common.settings");
settingsToggle.append(settingsIcon, " ", settingsLabel);
// AI model badge previously lived here (next to the backend indicator). It now
// sits next to the "AI Enhance" section heading inside ActionsBar — see
// actionsBar.setModel() below.
header.append(title, indicatorHost, themeToggle, settingsToggle);

const main = el("main", "main-pane");

const captureHost = el("section", "capture-host");
const cardsHost = el("div", "mode-cards");
const wsIndicatorHost = el("div", "ws-indicator-host");
wsIndicatorHost.hidden = true;
const uploadRetryHost = el("div", "upload-retry");
uploadRetryHost.hidden = true;
captureHost.append(cardsHost, wsIndicatorHost, uploadRetryHost);

// Explicit classes so the touch-device media query in style.css can reorder
// these sections via `order:` without using :has() / structural selectors.
const transcriptHost = el("section", "transcript-host");
const actionsHost = el("section", "actions-host");

// Answer pane: header (title + copy button) + body.
// Desktop: always visible, showing the localised placeholder until an action
// runs — gives a stable spatial cue for "AI output appears here".
// Touch: hidden until the first action (or recording-start reset), because
// the CSS reorder slots it between transcript and chips where empty space
// would push the chip bar further down.
const answerHost = el("section", "answer-pane");
answerHost.hidden = isTouchDevice();
const answerHeader = el("div", "answer-header");
const answerTitle = el("span", "answer-title");
answerTitle.textContent = t("answer.title");
const answerCopyBtn = button(t("common.copy")) as HTMLButtonElement;
answerCopyBtn.className = "answer-copy";
answerCopyBtn.title = t("answer.copyTitle");
answerCopyBtn.disabled = true; // nothing to copy until the first real answer
answerHeader.append(answerTitle, answerCopyBtn);
const answerBody = el("div", "answer-body");
answerBody.textContent = t("app.answerPlaceholder");
answerHost.append(answerHeader, answerBody);

let currentAnswerText = "";
answerCopyBtn.addEventListener("click", () => {
  if (!currentAnswerText) return;
  void copyToClipboard(currentAnswerText).then((ok) => {
    answerCopyBtn.textContent = ok
      ? t("answer.copied")
      : t("answer.copyFailed");
    setTimeout(() => (answerCopyBtn.textContent = t("common.copy")), 1500);
  });
});

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

const transcript = new TranscriptView(transcriptHost);

const backendIndicator = new BackendIndicator(indicatorHost);

const settingsPanel = new SettingsPanel({
  root: settingsHost,
  enumerateDevices: async () => navigator.mediaDevices.enumerateDevices(),
  onChange: (s) => store.setRetention(s.retention),
});

// HistoryPanel and ActionsBar reference each other: ActionsBar's onAnswer
// calls history.render() to refresh persisted runs, and HistoryPanel uses
// actionsBar.getActionLabel() to localise the action_id chips into the
// session preview. Cyclic — so declare `history` with definite-assignment
// (!) and assign it after actionsBar is constructed.
let history!: HistoryPanel;

const actionsBar = new ActionsBar({
  root: actionsHost,
  fetchActions: async () => {
    const r = await fetch(backendUrl("/actions"));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as {
      actions: ActionTemplate[];
      categories?: Category[];
    };
    return {
      actions: body.actions ?? [],
      categories: body.categories ?? [],
    } satisfies ActionsResponse;
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
  onAnswer: (run, meta) => {
    if (currentSessionId) {
      store.appendActionRun(currentSessionId, run);
    }
    currentAnswerText = run.answer;
    answerBody.textContent = run.answer;
    answerCopyBtn.disabled = !run.answer;
    history.render();
    // Auto-copy only on success — copying a localised "(request failed)" to
    // the clipboard would be hostile.
    if (meta.succeeded && run.answer && settingsPanel.getSettings().autoCopyAnswer) {
      void copyToClipboard(run.answer).then((ok) => {
        if (ok) toast(t("toast.answerAutoCopied"));
      });
    }
  },
  onLoading: ({ running }) => {
    answerHost.classList.toggle("is-loading", running);
    if (running) {
      // First chip click after page load (or after a fresh recording) reveals
      // the answer pane; on touch devices the CSS reorder slots it right
      // under the transcript so the user doesn't have to scroll past the
      // chip bar to see the response.
      answerHost.hidden = false;
      // Clear stale answer so the user sees a clean "processing" state.
      currentAnswerText = "";
      answerBody.textContent = t("answer.processing");
      answerCopyBtn.disabled = true;
      // Gently bring the answer pane into view. `block: "nearest"` is a no-op
      // when the pane is already visible (desktop with chip + answer both on
      // screen) and just enough scroll to reveal it when it's not (mobile —
      // user just tapped a chip at the bottom of the screen, the answer pane
      // is in the middle of the document above the chips).
      answerHost.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  },
  onWarn: (msg) => toast(`⚠ ${msg}`),
  getTranscript: () => transcript.getText(),
});

history = new HistoryPanel({
  root: historyHost,
  store,
  // Persisted action runs are stored by `action_id` (e.g. "passthrough").
  // The history panel renders that ID into a localised label using whatever
  // the actions registry currently calls it. If the registry hasn't loaded
  // yet (first render right after construction), the resolver returns null
  // and the panel falls back to the raw ID; we re-render once .load()
  // resolves so the labels light up.
  resolveActionLabel: (id) => actionsBar.getActionLabel(id),
});

void actionsBar.load().then(() => history.render());

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

// ---- LLM indicator (one-shot fetch of /status to surface the AI model) -----
// Doesn't need to poll — the active Gemini model is set at server startup and
// never changes at runtime. One read per page load is enough.
void fetch(backendUrl("/status"))
  .then((r) => (r.ok ? r.json() : null))
  .then((body) => {
    const gemini = body?.gemini as
      | { configured?: boolean; model?: string }
      | undefined;
    if (!gemini) return;
    // Hand the badge to ActionsBar — it renders next to the "AI Enhance"
    // section heading, which is the contextually right place for "what AI
    // is going to handle these chips".
    actionsBar.setModel({
      configured: !!gemini.configured,
      model: gemini.model,
    });
  })
  .catch(() => {
    // Best-effort: if /status is unreachable here, the BackendIndicator
    // already shows "backend offline" and the missing AI badge is a less
    // urgent signal than the main backend status.
  });

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
  currentAnswerText = "";
  // Reset to the localised placeholder so desktop (where the pane is always
  // visible) shows a helpful default instead of a stale answer or blank box.
  answerBody.textContent = t("app.answerPlaceholder");
  answerCopyBtn.disabled = true;
  // Touch only: re-hide for the same reason as initial state — pane sits
  // between transcript and chips via CSS reorder; empty pane = wasted space.
  answerHost.hidden = isTouchDevice();
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
        toast(t("toast.tooShortNotSaved", { duration: formatBriefDuration(dur) }));
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

/** Same `(hover: none) and (pointer: coarse)` heuristic used inside
 *  ActionsBar — pure-touch devices (phones, keyboardless tablets). On hover-
 *  capable devices this returns false so the answer pane behaves like a
 *  static placeholder. */
function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
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
