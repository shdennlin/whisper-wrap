/**
 * Settings view (fe-models-settings + ai-provider-settings): a first-class
 * shell view that hosts the AI-provider editor and the existing settings panel.
 *
 * The AI card used to be a read-only indicator (env-based config). It is now a
 * full editor over the engine's `/config/ai` surface — provider preset,
 * endpoint, model, and API key — so the user configures AI without touching
 * `.env`. It is an engine HTTP feature and works on both the web PWA and the
 * desktop app (no desktop shell required).
 *
 * `main.ts` injects the real settings-panel mount; tests inject spies and stub
 * the AI-config deps.
 */

import { mountAiProviderForm, type AiProviderFormDeps } from "./ai-provider-form";
import {
  mountDictionarySection,
  type DictionarySectionDeps,
} from "./dictionary-section";
import { t } from "../i18n";

/** Anything the view can drive with the top-of-page search box. */
export interface SettingsFilterable {
  filter(query: string): void;
}

export interface SettingsViewDeps {
  /** Mount the settings panel; may return a filterable handle for the search. */
  mount?: (host: HTMLElement) => SettingsFilterable | void;
  /** AI-config client deps for the editor — overridable for tests. */
  aiDeps?: AiProviderFormDeps;
  /** Dictionary-config client deps (zh-convert-dictionary) — for tests. */
  dictDeps?: DictionarySectionDeps;
}

export async function renderSettings(
  container: HTMLElement,
  deps: SettingsViewDeps = {},
): Promise<void> {
  container.replaceChildren();
  container.classList.add("settings-view");

  // Card-row framing (fe-visual-polish): row title, the AI editor as an mrow
  // card, and an mrow frame around the unchanged SettingsPanel mount target.
  const rowTitle = document.createElement("div");
  rowTitle.className = "row-title";
  const heading = document.createElement("h3");
  heading.textContent = t("settingsView.title");
  rowTitle.appendChild(heading);
  container.appendChild(rowTitle);

  // Search box at the TOP of the view (above the AI card) — filters the panel
  // below AND hides the AI card when it doesn't match.
  const searchWrap = document.createElement("div");
  searchWrap.className = "settings-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "settings-search-input";
  searchInput.placeholder = t("settingsView.searchPlaceholder");
  searchInput.setAttribute("aria-label", t("settingsView.searchAria"));
  searchWrap.appendChild(searchInput);
  container.appendChild(searchWrap);

  // The AI card now hosts the full provider editor (replacing the read-only
  // indicator). `mountAiProviderForm` loads the saved config (masked key) and
  // wires all controls; it never auto-fetches the model list and never persists
  // the API key to localStorage.
  const aiSection = document.createElement("div");
  aiSection.className = "settings-ai mrow";
  container.appendChild(aiSection);
  await mountAiProviderForm(aiSection, deps.aiDeps);

  // Dictionary card (zh-convert-dictionary): the s2tw conversion toggle +
  // word-replacement editor over the engine's /config/dictionary surface.
  const dictSection = document.createElement("div");
  dictSection.className = "settings-dictionary mrow";
  container.appendChild(dictSection);
  const dictHandle = await mountDictionarySection(dictSection, deps.dictDeps);

  const frame = document.createElement("div");
  frame.className = "mrow-frame";
  const host = document.createElement("div");
  host.className = "settings-host";
  frame.appendChild(host);
  container.appendChild(frame);
  const panel = deps.mount?.(host);

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    panel?.filter(searchInput.value);
    // Treat the AI provider card as one searchable section.
    aiSection.hidden = q !== "" && !(aiSection.textContent ?? "").toLowerCase().includes(q);
    // The dictionary card filters itself (its pair values live in inputs,
    // which textContent cannot see).
    dictHandle.filter(searchInput.value);
  });
}
