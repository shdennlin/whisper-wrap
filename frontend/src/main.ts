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
import {
  resolveLiveStrategy,
  type LiveStrategy,
} from "./capture/live-caption-strategy";
import { loadLiveCaptions } from "./capture/mode-store";
import { HealthMonitor } from "./health/health-monitor";
import { copyToClipboard } from "./platform/clipboard";
import { toast, toastWithAction } from "./ui/toast";
import { maybeShowFirstRunGate } from "./ui/first-run-gate";
import type {
  ActionTemplate,
  ActionsResponse,
  Category,
} from "./ui/actions-bar";
import { SettingsPanel, loadSettings } from "./ui/settings-panel";
import { refreshAllSurfaces } from "./ui/refresh-surfaces";
import { subscribeSessionEvents } from "./library/session-events";
import { LIBRARY_CHANGED_EVENT } from "./library/library-events";
import { BackendIndicator } from "./ui/backend-indicator";
import { HistoryStore } from "./storage/history-store";
import { navigateToHistory, onRouteChange } from "./routing/hash-route";
import { mountAppShell } from "./ui/app-shell";
import { renderLibrary } from "./ui/library-view";
import { renderDetail } from "./ui/detail-view";
import { openAiActionModal } from "./ui/ai-action-modal";
import { runStage, pollRun } from "./library/runs-api";
import { renderModels } from "./ui/models-view";
import { renderSettings } from "./ui/settings-view";
import { renderLicense } from "./ui/license-view";
import { wireLicenseMenu } from "./ui/license-menu";
import { ModelManager } from "./ui/model-manager";
import { AuxModelManager } from "./ui/aux-model-manager";
import { mountHomeView, type HomeViewHandle } from "./ui/home-view";
import { createRecordingLayer } from "./ui/recording-view";
import {
  createRecordingController,
  type RecordingController,
} from "./capture/recording-controller";
import { navigateToView, parseViewHash } from "./routing/view-route";
import { tauriInvoke, tauriListen } from "./platform/capability";
import {
  bootLandingView,
  resolveSurface,
  surfaceProfile,
} from "./platform/surface";
import { itemDisplayTitle, listItems } from "./library/items";
import { wirePastePermissionHint } from "./ui/paste-permission-hint";
import { client } from "./api/client";
import { backendUrl } from "./api/backend-url";

// Resolve locale before any component reads strings.
loadLocale();
// Resolve theme before first paint so the page doesn't flash the OS default
// when the user has explicitly chosen the opposite. applyTheme() writes
// `data-theme` on <html> and updates the <meta theme-color> tag.
loadTheme();
applyTheme();

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("missing #app root");
appRoot.replaceChildren();

// Surface profile (fe-surface-profile): resolve the surface once and drive
// every per-surface presentation decision (nav, home density, desktop-only
// settings, boot landing) from it instead of scattered isDesktopShell() calls.
const profile = surfaceProfile(resolveSurface());

// macOS vibrancy (fe-macos-vibrancy): inside the Tauri shell the window is
// transparent with an NSVisualEffectView backdrop — this root class lets the
// stylesheet drop the opaque page/shell backgrounds so the material shows
// through. Plain browsers never get the class, so web rendering is unchanged.
if (profile.surface === "desktop") {
  document.documentElement.classList.add("is-desktop-shell");
}

// fe-item-library cutover: the macOS app-shell is the real application root.
// Desktop and web load this same bundle, so this single mount covers both.
// The Home view shows the existing app (built into `root` = homeHost below).
// The actual `mountAppShell(...)` call is deferred until after the Models /
// Settings component dependencies (store, toast) are defined (fe-models-settings
// D3) so those views have their real mounts at first render.
const homeHost = document.createElement("div");
homeHost.className = "home-host";

// The existing app is built into `homeHost` (shown under the Home view).
const root = homeHost;
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
const MOON_PATH = "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z";
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
    themeIcon.replaceChildren(
      svgIcon({ tag: "path", attrs: { d: MOON_PATH } }),
    );
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

main.append(captureHost, actionsHost, answerHost);

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

