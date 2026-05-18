import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  navigateToHistory,
  onRouteChange,
  parseHash,
  type ParsedRoute,
} from "./hash-route";

describe("parseHash", () => {
  it("maps the empty hash to the shell route", () => {
    expect(parseHash("")).toEqual({ name: "shell" });
  });

  it("maps a bare '#' to the shell route", () => {
    expect(parseHash("#")).toEqual({ name: "shell" });
  });

  it("maps '#/history' to history route with null sessionId", () => {
    expect(parseHash("#/history")).toEqual({ name: "history", sessionId: null });
  });

  it("maps '#/history/<id>' to history route with that sessionId", () => {
    expect(parseHash("#/history/abc-123")).toEqual({
      name: "history",
      sessionId: "abc-123",
    });
  });

  it("falls back to shell for unrecognized routes", () => {
    expect(parseHash("#/foo")).toEqual({ name: "shell" });
  });

  it("treats malformed history paths as shell", () => {
    // Trailing slash with nothing after — sessionId would be empty string
    expect(parseHash("#/history/")).toEqual({ name: "shell" });
    // Multiple path segments after id — out of contract
    expect(parseHash("#/history/abc/def")).toEqual({ name: "shell" });
    expect(parseHash("#/history//")).toEqual({ name: "shell" });
  });

  it("is total (never throws) for arbitrary garbage", () => {
    expect(() => parseHash("#????///!!")).not.toThrow();
    expect(() => parseHash("not-a-hash")).not.toThrow();
  });
});

describe("onRouteChange", () => {
  const originalHash = window.location.hash;

  beforeEach(() => {
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = originalHash;
  });

  it("fires the handler synchronously with the current route on register", () => {
    window.location.hash = "#/history/initial";
    const handler = vi.fn();
    const unsubscribe = onRouteChange(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      name: "history",
      sessionId: "initial",
    } satisfies ParsedRoute);
    unsubscribe();
  });

  it("calls the handler on subsequent hashchange events", () => {
    const handler = vi.fn();
    const unsubscribe = onRouteChange(handler);
    handler.mockClear();

    window.location.hash = "#/history";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(handler).toHaveBeenCalledWith({
      name: "history",
      sessionId: null,
    } satisfies ParsedRoute);

    window.location.hash = "";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(handler).toHaveBeenLastCalledWith({
      name: "shell",
    } satisfies ParsedRoute);

    unsubscribe();
  });

  it("unsubscribes cleanly", () => {
    const handler = vi.fn();
    const unsubscribe = onRouteChange(handler);
    handler.mockClear();

    unsubscribe();
    window.location.hash = "#/history";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("navigateToHistory", () => {
  const originalHash = window.location.hash;

  afterEach(() => {
    window.location.hash = originalHash;
  });

  it("sets the rail-only hash when called with no id", () => {
    navigateToHistory();
    expect(window.location.hash).toBe("#/history");
  });

  it("sets the per-session hash when given an id", () => {
    navigateToHistory("xyz-1");
    expect(window.location.hash).toBe("#/history/xyz-1");
  });
});
