import { beforeEach, describe, expect, it } from "vitest";

import { SettingsPanel, type SettingsPanelOptions } from "./settings-panel";

/**
 * Surface-profile gating of the desktop-only Settings sections. The panel no
 * longer probes `isDesktopShell()` itself — it renders the Shortcuts /
 * auto-paste / Experimental sections from the `showDesktopShortcuts` and
 * `showExperimental` flags the surface profile passes in (via main.ts).
 */
describe("SettingsPanel — desktop section gating", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  function mount(overrides: Partial<SettingsPanelOptions> = {}): SettingsPanel {
    return new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
      ...overrides,
    });
  }

  function hasCheckboxLabelled(text: string): boolean {
    return [...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox")].some(
      (l) => l.textContent?.includes(text),
    );
  }

  it("shows the Shortcuts section only when showDesktopShortcuts is true", () => {
    mount({ showDesktopShortcuts: false });
    expect(host.querySelector(".settings-shortcut-btn")).toBeNull();
    expect(hasCheckboxLabelled("⌥Space")).toBe(false);

    host.replaceChildren();
    mount({ showDesktopShortcuts: true });
    expect(host.querySelector(".settings-shortcut-btn")).toBeTruthy();
    expect(hasCheckboxLabelled("⌥Space")).toBe(true);
  });

  it("shows the auto-paste row under showDesktopShortcuts", () => {
    mount({ showDesktopShortcuts: false });
    expect(hasCheckboxLabelled("Auto-paste transcript")).toBe(false);

    host.replaceChildren();
    mount({ showDesktopShortcuts: true });
    expect(hasCheckboxLabelled("Auto-paste transcript")).toBe(true);
  });

  it("shows the Experimental section only when showExperimental is true", () => {
    mount({ showExperimental: false });
    expect(hasCheckboxLabelled("Pause media while recording")).toBe(false);

    host.replaceChildren();
    mount({ showExperimental: true });
    expect(hasCheckboxLabelled("Pause media while recording")).toBe(true);
  });

  it("defaults to hiding both desktop-only sections when no flags are given", () => {
    mount();
    expect(host.querySelector(".settings-shortcut-btn")).toBeNull();
    expect(hasCheckboxLabelled("Pause media while recording")).toBe(false);
  });

  describe("filter() (driven by the view's top search box)", () => {
    const fieldFor = (label: string): HTMLElement =>
      [...host.querySelectorAll<HTMLElement>(".settings-field")].find((f) =>
        f.textContent?.includes(label),
      )!;

    it("hides rows and their card when the query doesn't match", () => {
      const panel = mount();
      const audioSave = fieldFor("Save audio for replay");
      const autoCopy = fieldFor("Auto-copy transcript");
      panel.filter("save audio");
      expect(audioSave.hidden).toBe(false);
      expect(autoCopy.hidden).toBe(true);
      // The Output & Paste card (autoCopy's card) has no match → hidden.
      expect(autoCopy.closest(".settings-card")!.hasAttribute("hidden")).toBe(true);
    });

    it("restores everything when the query is cleared", () => {
      const panel = mount();
      const autoCopy = fieldFor("Auto-copy transcript");
      panel.filter("save audio");
      expect(autoCopy.hidden).toBe(true);
      panel.filter("");
      expect(autoCopy.hidden).toBe(false);
      expect(host.querySelector(".settings-search-empty")?.hasAttribute("hidden")).toBe(true);
    });

    it("shows an empty-state line when nothing matches", () => {
      const panel = mount();
      panel.filter("zzzznotathing");
      const empty = host.querySelector<HTMLElement>(".settings-search-empty")!;
      expect(empty).toBeTruthy();
      expect(empty.hidden).toBe(false);
    });
  });
});