recordingShell.append(main, aside);

// ---- New Home (fe-home-redesign) -------------------------------------------
// The mockup-standard Home: a recording layer (recbar / draft / processing /
// confirming / done) followed by the idle hero view. The layer renders first
// so CSS can hide the hero while a capture is in flight. Capture
// orchestration stays in the lifecycle functions below (hoisted function
// declarations) — these views are presentation only.
const homeViewHost = el("div", "home-idle-host");

// The recording lifecycle lives in createRecordingController(deps) now; `rec`
// is constructed below (after store/healthMonitor/settingsPanel exist) and the
// layer/home/quick handlers below bind to it lazily.
let rec: RecordingController;
let homeHandle: HomeViewHandle;
const recLayer = createRecordingLayer(homeViewHost, {
  // onStart is a no-op by design: orchestration starts via the hero/quick
  // entry points (rec.start() itself morphs the layer with .start(),
  // mirroring how the legacy flow called ModeCard.start() purely for UI).
  live: {
    onStart: () => {},
    onStop: () => void rec.stop().catch(reportError),
    onPauseResume: () => void rec.togglePause().catch(reportError),
    onDiscard: () => void rec.discard().catch(reportError),
  },
  batch: {
    onStart: () => {},
    onStop: () => void rec.stop().catch(reportError),
    onPauseResume: () => void rec.togglePause().catch(reportError),
    onDiscard: () => void rec.discard().catch(reportError),
    onFilePicked: (file) => void rec.onBatchFilePicked(file).catch(reportError),
    onConfirmStart: () => void rec.confirmBatchStart().catch(reportError),
    // Re-open the picker WITHOUT clearing the pending file or resetting the
    // card; only a fresh `change` selection replaces it (via onFilePicked).
    onConfirmChange: () => recLayer.batch.openFilePicker(),
  },
  setEntriesDisabled: (disabled, disabledTitle) =>
    homeHandle?.setEntriesDisabled(disabled, disabledTitle),
  // Recbar live-captions toggle: flip captions on/off mid-recording.
  onLiveToggle: (on) => rec.setLiveCaptions(on),
});
homeHandle = mountHomeView(homeViewHost, {
  homeDensity: profile.homeDensity,
  listItems,
  navigateToView,
  // One capture action now — live captions are a toggle, not a separate mode.
  onHeroStart: () => void rec.start().catch(reportError),
  onQuickStart: () => void rec.start().catch(reportError),
  onImportPick: () => recLayer.batch.openFilePicker(),
  // Initial toggle state from storage; the controller owns the live var.
  liveCaptionsEnabled: loadLiveCaptions(),
  onLiveCaptionsToggle: (on) => rec.setLiveCaptions(on),
  // The meeting page is its own legacy-routed view inside the Home host;
  // parseViewHash maps "#/meeting" to the home view, so this both shows
  // Home and activates the meeting route.
  onMeeting: () => {
    window.location.hash = "#/meeting";
  },
});

// The recording layer owns the live transcript now (retire-v2-recording-shell),
// so this only manages the done-view AI bar and returns the legacy actions /
// answer panes on idle.
// Done-view AI: one ✨AI 加工 entry that opens the shared action-picker modal,
// replacing the old inline AI Enhance panel + answer pane (完成卡瘦身). Each
// pick runs the item's ai stage, so the answer is recorded as an ai run and
// shows up in the detail view's 處理紀錄 — one AI path, one data model.
const doneAiBar = el("div", "done-ai-bar");
const doneAiBtn = document.createElement("button");
doneAiBtn.type = "button";
doneAiBtn.className = "stage-btn ai-open done-ai-btn";
doneAiBtn.textContent = "✨ AI 加工";
doneAiBtn.addEventListener("click", () => {
  const itemId = doneItemId;
  if (!itemId) return;
  openAiActionModal({
    loadActions: fetchAiActions,
    runAi: async (instruction) => {
      const runId = await runStage(itemId, "ai", { prompt: instruction });
      const done = await pollRun(runId);
      const answer = (done.result as { answer?: string } | null)?.answer;
      if (typeof answer !== "string")
        throw new Error(done.error ?? "ai run failed");
      return answer;
    },
    model: aiModelStatus,
  });
});
doneAiBar.appendChild(doneAiBtn);

