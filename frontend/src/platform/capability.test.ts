import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasTauri,
  isDesktopShell,
  tauriEmit,
  tauriInvoke,
  tauriListen,
} from "./capability";

describe("platform capability", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  });

  it("reports no desktop shell in a plain browser", () => {
    expect(hasTauri()).toBe(false);
    expect(tauriInvoke()).toBeNull();
    expect(isDesktopShell()).toBe(false);
  });

  it("detects the desktop shell when the bridge is present", () => {
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      core: { invoke: async () => undefined },
    };
    expect(hasTauri()).toBe(true);
    expect(typeof tauriInvoke()).toBe("function");
    expect(isDesktopShell()).toBe(true);
  });

  it("has the Tauri global but no invoke bridge -> not a desktop shell", () => {
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {};
    expect(hasTauri()).toBe(true);
    expect(isDesktopShell()).toBe(false);
  });

  it("tauriListen returns null in a plain browser", () => {
    expect(tauriListen("quick-record", () => {})).toBeNull();
  });

  it("tauriListen wires the handler and returns an unlisten with the bridge", async () => {
    const unlisten = vi.fn();
    let captured: ((e: unknown) => void) | null = null;
    const listen = vi.fn(async (_event: string, cb: (e: unknown) => void) => {
      captured = cb;
      return unlisten;
    });
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { event: { listen } };

    const handler = vi.fn();
    const off = tauriListen("quick-record", handler);
    expect(off).not.toBeNull();
    expect(listen).toHaveBeenCalledWith("quick-record", expect.any(Function));

    // The underlying event fires our handler.
    captured!({ payload: null });
    expect(handler).toHaveBeenCalledTimes(1);

    // Unlisten awaits the listen promise then calls the real unlisten.
    off!();
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("tauriEmit is a silent no-op in a plain browser", () => {
    expect(() => tauriEmit("library-changed")).not.toThrow();
  });

  it("tauriEmit forwards the event + payload to the bridge when present", () => {
    const emit = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { event: { emit } };

    tauriEmit("library-changed", { reason: "overlay" });

    expect(emit).toHaveBeenCalledWith("library-changed", { reason: "overlay" });
  });
});
