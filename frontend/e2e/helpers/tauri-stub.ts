/**
 * In-page Tauri bridge stub for the `mocked` Playwright project
 * (fe-e2e-playwright). Installs `window.__TAURI__` so `isDesktopShell()` is
 * true and desktop-only UI renders, records every `invoke` call for assertion,
 * and exposes `window.__emitTauri(name)` so specs can drive the desktop events
 * (`overlay-start` / `overlay-stop` / `overlay-cancel`) that the Rust shell
 * would normally emit. The real Rust↔JS boundary stays out of scope; this
 * exercises the JS contract on that boundary in a real browser.
 *
 * Mirrors the exact surface `src/platform/capability.ts` probes:
 *   window.__TAURI__.core.invoke(cmd, args) => Promise
 *   window.__TAURI__.event.listen(event, handler) => Promise<unlisten>
 */

import type { Page } from "@playwright/test";

export interface TauriCall {
  cmd: string;
  args?: Record<string, unknown>;
}

export async function installTauriStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI__?: unknown;
      __tauriCalls?: TauriCall[];
      __tauriListeners?: Record<string, ((e: unknown) => void)[]>;
      __emitTauri?: (name: string, payload?: unknown) => void;
    };
    w.__tauriCalls = [];
    w.__tauriListeners = {};
    w.__TAURI__ = {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          w.__tauriCalls!.push({ cmd, args });
          return Promise.resolve(undefined);
        },
      },
      event: {
        listen: (event: string, handler: (e: unknown) => void) => {
          (w.__tauriListeners![event] ||= []).push(handler);
          return Promise.resolve(() => {
            const arr = w.__tauriListeners![event] || [];
            const i = arr.indexOf(handler);
            if (i >= 0) arr.splice(i, 1);
          });
        },
      },
    };
    w.__emitTauri = (name: string, payload?: unknown) => {
      for (const cb of w.__tauriListeners![name] || []) {
        cb({ event: name, payload });
      }
    };
  });
}

/** Read the recorded invoke calls from the page. */
export async function tauriCalls(page: Page): Promise<TauriCall[]> {
  return page.evaluate(
    () => (window as unknown as { __tauriCalls: TauriCall[] }).__tauriCalls,
  );
}

/** Fire a desktop event into the app (as the Rust shell would). */
export async function emitTauri(
  page: Page,
  name: string,
  payload?: unknown,
): Promise<void> {
  await page.evaluate(
    ([n, p]) =>
      (
        window as unknown as {
          __emitTauri: (name: string, payload?: unknown) => void;
        }
      ).__emitTauri(n as string, p),
    [name, payload] as const,
  );
}
