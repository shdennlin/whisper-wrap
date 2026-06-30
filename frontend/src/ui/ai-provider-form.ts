/**
 * AI-provider editor (ai-provider-settings).
 *
 * Replaces the old read-only AI indicator with a full editor for the engine's
 * `/config/ai` surface. It is an engine HTTP feature — it works in a plain
 * browser with no desktop shell.
 *
 * Security contract (audited):
 *   - The raw API key is NEVER rendered: a read shows only the masked
 *     `keyHint`; the key <input> starts empty.
 *   - Leaving the key field blank submits `apiKey: ""` so the server keeps the
 *     stored key. A non-empty value replaces it.
 *   - The key is NEVER written to localStorage anywhere.
 *
 * Presets are a UI affordance over two server providers: Gemini → `gemini`
 * (base-url hidden); OpenAI / OpenRouter / Ollama / Custom → `openai-compatible`
 * with a prefilled-but-editable base URL.
 *
 * Dependency-injectable: the four API methods are injected so vitest can stub
 * the network without a server. No discovery fetch fires on load — the model
 * list is user-triggered via "Refresh models".
 */

import { t } from "../i18n";
import type {
  AiConfigView,
  AiConfigUpdate,
  AiModelsResult,
  AiTestResult,
  AiProvider,
} from "../api/ai-config";
import {
  getAiConfig,
  putAiConfig,
  listAiModels,
  testAiConfig,
} from "../api/ai-config";

/** UI preset ids. Maps to a server `provider` + base URL on submit. */
type Preset = "gemini" | "openai" | "openrouter" | "ollama" | "custom";

interface PresetDef {
  id: Preset;
  labelKey: string;
  /** The base URL prefilled when the preset is selected; "" = empty/custom. */
  baseUrl: string;
  /** Whether the base-url field is visible (false only for Gemini). */
  baseUrlVisible: boolean;
  provider: AiProvider;
}

const PRESETS: readonly PresetDef[] = [
  {
    id: "gemini",
    labelKey: "aiProvider.presetGemini",
    baseUrl: "",
    baseUrlVisible: false,
    provider: "gemini",
  },
  {
    id: "openai",
    labelKey: "aiProvider.presetOpenai",
    baseUrl: "https://api.openai.com/v1",
    baseUrlVisible: true,
    provider: "openai-compatible",
  },
  {
    id: "openrouter",
    labelKey: "aiProvider.presetOpenrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlVisible: true,
    provider: "openai-compatible",
  },
  {
    id: "ollama",
    labelKey: "aiProvider.presetOllama",
    baseUrl: "http://localhost:11434/v1",
    baseUrlVisible: true,
    provider: "openai-compatible",
  },
  {
    id: "custom",
    labelKey: "aiProvider.presetCustom",
    baseUrl: "",
    baseUrlVisible: true,
    provider: "openai-compatible",
  },
];

