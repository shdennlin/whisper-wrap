/**
 * Settings Dictionary section (zh-convert-dictionary).
 *
 * Editor over the engine's `/config/dictionary` surface: the
 * Simplified→Traditional (Taiwan) conversion toggle plus the word-replacement
 * table. It is an engine HTTP feature — it works in a plain browser with no
 * desktop shell, and the setting is engine-global (it changes what gets
 * STORED, so it deliberately does not live in localStorage).
 *
 * Editing model: the top row adds pairs (comma-separated originals expand to
 * one stored pair per original, VoiceInk-style); each stored pair renders as
 * two in-place inputs plus a delete button. Every change PUTs the FULL
 * document and re-renders from the server's echo, so the UI can never drift
 * from what the engine persisted.
 *
 * Dependency-injectable: the two API methods are injected so vitest can stub
 * the network without a server.
 */

import { t } from "../i18n";
import type { DictionaryConfig, ReplacementPair } from "../api/dictionary-config";
import { getDictionaryConfig, putDictionaryConfig } from "../api/dictionary-config";

export interface DictionarySectionDeps {
  get?: () => Promise<DictionaryConfig>;
  put?: (cfg: DictionaryConfig) => Promise<DictionaryConfig>;
}

/**
 * The wire contract leaves both fields optional (the engine defaults missing
 * fields), so the section normalizes every server document once and works
 * with a fully-populated shape internally.
 */
type FullConfig = {
  zh_convert: NonNullable<DictionaryConfig["zh_convert"]>;
  replacements: ReplacementPair[];
};

function normalize(cfg: DictionaryConfig): FullConfig {
  return {
    zh_convert: cfg.zh_convert ?? "off",
    replacements: cfg.replacements ?? [],
  };
}

/** Handle for the settings search box (same idea as `SettingsFilterable`). */
export interface DictionarySectionHandle {
  filter(query: string): void;
}

export async function mountDictionarySection(
  host: HTMLElement,
  deps: DictionarySectionDeps = {},
): Promise<DictionarySectionHandle> {
  const get = deps.get ?? getDictionaryConfig;
  const put = deps.put ?? putDictionaryConfig;

  host.classList.add("dictionary-section");

  const heading = document.createElement("h4");
  heading.className = "dictionary-title";
  heading.textContent = t("dictionary.title");
  host.appendChild(heading);

  // ---- conversion toggle ----
  const toggleRow = document.createElement("label");
  toggleRow.className = "dictionary-toggle-row";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("data-dict-toggle", "");
  const toggleText = document.createElement("span");
  toggleText.textContent = t("dictionary.zhConvertLabel");
  toggleRow.append(toggle, toggleText);
  host.appendChild(toggleRow);

  const hint = document.createElement("p");
  hint.className = "dictionary-hint";
  hint.textContent = t("dictionary.zhConvertHint");
  host.appendChild(hint);

  // ---- add-pair row ----
  const addRow = document.createElement("div");
  addRow.className = "dictionary-add-row";
  const fromInput = document.createElement("input");
  fromInput.type = "text";
  fromInput.placeholder = t("dictionary.fromPlaceholder");
  fromInput.setAttribute("data-dict-from", "");
  const toInput = document.createElement("input");
  toInput.type = "text";
  toInput.placeholder = t("dictionary.toPlaceholder");
  toInput.setAttribute("data-dict-to", "");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = t("dictionary.add");
  addBtn.setAttribute("data-dict-add", "");
  addRow.append(fromInput, toInput, addBtn);
  host.appendChild(addRow);

  // ---- stored pairs ----
  const list = document.createElement("div");
  list.className = "dictionary-list";
  host.appendChild(list);

  const empty = document.createElement("p");
  empty.className = "dictionary-empty";
  empty.textContent = t("dictionary.empty");
  host.appendChild(empty);

  const status = document.createElement("p");
  status.className = "dictionary-status";
  status.setAttribute("data-dict-status", "");
  host.appendChild(status);

  let cfg: FullConfig = { zh_convert: "off", replacements: [] };
  try {
    cfg = normalize(await get());
  } catch (err) {
    setStatus(t("dictionary.loadError", { message: errText(err) }));
  }
  render();

  toggle.addEventListener("change", () => {
    void save({
      ...cfg,
      zh_convert: toggle.checked ? "s2tw" : "off",
    });
  });

  addBtn.addEventListener("click", () => {
    // Comma-separated originals expand to one stored pair per original,
    // all sharing the entered replacement (UI convenience only — storage
    // stays one-pair-per-entry).
    const originals = fromInput.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (originals.length === 0) return;
    const to = toInput.value;
    const added: ReplacementPair[] = originals.map((from) => ({ from, to }));
    void save(
      { ...cfg, replacements: [...cfg.replacements, ...added] },
      () => {
        fromInput.value = "";
        toInput.value = "";
      },
    );
  });

  /** PUT the full document; re-render from the server's echo. */
  async function save(next: FullConfig, onOk?: () => void): Promise<void> {
    setStatus("");
    try {
      cfg = normalize(await put(next));
      onOk?.();
    } catch (err) {
      setStatus(t("dictionary.saveError", { message: errText(err) }));
    }
    render();
  }

  function render(): void {
    toggle.checked = cfg.zh_convert === "s2tw";
    empty.hidden = cfg.replacements.length > 0;
    list.replaceChildren(
      ...cfg.replacements.map((pair, index) => pairRow(pair, index)),
    );
  }

  function pairRow(pair: ReplacementPair, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "dictionary-row";
    row.setAttribute("data-dict-row", "");

    const from = document.createElement("input");
    from.type = "text";
    from.value = pair.from;
    from.setAttribute("data-dict-row-from", "");
    from.setAttribute("aria-label", t("dictionary.fromAria"));

    const arrow = document.createElement("span");
    arrow.className = "dictionary-arrow";
    arrow.textContent = "→";

    const to = document.createElement("input");
    to.type = "text";
    to.value = pair.to;
    to.setAttribute("data-dict-row-to", "");
    to.setAttribute("aria-label", t("dictionary.toAria"));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "dictionary-delete";
    del.textContent = t("dictionary.delete");
    del.setAttribute("data-dict-delete", "");

    const edited = (): void => {
      const replacements = cfg.replacements.map((p, i) =>
        i === index ? { from: from.value, to: to.value } : p,
      );
      void save({ ...cfg, replacements });
    };
    from.addEventListener("change", edited);
    to.addEventListener("change", edited);
    del.addEventListener("click", () => {
      const replacements = cfg.replacements.filter((_, i) => i !== index);
      void save({ ...cfg, replacements });
    });

    row.append(from, arrow, to, del);
    return row;
  }

  function setStatus(text: string): void {
    status.textContent = text;
    status.hidden = text === "";
  }

  return {
    // Same contract as the AI card in settings-view: hide when a non-empty
    // query matches none of the section's text. Pair values live in <input>
    // elements (not textContent), so they are searched explicitly.
    filter(query: string): void {
      const q = query.trim().toLowerCase();
      const searchable = [
        host.textContent ?? "",
        ...cfg.replacements.flatMap((p) => [p.from, p.to]),
      ]
        .join(" ")
        .toLowerCase();
      host.hidden = q !== "" && !searchable.includes(q);
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
