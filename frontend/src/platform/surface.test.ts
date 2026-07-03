import { afterEach, describe, expect, it } from "vitest";

import { bootLandingView, resolveSurface, surfaceProfile } from "./surface";

/** Toggle the Tauri command bridge the way capability.isDesktopShell() probes
 *  it (window.__TAURI__.core.invoke). */
function setBridge(present: boolean): void {
  if (present) {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
    };
  } else {
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  }
}

describe("resolveSurface", () => {
  afterEach(() => setBridge(false));

  it("resolves desktop when the Tauri bridge is present", () => {
    setBridge(true);
    expect(resolveSurface()).toBe("desktop");
  });

  it("resolves web in a plain browser", () => {
    setBridge(false);
    expect(resolveSurface()).toBe("web");
  });
});

describe("surfaceProfile", () => {
  it("web lands capture-first with Models hidden", () => {
    const p = surfaceProfile("web");
    expect(p.surface).toBe("web");
    expect(p.defaultView).toBe("home");
    expect(p.homeDensity).toBe("compact");
    expect(p.nav).toEqual(["home", "library", "settings"]);
    expect(p.nav).not.toContain("models");
    // fe-license-tab: the License item is desktop-only — web never renders it.
    expect(p.nav).not.toContain("license");
    expect(p.modelsAccess).toBe("hidden");
    expect(p.showDesktopShortcuts).toBe(false);
    expect(p.showExperimental).toBe(false);
  });

  it("desktop lands on the full workspace with Models present", () => {
    const p = surfaceProfile("desktop");
    expect(p.surface).toBe("desktop");
    expect(p.defaultView).toBe("library");
    expect(p.homeDensity).toBe("full");
    expect(p.nav).toEqual(["home", "library", "models", "settings", "license"]);
    expect(p.nav).toContain("models");
    // fe-license-tab: License is a desktop-only sidebar destination.
    expect(p.nav).toContain("license");
    expect(p.modelsAccess).toBe("full");
    expect(p.showDesktopShortcuts).toBe(true);
    expect(p.showExperimental).toBe(true);
  });

  it("returns a fresh nav array so callers cannot mutate the shared profile", () => {
    const a = surfaceProfile("web");
    a.nav.push("models");
    const b = surfaceProfile("web");
    expect(b.nav).toEqual(["home", "library", "settings"]);
  });
});

describe("bootLandingView", () => {
  it("lands on home for the web default at an empty hash", () => {
    expect(bootLandingView("", "home")).toEqual({ name: "home" });
    expect(bootLandingView("#", "home")).toEqual({ name: "home" });
    expect(bootLandingView("#/", "home")).toEqual({ name: "home" });
  });

  it("lands on library for the desktop default at an empty hash", () => {
    expect(bootLandingView("", "library")).toEqual({ name: "library" });
    expect(bootLandingView("#/", "library")).toEqual({ name: "library" });
  });

  it("honors a non-empty deep-link hash (no override)", () => {
    expect(bootLandingView("#/item/abc", "library")).toBeNull();
    expect(bootLandingView("#/settings", "home")).toBeNull();
    expect(bootLandingView("#/models", "library")).toBeNull();
  });
});
