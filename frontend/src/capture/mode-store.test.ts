import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_CAPTURE_MODE_KEY,
  LIVE_CAPTIONS_KEY,
  loadLiveCaptions,
  saveLiveCaptions,
} from "./mode-store";

describe("mode-store (liveCaptionsEnabled)", () => {
  afterEach(() => {
    window.localStorage.removeItem(LIVE_CAPTIONS_KEY);
    window.localStorage.removeItem(LEGACY_CAPTURE_MODE_KEY);
  });

  it("defaults to false (live captions off) when nothing is stored", () => {
    expect(loadLiveCaptions()).toBe(false);
  });

  it("save/load round-trips the boolean", () => {
    saveLiveCaptions(true);
    expect(loadLiveCaptions()).toBe(true);
    saveLiveCaptions(false);
    expect(loadLiveCaptions()).toBe(false);
  });

  it("migrates the legacy captureMode 'live' to true", () => {
    window.localStorage.setItem(LEGACY_CAPTURE_MODE_KEY, "live");
    expect(loadLiveCaptions()).toBe(true);
  });

  it("migrates legacy 'batch' / missing / garbage to false", () => {
    window.localStorage.setItem(LEGACY_CAPTURE_MODE_KEY, "batch");
    expect(loadLiveCaptions()).toBe(false);
    window.localStorage.setItem(LEGACY_CAPTURE_MODE_KEY, "garbage");
    expect(loadLiveCaptions()).toBe(false);
    window.localStorage.removeItem(LEGACY_CAPTURE_MODE_KEY);
    expect(loadLiveCaptions()).toBe(false);
  });

  it("prefers the new key over the legacy value once saved", () => {
    window.localStorage.setItem(LEGACY_CAPTURE_MODE_KEY, "live");
    saveLiveCaptions(false);
    // New explicit choice wins over the legacy migration.
    expect(loadLiveCaptions()).toBe(false);
  });
});
