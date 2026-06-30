/**
 * One-time "paste needs Accessibility permission" hint (overlay-auto-paste).
 *
 * The Rust desktop shell emits the `paste-needs-permission` event (at most
 * once per process run) the first time a paste runs without the macOS
 * Accessibility permission. We surface a single guiding toast pointing the
 * user at the Accessibility pane. Wiring lives behind an injectable seam so
 * it can be unit-tested without the Tauri bridge.
 */

import { t } from "../i18n";

/** The desktop event-subscribe seam (matches `tauriListen`): returns an
 *  unlisten, or null in a plain browser. */
type ListenSeam = (
  event: string,
  handler: (payload?: unknown) => void,
) => (() => void) | null;

export interface PastePermissionHintDeps {
  /** Event-subscribe seam — `tauriListen` in production. */
  listen: ListenSeam;
  /** Renders the hint message — `toast` in production. */
  showHint: (message: string) => void;
}

const PASTE_NEEDS_PERMISSION_EVENT = "paste-needs-permission";

/**
 * Subscribe to `paste-needs-permission` and show the Accessibility hint the
 * first time it fires. Idempotent per call: a repeated event is ignored so
 * the user never sees the same hint twice.
 */
export function wirePastePermissionHint(deps: PastePermissionHintDeps): void {
  let shown = false;
  deps.listen(PASTE_NEEDS_PERMISSION_EVENT, () => {
    if (shown) return;
    shown = true;
    deps.showHint(t("paste.needsPermission"));
  });
}