// Guarded by a placement marker so the 250 ms timer ticks don't thrash DOM.
let panePlacement: "legacy" | "done" = "legacy";
recLayer.subscribe((s) => {
  if (s.state === "done") {
    if (panePlacement !== "done") {
      // Slimmed done card: the layer's owned transcript + Copy, then the
      // ✨AI 加工 modal entry (no inline AI Enhance panel, no answer pane —
      // those live in the modal / the detail view now).
      recLayer.els.actionsHost.appendChild(doneAiBar);
      panePlacement = "done";
    }
  } else if (s.state === "idle" && panePlacement !== "legacy") {
    main.append(actionsHost, answerHost);
    panePlacement = "legacy";
  }
});

// Legacy chrome retired (fe-home-redesign 3.2): the old header, recording
// shell (slim history aside, history view + resizer), and settings modal are
// still constructed — the lifecycle code touches them — but no longer
// mounted. Their functions live elsewhere now: history → Library view,
// settings → Settings view, indicators + theme toggle → shell toolbar
// (inserted after mountAppShell below), first-run gate → document.body.
root.append(homeViewHost);

// The WS reconnect row surfaces inside the recording layer (it only matters
// mid-capture); the upload-retry prompt lands on Home where the user retries.
recLayer.els.root.appendChild(wsIndicatorHost);
homeViewHost.appendChild(uploadRetryHost);

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
  onError: (e, ctx) => {
    const msg = e instanceof Error ? e.message : String(e);
    toast(`⚠ history ${ctx.op} failed: ${msg}`);
  },
});
store.setRetention(settings0.retention);

const backendIndicator = new BackendIndicator(indicatorHost);

const settingsPanel = new SettingsPanel({
  root: settingsHost,
  enumerateDevices: async () => navigator.mediaDevices.enumerateDevices(),
  onChange: (s) => store.setRetention(s.retention),
  clearAllAudio: () => store.bulkClearAudio(),
  onToast: (text) => toast(text),
  showDesktopShortcuts: profile.showDesktopShortcuts,
  showExperimental: profile.showExperimental,
});

// Mount the app-shell now that the Models/Settings component dependencies
// (store, toast, backendUrl) exist (fe-models-settings D3). Home shows the
// existing app (homeHost); Library/Detail are the new views; Models/Settings
// mount fresh ModelManager / SettingsPanel instances.
// One-shot handoff from the sidebar ⭐ entry to the next Library render —
// the star filter is view-internal state, not a route.
let pendingStarredNav = false;
function consumeStarredNav(): boolean {
  const v = pendingStarredNav;
  pendingStarredNav = false;
  return v;
}

// Boot landing (fe-surface-profile D4): with an empty location hash, land on
// the surface's default view (desktop → Library, web → Home). A non-empty
// deep-link hash is honored unchanged (bootLandingView returns null). Run
// before mountAppShell so its initial onViewChange reads the resolved hash
// directly (no home→library flash). parseViewHash keeps its empty/unknown →
// home fallback as the router's net.
{
  const landing = bootLandingView(window.location.hash, profile.defaultView);
  if (landing) navigateToView(landing, { replace: true });
}

