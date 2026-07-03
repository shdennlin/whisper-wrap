/**
 * License view (fe-license-tab) — ported from surfaces/license-ui/src/license-app.ts.
 *
 * A first-class shell view (View name "license") that drives the three
 * unchanged desktop commands and renders the four license states:
 *
 *   license_status()                         → { state, device_name?, ... }
 *   license_activate({ key, deviceName })    → status payload (post-activation)
 *   license_deactivate()                     → status payload (unactivated)
 *
 * On mount it calls `license_status` and renders by state:
 *   - unactivated → device-name input (pre-filled from `default_device_name`),
 *                   key input, Activate button
 *   - active      → device name, offline window end, update window end, days
 *                   remaining, Deactivate button
 *   - expired     → a re-activation prompt + the activate form
 *   - invalid     → the `detail` string + the activate form
 *
 * The state machine and coverage are carried over verbatim from the MVP; the
 * only adaptation is the seam: commands go through platform/capability's
 * `tauriInvoke()` instead of the surface's own shim, and a desktop-only guard
 * redirects to the surface default view when the command bridge is unavailable
 * or the surface is not desktop (a hand-typed #license hash on web).
 *
 * Per the fe-license-tab decision "Public-repo licensing consequence is
 * accepted and recorded": this view lands in the GPLv3 public frontend and
 * contains NO premium logic — it only renders states the desktop commands
 * return.
 */

import { t } from "../i18n";
import { tauriInvoke, type TauriInvoke } from "../platform/capability";
import { resolveSurface, surfaceProfile } from "../platform/surface";
import { navigateToView, type View } from "../routing/view-route";

export type LicenseState = "unactivated" | "active" | "expired" | "invalid";

/** The `license_status` / `license_activate` / `license_deactivate` payload. */
export interface LicenseStatus {
  state: LicenseState;
  device_name?: string;
  offline_until?: string;
  updates_until?: string;
  days_remaining?: number;
  detail?: string;
  default_device_name?: string;
}

export interface LicenseViewDeps {
  /** Invoke a desktop command; defaults to the Tauri bridge (null in a plain
   *  browser, which trips the desktop-only redirect). Pass a stub in tests. */
  invoke?: TauriInvoke | null;
  /** Whether the current surface is desktop; defaults to the resolved surface. */
  isDesktop?: boolean;
  /** Redirect target when the view is routed off the desktop; defaults to the
   *  surface profile's default view via the shared navigation seam. */
  onRedirect?: () => void;
}

export interface LicenseViewHandle {
  element: HTMLElement;
  /** Resolves once the initial `license_status` load has rendered. */
  ready: Promise<void>;
  /** Resolves once the most recent command (load/activate/deactivate) settles. */
  idle(): Promise<void>;
  destroy(): void;
}

/** Best-effort reason string from a command rejection (Rust returns Err(String)). */
function reasonOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.reason === "string") return o.reason;
    if (typeof o.message === "string") return o.message;
  }
  return String(err);
}

/** Default redirect: land on the surface profile's default view (mirrors
 *  bootLandingView's home/library resolution), reusing the router's seam. */
function defaultRedirect(): void {
  const profile = surfaceProfile(resolveSurface());
  const target: View =
    profile.defaultView === "library" ? { name: "library" } : { name: "home" };
  navigateToView(target, { replace: true });
}

function labeledInput(
  labelText: string,
  className: string,
  value: string,
  placeholder: string,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "license-field";
  const span = document.createElement("span");
  span.className = "license-field-label";
  span.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.className = className;
  input.value = value;
  input.placeholder = placeholder;
  label.append(span, input);
  return label;
}

function readonlyRow(
  labelText: string,
  className: string,
  value: string,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "license-row";
  const span = document.createElement("span");
  span.className = "license-row-label";
  span.textContent = labelText;
  const val = document.createElement("span");
  val.className = className;
  val.textContent = value;
  row.append(span, val);
  return row;
}

/** Render an RFC3339 certificate timestamp as a local date (fe-license-tab UI
 *  polish): the raw string carries microseconds + offset, which reads as noise
 *  in a settings row. Same convention as home-view's toLocaleDateString. An
 *  unparseable value falls back to the raw string rather than hiding it. */
