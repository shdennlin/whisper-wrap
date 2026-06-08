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
import { DualRecorder } from "./capture/dual-recorder";
import { LiveTimeoutManager, type LiveTimeoutReason } from "./capture/live-timeout";
import { getAudio as fetchAudioFromApi } from "./storage/history-api-client";
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
import { HistoryView, type ActionChoice } from "./ui/history-view";
import { HistoryResizer } from "./ui/history-resizer";
import { ModeCard } from "./ui/mode-card";
import { BackendIndicator } from "./ui/backend-indicator";
import {
  HistoryStore,
  MIN_USABLE_DURATION_MS,
  sessionDurationMs,
} from "./storage/history-store";
import { navigateToHistory, onRouteChange } from "./routing/hash-route";

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
// SVG icons (rather than emoji) keep the moon/sun/gear glyphs monochrome and
// the same height — emoji 🌙 was rendered by the OS colour-emoji font and
// landed taller than the text-style ⚙︎ gear, so the two header buttons looked
// misaligned and the moon clashed with the muted dark-mode palette.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgIcon(
  ...children: { tag: "path" | "circle"; attrs: Record<string, string> }[]
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const { tag, attrs } of children) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}
const MOON_PATH =
  "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z";
const SUN_RAYS =
  "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41";
const GEAR_PATH =
  "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z";

// History view toggle: navigates to the master-detail History route. Hash-
// based routing keeps the service worker config untouched (no navigateFallback
// allowlist needed) since the SW only sees the path, not the fragment.
const historyToggle = document.createElement("button");
historyToggle.type = "button";
historyToggle.className = "history-toggle";
historyToggle.setAttribute("aria-label", t("history.title", { count: 0 }));
historyToggle.textContent = "☰";
historyToggle.addEventListener("click", () => navigateToHistory());

const themeToggle = document.createElement("button");
themeToggle.type = "button";
themeToggle.className = "theme-toggle";
const themeIcon = document.createElement("span");
themeIcon.className = "header-icon";
themeIcon.setAttribute("aria-hidden", "true");
const themeLabel = document.createElement("span");
themeLabel.className = "header-button-label";
themeToggle.append(themeIcon, themeLabel);
function paintThemeButton(resolved: ResolvedTheme): void {
  // Icon shows what the page currently *is*; the aria-label / tooltip
  // describes what clicking does (i.e. the opposite). Mirrors GitHub /
  // Vercel / macOS behaviour where the icon is a status indicator.
  if (resolved === "dark") {
    themeIcon.replaceChildren(svgIcon({ tag: "path", attrs: { d: MOON_PATH } }));
    themeLabel.textContent = t("theme.labelDark");
    themeToggle.setAttribute("aria-label", t("theme.toggleAriaToLight"));
    themeToggle.title = t("theme.toggleAriaToLight");
  } else {
    themeIcon.replaceChildren(
      svgIcon(
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "4" } },
        { tag: "path", attrs: { d: SUN_RAYS } },
      ),
    );
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
settingsIcon.className = "header-icon";
settingsIcon.setAttribute("aria-hidden", "true");
settingsIcon.replaceChildren(
  svgIcon(
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
    { tag: "path", attrs: { d: GEAR_PATH } },
  ),
);
const settingsLabel = document.createElement("span");
settingsLabel.className = "header-button-label";
settingsLabel.textContent = t("common.settings");
settingsToggle.append(settingsIcon, settingsLabel);
// AI model badge previously lived here (next to the backend indicator). It now
// sits next to the "AI Enhance" section heading inside ActionsBar — see
// actionsBar.setModel() below.
// View tabs: segmented control to switch between recording shell (#) and
// Meeting Mode (#/meeting). Click navigates via the hash; the route handler
// already in this file repaints active state when the hash changes.
const viewTabs = document.createElement("div");
viewTabs.className = "view-tabs";
viewTabs.setAttribute("role", "tablist");
type ViewTab = { name: "shell" | "meeting"; label: string; icon: string };
const VIEW_TABS: ViewTab[] = [
  { name: "shell", label: "Live", icon: "●" },
  { name: "meeting", label: "Meeting", icon: "▦" },
];
const viewTabButtons = new Map<"shell" | "meeting", HTMLButtonElement>();
for (const tab of VIEW_TABS) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "tab");
  btn.dataset.view = tab.name;
  const iconSpan = document.createElement("span");
  iconSpan.className = "view-tab-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.textContent = tab.icon;
  const textSpan = document.createElement("span");
  textSpan.className = "view-tab-text";
  textSpan.textContent = tab.label;
  btn.append(iconSpan, textSpan);
  btn.addEventListener("click", () => {
    window.location.hash = tab.name === "meeting" ? "#/meeting" : "";
  });
  viewTabs.appendChild(btn);
  viewTabButtons.set(tab.name, btn);
}
function paintViewTabs(active: "shell" | "meeting"): void {
  for (const [name, btn] of viewTabButtons.entries()) {
    if (name === active) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  }
}

