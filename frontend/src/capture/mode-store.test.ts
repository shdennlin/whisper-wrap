import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_MODE_KEY,
  DEFAULT_CAPTURE_MODE,
  loadCaptureMode,
  saveCaptureMode,
} from "./mode-store";

describe("mode-store", () => {
  afterEach(() => {
    window.localStorage.removeItem(CAPTURE_MODE_KEY);
  });

  it("returns batch by default when nothing is stored", () => {
    expect(loadCaptureMode()).toBe(DEFAULT_CAPTURE_MODE);
    expect(loadCaptureMode()).toBe("batch");
  });

  it("persists and reads back the chosen mode", () => {
    saveCaptureMode("live");
    expect(loadCaptureMode()).toBe("live");
    saveCaptureMode("batch");
    expect(loadCaptureMode()).toBe("batch");
  });

  it("falls back to batch when stored value is garbage", () => {
    window.localStorage.setItem(CAPTURE_MODE_KEY, "garbage");
    expect(loadCaptureMode()).toBe("batch");
  });
});