export function formatLicenseDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function renderLicense(
  container: HTMLElement,
  deps: LicenseViewDeps = {},
): LicenseViewHandle {
  const invoke = deps.invoke ?? tauriInvoke();
  const isDesktop = deps.isDesktop ?? resolveSurface() === "desktop";
  const onRedirect = deps.onRedirect ?? defaultRedirect;

  container.replaceChildren();

  // Desktop-only guard (fe-license-tab "License view is an in-shell desktop-only
  // destination"): with no command bridge or off the desktop surface, render
  // nothing and redirect to the profile default instead of a broken form.
  if (!invoke || !isDesktop) {
    onRedirect();
    return {
      element: container,
      ready: Promise.resolve(),
      idle: () => Promise.resolve(),
      destroy() {
        container.replaceChildren();
      },
    };
  }

  container.classList.add("license-view");

  const rowTitle = document.createElement("div");
  rowTitle.className = "row-title";
  const heading = document.createElement("h3");
  heading.className = "license-heading";
  heading.textContent = t("license.title");
  rowTitle.appendChild(heading);

  const body = document.createElement("div");
  body.className = "license-body mrow-frame";

  // Dedicated, always-present error line — every command failure lands here.
  const error = document.createElement("p");
  error.className = "license-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  container.append(rowTitle, body, error);

  let busy = false;
  let pending: Promise<void> = Promise.resolve();

  function setError(message: string | null): void {
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }
  }

  function setBusy(value: boolean): void {
    busy = value;
    const controls = body.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >("button, input");
    for (const el of controls) el.disabled = value;
  }

  function keyValue(): string {
    return (
      body.querySelector<HTMLInputElement>(".license-key-input")?.value ?? ""
    );
  }

  function deviceValue(): string {
    return (
      body.querySelector<HTMLInputElement>(".license-device-input")?.value ?? ""
    );
  }

  // --- render ------------------------------------------------------------
  function activateForm(
    status: LicenseStatus,
    prompt: string | null,
  ): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (prompt) {
      const p = document.createElement("p");
      p.className = "license-prompt";
      p.textContent = prompt;
      frag.append(p);
    }
    // Pre-fill the device name from the shell-supplied host name (falling back
    // to any previously recorded label). The user may edit or clear it; an empty
    // value is defaulted to the host name Rust-side.
    const device = status.default_device_name ?? status.device_name ?? "";
    frag.append(
      labeledInput(
        t("license.deviceLabel"),
        "license-device-input",
        device,
        t("license.devicePlaceholder"),
      ),
      labeledInput(
        t("license.keyLabel"),
        "license-key-input",
        "",
        t("license.keyPlaceholder"),
      ),
    );
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "license-activate";
    activate.textContent = t("license.activate");
    activate.addEventListener("click", () => {
      pending = run(doActivate);
    });
    frag.append(activate);
    return frag;
  }

  function activePanel(status: LicenseStatus): DocumentFragment {
    const frag = document.createDocumentFragment();
    // Lifetime-updates working decision (2026-07-03, fe-license-tab): the
    // license itself never expires and updates are lifetime (competitor
    // parity), so the active panel leads with an explicit Lifetime row and
    // renders NO update window — the certificate's updates_until stays signed
    // but unrendered. The offline window is the only date shown, with a hint
    // that it self-extends online, so it never reads as a subscription clock.
    const hint = document.createElement("p");
    hint.className = "license-offline-hint";
    hint.textContent = t("license.offlineHint");
    frag.append(
      readonlyRow(
        t("license.rowLicense"),
        "license-kind",
        t("license.lifetime"),
      ),
      readonlyRow(
        t("license.rowDevice"),
        "license-device-name",
        status.device_name ?? "—",
      ),
      readonlyRow(
        t("license.rowOfflineUntil"),
        "license-offline-until",
        status.offline_until != null ? formatLicenseDate(status.offline_until) : "—",
      ),
      hint,
    );
    const deactivate = document.createElement("button");
    deactivate.type = "button";
    deactivate.className = "license-deactivate";
    deactivate.textContent = t("license.deactivate");
    deactivate.addEventListener("click", () => {
      pending = run(doDeactivate);
    });
    frag.append(deactivate);
    return frag;
  }

  function render(status: LicenseStatus): void {
    body.replaceChildren();
    switch (status.state) {
      case "active":
        body.append(activePanel(status));
        break;
      case "expired":
        body.append(activateForm(status, t("license.expiredPrompt")));
        break;
      case "invalid":
        body.append(
          activateForm(status, status.detail ?? t("license.invalidFallback")),
        );
        break;
      case "unactivated":
      default:
        body.append(activateForm(status, null));
        break;
    }
  }

  // --- commands ----------------------------------------------------------
  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      // On success the body was re-rendered with fresh (enabled) controls; on
      // failure the prior controls are re-enabled so the user can retry.
      setBusy(false);
    }
  }

  async function doLoad(): Promise<void> {
    try {
      const status = (await invoke!("license_status")) as LicenseStatus;
      setError(null);
      render(status);
    } catch (err) {
      setError(reasonOf(err));
    }
  }

  async function doActivate(): Promise<void> {
    const key = keyValue();
    const deviceName = deviceValue();
    try {
      const status = (await invoke!("license_activate", {
        key,
        deviceName,
      })) as LicenseStatus;
      setError(null);
      render(status);
    } catch (err) {
      // Stay in the prior state; surface the reason verbatim.
      setError(reasonOf(err));
    }
  }

  async function doDeactivate(): Promise<void> {
    try {
      const status = (await invoke!("license_deactivate")) as LicenseStatus;
      setError(null);
      render(status);
    } catch (err) {
      setError(reasonOf(err));
    }
  }

  const ready = run(doLoad);
  pending = ready;

  return {
    element: container,
    ready,
    idle(): Promise<void> {
      return pending;
    },
    destroy(): void {
      container.replaceChildren();
      container.classList.remove("license-view");
    },
  };
}
