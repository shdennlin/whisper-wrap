import { describe, expect, it, vi } from "vitest";

import { renderSettings } from "./settings-view";
import type { AiProviderFormDeps } from "./ai-provider-form";
import type { AiConfigView } from "../api/ai-config";
import type { DictionarySectionDeps } from "./dictionary-section";

const SAVED: AiConfigView = {
  provider: "gemini",
  baseUrl: "",
  model: "gemini-3.1-flash-lite",
  keySet: true,
  keyHint: "AIza…9b2c",
  systemPromptSet: false,
};

function aiDeps(overrides: Partial<AiProviderFormDeps> = {}): AiProviderFormDeps {
  return {
    getConfig: async () => SAVED,
    putConfig: async (u) => ({ ...SAVED, model: u.model }),
    listModels: async () => ({ models: [], error: null }),
    testConfig: async () => ({ ok: true, error: null }),
    ...overrides,
  };
}

function dictDeps(): DictionarySectionDeps {
  return {
    get: async () => ({
      zh_convert: "off",
      replacements: [{ from: "Cloud Code", to: "Claude Code" }],
    }),
    put: async (c) => c,
  };
}

describe("renderSettings", () => {
  it("mounts the AI provider editor and the settings panel", async () => {
    const container = document.createElement("div");
    const mount = vi.fn();
    await renderSettings(container, { mount, aiDeps: aiDeps() });
    // The editor replaced the old read-only indicator.
    const form = container.querySelector<HTMLElement>(".ai-provider-form")!;
    expect(form).toBeTruthy();
    expect(form.querySelector(".ai-provider-select")).toBeTruthy();
    expect(form.querySelector(".ai-save-btn")).toBeTruthy();
    expect(mount).toHaveBeenCalledWith(container.querySelector(".settings-host"));
  });

  it("frames the view with a row title, mrow ai card and an mrow-frame host wrap", async () => {
    const container = document.createElement("div");
    await renderSettings(container, { mount: () => {}, aiDeps: aiDeps() });
    expect(container.querySelector(".row-title h3")!.textContent).toBe("Settings");
    const ai = container.querySelector<HTMLElement>(".settings-ai")!;
    expect(ai.classList.contains("mrow")).toBe(true);
    const host = container.querySelector<HTMLElement>(".settings-host")!;
    expect(host.parentElement!.classList.contains("mrow-frame")).toBe(true);
  });

  it("renders the editor in a plain browser (no desktop shell)", async () => {
    // No __TAURI__ on window → plain-browser path; the editor must still mount.
    expect(
      (window as unknown as { __TAURI__?: unknown }).__TAURI__,
    ).toBeUndefined();
    const container = document.createElement("div");
    await renderSettings(container, { mount: () => {}, aiDeps: aiDeps() });
    expect(container.querySelector(".ai-provider-form")).toBeTruthy();
  });

  it("renders the saved config's masked key without exposing the raw key", async () => {
    const container = document.createElement("div");
    await renderSettings(container, { mount: () => {}, aiDeps: aiDeps() });
    const hint = container.querySelector<HTMLElement>(".ai-key-hint")!;
    expect(hint.textContent).toContain("AIza…9b2c");
    const keyInput = container.querySelector<HTMLInputElement>(".ai-key-input")!;
    expect(keyInput.value).toBe("");
  });

  it("mounts the dictionary section as its own mrow card (zh-convert-dictionary)", async () => {
    const container = document.createElement("div");
    await renderSettings(container, {
      mount: () => {},
      aiDeps: aiDeps(),
      dictDeps: dictDeps(),
    });
    const dict = container.querySelector<HTMLElement>(".settings-dictionary")!;
    expect(dict).toBeTruthy();
    expect(dict.classList.contains("mrow")).toBe(true);
    expect(dict.querySelector("[data-dict-toggle]")).toBeTruthy();
    expect(dict.querySelectorAll("[data-dict-row]")).toHaveLength(1);
  });

  it("the settings search filter hides and shows the dictionary section", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettings(container, {
      mount: () => {},
      aiDeps: aiDeps(),
      dictDeps: dictDeps(),
    });
    const search = container.querySelector<HTMLInputElement>(".settings-search-input")!;
    const dict = container.querySelector<HTMLElement>(".settings-dictionary")!;

    search.value = "zzzz-no-match";
    search.dispatchEvent(new Event("input"));
    expect(dict.hidden).toBe(true);

    // Matches a stored pair's text (lives in <input> values).
    search.value = "claude";
    search.dispatchEvent(new Event("input"));
    expect(dict.hidden).toBe(false);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(dict.hidden).toBe(false);
  });

  it("still renders the editor when the config read fails", async () => {
    const container = document.createElement("div");
    await renderSettings(container, {
      mount: () => {},
      aiDeps: aiDeps({
        getConfig: async () => {
          throw new Error("offline");
        },
      }),
    });
    expect(container.querySelector(".ai-provider-form")).toBeTruthy();
  });
});