function presetById(id: Preset): PresetDef {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/**
 * Map a saved (server) config back onto a UI preset. Gemini is unambiguous;
 * an OpenAI-compatible base URL matches a named preset when it's one of the
 * known defaults, otherwise it falls back to Custom (keeping the saved URL).
 */
function presetForConfig(cfg: AiConfigView): Preset {
  if (cfg.provider === "gemini") return "gemini";
  const match = PRESETS.find(
    (p) => p.provider === "openai-compatible" && p.baseUrl === cfg.baseUrl,
  );
  return match?.id ?? "custom";
}

export interface AiProviderFormDeps {
  getConfig: () => Promise<AiConfigView>;
  putConfig: (update: AiConfigUpdate) => Promise<AiConfigView>;
  listModels: (probe: {
    provider: AiProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
  }) => Promise<AiModelsResult>;
  testConfig: (probe: {
    provider: AiProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
  }) => Promise<AiTestResult>;
}

/** Default deps wire the real `/config/ai` client over the global fetch. */
export function defaultAiProviderFormDeps(): AiProviderFormDeps {
  return {
    getConfig: () => getAiConfig(),
    putConfig: (u) => putAiConfig(u),
    listModels: (p) => listAiModels(p),
    testConfig: (p) => testAiConfig(p),
  };
}

function field(labelText: string): { wrap: HTMLLabelElement } {
  const wrap = document.createElement("label");
  wrap.className = "settings-field";
  wrap.append(document.createTextNode(labelText));
  return { wrap };
}

/**
 * Build + mount the editor into `host`. Loads the saved config (masked) and
 * wires the controls. Returns once the initial render is complete.
 */
export async function mountAiProviderForm(
  host: HTMLElement,
  deps: AiProviderFormDeps = defaultAiProviderFormDeps(),
): Promise<void> {
  host.replaceChildren();
  host.classList.add("ai-provider-form", "settings-card");

  const cfg = await deps
    .getConfig()
    .catch(
      (): AiConfigView => ({
        provider: "gemini",
        baseUrl: "",
        model: "",
        keySet: false,
        keyHint: "",
        systemPromptSet: false,
      }),
    );

  // --- Provider preset dropdown ---
  const providerField = field(t("aiProvider.providerLabel"));
  const providerSelect = document.createElement("select");
  providerSelect.className = "ai-provider-select";
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = t(p.labelKey as Parameters<typeof t>[0]);
    providerSelect.appendChild(opt);
  }
  providerField.wrap.appendChild(providerSelect);
  host.appendChild(providerField.wrap);

  // --- Base URL (hidden for Gemini, editable for everyone else) ---
  const baseUrlField = field(t("aiProvider.baseUrlLabel"));
  baseUrlField.wrap.classList.add("ai-baseurl-field");
  const baseUrlInput = document.createElement("input");
  baseUrlInput.type = "url";
  baseUrlInput.className = "ai-baseurl-input";
  baseUrlInput.value = cfg.baseUrl;
  baseUrlField.wrap.appendChild(baseUrlInput);
  host.appendChild(baseUrlField.wrap);

  // --- Model: dropdown (populated on refresh) + always-on free-text entry ---
  const modelField = field(t("aiProvider.modelLabel"));
  modelField.wrap.classList.add("ai-model-field");
  const modelSelect = document.createElement("select");
  modelSelect.className = "ai-model-select";
  modelSelect.hidden = true; // shown once a refresh returns models
  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.className = "ai-model-input";
  modelInput.placeholder = t("aiProvider.modelPlaceholder");
  modelInput.value = cfg.model;
  // Picking from the dropdown copies into the free-text input (which is the
  // single source of truth on save).
  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) modelInput.value = modelSelect.value;
  });
  modelField.wrap.append(modelSelect, modelInput);
  host.appendChild(modelField.wrap);

  // --- API key: empty input + masked hint; raw key never rendered ---
  const keyField = field(t("aiProvider.apiKeyLabel"));
  keyField.wrap.classList.add("ai-key-field");
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.className = "ai-key-input";
  keyInput.autocomplete = "off";
  keyInput.placeholder = t("aiProvider.apiKeyPlaceholder");
  keyInput.value = ""; // NEVER seeded with the secret
  const keyHint = document.createElement("span");
  keyHint.className = "settings-hint ai-key-hint";
  keyField.wrap.append(keyInput, keyHint);
  host.appendChild(keyField.wrap);

  const refreshKeyHint = (): void => {
    keyHint.textContent = cfg.keySet
      ? t("aiProvider.apiKeyHintSet", { hint: cfg.keyHint })
      : t("aiProvider.apiKeyHintUnset");
  };
  refreshKeyHint();

  // --- Actions row: Refresh models · Test connection · Save ---
  const actions = document.createElement("div");
  actions.className = "ai-actions";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ai-refresh-btn";
  refreshBtn.textContent = t("aiProvider.refreshModels");
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "ai-test-btn";
  testBtn.textContent = t("aiProvider.testConnection");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ai-save-btn";
  saveBtn.textContent = t("aiProvider.save");
  actions.append(refreshBtn, testBtn, saveBtn);
  host.appendChild(actions);

  // --- Status line: success / error from refresh / test / save ---
  const status = document.createElement("div");
  status.className = "ai-status settings-hint";
  status.setAttribute("role", "status");
  host.appendChild(status);

  function setStatus(text: string, kind: "ok" | "error" | ""): void {
    status.textContent = text;
    if (kind) status.dataset.state = kind;
    else delete status.dataset.state;
  }

  /** The provider value to send to the server for the current preset. */
  function currentProvider(): AiProvider {
    return presetById(providerSelect.value as Preset).provider;
  }

  /** The base URL to send: empty for Gemini (server ignores it). */
  function currentBaseUrl(): string {
    return currentProvider() === "gemini" ? "" : baseUrlInput.value.trim();
  }

  function applyPreset(id: Preset): void {
    const def = presetById(id);
    baseUrlField.wrap.hidden = !def.baseUrlVisible;
    baseUrlInput.value = def.baseUrl;
  }

  // Reflect the saved config's preset (and base-url visibility) on first paint.
  const initialPreset = presetForConfig(cfg);
  providerSelect.value = initialPreset;
  baseUrlField.wrap.hidden = !presetById(initialPreset).baseUrlVisible;
  // Keep the saved base URL (don't clobber it with the preset default on load).
  baseUrlInput.value = cfg.baseUrl;

  providerSelect.addEventListener("change", () => {
    applyPreset(providerSelect.value as Preset);
  });

  refreshBtn.addEventListener("click", () => {
    void (async () => {
      refreshBtn.disabled = true;
      const prev = refreshBtn.textContent;
      refreshBtn.textContent = t("aiProvider.refreshing");
      setStatus("", "");
      try {
        const res = await deps.listModels({
          provider: currentProvider(),
          baseUrl: currentBaseUrl(),
          model: modelInput.value.trim(),
          apiKey: keyInput.value,
        });
        modelSelect.replaceChildren();
        if (res.models.length === 0) {
          modelSelect.hidden = true;
          setStatus(
            res.error
              ? t("aiProvider.modelsError", { message: res.error })
              : t("aiProvider.modelsEmpty"),
            res.error ? "error" : "",
          );
        } else {
          for (const m of res.models) {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            modelSelect.appendChild(opt);
          }
          modelSelect.hidden = false;
          // Keep the dropdown in sync with the typed model when it matches.
          if (res.models.includes(modelInput.value)) {
            modelSelect.value = modelInput.value;
          }
          if (res.error) {
            setStatus(t("aiProvider.modelsError", { message: res.error }), "error");
          }
        }
      } catch (err) {
        setStatus(t("aiProvider.modelsError", { message: errText(err) }), "error");
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = prev;
      }
    })();
  });

  testBtn.addEventListener("click", () => {
    void (async () => {
      testBtn.disabled = true;
      const prev = testBtn.textContent;
      testBtn.textContent = t("aiProvider.testing");
      setStatus("", "");
      try {
        const res = await deps.testConfig({
          provider: currentProvider(),
          baseUrl: currentBaseUrl(),
          model: modelInput.value.trim(),
          apiKey: keyInput.value,
        });
        if (res.ok) {
          setStatus(t("aiProvider.testOk"), "ok");
        } else {
          setStatus(
            t("aiProvider.testFailed", { message: res.error ?? "" }),
            "error",
          );
        }
      } catch (err) {
        setStatus(t("aiProvider.testFailed", { message: errText(err) }), "error");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = prev;
      }
    })();
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      saveBtn.disabled = true;
      const prev = saveBtn.textContent;
      saveBtn.textContent = t("aiProvider.saving");
      setStatus("", "");
      try {
        const update: AiConfigUpdate = {
          provider: currentProvider(),
          baseUrl: currentBaseUrl(),
          model: modelInput.value.trim(),
          // Blank key field → empty apiKey → server keeps the stored key.
          apiKey: keyInput.value,
        };
        const next = await deps.putConfig(update);
        // Reflect the freshly-masked view; the key input goes back to empty so
        // the secret never lingers in the DOM.
        cfg.provider = next.provider;
        cfg.baseUrl = next.baseUrl;
        cfg.model = next.model;
        cfg.keySet = next.keySet;
        cfg.keyHint = next.keyHint;
        cfg.systemPromptSet = next.systemPromptSet;
        keyInput.value = "";
        refreshKeyHint();
        setStatus(t("aiProvider.saved"), "ok");
      } catch (err) {
        setStatus(t("aiProvider.saveError", { message: errText(err) }), "error");
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prev;
      }
    })();
  });

  // This form's DOM is appended in an async continuation (after getConfig()).
  // WebKit/WKWebView can skip laying it out until the first interaction, so the
  // card shows blank until clicked. Reading a layout property flushes the
  // pending layout now. Guarded for non-DOM/test environments.
  void (host as { offsetHeight?: number }).offsetHeight;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
