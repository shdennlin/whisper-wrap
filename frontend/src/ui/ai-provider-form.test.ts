/**
 * Tests for the AI-provider editor (ai-provider-settings task 4.2).
 *
 * Pins the security-critical + behavioural contract: masked render (raw key
 * never shown), preset → base-url prefill, Gemini hides base-url, manual
 * refresh populates from a stubbed endpoint, custom free-text model accepted +
 * submitted, NO discovery fetch on load, and a blank key field submits an empty
 * apiKey so the server keeps the stored key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LOCALE_STORAGE_KEY, loadLocale } from "../i18n";
import { mountAiProviderForm, type AiProviderFormDeps } from "./ai-provider-form";
import type {
  AiConfigView,
  AiConfigUpdate,
  AiModelsResult,
  AiTestResult,
} from "../api/ai-config";

const SAVED_GEMINI: AiConfigView = {
  provider: "gemini",
  baseUrl: "",
  model: "gemini-3.1-flash-lite",
  keySet: true,
  keyHint: "AIza…9b2c",
  systemPromptSet: false,
};

function makeDeps(overrides: Partial<AiProviderFormDeps> = {}): AiProviderFormDeps {
  return {
    getConfig: async () => SAVED_GEMINI,
    putConfig: async (u) => ({ ...SAVED_GEMINI, model: u.model }),
    listModels: async () => ({ models: [], error: null }),
    testConfig: async () => ({ ok: true, error: null }),
    ...overrides,
  };
}

async function mount(deps: AiProviderFormDeps): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await mountAiProviderForm(host, deps);
  return host;
}

function providerSelect(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>(".ai-provider-select")!;
}
function baseUrlField(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>(".ai-baseurl-field")!;
}
function baseUrlInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(".ai-baseurl-input")!;
}
function modelInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(".ai-model-input")!;
}
function modelSelect(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>(".ai-model-select")!;
}
function keyInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(".ai-key-input")!;
}

describe("Ai provider form", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    loadLocale();
  });

  it("renders the saved config and shows the key only as a masked hint (raw key absent)", async () => {
    const host = await mount(makeDeps());
    expect(providerSelect(host).value).toBe("gemini");
    expect(modelInput(host).value).toBe("gemini-3.1-flash-lite");
    // The key input itself is empty — never seeded with anything secret.
    expect(keyInput(host).value).toBe("");
    // The masked hint is surfaced but reveals nothing usable.
    const hint = host.querySelector<HTMLElement>(".ai-key-hint")!;
    expect(hint.textContent).toContain("AIza…9b2c");
    // The raw key string is nowhere in the DOM.
    expect(host.innerHTML).not.toContain("AIzaSyFULLSECRET");
  });

  it("does NOT auto-fetch the model list on load", async () => {
    const listModels = vi.fn(async (): Promise<AiModelsResult> => ({
      models: ["x"],
      error: null,
    }));
    await mount(makeDeps({ listModels }));
    expect(listModels).not.toHaveBeenCalled();
  });

  it("hides the base-url field for Gemini and shows it for OpenAI-compatible presets", async () => {
    const host = await mount(makeDeps());
    // Saved config is Gemini → base-url hidden.
    expect(baseUrlField(host).hidden).toBe(true);

    const sel = providerSelect(host);
    sel.value = "openrouter";
    sel.dispatchEvent(new Event("change"));
    expect(baseUrlField(host).hidden).toBe(false);
    expect(baseUrlInput(host).value).toBe("https://openrouter.ai/api/v1");

    sel.value = "gemini";
    sel.dispatchEvent(new Event("change"));
    expect(baseUrlField(host).hidden).toBe(true);
  });

  it("prefills the base-url per preset and keeps it editable", async () => {
    const host = await mount(
      makeDeps({ getConfig: async () => ({ ...SAVED_GEMINI }) }),
    );
    const sel = providerSelect(host);
    const cases: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      ollama: "http://localhost:11434/v1",
    };
    for (const [preset, url] of Object.entries(cases)) {
      sel.value = preset;
      sel.dispatchEvent(new Event("change"));
      expect(baseUrlInput(host).value).toBe(url);
      expect(baseUrlInput(host).readOnly).toBe(false);
      expect(baseUrlInput(host).disabled).toBe(false);
    }
    // Custom clears the field for user entry.
    sel.value = "custom";
    sel.dispatchEvent(new Event("change"));
    expect(baseUrlInput(host).value).toBe("");
  });

  it("Refresh models populates the dropdown from the discovery endpoint", async () => {
    const listModels = vi.fn(async (): Promise<AiModelsResult> => ({
      models: ["gemini-3.1-flash-lite", "gemini-3.1-pro"],
      error: null,
    }));
    const host = await mount(makeDeps({ listModels }));
    const refresh = host.querySelector<HTMLButtonElement>(".ai-refresh-btn")!;
    refresh.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(listModels).toHaveBeenCalledTimes(1);
    const options = Array.from(modelSelect(host).options).map((o) => o.value);
    expect(options).toContain("gemini-3.1-flash-lite");
    expect(options).toContain("gemini-3.1-pro");
  });

  it("accepts a custom free-text model and submits it on save", async () => {
    const putConfig = vi.fn(async (u: AiConfigUpdate) => ({
      ...SAVED_GEMINI,
      model: u.model,
    }));
    const host = await mount(makeDeps({ putConfig }));
    const model = modelInput(host);
    model.value = "some-model-not-in-any-list";
    model.dispatchEvent(new Event("input"));

    const save = host.querySelector<HTMLButtonElement>(".ai-save-btn")!;
    save.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(putConfig).toHaveBeenCalledTimes(1);
    expect(putConfig.mock.calls[0][0].model).toBe("some-model-not-in-any-list");
  });

  it("selecting a discovered model copies it into the free-text input", async () => {
    const listModels = async (): Promise<AiModelsResult> => ({
      models: ["m1", "m2"],
      error: null,
    });
    const host = await mount(makeDeps({ listModels }));
    host.querySelector<HTMLButtonElement>(".ai-refresh-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const sel = modelSelect(host);
    sel.value = "m2";
    sel.dispatchEvent(new Event("change"));
    expect(modelInput(host).value).toBe("m2");
  });

  it("saving with a blank key field submits an empty apiKey (keep stored key)", async () => {
    const putConfig = vi.fn(async (u: AiConfigUpdate) => ({
      ...SAVED_GEMINI,
      model: u.model,
    }));
    const host = await mount(makeDeps({ putConfig }));
    // Leave the key field blank, change only the model.
    modelInput(host).value = "gemini-3.1-pro";
    modelInput(host).dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ai-save-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(putConfig.mock.calls[0][0].apiKey).toBe("");
  });

  it("submits the typed key when the user enters one", async () => {
    const putConfig = vi.fn(async (u: AiConfigUpdate) => ({
      ...SAVED_GEMINI,
      model: u.model,
    }));
    const host = await mount(makeDeps({ putConfig }));
    keyInput(host).value = "AIza-new-key";
    keyInput(host).dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ai-save-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(putConfig.mock.calls[0][0].apiKey).toBe("AIza-new-key");
  });

  it("never writes the API key to localStorage", async () => {
    const setItem = vi.spyOn(window.localStorage.__proto__, "setItem");
    try {
      const host = await mount(makeDeps());
      keyInput(host).value = "AIza-super-secret";
      keyInput(host).dispatchEvent(new Event("input"));
      host.querySelector<HTMLButtonElement>(".ai-save-btn")!.click();
      await new Promise((r) => setTimeout(r, 0));
      for (const call of setItem.mock.calls) {
        expect(String(call[1])).not.toContain("AIza-super-secret");
      }
    } finally {
      setItem.mockRestore();
    }
  });

  it("maps Gemini → gemini and other presets → openai-compatible on save", async () => {
    const putConfig = vi.fn(async (u: AiConfigUpdate) => ({
      ...SAVED_GEMINI,
      provider: u.provider,
      baseUrl: u.baseUrl,
      model: u.model,
    }));
    const host = await mount(makeDeps({ putConfig }));
    const sel = providerSelect(host);
    sel.value = "ollama";
    sel.dispatchEvent(new Event("change"));
    modelInput(host).value = "llama3";
    modelInput(host).dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ai-save-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(putConfig.mock.calls[0][0].provider).toBe("openai-compatible");
    expect(putConfig.mock.calls[0][0].baseUrl).toBe("http://localhost:11434/v1");
  });

  it("Test connection surfaces ok / error from the test endpoint", async () => {
    const testConfig = vi.fn(
      async (): Promise<AiTestResult> => ({ ok: false, error: "boom" }),
    );
    const host = await mount(makeDeps({ testConfig }));
    host.querySelector<HTMLButtonElement>(".ai-test-btn")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const status = host.querySelector<HTMLElement>(".ai-status")!;
    expect(testConfig).toHaveBeenCalledTimes(1);
    expect(status.textContent).toContain("boom");
  });
});
