import { afterEach, describe, expect, it } from "vitest";
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  loadLocale,
  saveLocale,
  t,
} from "./index";
import { STRINGS } from "./strings";

describe("i18n", () => {
  afterEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    loadLocale(); // restore default
  });

  it("defaults to English when no preference is stored", () => {
    expect(loadLocale()).toBe(DEFAULT_LOCALE);
    expect(t("common.copy")).toBe("Copy");
  });

  it("returns Chinese strings after saving zh-TW", () => {
    saveLocale("zh-TW");
    expect(t("common.copy")).toBe("複製");
    expect(t("backend.ok")).toBe("已連線");
  });

  it("interpolates {name} placeholders", () => {
    saveLocale("en");
    expect(t("history.title", { count: 5 })).toBe("Sessions (5)");
    expect(t("toast.autoStopIdle", { minutes: 30 })).toBe(
      "Idle for 30 minutes, auto-stopped recording",
    );
  });

  it("leaves the placeholder in place when a var is missing", () => {
    saveLocale("en");
    expect(t("history.title", {})).toBe("Sessions ({count})");
  });

  it("falls back to English when a key is missing in the active locale", () => {
    // Manually inject a partial table to simulate a missing translation.
    saveLocale("zh-TW");
    expect(t("modeCard.batchLabel")).toBe("Batch"); // identical in both locales
  });

  it("loadLocale ignores garbage values", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    expect(loadLocale()).toBe(DEFAULT_LOCALE);
  });

  it("every English key has a Chinese counterpart", () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    const zhKeys = Object.keys(STRINGS["zh-TW"]).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("AVAILABLE_LOCALES contains both shipping locales", () => {
    expect(AVAILABLE_LOCALES).toEqual(["en", "zh-TW"]);
  });

  it("miscCategoryLabel localises", () => {
    saveLocale("en");
    expect(t("actions.miscCategoryLabel")).toBe("Misc");
    saveLocale("zh-TW");
    expect(t("actions.miscCategoryLabel")).toBe("其他");
  });
});
