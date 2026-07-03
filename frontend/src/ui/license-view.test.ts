/**
 * License view tests (fe-license-tab, task 1.3).
 *
 * Ported from surfaces/license-ui/src/license-app.test.ts — same state machine
 * and coverage, adapted to the frontend view seam: an injected `invoke` stub
 * (like the sibling view tests) plus the desktop-only `isDesktop` / `onRedirect`
 * gate that replaces the private surface's own capability shim.
 */

import { describe, expect, it, vi } from "vitest";

import { type LicenseStatus, renderLicense, formatLicenseDate } from "./license-view";

/** Mount on the desktop surface with a canned `license_status` payload. */
function mountWithStatus(status: LicenseStatus) {
  const container = document.createElement("div");
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "license_status") return status;
    return status;
  });
  const handle = renderLicense(container, { invoke, isDesktop: true });
  return { container, invoke, handle };
}

describe("renderLicense", () => {
  it("renders the unactivated state with a key input and activate button", async () => {
    const { container, handle } = mountWithStatus({
      state: "unactivated",
      default_device_name: "My-Mac",
    });
    await handle.ready;

    expect(container.querySelector(".license-key-input")).toBeTruthy();
    expect(container.querySelector(".license-activate")).toBeTruthy();
    // Device-name input is pre-filled from the shell-supplied host name.
    const dev = container.querySelector<HTMLInputElement>(
      ".license-device-input",
    );
    expect(dev?.value).toBe("My-Mac");
    // No active-state controls while unactivated.
    expect(container.querySelector(".license-deactivate")).toBeNull();
  });

  it("renders the active state as a lifetime license with the offline window and deactivate", async () => {
    const { container, handle } = mountWithStatus({
      state: "active",
      device_name: "My-Mac",
      offline_until: "2027-01-01",
      updates_until: "2027-06-01",
      days_remaining: 175,
    });
    await handle.ready;

    expect(container.querySelector(".license-deactivate")).toBeTruthy();
    // Lifetime-updates working decision (2026-07-03): the panel leads with an
    // explicit Lifetime row and shows NO update window and NO day countdown —
    // nothing that reads as a subscription clock.
    expect(container.querySelector(".license-kind")?.textContent).toContain("Lifetime");
    expect(container.querySelector(".license-updates-until")).toBeNull();
    expect(container.querySelector(".license-days-remaining")).toBeNull();
    expect(container.textContent).toContain("My-Mac");
    // The offline date renders through formatLicenseDate with the auto-extend hint.
    expect(container.textContent).toContain(formatLicenseDate("2027-01-01"));
    expect(container.textContent).not.toContain(formatLicenseDate("2027-06-01"));
    expect(container.querySelector(".license-offline-hint")).toBeTruthy();
    // Active state has no key input / activate button.
    expect(container.querySelector(".license-key-input")).toBeNull();
    expect(container.querySelector(".license-activate")).toBeNull();
  });

  it("renders the expired state with a re-activation prompt and key input", async () => {
    const { container, handle } = mountWithStatus({
      state: "expired",
      default_device_name: "My-Mac",
    });
    await handle.ready;

    expect(container.querySelector(".license-key-input")).toBeTruthy();
    expect(container.querySelector(".license-activate")).toBeTruthy();
    const prompt = container.querySelector(".license-prompt");
    expect(prompt).toBeTruthy();
    expect((prompt?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("renders the invalid state showing the detail string with a key input", async () => {
    const { container, handle } = mountWithStatus({
      state: "invalid",
      detail: "signature verification failed",
    });
    await handle.ready;

    expect(container.textContent).toContain("signature verification failed");
    expect(container.querySelector(".license-key-input")).toBeTruthy();
    expect(container.querySelector(".license-activate")).toBeTruthy();
  });

  it("transitions from unactivated to active on a successful activate", async () => {
    const active: LicenseStatus = {
      state: "active",
      device_name: "My-Mac",
      offline_until: "2027-01-01",
      updates_until: "2027-06-01",
      days_remaining: 180,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "license_status")
        return { state: "unactivated", default_device_name: "My-Mac" };
      if (cmd === "license_activate") return active;
      throw new Error(`unexpected command ${cmd}`);
    });
    const container = document.createElement("div");
    const handle = renderLicense(container, { invoke, isDesktop: true });
    await handle.ready;

    container.querySelector<HTMLInputElement>(".license-key-input")!.value =
      "KEY-123";
    container.querySelector<HTMLButtonElement>(".license-activate")!.click();
    await handle.idle();

    // Sent the entered key + the (pre-filled) device name, camelCased for Tauri.
    expect(invoke).toHaveBeenCalledWith("license_activate", {
      key: "KEY-123",
      deviceName: "My-Mac",
    });
    // Re-rendered from the returned active payload.
    expect(container.querySelector(".license-deactivate")).toBeTruthy();
    expect(container.textContent).toContain("My-Mac");
    expect(container.textContent).toContain(formatLicenseDate("2027-01-01"));
    // Error line stays clear on success.
    expect(container.querySelector<HTMLElement>(".license-error")?.hidden).toBe(
      true,
    );
  });

  it("surfaces the rejection reason verbatim and stays in the prior state when activate fails", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "license_status")
        return { state: "unactivated", default_device_name: "My-Mac" };
      if (cmd === "license_activate") throw "activation_limit_reached";
      throw new Error(`unexpected command ${cmd}`);
    });
    const container = document.createElement("div");
    const handle = renderLicense(container, { invoke, isDesktop: true });
    await handle.ready;

    container.querySelector<HTMLInputElement>(".license-key-input")!.value =
      "KEY-123";
    container.querySelector<HTMLButtonElement>(".license-activate")!.click();
    await handle.idle();

    const err = container.querySelector<HTMLElement>(".license-error");
    expect(err?.hidden).toBe(false);
    expect(err?.textContent).toContain("activation_limit_reached");
    // View stayed in the unactivated state (no silent transition).
    expect(container.querySelector(".license-key-input")).toBeTruthy();
    expect(container.querySelector(".license-deactivate")).toBeNull();
  });

  it("disables the action buttons while a command is in flight", async () => {
    let resolveActivate: ((s: LicenseStatus) => void) | null = null;
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "license_status")
        return Promise.resolve({
          state: "unactivated",
          default_device_name: "My-Mac",
        });
      if (cmd === "license_activate")
        return new Promise<LicenseStatus>((res) => {
          resolveActivate = res;
        });
      throw new Error(`unexpected command ${cmd}`);
    });
    const container = document.createElement("div");
    const handle = renderLicense(container, { invoke, isDesktop: true });
    await handle.ready;

    const activate =
      container.querySelector<HTMLButtonElement>(".license-activate")!;
    const keyInput =
      container.querySelector<HTMLInputElement>(".license-key-input")!;
    activate.click();
    // Command is in flight — every control disables to prevent double-submits.
    expect(activate.disabled).toBe(true);
    expect(keyInput.disabled).toBe(true);

    resolveActivate!({ state: "active", device_name: "My-Mac" });
    await handle.idle();
    // Re-rendered active panel with fresh, enabled controls.
    expect(
      container.querySelector<HTMLButtonElement>(".license-deactivate")
        ?.disabled,
    ).toBe(false);
  });

  it("deactivates back to the unactivated state", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "license_status")
        return {
          state: "active",
          device_name: "My-Mac",
          offline_until: "2027-01-01",
          updates_until: "2027-06-01",
          days_remaining: 180,
        };
      if (cmd === "license_deactivate")
        return { state: "unactivated", default_device_name: "My-Mac" };
      throw new Error(`unexpected command ${cmd}`);
    });
    const container = document.createElement("div");
    const handle = renderLicense(container, { invoke, isDesktop: true });
    await handle.ready;

    container.querySelector<HTMLButtonElement>(".license-deactivate")!.click();
    await handle.idle();

    expect(invoke.mock.calls.some((c) => c[0] === "license_deactivate")).toBe(
      true,
    );
    expect(container.querySelector(".license-key-input")).toBeTruthy();
    expect(container.querySelector(".license-deactivate")).toBeNull();
  });

  it("renders nothing and redirects on a non-desktop surface", async () => {
    const invoke = vi.fn();
    const onRedirect = vi.fn();
    const container = document.createElement("div");
    const handle = renderLicense(container, {
      invoke,
      isDesktop: false,
      onRedirect,
    });
    await handle.ready;

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(container.children.length).toBe(0);
    // Never touched the desktop commands.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("renders nothing and redirects when the command bridge is unavailable", async () => {
    const onRedirect = vi.fn();
    const container = document.createElement("div");
    // Desktop surface but no invoke bridge (null) → defense-in-depth redirect.
    const handle = renderLicense(container, {
      invoke: null,
      isDesktop: true,
      onRedirect,
    });
    await handle.ready;

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(container.children.length).toBe(0);
  });
});

describe("formatLicenseDate", () => {
  it("renders an RFC3339 certificate timestamp as a local date", () => {
    const raw = "2026-12-29T18:28:53.819058+00:00";
    expect(formatLicenseDate(raw)).toBe(new Date(raw).toLocaleDateString());
    // The noisy raw form must not leak through.
    expect(formatLicenseDate(raw)).not.toContain("T18:28");
  });

  it("falls back to the raw string when unparseable", () => {
    expect(formatLicenseDate("not-a-date")).toBe("not-a-date");
  });
});