header.append(
  title,
  viewTabs,
  indicatorHost,
  historyToggle,
  themeToggle,
  settingsToggle,
);

// Recording-shell container groups <main> + <aside> so the route switcher can
// toggle the whole shell with one `hidden` flag without leaking the toggle to
// the header (which stays visible on every route).
const recordingShell = el("div", "recording-shell");
recordingShell.dataset.testid = "recording-shell";

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

// History view host lives INSIDE the recording shell so wide-screen viewports
// (≥1200px) can show it side-by-side with the recording UI (the slim sidebar
// `aside` is hidden by CSS in that breakpoint). On narrower screens the host
// is hidden via `[hidden]` and the slim sidebar takes its place; route-based
// switching at `#/history` then toggles the visibility.
const historyViewHost = el("div", "history-view-host");
historyViewHost.hidden = true;

// Drag-resize handle between main and history columns (desktop one-page
// only; CSS hides it on narrow viewports). Persists width to localStorage
// so the user's preferred split survives reloads.
const historyResizer = new HistoryResizer({ shell: recordingShell });

recordingShell.append(main, aside, historyResizer.element(), historyViewHost);

root.append(header, recordingShell, settingsModal);

// ---- Insecure-origin banner (above header) ---------------------------------
if (!window.isSecureContext && window.location.hostname !== "localhost") {
  const banner = el("div", "banner");
  banner.textContent = t("app.insecureBanner");
  root.insertBefore(banner, header);
}

// ---- State and components --------------------------------------------------
const settings0 = loadSettings();
// History is now backend-backed; pass a backendUrl getter (re-read every
// call so Settings URL changes apply immediately) plus an error hook so
// failed background writes surface as a toast instead of disappearing.
const store = new HistoryStore({
  backendUrl: () => loadSettings().backendUrl || window.location.origin,
  onError: (e, ctx) => {
    const msg = e instanceof Error ? e.message : String(e);
    toast(`⚠ history ${ctx.op} failed: ${msg}`);
  },
});
store.setRetention(settings0.retention);

const transcript = new TranscriptView(transcriptHost);

const backendIndicator = new BackendIndicator(indicatorHost);

const settingsPanel = new SettingsPanel({
  root: settingsHost,
  enumerateDevices: async () => navigator.mediaDevices.enumerateDevices(),
  onChange: (s) => store.setRetention(s.retention),
  clearAllAudio: () => store.bulkClearAudio(),
  onToast: (text) => toast(text),
});