const appShell = mountAppShell(appRoot, {
  nav: profile.nav,
  recordingState: (cb) =>
    recLayer.subscribe((s) =>
      cb({ active: s.active, elapsedLabel: s.elapsedLabel }),
    ),
  onStarredNav: () => {
    pendingStarredNav = true;
    // Setting the hash to the SAME value fires no hashchange, so when already
    // on Library the renderView wouldn't re-run and the star filter wouldn't
    // apply. `replace` always dispatches hashchange, forcing the re-render.
    const onLibrary = parseViewHash(window.location.hash).name === "library";
    navigateToView(
      { name: "library" },
      onLibrary ? { replace: true } : undefined,
    );
  },
  // Enriched sidebar (fe-visual-polish): counts + recents from the same
  // unified item list the Library uses; failure degrades to the plain nav.
  sidebarSummary: async () => {
    const items = await listItems();
    return {
      counts: {
        library: items.length,
        starred: items.filter((i) => i.starred).length,
      },
      recent: items.slice(0, 3).map((i) => ({
        id: i.id,
        title: itemDisplayTitle(i),
        hint: new Date(i.createdAt).toLocaleDateString(),
        preview: i.preview,
      })),
    };
  },
  renderView(view, container) {
    container.classList.toggle("is-home", view.name === "home");
    if (view.name === "home") {
      // Meeting-route enter/leave is handled by the legacy onRouteChange
      // below — both routers listen to the same hashchange.
      container.replaceChildren(homeHost);
    } else if (view.name === "library") {
      void renderLibrary(container, {
        initialStarred: consumeStarredNav(),
      });
    } else if (view.name === "detail") {
      void renderDetail(container, view.itemId);
    } else if (view.name === "models") {
      renderModels(container, {
        mount: (host) => new ModelManager(host, { onActiveChange: () => {} }),
        mountAux: (host) =>
          new AuxModelManager(host, { onInstalled: () => {} }),
      });
    } else if (view.name === "settings") {
      void renderSettings(container, {
        mount: (host) =>
          new SettingsPanel({
            root: host,
            enumerateDevices: async () =>
              navigator.mediaDevices.enumerateDevices(),
            onChange: (s) => store.setRetention(s.retention),
            clearAllAudio: () => store.bulkClearAudio(),
            onToast: (text) => toast(text),
            showDesktopShortcuts: profile.showDesktopShortcuts,
            showExperimental: profile.showExperimental,
          }),
      });
    } else if (view.name === "license") {
      // fe-license-tab: the desktop-only license view. renderLicense reads the
      // command bridge + surface itself and redirects to the profile default on
      // a non-desktop surface (a hand-typed #license hash on web).
      renderLicense(container);
    }
  },
});

// fe-license-tab: subscribe the macOS app-menu License… bridge at shell boot.
// The desktop shell focuses the main window and emits "open-license"; here we
// navigate to the in-shell license view. `tauriListen` returns null in a plain
// browser, so this is silently skipped on the web surface.
wireLicenseMenu({ listen: tauriListen });

// Relocate the backend indicator + theme toggle into the shell toolbar
// (their legacy header is no longer mounted). Inserted before the model pill
// so status chips group on the right.
{
  const shellToolbar = appRoot.querySelector(".shell-toolbar");
  const shellModelPill = shellToolbar?.querySelector(".model-pill") ?? null;
  if (shellToolbar) {
    indicatorHost.classList.add("toolbar-indicator");
    themeToggle.classList.add("toolbar-theme-toggle");
    shellToolbar.insertBefore(indicatorHost, shellModelPill);
    shellToolbar.insertBefore(themeToggle, shellModelPill);
  }
}

// Shared by the done-view ✨AI 加工 modal so it reads the one /actions registry.
const fetchAiActions = async (): Promise<ActionsResponse> => {
  const { data, error, response } = await client.GET("/actions");
  const status = response.status;
  if (error || !data) throw new Error(`HTTP ${status}`);
  // The contract types `/actions` arrays as `unknown[]` (their elements are
  // `serde_json::Value` in core, deliberately not over-typed). Map to the
  // frontend Action/Category shapes at this boundary — a contract-loose array
  // mapping, NOT a documented dynamic-exception response cast (those live in
  // `src/api/ai-config.ts`).
  return {
    actions: (data.actions ?? []) as ActionTemplate[],
    categories: (data.categories ?? []) as Category[],
  };
};

// The just-captured item + AI model, fed to the done-view AI picker modal.
let doneItemId: string | null = null;
let aiModelStatus: { configured: boolean; model?: string } | null = null;

