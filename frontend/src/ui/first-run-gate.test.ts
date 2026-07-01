/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { maybeShowFirstRunGate, isModelLoaded } from "./first-run-gate";

/** The `/status` liveness probe now routes through the generated client (which
 * calls `globalThis.fetch` by default), while the un-migrated ModelManager still
 * calls `globalThis.fetch` directly — so stubbing `globalThis.fetch` covers
 * both. openapi-fetch needs a real `Response` (it reads headers + parses JSON),
 * and receives a `Request` object as its single argument, so extract the URL
 * from either shape. */
function reqUrl(input: string | Request): string {
  return typeof input === "string" ? input : input.url;
}

/** openapi-fetch calls `fetch` with a single `Request` (method lives on it, not
 * in an `init` arg), so read the method from the Request when present. */
function reqMethod(input: string | Request, init?: RequestInit): string {
  return typeof input === "string" ? (init?.method ?? "GET") : input.method;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | Request) =>
      Promise.resolve(jsonResponse(handler(reqUrl(input)))),
    ),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const gate = () => document.querySelector('[data-testid="first-run-gate"]');

describe("first-run gate", () => {
  it("isModelLoaded reflects status.model.loaded", async () => {
    mockFetch(() => ({ model: { loaded: true } }));
    expect(await isModelLoaded()).toBe(true);

    mockFetch(() => ({ model: { loaded: false } }));
    expect(await isModelLoaded()).toBe(false);
  });

  it("does NOT show the gate when a model is already loaded", async () => {
    mockFetch(() => ({ model: { loaded: true } }));
    const shown = await maybeShowFirstRunGate();
    expect(shown).toBe(false);
    expect(gate()).toBeNull();
  });

  it("shows the gate (with the model manager) when no model is loaded", async () => {
    mockFetch((url) =>
      url.endsWith("/status")
        ? { model: { loaded: false } }
        : { active: "", models: [] }, // ModelManager's GET /models
    );
    const shown = await maybeShowFirstRunGate();
    expect(shown).toBe(true);
    expect(gate()).not.toBeNull();
    expect(gate()!.querySelector(".model-manager")).not.toBeNull();
  });

  it("reveals Continue-in-background once a download starts; finishing in background toasts instead of reloading", async () => {
    vi.useFakeTimers();
    let downloading = false;
    let installed = false;
    let loaded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | Request, init?: RequestInit) => {
        const url = reqUrl(input);
        let body: unknown;
        if (url.endsWith("/status")) {
          body = { model: { loaded } };
        } else if (url.endsWith("/models/download") && reqMethod(input, init) === "POST") {
          downloading = true;
          body = { name: "breeze", status: "downloading" };
        } else if (url.includes("/models/download/")) {
          installed = downloading;
          body = { name: "breeze", status: downloading ? "done" : "idle" };
        } else if (url.endsWith("/models/active") && reqMethod(input, init) === "POST") {
          loaded = true;
          body = { active: "breeze", swapped: true };
        } else {
          body = {
            active: "breeze",
            loaded,
            models: [
              {
                name: "breeze",
                description: null,
                license: null,
                formats: ["ggml"],
                installed,
                runnable: true,
              },
            ],
          };
        }
        return Promise.resolve(jsonResponse(body));
      }),
    );

    const onReady = vi.fn();
    await maybeShowFirstRunGate(onReady);
    await vi.advanceTimersByTimeAsync(0);

    const bgBtn = gate()!.querySelector<HTMLButtonElement>(".first-run-bg");
    expect(bgBtn).not.toBeNull();
    expect(bgBtn!.hidden).toBe(true); // hidden until a download is running

    // Start the download → background button appears.
    gate()!.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bgBtn!.hidden).toBe(false);

    // Enter the main page; the gate goes away but the download keeps going.
    bgBtn!.click();
    expect(gate()).toBeNull();

    // Poll tick: done → auto-activate → ready lands as a toast, no reload.
    // The poll + auto-activate now run through the openapi-fetch client, which
    // adds several await hops per request; drain them before asserting.
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(document.querySelector(".toast")).not.toBeNull();
  });

  it("a background download failure surfaces as an action toast that re-opens the gate", async () => {
    vi.useFakeTimers();
    let downloading = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | Request, init?: RequestInit) => {
        const url = reqUrl(input);
        let body: unknown;
        if (url.endsWith("/status")) {
          body = { model: { loaded: false } };
        } else if (url.endsWith("/models/download") && reqMethod(input, init) === "POST") {
          downloading = true;
          body = { name: "breeze", status: "downloading" };
        } else if (url.includes("/models/download/")) {
          body = downloading
            ? { name: "breeze", status: "error", error: "network died" }
            : { name: "breeze", status: "idle" };
        } else {
          body = {
            active: "breeze",
            loaded: false,
            models: [
              {
                name: "breeze",
                description: null,
                license: null,
                formats: ["ggml"],
                installed: false,
                runnable: true,
              },
            ],
          };
        }
        return Promise.resolve(jsonResponse(body));
      }),
    );

    const onReady = vi.fn();
    await maybeShowFirstRunGate(onReady);
    await vi.advanceTimersByTimeAsync(0);

    gate()!.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    gate()!.querySelector<HTMLButtonElement>(".first-run-bg")!.click();
    expect(gate()).toBeNull();

    // Poll tick → error while backgrounded → action toast, not silence.
    // Drain the openapi-fetch client's await hops before asserting the toast.
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    const toastNode = document.querySelector(".toast");
    expect(toastNode?.textContent).toContain("network died");

    // The toast's action brings the setup gate back.
    toastNode!.querySelector<HTMLButtonElement>(".toast-action")!.click();
    expect(gate()).not.toBeNull();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("treats an unreachable backend as needs-setup (shows the gate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | Request) =>
        reqUrl(input).endsWith("/status")
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(jsonResponse({ active: "", models: [] })),
      ),
    );
    const shown = await maybeShowFirstRunGate();
    expect(shown).toBe(true);
    expect(gate()).not.toBeNull();
  });
});
