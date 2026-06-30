/**
 * Platform-capability seam (app-shell).
 *
 * Distinguishes SHELL capability — is this running inside the Tauri desktop
 * shell (`window.__TAURI__` injected via withGlobalTauri) with the command
 * bridge available — from a viewport guess, which lies about capability.
 * Desktop-only features gate on `isDesktopShell()` (and, where relevant, a
 * backend `/status` capability), never on window size.
 *
 * This is the canonical home for the `__TAURI__` probe that platform/save-file
 * currently inlines.
 */

export type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The withGlobalTauri event API: `listen` is async and resolves an unlisten. */
type TauriEventListen = (
  event: string,
  handler: (e: unknown) => void,
) => Promise<() => void>;

/** The withGlobalTauri event API: `emit` broadcasts an app-wide event. */
type TauriEventEmit = (event: string, payload?: unknown) => Promise<void>;

interface TauriBridge {
  core?: { invoke?: TauriInvoke };
  event?: { listen?: TauriEventListen; emit?: TauriEventEmit };
}

function bridge(): TauriBridge | undefined {
  return (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__;
}

/** True when the Tauri global is present (desktop shell), regardless of the
 *  command bridge. */
export function hasTauri(): boolean {
  return bridge() != null;
}

/** The desktop command-invoke function, or null in a plain browser. */
export function tauriInvoke(): TauriInvoke | null {
  return bridge()?.core?.invoke ?? null;
}

/** True only when the desktop shell AND its command bridge are available —
 *  the gate for desktop-only features. */
export function isDesktopShell(): boolean {
  return tauriInvoke() != null;
}

/**
 * Subscribe to a desktop (Tauri) event; returns null in a plain browser so
 * callers can gate on the desktop shell. The underlying `listen` is async, so
 * the returned unlisten awaits it before tearing the subscription down.
 */
export function tauriListen(
  event: string,
  handler: (payload?: unknown) => void,
): (() => void) | null {
  const listen = bridge()?.event?.listen;
  if (!listen) return null;
  const pending = listen(event, (e: unknown) =>
    handler((e as { payload?: unknown } | undefined)?.payload),
  );
  return () => {
    void pending.then((unlisten) => unlisten());
  };
}

/**
 * Emit an application-wide desktop (Tauri) event so other windows can react —
 * e.g. the capture overlay tells the main window a capture landed. A silent
 * no-op in a plain browser (no Tauri bridge), so callers need not gate.
 */
export function tauriEmit(event: string, payload?: unknown): void {
  const emit = bridge()?.event?.emit;
  if (!emit) return;
  void emit(event, payload);
}
