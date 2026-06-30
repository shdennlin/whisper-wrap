import { afterEach, describe, expect, it } from "vitest";

import {
  navigateToView,
  onViewChange,
  parseViewHash,
  viewToHash,
  type View,
} from "./view-route";

describe("parseViewHash", () => {
  it("maps empty / bare-hash / unknown to home", () => {
    expect(parseViewHash("")).toEqual({ name: "home" });
    expect(parseViewHash("#")).toEqual({ name: "home" });
    expect(parseViewHash("#/")).toEqual({ name: "home" });
    expect(parseViewHash("#/nope")).toEqual({ name: "home" });
  });

  it("maps the static views", () => {
    expect(parseViewHash("#/library")).toEqual({ name: "library" });
    expect(parseViewHash("#/models")).toEqual({ name: "models" });
    expect(parseViewHash("#/settings")).toEqual({ name: "settings" });
  });

  it("maps an item route to detail with the id", () => {
    expect(parseViewHash("#/item/abc")).toEqual({ name: "detail", itemId: "abc" });
  });

  it("rejects empty / multi-segment item ids back to home", () => {
    expect(parseViewHash("#/item/")).toEqual({ name: "home" });
    expect(parseViewHash("#/item/a/b")).toEqual({ name: "home" });
  });
});

describe("viewToHash round-trips through parseViewHash", () => {
  it("every view round-trips", () => {
    const views: View[] = [
      { name: "home" },
      { name: "library" },
      { name: "models" },
      { name: "settings" },
      { name: "detail", itemId: "x" },
    ];
    for (const v of views) {
      expect(parseViewHash(viewToHash(v))).toEqual(v);
    }
  });
});

describe("onViewChange / navigateToView", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("fires synchronously with the current view on subscribe", () => {
    const seen: View[] = [];
    const off = onViewChange((v) => seen.push(v));
    expect(seen).toHaveLength(1);
    off();
  });

  it("notifies subscribers when navigating", () => {
    const seen: View[] = [];
    const off = onViewChange((v) => seen.push(v));
    navigateToView({ name: "library" }, { replace: true });
    expect(seen.at(-1)).toEqual({ name: "library" });
    off();
  });
});