// Prime the history cache from the backend, then refresh the v3 surfaces
// (the v2 history rail + master-detail view are retired —
// retire-v2-recording-shell). The done-view AI path loads its templates
// lazily through fetchAiActions when the modal opens.
void store.prime().then(() => refreshAll());

// Refresh the v3 data surfaces at once: the App Shell sidebar (counts +
// recents) and the Home dashboard. Routed through the shared helper so no path
// can update one surface while leaving the other stale. The v2 history rail is
// retired (retire-v2-recording-shell); cross-client / finalize updates also
// arrive via the SSE push wired in subscribeSessionEvents below.
function refreshAll(): void {
  refreshAllSurfaces({
    shell: () => appShell.refresh(),
    home: () => homeHandle.refresh(),
  });
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
  // The meeting page replaces the Home content (hero + recording layer).
  homeViewHost.hidden = true;
}

function deactivateMeetingRoute(): void {
  if (meetingHost) meetingHost.hidden = true;
  homeViewHost.hidden = false;
}

onRouteChange((route) => {
  if (route.name === "meeting") {
    paintViewTabs("meeting");
    void activateMeetingRoute();
    return;
  }
  // Home / Library / item detail are owned by the v3 App Shell router; here we
  // only toggle Meeting Mode and paint the view tabs.
  paintViewTabs("shell");
  deactivateMeetingRoute();
});

// ---- Capture adapters (fe-home-redesign) -----------------------------------
// The ModeCard pair is replaced by the recording layer's two adapters, which
// keep the exact surface the lifecycle functions below consume. The legacy
// mode-card module stays in the tree (unreferenced here) until fe-visual-polish
// confirms no other consumer.

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
  // Raw URL: HealthMonitor owns its own fetch; its GET /status probe is routed
  // through the generated client inside health-monitor.ts (task 2.6). Here we
  // only collapse the base-URL source onto the canonical `backendUrl()`.
  url: `${backendUrl()}/status`,
  onStateChange: (state) => {
    backendIndicator.setState(state);
    const disabled = state !== "ok";
    const title = disabled ? t("backend.disabledTitle") : undefined;
    // Only disable modes that are currently idle — never yank the UI out
    // from under an in-progress recording.
    if (recLayer.batch.getState() === "idle")
      recLayer.batch.setDisabled(disabled, title);
    if (recLayer.live.getState() === "idle")
      recLayer.live.setDisabled(disabled, title);
  },
});
healthMonitor.start();

// ---- LLM indicator (one-shot fetch of /status to surface the AI model) -----
// Doesn't need to poll — the active Gemini model is set at server startup and
// never changes at runtime. One read per page load is enough.
void client
  .GET("/status")
  .then(({ data }) => {
    const gemini = data?.gemini;
    if (!gemini) return;
    // Cached for the done-view ✨AI 加工 modal (openAiActionModal reads it).
    aiModelStatus = { configured: !!gemini.configured, model: gemini.model };
  })
  .catch(() => {
    // Best-effort: if /status is unreachable here, the BackendIndicator
    // already shows "backend offline" and the missing AI badge is a less
    // urgent signal than the main backend status.
  });

// ---- First-run gate --------------------------------------------------------
// A fresh install has no model weights; the engine boots with model.loaded
// false. Block the shell behind a download gate until a model is active.
void maybeShowFirstRunGate();