// HistoryPanel and ActionsBar reference each other: ActionsBar's onAnswer
// calls refreshHistory() to refresh persisted runs, and HistoryPanel uses
// actionsBar.getActionLabel() to localise the action_id chips into the
// session preview. Cyclic — so declare `history` with definite-assignment
// (!) and assign it after actionsBar is constructed. The HistoryPanel also
// consumes audioStore + a re-ASR transcribe callback (added by the audio
// replay change) — those are passed in at construction further below.
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
    // log=false: action_runs land via /v1/sessions/{id}/runs on the
    // PWA-owned session. Without this, every chip click would also create
    // a separate one-shot auto-session, double-logging the answer.
    const r = await fetch(backendUrl("/ask?log=false"), {
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
    refreshHistory();
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

// Slim sidebar — most-recent N glance only. Clicking a row navigates to the
// full master-detail HistoryView at `#/history/<id>`.
history = new HistoryPanel({
  root: historyHost,
  store,
  maxItems: 5,
});

// Prime the history cache from the backend BEFORE the panel renders its
// first frame so persisted sessions appear instantly instead of after a
// blink. ActionsBar load is independent; both can run concurrently.
void Promise.all([store.prime(), actionsBar.load()]).then(() => {
  refreshHistory();
  // If the user landed directly on #/history the route handler already fired
  // synchronously below — re-render so the freshly primed cache is visible.
  if (window.location.hash.startsWith("#/history")) {
    historyView.show(parseSessionIdFromHash());
  }
});

// ---- History master-detail view + hash routing ----------------------------
const historyView = new HistoryView({
  root: historyViewHost,
  store,
  resolveActionLabel: (id) => actionsBar.getActionLabel(id),
  getAudio: async (id) => {
    const got = await fetchAudioFromApi(
      loadSettings().backendUrl || window.location.origin,
      id,
    );
    if (!got) return null;
    // duration_ms drives the waveform player's time axis and the drag-to-scrub
    // math (`currentTime = (x/w) * duration_ms/1000`). Pull it from the cached
    // session — after `prime()` and stopSession's PATCH, the value is either
    // `ended_at - started_at` (preferred) or the finals-based fallback.
    const session = store.list().find((s) => s.id === id);
    const duration_ms = session ? sessionDurationMs(session) : 0;
    return {
      session_id: id,
      mime_type: got.mime_type,
      blob: got.blob,
      duration_ms,
      byte_size: got.blob.size,
      stored_at: Date.now(),
    };
  },
  listActions: () => actionsBarChoices(),
  runActionAgain: async (_sessionId, _actionId, prompt) => {
    // Re-run on a past session: hit /ask with the templated text only — no
    // audio body, no STT round-trip. The answer is then persisted as a new
    // ActionRun on the existing PWA-owned session by HistoryView itself, so
    // log=false avoids creating a second auto-logged sibling session.
    const r = await fetch(backendUrl("/ask?log=false"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { answer: string };
    return body.answer ?? "";
  },
  // Re-ASR: POST the stored blob back to /transcribe with an optional
  // user-tuned prompt + language hint, then persist the result as an
  // ActionRun with action_id="re_asr" so it lands in the runs stack.
  reAsrDeps: {
    transcribe: async (blob, opts) => {
      const form = new FormData();
      form.append("file", blob, `re-asr.${mimeToExt(blob.type)}`);
      if (opts.prompt) form.append("prompt", opts.prompt);
      if (opts.language) form.append("language", opts.language);
      // log=false: the answer becomes an ActionRun on the existing PWA
      // session, not a brand-new auto-logged sibling.
      const r = await fetch(backendUrl("/transcribe?log=false"), {
        method: "POST",
        body: form,
      });
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
 * Kept short on purpose — the form is for tweaking, not for picking an
 * unfamiliar language.
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

function actionsBarChoices(): ActionChoice[] {
  // ActionsBar owns the localised label resolution + the loaded template
  // list; map it onto the smaller HistoryView shape.
  const tpls = actionsBar.getTemplates();
  return tpls.map((tpl) => ({
    id: tpl.id,
    label: actionsBar.getActionLabel(tpl.id) ?? tpl.id,
    template: tpl.template,
  }));
}

function parseSessionIdFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#/history/")) return null;
  const rest = hash.slice("#/history/".length);
  return rest && !rest.includes("/") ? rest : null;
}

// Single entry point for "store mutated, both history surfaces need to
// reflect it". HistoryPanel is the slim sidebar (hidden on desktop ≥1200px
// via CSS); HistoryView is the master-detail panel (always visible on
// desktop one-page mode). Before this helper existed, callers only refreshed
// the sidebar, so a fresh batch transcript wouldn't appear in the desktop
// HistoryView until the user clicked a route or resized the window.
function refreshHistory(): void {
  history.render();
  historyView.refresh();
}

// Desktop ≥1200px = "one-page mode": recording UI and HistoryView are always
// both visible (slim sidebar hidden by CSS). The route still selects which
// session is highlighted, but no longer hides the recording shell.
const desktopOnePage = window.matchMedia("(min-width: 1200px)");
let currentRoute: { name: "shell" } | { name: "history"; sessionId: string | null } =
  { name: "shell" };

function applyLayoutForRoute(): void {
  const isDesktop = desktopOnePage.matches;
  if (isDesktop) {
    // Desktop: ignore route — both panes always visible.
    recordingShell.classList.remove("is-history-route");
    recordingShell.hidden = false;
    historyViewHost.hidden = false;
    historyView.show(
      currentRoute.name === "history" ? currentRoute.sessionId : null,
    );
  } else if (currentRoute.name === "history") {
    // Mobile/tablet at #/history: hide main+aside via class (NOT the whole
    // shell — historyViewHost lives inside the shell now and would vanish
    // together with it).
    recordingShell.classList.add("is-history-route");
    recordingShell.hidden = false;
    historyViewHost.hidden = false;
    historyView.show(currentRoute.sessionId);
  } else {
    recordingShell.classList.remove("is-history-route");
    historyView.hide();
    historyViewHost.hidden = true;
    recordingShell.hidden = false;
  }
}

// Meeting Mode lives at #/meeting. The page module is loaded on the first
// navigation so users who never visit don't pay the parse cost.
let meetingHost: HTMLElement | null = null;
let meetingPageMounted = false;
function ensureMeetingHost(): HTMLElement {
  if (meetingHost) return meetingHost;
  meetingHost = document.createElement("div");
  meetingHost.id = "meeting-view-host";
  meetingHost.hidden = true;
  // Append inside #app (not body) so the host participates in the
  // flex/min-height column. Appending to body would put it BELOW the
  // 100vh #app shell and require the user to scroll past a blank screen.
  root!.appendChild(meetingHost);
  return meetingHost;
}

async function activateMeetingRoute(): Promise<void> {
  const host = ensureMeetingHost();
  if (!meetingPageMounted) {
    const { createMeetingPage } = await import("./meeting/meeting-page");
    host.appendChild(createMeetingPage().element);
    meetingPageMounted = true;
  }
  host.hidden = false;
  recordingShell.hidden = true;
}

function deactivateMeetingRoute(): void {
  if (meetingHost) meetingHost.hidden = true;
}

onRouteChange((route) => {
  if (route.name === "meeting") {
    currentRoute = { name: "shell" };
    paintViewTabs("meeting");
    void activateMeetingRoute();
    return;
  }
  paintViewTabs("shell");
  deactivateMeetingRoute();
  currentRoute =
    route.name === "history"
      ? { name: "history", sessionId: route.sessionId }
      : { name: "shell" };
  applyLayoutForRoute();
});

// Re-apply layout when crossing the wide-screen breakpoint so the view stays
// consistent with the viewport (e.g., user rotates tablet, resizes window).
desktopOnePage.addEventListener("change", applyLayoutForRoute);

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

// Safety net for tab close / refresh during an active recording: fire a
// best-effort PATCH so the backend persists ended_at + duration_ms even when
// stopSession's normal await chain never gets to run. `keepalive: true` tells
// the browser to deliver the request after the document unloads — the
// modern, navigateAway-safe replacement for synchronous XHR in beforeunload.
//
// Uses `pagehide` (not `beforeunload`) because:
//   - pagehide fires on the bfcache path that mobile Safari uses;
//   - beforeunload no longer fires reliably for some PWA close paths.
window.addEventListener("pagehide", () => {
  if (currentSessionId === null) return;
  const session = store.list().find((s) => s.id === currentSessionId);
  if (!session || session.ended_at !== null) return;
  const ended_at = Date.now();
  fetch(backendUrl(`/v1/sessions/${currentSessionId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ended_at,
      duration_ms: ended_at - session.started_at,
    }),
    keepalive: true,
  }).catch(() => {});
});

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
    currentSessionId = store.startSession("live");
    refreshHistory();
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
      refreshHistory();
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
      // Await so the PATCH lands AND the local cache mutation (ended_at
      // assignment) happens before we check it below. Swallow network errors
      // here — the pagehide keepalive handler is the last-resort retry.
      await store.stopSession(currentSessionId).catch(() => {});
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
      refreshHistory();
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
    const sessionId = store.startSession("batch");
    await store.appendFinal(sessionId, { text, start_ms: 0, end_ms: durationMs });
    await store.stopSession(sessionId);
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
    refreshHistory();
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
 * Best-effort upload of `blob` to the backend for `sessionId`. The backend
 * stores the file under `data/audio/{id}{ext}` and stamps `audio_path` on
 * the session row; the HistoryStore mirrors this as `audio_saved=true`.
 * Errors surface as a toast — the transcript is already saved server-side.
 * `durationMs` is unused now (waveform player decodes its own duration).
 */
async function persistAudio(
  sessionId: string,
  blob: Blob,
  _durationMs: number,
): Promise<void> {
  try {
    await store.uploadSessionAudio(sessionId, blob, blob.type || "audio/webm");
  } catch (e) {
    toast(`⚠ ${e instanceof Error ? e.message : String(e)}`);
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
  // log=false: the PWA owns its own session lifecycle via /v1/sessions/*.
  // External API consumers (Shortcut, curl) default to log=true so they
  // also appear in the history view.
  const r = await fetch(backendUrl("/transcribe?log=false"), {
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
      refreshHistory();
      liveTimeout?.onActivity();
      break;
    case "error":
      toast(`⚠ ${e.message}`);
      break;
  }
}

// ---- Background-tab freshness ---------------------------------------------
// When the user backgrounds the PWA, calls /transcribe (Shortcut / curl /
// OpenAI-compat) from another app, then returns, the rail used to be stale
// — store.prime() only ran at startup. Listen for visibilitychange and
// re-prime + refresh whenever the tab becomes visible again. Throttled to
// once per 5 seconds so rapid app-switches don't hammer /v1/sessions.
let lastVisibilityReprime = 0;
const REPRIME_MIN_INTERVAL_MS = 5_000;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastVisibilityReprime < REPRIME_MIN_INTERVAL_MS) return;
  lastVisibilityReprime = now;
  void store.prime().then(() => refreshHistory());
});

// ---- Service worker --------------------------------------------------------
// registerType: "prompt" means the new SW stays in "waiting" until we call
// updateSW(true) — that posts SKIP_WAITING + reloads. On iOS standalone PWAs
// there's no native refresh affordance, so the toast MUST give the user an
// explicit "Update" button; a bare informational toast traps them into
// force-closing the app, which is what triggered this fix.
const updateSW = registerSW({
  onNeedRefresh() {
    toastWithAction(
      t("app.newVersionReady"),
      t("app.newVersionUpdate"),
      () => void updateSW(true),
    );
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

/** Toast with an inline action button. Used for SW update prompts where the
 * user MUST get an interaction surface — iOS standalone PWAs have no native
 * "refresh" otherwise. Click dismisses the toast and calls onAction. */
function toastWithAction(
  message: string,
  actionLabel: string,
  onAction: () => void,
): void {
  const tNode = el("div", "toast toast-with-action");
  const text = document.createElement("span");
  text.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action";
  btn.textContent = actionLabel;
  btn.addEventListener("click", () => {
    tNode.remove();
    onAction();
  });
  tNode.append(text, btn);
  document.body.appendChild(tNode);
  // Longer dwell time than plain toast — user needs reading + clicking time.
  setTimeout(() => tNode.remove(), 10000);
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
