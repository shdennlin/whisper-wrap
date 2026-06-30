/**
 * First-run gate.
 *
 * A fresh install ships zero model weights — the engine boots with no model
 * loaded (GET /status → model.loaded === false) and every transcription
 * endpoint returns 503. This full-screen overlay blocks the app shell and
 * hosts the existing ModelManager so the user can download + activate a
 * model. POST /models/active loads the weights synchronously server-side, so
 * once it succeeds we reload into the normal app.
 */
import { ModelManager } from "./model-manager";
import { toast, toastWithAction } from "./toast";
import { t } from "../i18n";

interface StatusResponse {
  model?: { loaded?: boolean };
}

/** True only when the engine reports a loaded model. Any error → false (treat
 *  as "needs setup" rather than crashing the boot path). */
export async function isModelLoaded(base: string): Promise<boolean> {
  try {
    const resp = await fetch(`${base}/status`);
    if (!resp.ok) return false;
    const body = (await resp.json()) as StatusResponse;
    return body.model?.loaded === true;
  } catch {
    return false;
  }
}

/** Show the gate iff no model is loaded. Returns true when the gate was shown. */
export async function maybeShowFirstRunGate(
  getBackendUrl: () => string,
  onReady: () => void = () => window.location.reload(),
): Promise<boolean> {
  if (await isModelLoaded(getBackendUrl())) return false;
  showFirstRunGate(getBackendUrl, onReady);
  return true;
}

export function showFirstRunGate(
  getBackendUrl: () => string,
  onReady: () => void,
): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "first-run-overlay";
  overlay.dataset.testid = "first-run-gate";

  const panel = document.createElement("div");
  panel.className = "first-run-panel";

  const heading = document.createElement("h1");
  heading.className = "first-run-title";
  heading.textContent = t("firstRun.title");

  const sub = document.createElement("p");
  sub.className = "first-run-subtitle";
  sub.textContent = t("firstRun.subtitle");

  const managerHost = document.createElement("div");

  // Revealed once a download is running: lets the user use the app (history,
  // settings…) while weights stream in the background. The download is a
  // server-side job — dismissing the overlay only hides the UI; the manager
  // keeps polling and auto-loads the model when the download lands.
  const bgBtn = document.createElement("button");
  bgBtn.type = "button";
  bgBtn.className = "first-run-bg";
  bgBtn.textContent = t("firstRun.continueBackground");
  bgBtn.hidden = true;

  panel.append(heading, sub, managerHost, bgBtn);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let background = false;
  bgBtn.addEventListener("click", () => {
    background = true;
    overlay.remove();
  });

  let manager: ModelManager | null = null;
  const onActiveChange = async () => {
    // set_active loads the weights before responding, so the model should be
    // loaded by now — confirm, then hand over to the app. Foreground: re-init
    // cleanly via reload. Background: the user is already mid-session in the
    // main page, so a toast beats yanking the page out from under them.
    if (await isModelLoaded(getBackendUrl())) {
      manager?.dispose();
      overlay.remove();
      if (background) {
        toast(t("firstRun.ready"));
      } else {
        onReady();
      }
    }
  };

  manager = new ModelManager(managerHost, getBackendUrl, {
    onActiveChange: () => {
      void onActiveChange();
    },
    onDownloadStart: () => {
      bgBtn.hidden = false;
    },
    onError: (message) => {
      // While backgrounded the gate (and its inline error) is invisible —
      // re-surface the failure as a toast whose action brings the gate back.
      if (!background) return;
      toastWithAction(message, t("firstRun.showSetup"), () => {
        background = false;
        document.body.appendChild(overlay);
      });
    },
  });
  return overlay;
}
