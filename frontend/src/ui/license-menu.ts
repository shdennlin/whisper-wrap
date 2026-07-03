/**
 * macOS app-menu License… → in-shell view wiring (fe-license-tab).
 *
 * The desktop shell no longer opens a separate License window: its app-menu
 * License… item focuses the main window and emits the `open-license` app event
 * to the webview. The frontend subscribes at shell boot and navigates to the
 * in-shell license view when it fires. Wiring lives behind an injectable
 * `listen` seam (mirrors wirePastePermissionHint) so the event→navigate
 * behavior is unit-testable without the Tauri bridge; on surfaces without the
 * event bridge `tauriListen` returns null and the subscription is silently
 * skipped.
 */

import { navigateToView } from "../routing/view-route";

/** The desktop event-subscribe seam (matches `tauriListen`): returns an
 *  unlisten, or null in a plain browser. */
type ListenSeam = (
  event: string,
  handler: (payload?: unknown) => void,
) => (() => void) | null;

export interface LicenseMenuDeps {
  /** Event-subscribe seam — `tauriListen` in production. */
  listen: ListenSeam;
  /** Navigate to the license view — defaults to the router seam. */
  navigate?: () => void;
}

export const OPEN_LICENSE_EVENT = "open-license";

/**
 * Subscribe to `open-license` and navigate to the license view when the shell
 * emits it. A no-op when the listener seam is unavailable (plain browser).
 */
export function wireLicenseMenu(deps: LicenseMenuDeps): void {
  const navigate = deps.navigate ?? (() => navigateToView({ name: "license" }));
  deps.listen(OPEN_LICENSE_EVENT, () => navigate());
}