// ---- Global ⌥Space shortcut (desktop-global-hotkey) ------------------------
// Desktop only: the Rust shell registers ⌥Space and emits `quick-record` when
// pressed; we start a quick-voice (batch) capture. On boot we reconcile the OS
// registration with the user's persisted toggle (the shell registers by
// default at startup, so a disabled preference unregisters it here).
if (profile.surface === "desktop") {
  tauriListen("quick-record", () => {
    void rec.start().catch(reportError);
  });
  const hotkeySettings = loadSettings();
  void tauriInvoke()?.("set_global_hotkey", {
    enabled: hotkeySettings.globalHotkeyEnabled,
    accelerator: hotkeySettings.globalHotkeyAccelerator,
  });

  // ---- Auto-paste (overlay-auto-paste) -------------------------------------
  // Reconcile the shell's live paste state with the persisted settings on
  // boot — mirrors the set_global_hotkey reconciliation above. The shell
  // starts these features off, so an enabled preference re-arms them here.
  void tauriInvoke()?.("set_auto_paste", {
    enabled: hotkeySettings.autoPasteEnabled,
  });
  void tauriInvoke()?.("set_paste_hotkey", {
    enabled: hotkeySettings.pasteHotkeyEnabled,
    accelerator: hotkeySettings.pasteHotkeyAccelerator,
  });
  // Experimental: auto-pause-media (overlay-media-pause).
  void tauriInvoke()?.("set_auto_pause_media", {
    enabled: hotkeySettings.autoPauseMediaEnabled,
  });

  // Overlay surface prefs (extract-premium-surfaces): the dictation overlay now
  // runs as a separate private bundle at its own asset origin, so it can read
  // NEITHER this window's localStorage NOR the engine's same-origin cookie.
  // Report the two values it depends on to the shell, which forwards them: the
  // locale (so a non-English overlay keeps its language) and the Save-audio
  // preference (re-sent per capture so a mid-session opt-out is honored).
  void tauriInvoke()?.("set_overlay_prefs", {
    audioSave: hotkeySettings.audioSave,
    locale: loadLocale(),
  });

  // One-time hint when a paste runs without macOS Accessibility permission.
  wirePastePermissionHint({
    listen: tauriListen,
    showHint: (msg) => toast(msg),
  });
}

// ---- Recording lifecycle (recording-controller-extract) --------------------
// The capture start/stop/pause/discard, batch upload, live-caption sink wiring,
// audio persistence, upload-retry UI, and health gating moved verbatim into
// createRecordingController(deps). main.ts builds the deps and binds the
// card / recbar / home-toggle handlers (above) to the controller instance.
/** Active ASR live capability → strategy (local Whisper → windowed-batch). */
const liveStrategy: LiveStrategy = resolveLiveStrategy({ localWhisper: true });
rec = createRecordingController({
  store,
  healthMonitor,
  recLayer,
  liveStrategy,
  settingsPanel,
  onLibraryChanged: refreshAll,
  wsIndicatorHost,
  uploadRetryHost,
  // Reset the legacy answer pane on a fresh capture (desktop keeps it visible).
  resetAnswerPane: () => {
    currentAnswerText = "";
    answerBody.textContent = t("app.answerPlaceholder");
    answerCopyBtn.disabled = true;
    answerHost.hidden = isTouchDevice();
  },
  showMicPermissionError: micPermissionModal,
  // Hand the just-finished item id to the done-view AI modal.
  onDoneItem: (sessionId) => {
    doneItemId = sessionId;
  },
});

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
  void store.prime().then(() => refreshAll());
});

// ---- Live library refresh (live-library-push) ------------------------------
// The debounced re-prime + refresh lives in the controller now
// (rec.scheduleLiveRefresh); the two push channels below feed it: the backend
// SSE stream (universal) and a desktop Tauri event the overlay emits on save.

// Backend SSE — a no-op where EventSource is unavailable, so startup never throws.
// EXEMPT from the generated JSON client (design "Streaming, SSE, and binary
// engine calls stay off the generated client"): this stays on `EventSource`;
// only its base URL collapses onto the canonical `backendUrl()`.
subscribeSessionEvents({
  onChange: () => rec.scheduleLiveRefresh(),
  url: `${backendUrl()}/v1/sessions/events`,
});
// Desktop fast-path — null (no-op) in a plain browser with no Tauri bridge.
tauriListen(LIBRARY_CHANGED_EVENT, () => rec.scheduleLiveRefresh());

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
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

function micPermissionModal(detail: string): void {
  const modal = el("div", "banner");
  modal.textContent = t("app.micPermissionDenied", { detail });
  root!.insertBefore(modal, root!.firstChild);
}

function reportError(e: unknown): void {
  console.error(e);
  toast(
    t("app.errorPrefix", {
      message: e instanceof Error ? e.message : String(e),
    }),
  );
}
