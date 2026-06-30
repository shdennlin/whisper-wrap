import { describe, expect, it } from "vitest";

import { LIBRARY_CHANGED_EVENT } from "./library-events";

describe("library-events", () => {
  // The literal is a cross-process contract: the desktop shell emits this exact
  // event name and the extracted overlay surface re-declares it independently.
  // Locking the value here makes any accidental rename a visible, failing test
  // rather than a silent break of the cross-window refresh.
  it("exposes the stable native event name", () => {
    expect(LIBRARY_CHANGED_EVENT).toBe("library-changed");
  });
});
