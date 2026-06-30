/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { maybeShowFirstRunGate, isModelLoaded } from "./first-run-gate";

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(handler(String(input))),
      } as Response),
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
    expect(await isModelLoaded("http://x")).toBe(true);

    mockFetch(() => ({ model: { loaded: false } }));
    expect(await isModelLoaded("http://x")).toBe(false);
  });

  it("does NOT show the gate when a model is already loaded", async () => {
    mockFetch(() => ({ model: { loaded: true } }));
    const shown = await maybeShowFirstRunGate(() => "http://x");
    expect(shown).toBe(false);
    expect(gate()).toBeNull();
  });

  it("shows the gate (with the model manager) when no model is loaded", async () => {
    mockFetch((url) =>
      url.endsWith("/status")
        ? { model: { loaded: false } }
        : { active: "", models: [] }, // ModelManager's GET /models
    );
    const shown = await maybeShowFirstRunGate(() => "http://x");
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
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        let body: unknown;
        if (url.endsWith("/status")) {
          body = { model: { loaded } };
        } else if (url.endsWith("/models/download") && init?.method === "POST") {
          downloading = true;
          body = { name: "breeze", status: "downloading" };
        } else if (url.includes("/models/download/")) {
          installed = downloading;
          body = { name: "breeze", status: downloading ? "done" : "idle" };
        } else if (url.endsWith("/models/active") && init?.method === "POST") {
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
      }),
    );

    const onReady = vi.fn();
    await maybeShowFirstRunGate(() => "http://x", onReady);
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
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReady).not.toHaveBeenCalled();
    expect(document.querySelector(".toast")).not.toBeNull();
  });

  it("a background download failure surfaces as an action toast that re-opens the gate", async () => {
    vi.useFakeTimers();
    let downloading = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        let body: unknown;
        if (url.endsWith("/status")) {
          body = { model: { loaded: false } };
        } else if (url.endsWith("/models/download") && init?.method === "POST") {
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
      }),
    );

    const onReady = vi.fn();
    await maybeShowFirstRunGate(() => "http://x", onReady);
    await vi.advanceTimersByTimeAsync(0);

    gate()!.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    gate()!.querySelector<HTMLButtonElement>(".first-run-bg")!.click();
    expect(gate()).toBeNull();

    // Poll tick → error while backgrounded → action toast, not silence.
    await vi.advanceTimersByTimeAsync(2000);
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
      vi.fn((input: string) =>
        String(input).endsWith("/status")
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ active: "", models: [] }),
            } as Response),
      ),
    );
    const shown = await maybeShowFirstRunGate(() => "http://x");
    expect(shown).toBe(true);
    expect(gate()).not.toBeNull();
  });
});
