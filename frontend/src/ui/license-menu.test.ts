/**
 * Tests for the macOS app-menu License… → in-shell view wiring
 * (fe-license-tab, task 1.4).
 *
 * Mirrors the paste-permission-hint wiring test: the `open-license` event
 * subscription lives behind an injectable `listen` seam so the event→navigate
 * behavior is unit-testable without the Tauri bridge (the subscription itself
 * is invoked from main.ts at shell boot with the real `tauriListen`).
 */

import { describe, expect, it, vi } from "vitest";

import { OPEN_LICENSE_EVENT, wireLicenseMenu } from "./license-menu";

describe("wireLicenseMenu", () => {
  it("navigates to the license view when the open-license event fires", () => {
    let handler: (() => void) | null = null;
    const listen = vi.fn((_event: string, h: () => void) => {
      handler = h;
      return () => {};
    });
    const navigate = vi.fn();

    wireLicenseMenu({ listen, navigate });

    expect(listen).toHaveBeenCalledWith(
      OPEN_LICENSE_EVENT,
      expect.any(Function),
    );
    expect(navigate).not.toHaveBeenCalled();

    // The shell emits open-license — the view is navigated to.
    handler!();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the listener seam is unavailable (plain browser)", () => {
    const navigate = vi.fn();
    expect(() =>
      wireLicenseMenu({ listen: () => null, navigate }),
    ).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
});
