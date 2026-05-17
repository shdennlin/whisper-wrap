/**
 * Theme runtime.
 *
 * Mirrors the shape of ./i18n/index.ts on purpose — small surface, predictable
 * persistence. Three logical states:
 *   - "light":  force light, regardless of OS preference
 *   - "dark":   force dark
 *   - "system": follow `prefers-color-scheme` (default for first-time visitors)
 *
 * The resolved theme is written as `data-theme="light|dark"` on <html>. CSS
 * variables in style.css key off that attribute. The OS media-query fallback
 * also keys off `:root:not([data-theme])` so a pre-paint without JS still
 * respects the OS, but as soon as applyTheme() runs the attribute takes over.
 *
 * `<meta name="theme-color">` is updated alongside the attribute so the iOS
 * PWA status-bar tint matches the chosen theme.
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "whisper-wrap.theme";
export const DEFAULT_THEME: Theme = "system";

const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#ffffff",
  dark: "#0f1115",
};

let activeTheme: Theme = DEFAULT_THEME;
let mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;

export function loadTheme(): Theme {
  const stored =
    typeof window !== "undefined"
      ? window.localStorage.getItem(THEME_STORAGE_KEY)
      : null;
  activeTheme = isTheme(stored) ? stored : DEFAULT_THEME;
  return activeTheme;
}

export function saveTheme(theme: Theme): void {
  activeTheme = theme;
  if (typeof window === "undefined") return;
  if (theme === DEFAULT_THEME) {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
}

export function getTheme(): Theme {
  return activeTheme;
}

export function resolveTheme(theme: Theme = activeTheme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

export function applyTheme(theme: Theme = activeTheme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", resolved);
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = THEME_COLORS[resolved];
  }
  syncSystemListener(theme);
  return resolved;
}

function syncSystemListener(theme: Theme): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mediaQueryListener) {
    mq.removeEventListener("change", mediaQueryListener);
    mediaQueryListener = null;
  }
  if (theme !== "system") return;
  mediaQueryListener = () => {
    if (activeTheme === "system") applyTheme("system");
  };
  mq.addEventListener("change", mediaQueryListener);
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function isTheme(s: string | null): s is Theme {
  return s === "light" || s === "dark" || s === "system";
}
