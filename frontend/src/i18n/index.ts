/**
 * Minimal i18n runtime.
 *
 * Two locales (en, zh-TW), no plural rules, simple `{name}` interpolation.
 * Default is English: a brand-new visitor (no localStorage key) sees English
 * regardless of browser language, so the app's UX language is predictable
 * across machines.
 *
 * The "set locale" flow reloads the page rather than re-rendering every
 * component — for a small PWA where switching happens once or twice, a
 * 200 ms reload is dramatically cheaper than wiring an observable through
 * every component constructor.
 */

import { STRINGS } from "./strings";

export type Locale = keyof typeof STRINGS;
export type StringKey = keyof (typeof STRINGS)["en"];

export const LOCALE_STORAGE_KEY = "whisper-wrap.locale";
export const DEFAULT_LOCALE: Locale = "en";
export const AVAILABLE_LOCALES: ReadonlyArray<Locale> = ["en", "zh-TW"];

let activeLocale: Locale = DEFAULT_LOCALE;

export function loadLocale(): Locale {
  const stored = typeof window !== "undefined"
    ? window.localStorage.getItem(LOCALE_STORAGE_KEY)
    : null;
  if (stored && isLocale(stored)) {
    activeLocale = stored;
  } else {
    activeLocale = DEFAULT_LOCALE;
  }
  return activeLocale;
}

export function saveLocale(loc: Locale): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, loc);
  activeLocale = loc;
}

export function getLocale(): Locale {
  return activeLocale;
}

export function t(
  key: StringKey,
  vars?: Record<string, string | number>,
): string {
  const table = STRINGS[activeLocale] as Readonly<Record<StringKey, string>>;
  const template = table[key] ?? (STRINGS.en as Readonly<Record<StringKey, string>>)[key] ?? String(key);
  return vars ? interpolate(template, vars) : template;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const v = vars[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

function isLocale(s: string): s is Locale {
  return (AVAILABLE_LOCALES as readonly string[]).includes(s);
}
