/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MEETING_VIEW_MODE,
  loadMeetingViewMode,
  MEETING_VIEW_MODE_KEY,
  saveMeetingViewMode,
} from "./view-mode-store";

beforeEach(() => {
  window.localStorage.removeItem(MEETING_VIEW_MODE_KEY);
});

describe("view-mode-store", () => {
  it("defaults to chat when nothing is stored", () => {
    expect(loadMeetingViewMode()).toBe("chat");
    expect(DEFAULT_MEETING_VIEW_MODE).toBe("chat");
  });

  it("persists and reads back the stored value", () => {
    saveMeetingViewMode("detail");
    expect(loadMeetingViewMode()).toBe("detail");
    saveMeetingViewMode("chat");
    expect(loadMeetingViewMode()).toBe("chat");
  });

  it("falls back to the default for invalid stored values", () => {
    window.localStorage.setItem(MEETING_VIEW_MODE_KEY, "garbage");
    expect(loadMeetingViewMode()).toBe(DEFAULT_MEETING_VIEW_MODE);
  });
});
