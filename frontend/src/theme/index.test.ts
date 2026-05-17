import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME,
  getTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
  THEME_STORAGE_KEY,
} from "./index";

/**
 * Theme is a small, well-contained module: load → save → apply → resolve.
 * These tests pin the contract that the rest of the UI relies on:
 *   - default is "system" (no localStorage write on a fresh visit)
 *   - explicit picks survive a reload
 *   - applyTheme writes data-theme on <html> and updates <meta theme-color>
 *   - "system" follows prefers-color-scheme via matchMedia
 */
describe("theme", () => {
  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme");
    document.head
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((n) => n.remove());
    // Default matchMedia stub: OS in light mode.
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => {
      return {
        matches: false,
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme");
    loadTheme();
  });

  it("defaults to 'system' when no preference is stored", () => {
    expect(loadTheme()).toBe(DEFAULT_THEME);
    expect(getTheme()).toBe("system");
  });

  it("persists explicit picks and clears storage for system", () => {
    saveTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    saveTheme("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("applyTheme writes data-theme on <html> for explicit picks", () => {
    saveTheme("light");
    expect(applyTheme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    saveTheme("dark");
    expect(applyTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applyTheme updates the <meta name=theme-color> tag", () => {
    saveTheme("dark");
    applyTheme();
    const meta = document.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    expect(meta?.content).toBe("#0f1115");

    saveTheme("light");
    applyTheme();
    expect(
      document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe("#ffffff");
  });

  it("resolveTheme('system') follows prefers-color-scheme", () => {
    // OS reports dark.
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: true,
          media: q,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    saveTheme("system");
    expect(resolveTheme()).toBe("dark");
    expect(applyTheme()).toBe("dark");
  });
});
