/**
 * Tests for the one-time `paste-needs-permission` hint wiring
 * (overlay-auto-paste task 4.2).
 */

import { describe, expect, it, vi } from "vitest";

import { wirePastePermissionHint } from "./paste-permission-hint";

describe("wirePastePermissionHint", () => {
  it("renders the hint once when the event fires, and not again on repeat", () => {
    let handler: (() => void) | null = null;
    const listen = vi.fn((_event: string, h: () => void) => {
      handler = h;
      return () => {};
    });
    const shown: string[] = [];

    wirePastePermissionHint({
      listen,
      showHint: (msg) => shown.push(msg),
    });

    expect(listen).toHaveBeenCalledWith(
      "paste-needs-permission",
      expect.any(Function),
    );
    expect(shown).toHaveLength(0);

    // Shell emits the event — hint renders once.
    handler!();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBeTruthy();

    // A second emission (should not happen per the Rust contract, but guard
    // anyway) does not render the hint a second time.
    handler!();
    expect(shown).toHaveLength(1);
  });

  it("no-ops when the listener seam is unavailable (plain browser)", () => {
    const shown: string[] = [];
    expect(() =>
      wirePastePermissionHint({
        listen: () => null,
        showHint: (msg) => shown.push(msg),
      }),
    ).not.toThrow();
    expect(shown).toHaveLength(0);
  });
});
