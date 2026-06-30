/**
 * Settings panel persisting user preferences to localStorage.
 *
 * Controls:
 *   - microphone deviceId (from navigator.mediaDevices.enumerateDevices())
 *   - backend base URL (default: window.location.origin)
 *   - show partials toggle
 *   - auto-scroll toggle
 *   - auto-copy transcript toggle
 *   - history retention count (1–50, default 20)
 *   - Live idle-stop minutes (0 disables; default 30)
 *   - Live hard-cap minutes (0 disables; default 240 = 4 h)
 *   - audio.save toggle (persists per-session recordings)
 *   - audio.budget_mb numeric field (10–1000 MB, default 100 MB)
 *   - clear-all-audio button (double-confirm)
 */

import {
  AVAILABLE_LOCALES,
  getLocale,
  saveLocale,
  t,
  type Locale,
  type StringKey,
} from "../i18n";
import { modalConfirm } from "./modal-prompt";
import { tauriInvoke } from "../platform/capability";
import { accelFromEvent, formatAccelerator } from "./shortcut-capture";

export const SETTINGS_KEY = "whisper-wrap.settings";

/**
 * localStorage key for the per-tab audio budget. Shared with the audio-store
 * (kept in sync with `AUDIO_BUDGET_KEY` in `src/storage/audio-store.ts`).
 * The stored value is a byte integer; the Settings panel surfaces megabytes.
 */
export const AUDIO_BUDGET_MB_KEY = "whisper-wrap.audio_budget";

const AUDIO_BUDGET_DEFAULT_MB = 100;
const AUDIO_BUDGET_MIN_MB = 10;
const AUDIO_BUDGET_MAX_MB = 1000;
const BYTES_PER_MB = 1024 * 1024;

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
};

export interface Settings {
  deviceId: string | null;
  backendUrl: string;
  showPartials: boolean;
  autoScroll: boolean;
  autoCopy: boolean;
  /** Auto-copy the AI answer to clipboard when an action completes. */
  autoCopyAnswer: boolean;
  retention: number;
  /** Stop Live recording after this many minutes with no speech. 0 = off. */
  liveIdleMinutes: number;
  /** Hard cap on Live recording wall-clock duration. 0 = off. */
  liveMaxMinutes: number;
  /** Persist per-session audio so transcripts can be replayed / re-ASR'd. */
  audioSave: boolean;
  /** Desktop-only: register the global ⌥Space quick-voice shortcut. */
  globalHotkeyEnabled: boolean;
  /** Desktop-only: the quick-voice shortcut accelerator (Tauri syntax, e.g.
   *  "Alt+Space"). Rebindable from Settings. */
  globalHotkeyAccelerator: string;
  /** Desktop-only: paste the transcript into the frontmost app when a
   *  quick-voice capture finishes (needs macOS Accessibility permission). */
  autoPasteEnabled: boolean;
  /** Desktop-only: register the global "paste last transcript" shortcut. */
  pasteHotkeyEnabled: boolean;
  /** Desktop-only: the paste-last shortcut accelerator (Tauri syntax). Empty
   *  string = unbound. Rebindable from Settings. */
  pasteHotkeyAccelerator: string;
  /** Desktop-only (Experimental): pause playing media while recording. */
  autoPauseMediaEnabled: boolean;
}

export const DEFAULTS: Settings = {
  deviceId: null,
  backendUrl: "",
  showPartials: true,
  autoScroll: true,
  autoCopy: true,
  autoCopyAnswer: true,
  retention: 20,
  liveIdleMinutes: 30,
  liveMaxMinutes: 240,
  audioSave: true,
  globalHotkeyEnabled: true,
  globalHotkeyAccelerator: "Alt+Space",
  autoPasteEnabled: false,
  pasteHotkeyEnabled: false,
  pasteHotkeyAccelerator: "",
  autoPauseMediaEnabled: false,
};

export function loadSettings(): Settings {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  const fallback: Settings = {
    ...DEFAULTS,
    backendUrl: window.location?.origin ?? "",
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function saveSettings(s: Settings): void {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/**
 * Read the audio budget from localStorage and return it as megabytes.
 *
 * localStorage stores the value as a byte integer (shared with audio-store),
 * so we divide by `BYTES_PER_MB` before returning. Missing / invalid / out-of-
 * range values fall back to the default (100 MB).
 */
export function loadAudioBudgetMb(): number {
  try {
    const raw = window.localStorage.getItem(AUDIO_BUDGET_MB_KEY);
    if (!raw) return AUDIO_BUDGET_DEFAULT_MB;
    const bytes = Number.parseInt(raw, 10);
    if (!Number.isFinite(bytes) || bytes <= 0) return AUDIO_BUDGET_DEFAULT_MB;
    const mb = Math.round(bytes / BYTES_PER_MB);
    if (mb < AUDIO_BUDGET_MIN_MB || mb > AUDIO_BUDGET_MAX_MB) {
      return AUDIO_BUDGET_DEFAULT_MB;
    }
    return mb;
  } catch {
    return AUDIO_BUDGET_DEFAULT_MB;
  }
}

/**
 * Persist the audio budget. `mb` is in megabytes; the value written to
 * localStorage is `mb * 1024 * 1024` (bytes) so the audio-store can read it
 * directly.
 *
 * Throws `RangeError` when:
 *   - `mb` is not a finite integer, or
 *   - `mb < 10`, or
 *   - `mb > 1000`.
 */
export function saveAudioBudgetMb(mb: number): void {
  if (
    !Number.isFinite(mb) ||
    !Number.isInteger(mb) ||
    mb < AUDIO_BUDGET_MIN_MB ||
    mb > AUDIO_BUDGET_MAX_MB
  ) {
    throw new RangeError(
      `audio budget must be an integer between ${AUDIO_BUDGET_MIN_MB} and ${AUDIO_BUDGET_MAX_MB} MB, got ${mb}`,
    );
  }
  window.localStorage.setItem(AUDIO_BUDGET_MB_KEY, String(mb * BYTES_PER_MB));
}

export interface SettingsPanelOptions {
  root: HTMLElement;
  enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  onChange: (s: Settings) => void;
  /**
   * Optional dependency invoked when the user confirms (twice) "Clear all
   * audio". Resolves to the number of audio records deleted; the panel emits
   * that count via `onToast`.
   */
  clearAllAudio?: () => Promise<number>;
  /** Optional toast sink for ephemeral messages (clear-all completion). */
  onToast?: (text: string) => void;
  /**
   * Render the desktop-only Shortcuts section (global hotkey + rebinds) and the
   * auto-paste row. Sourced from the surface profile via main.ts; defaults to
   * false so a standalone panel never shows OS controls that no-op on the web.
   */
  showDesktopShortcuts?: boolean;
  /** Render the desktop-only Experimental section. Defaults to false. */
  showExperimental?: boolean;
}

export class SettingsPanel {
  private current: Settings;
  private deviceSelect!: HTMLSelectElement;
  private backendInput!: HTMLInputElement;
  private partialsInput!: HTMLInputElement;
  private autoscrollInput!: HTMLInputElement;
  private autocopyInput!: HTMLInputElement;
  private autocopyAnswerInput!: HTMLInputElement;
  private retentionInput!: HTMLInputElement;
  private liveIdleInput!: HTMLInputElement;
  private liveMaxInput!: HTMLInputElement;
  private audioSaveInput!: HTMLInputElement;
  /** Desktop-only — null in a plain browser (no global shortcuts on the web). */
  private globalHotkeyInput: HTMLInputElement | null = null;
  /** The accelerator currently chosen in the rebind control. */
  private globalHotkeyAccel = DEFAULTS.globalHotkeyAccelerator;
  /** Desktop-only auto-paste toggle; null in a plain browser. */
  private autoPasteInput: HTMLInputElement | null = null;
  /** Desktop-only (Experimental) auto-pause-media toggle; null in a browser. */
  private autoPauseMediaInput: HTMLInputElement | null = null;
  /** The accelerator currently chosen in the paste-last rebind control. */
  private pasteHotkeyAccel = DEFAULTS.pasteHotkeyAccelerator;
  private audioBudgetInput!: HTMLInputElement;
  private audioBudgetError!: HTMLSpanElement;
  private languageSelect!: HTMLSelectElement;
  /** The open card rows mount into; null = mount directly on the panel root. */
  private currentCard: HTMLElement | null = null;
  /** Empty-state line shown when a search query matches nothing. */
  private emptyEl!: HTMLParagraphElement;

  constructor(private readonly opts: SettingsPanelOptions) {
    this.current = loadSettings();
    this.opts.root.classList.add("settings-panel");
    this.build();
  }

  getSettings(): Settings {
    return { ...this.current };
  }

  private build(): void {
    this.initSearchState();

    // --- Shortcuts (desktop only — the web has no global hotkey API) ---
    if (this.opts.showDesktopShortcuts ?? false) {
      this.makeCard("settings.cardShortcuts");
      this.globalHotkeyAccel = this.current.globalHotkeyAccelerator;
      this.globalHotkeyInput = this.makeCheckboxWithHint(
        tSafe("settings.globalHotkeyLabel"),
        this.current.globalHotkeyEnabled,
        tSafe("settings.globalHotkeyHint"),
      );
      // Register/unregister at the OS level the moment the toggle flips —
      // re-registering uses the current accelerator.
      this.globalHotkeyInput.addEventListener("change", () => {
        void tauriInvoke()?.("set_global_hotkey", {
          enabled: this.globalHotkeyInput!.checked,
          accelerator: this.globalHotkeyAccel,
        });
      });
      this.buildShortcutRebind();
      // "Paste last transcript" global shortcut rebind.
      this.pasteHotkeyAccel = this.current.pasteHotkeyAccelerator;
      this.buildPasteShortcutRebind();
    }

    // --- Audio Input ---
    this.makeCard("settings.cardAudioInput");
    this.deviceSelect = this.makeSelect(t("settings.mic"));

    // --- Recording ---
    this.makeCard("settings.cardRecording");
    this.partialsInput = this.makeCheckbox(
      t("settings.showPartials"),
      this.current.showPartials,
    );
    this.autoscrollInput = this.makeCheckbox(
      t("settings.autoScroll"),
      this.current.autoScroll,
    );
    this.audioSaveInput = this.makeCheckboxWithHint(
      tSafe("settings.audioSaveLabel"),
      this.current.audioSave,
      tSafe("settings.audioSaveHint"),
    );
    // Keep the desktop overlay's Save-audio preference in sync: the overlay
    // surface runs at a separate asset origin and cannot read this from
    // localStorage, so the shell must be told the current value (it forwards it
    // to the overlay per capture). No-ops on the web (no Tauri bridge).
    this.audioSaveInput.addEventListener("change", () => {
      void tauriInvoke()?.("set_overlay_prefs", {
        audioSave: this.audioSaveInput.checked,
        locale: getLocale(),
      });
    });
    this.makeSectionTitle(t("settings.liveSection"));
    this.liveIdleInput = this.makeInputWithHint(
      t("settings.liveIdleLabel"),
      "number",
      String(this.current.liveIdleMinutes),
      t("settings.liveIdleHint"),
    );
    this.liveIdleInput.min = "0";
    this.liveIdleInput.max = "180";
    this.liveMaxInput = this.makeInputWithHint(
      t("settings.liveMaxLabel"),
      "number",
      String(this.current.liveMaxMinutes),
      t("settings.liveMaxHint"),
    );
    this.liveMaxInput.min = "0";
    this.liveMaxInput.max = "720";
    const budgetField = this.makeInputWithHintAndError(
      tSafe("settings.audioBudgetLabel"),
      "number",
      String(loadAudioBudgetMb()),
      tSafe("settings.audioBudgetHint"),
    );
    this.audioBudgetInput = budgetField.input;
    this.audioBudgetError = budgetField.error;
    this.audioBudgetInput.min = String(AUDIO_BUDGET_MIN_MB);
    this.audioBudgetInput.max = String(AUDIO_BUDGET_MAX_MB);

    // --- Output & Paste ---
    this.makeCard("settings.cardOutput");
    this.autocopyInput = this.makeCheckbox(
      t("settings.autoCopy"),
      this.current.autoCopy,
    );
    this.autocopyAnswerInput = this.makeCheckbox(
      t("settings.autoCopyAnswer"),
      this.current.autoCopyAnswer,
    );
    if (this.opts.showDesktopShortcuts ?? false) {
      // Auto-paste-on-finish (overlay-auto-paste): paste the transcript into
      // the frontmost app the moment a quick-voice capture lands.
      this.autoPasteInput = this.makeCheckboxWithHint(
        tSafe("settings.autoPasteLabel"),
        this.current.autoPasteEnabled,
        tSafe("settings.autoPasteHint"),
      );
      this.autoPasteInput.addEventListener("change", () => {
        void tauriInvoke()?.("set_auto_paste", {
          enabled: this.autoPasteInput!.checked,
        });
      });
      // Accessibility-permission status row — auto-paste silently no-ops
      // without it, so surface the live state + a one-click jump to the pane.
      this.buildAccessibilityRow();
    }

    // --- Experimental (desktop only) ---
    if (this.opts.showExperimental ?? false) {
      this.makeCard("settings.cardExperimental");
      // Auto-pause-media (overlay-media-pause): opt-in, coarse heuristics.
      this.autoPauseMediaInput = this.makeCheckboxWithHint(
        tSafe("settings.autoPauseMediaLabel"),
        this.current.autoPauseMediaEnabled,
        tSafe("settings.autoPauseMediaHint"),
      );
      this.autoPauseMediaInput.addEventListener("change", () => {
        void tauriInvoke()?.("set_auto_pause_media", {
          enabled: this.autoPauseMediaInput!.checked,
        });
      });
    }

    // --- General ---
    this.makeCard("settings.cardGeneral");
    this.backendInput = this.makeInput(
      t("settings.backendUrl"),
      "url",
      this.current.backendUrl,
    );
    this.languageSelect = this.makeSelect(t("settings.language"));
    for (const loc of AVAILABLE_LOCALES) {
      const opt = document.createElement("option");
      opt.value = loc;
      opt.textContent = LOCALE_LABELS[loc];
      this.languageSelect.appendChild(opt);
    }
    this.languageSelect.value = getLocale();
    // Locale change is rare; reload the page rather than re-rendering every
    // component subtree on the fly.
    this.languageSelect.addEventListener("change", () => {
      const next = this.languageSelect.value as Locale;
      saveLocale(next);
      window.location.reload();
    });
    this.retentionInput = this.makeInput(
      t("settings.retention"),
      "number",
      String(this.current.retention),
    );
    this.retentionInput.min = "1";
    this.retentionInput.max = "50";
    // Model management lives in its own dedicated Models view now — no need to
    // duplicate it inside Settings.
    this.buildClearAllAudioButton();

    this.populateDevices();

    const onAnyChange = (): void => {
      this.current = {
        deviceId: this.deviceSelect.value || null,
        backendUrl: this.backendInput.value,
        showPartials: this.partialsInput.checked,
        autoScroll: this.autoscrollInput.checked,
        autoCopy: this.autocopyInput.checked,
        autoCopyAnswer: this.autocopyAnswerInput.checked,
        retention: clampRetention(this.retentionInput.valueAsNumber),
        liveIdleMinutes: clampMinutes(this.liveIdleInput.valueAsNumber, 180),
        liveMaxMinutes: clampMinutes(this.liveMaxInput.valueAsNumber, 720),
        audioSave: this.audioSaveInput.checked,
        // Desktop-only input; keep the stored value when the toggle is absent.
        globalHotkeyEnabled:
          this.globalHotkeyInput?.checked ?? this.current.globalHotkeyEnabled,
        globalHotkeyAccelerator: this.globalHotkeyAccel,
        // Desktop-only inputs; keep the stored value when absent (web).
        autoPasteEnabled:
          this.autoPasteInput?.checked ?? this.current.autoPasteEnabled,
        pasteHotkeyEnabled: this.current.pasteHotkeyEnabled,
        pasteHotkeyAccelerator: this.pasteHotkeyAccel,
        autoPauseMediaEnabled:
          this.autoPauseMediaInput?.checked ??
          this.current.autoPauseMediaEnabled,
      };
      saveSettings(this.current);
      this.opts.onChange(this.current);
    };
    const changeInputs: (HTMLElement | null)[] = [
      this.deviceSelect,
      this.backendInput,
      this.partialsInput,
      this.autoscrollInput,
      this.autocopyInput,
      this.autocopyAnswerInput,
      this.retentionInput,
      this.liveIdleInput,
      this.liveMaxInput,
      this.audioSaveInput,
      this.globalHotkeyInput, // desktop-only; may be null
      this.autoPasteInput, // desktop-only; may be null
      this.autoPauseMediaInput, // desktop-only; may be null
    ];
    for (const el of changeInputs) {
      el?.addEventListener("change", onAnyChange);
    }

    // The audio budget lives under its OWN localStorage key (shared with the
    // audio-store) — never inside whisper-wrap.settings. Validate, persist,
    // surface inline errors on out-of-range values without touching storage.
    this.audioBudgetInput.addEventListener("change", () => {
      const raw = this.audioBudgetInput.valueAsNumber;
      try {
        saveAudioBudgetMb(raw);
        this.audioBudgetError.textContent = "";
      } catch (err) {
        const message =
          err instanceof RangeError
            ? err.message
            : `invalid audio budget: ${String(err)}`;
        this.audioBudgetError.textContent = message;
        // Roll the input back to the last-persisted value so the user sees
        // what's actually stored.
        this.audioBudgetInput.value = String(loadAudioBudgetMb());
      }
    });
  }

  private buildClearAllAudioButton(): void {
    const wrap = document.createElement("div");
    wrap.className = "settings-field settings-clear-audio-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-clear-audio";
    btn.textContent = tSafe("settings.audioClearAllButton");
    btn.addEventListener("click", () => {
      void this.handleClearAll();
    });
    wrap.appendChild(btn);
    this.mount(wrap);
  }

  private async handleClearAll(): Promise<void> {
    const dep = this.opts.clearAllAudio;
    if (!dep) return;
    // Double-confirm to match the mode-card discard pattern: prevents an
    // accidental click from wiping every recording.
    const prompt = tSafe("settings.audioClearAllConfirm");
    if (!(await modalConfirm(prompt))) return;
    if (!(await modalConfirm(prompt))) return;
    try {
      const count = await dep();
      const onToast = this.opts.onToast;
      if (onToast) {
        const template = tSafe("settings.audioClearedToast", { count });
        // If the i18n table isn't populated yet (fallback returns the raw
        // key) or the translator didn't include the {count} placeholder,
        // surface the count anyway so the toast is still informative.
        const text = template.includes(String(count))
          ? template
          : `${template} (${count})`;
        onToast(text);
      }
    } catch (err) {
      const onToast = this.opts.onToast;
      const detail = err instanceof Error ? err.message : String(err);
      if (onToast) onToast(`clear-all failed: ${detail}`);
    }
  }

  private async populateDevices(): Promise<void> {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await this.opts.enumerateDevices();
    } catch {
      // Browser denied enumerate (permissions); leave the select empty.
    }
    this.deviceSelect.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = t("settings.micAuto");
    this.deviceSelect.appendChild(auto);
    for (const d of devices) {
      if (d.kind !== "audioinput") continue;
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId;
      this.deviceSelect.appendChild(opt);
    }
    if (this.current.deviceId) {
      this.deviceSelect.value = this.current.deviceId;
    }
  }

  /** Append an element to the open card, or the panel root if none is open. */
  private mount(el: HTMLElement): void {
    (this.currentCard ?? this.opts.root).appendChild(el);
  }

  /** Prepare the no-results line (the search box itself lives at the top of the
   *  Settings view, above the AI card — see settings-view.ts). */
  private initSearchState(): void {
    this.emptyEl = document.createElement("p");
    this.emptyEl.className = "settings-search-empty";
    this.emptyEl.textContent = tSafe("settings.searchNoResults");
    this.emptyEl.hidden = true;
  }

  /** Filter the panel's cards/rows by a live query (driven by the view's
   *  top-of-page search box). */
  filter(query: string): void {
    this.applyFilter(query);
  }

  /** Filter cards/rows by a case-insensitive substring of their visible text.
   *  A card (and its title) hides when none of its rows match; a `.settings-
   *  section` sub-heading hides when no row beneath it (until the next heading)
   *  matches. An empty query restores everything. */
  private applyFilter(raw: string): void {
    const q = raw.trim().toLowerCase();
    const root = this.opts.root;
    let anyCardVisible = false;
    // Walk the panel's children: each .settings-card pairs with the
    // .settings-card-title immediately before it (avoids `:scope`, which
    // happy-dom doesn't support).
    let pendingTitle: HTMLElement | null = null;
    for (const node of Array.from(root.children) as HTMLElement[]) {
      if (node.classList.contains("settings-card-title")) {
        pendingTitle = node;
        continue;
      }
      if (!node.classList.contains("settings-card")) continue;
      let cardVisible = false;
      let section: HTMLElement | null = null;
      let sectionVisible = false;
      const flush = (): void => {
        if (section) section.hidden = !sectionVisible;
      };
      for (const child of Array.from(node.children) as HTMLElement[]) {
        if (child.classList.contains("settings-section")) {
          flush();
          section = child;
          sectionVisible = false;
          continue;
        }
        const match = q === "" || (child.textContent ?? "").toLowerCase().includes(q);
        child.hidden = !match;
        if (match) {
          cardVisible = true;
          sectionVisible = true;
        }
      }
      flush();
      node.hidden = !cardVisible;
      if (pendingTitle) pendingTitle.hidden = !cardVisible;
      pendingTitle = null;
      if (cardVisible) anyCardVisible = true;
    }
    // Mount the empty-state lazily so an untouched panel never carries it.
    if (!this.emptyEl.isConnected) root.appendChild(this.emptyEl);
    this.emptyEl.hidden = q === "" || anyCardVisible;
  }

  /** Open a titled settings card; subsequent rows mount inside it. */
  private makeCard(titleKey: string): void {
    const title = document.createElement("div");
    title.className = "settings-card-title";
    title.textContent = tSafe(titleKey);
    this.opts.root.appendChild(title);
    const card = document.createElement("div");
    card.className = "settings-card";
    this.opts.root.appendChild(card);
    this.currentCard = card;
  }

  private makeSelect(label: string): HTMLSelectElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field";
    wrap.append(document.createTextNode(label));
    const sel = document.createElement("select");
    wrap.appendChild(sel);
    this.mount(wrap);
    return sel;
  }

  private makeInput(label: string, type: string, value: string): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field";
    wrap.append(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    wrap.appendChild(input);
    this.mount(wrap);
    return input;
  }

  private makeInputWithHint(
    label: string,
    type: string,
    value: string,
    hint: string,
  ): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field";
    wrap.append(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    wrap.appendChild(input);
    const hintEl = document.createElement("span");
    hintEl.className = "settings-hint";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
    this.mount(wrap);
    return input;
  }

  private makeInputWithHintAndError(
    label: string,
    type: string,
    value: string,
    hint: string,
  ): { input: HTMLInputElement; error: HTMLSpanElement } {
    const wrap = document.createElement("label");
    wrap.className = "settings-field";
    wrap.append(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    wrap.appendChild(input);
    const hintEl = document.createElement("span");
    hintEl.className = "settings-hint";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
    const errEl = document.createElement("span");
    errEl.className = "settings-error";
    errEl.textContent = "";
    wrap.appendChild(errEl);
    this.mount(wrap);
    return { input, error: errEl };
  }

  private makeCheckbox(label: string, checked: boolean): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field settings-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    wrap.append(input, document.createTextNode(label));
    this.mount(wrap);
    return input;
  }

  private makeCheckboxWithHint(
    label: string,
    checked: boolean,
    hint: string,
  ): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field settings-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    wrap.append(input, document.createTextNode(label));
    const hintEl = document.createElement("span");
    hintEl.className = "settings-hint";
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
    this.mount(wrap);
    return input;
  }

  /** Desktop-only rebind control: a button that captures the next key combo
   *  and re-registers the quick-voice shortcut at the OS level. */
  private buildShortcutRebind(): void {
    const wrap = document.createElement("div");
    wrap.className = "settings-field settings-shortcut";
    const label = document.createElement("span");
    label.className = "settings-shortcut-label";
    label.textContent = tSafe("settings.shortcutLabel");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-shortcut-btn";
    btn.textContent = formatAccelerator(this.globalHotkeyAccel);
    const hint = document.createElement("span");
    hint.className = "settings-hint";
    hint.textContent = tSafe("settings.shortcutHint");

    let capturing = false;
    const stopCapture = (restore: boolean): void => {
      capturing = false;
      btn.classList.remove("is-capturing");
      window.removeEventListener("keydown", onKey, true);
      if (restore) btn.textContent = formatAccelerator(this.globalHotkeyAccel);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // Esc abandons the rebind without changing the binding.
      if (e.code === "Escape") {
        stopCapture(true);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // wait for a real modifier+key combo
      this.globalHotkeyAccel = accel;
      stopCapture(false);
      btn.textContent = formatAccelerator(accel);
      this.current = { ...this.current, globalHotkeyAccelerator: accel };
      saveSettings(this.current);
      this.opts.onChange(this.current);
      // Re-register at the OS only when the shortcut is enabled.
      if (this.globalHotkeyInput?.checked) {
        void tauriInvoke()?.("set_global_hotkey", {
          enabled: true,
          accelerator: accel,
        });
      }
    };
    btn.addEventListener("click", () => {
      if (capturing) {
        stopCapture(true);
        return;
      }
      capturing = true;
      btn.classList.add("is-capturing");
      btn.textContent = tSafe("settings.shortcutCapturing");
      window.addEventListener("keydown", onKey, true);
    });

    wrap.append(label, btn, hint);
    this.mount(wrap);
  }

  /** Desktop-only rebind control for the "paste last transcript" global
   *  shortcut. Capturing a combo enables the hotkey at the OS level and
   *  re-registers it through `set_paste_hotkey` (which may reject on an
   *  invalid accelerator — rolled back to the prior binding on failure). */
  private buildPasteShortcutRebind(): void {
    const wrap = document.createElement("div");
    wrap.className = "settings-field settings-shortcut settings-paste-shortcut";
    const label = document.createElement("span");
    label.className = "settings-shortcut-label";
    label.textContent = tSafe("settings.pasteHotkeyLabel");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-shortcut-btn settings-paste-shortcut-btn";
    btn.textContent = this.pasteHotkeyAccel
      ? formatAccelerator(this.pasteHotkeyAccel)
      : tSafe("settings.shortcutCapturing");
    const hint = document.createElement("span");
    hint.className = "settings-hint";
    hint.textContent = tSafe("settings.pasteHotkeyHint");

    let capturing = false;
    const stopCapture = (restore: boolean): void => {
      capturing = false;
      btn.classList.remove("is-capturing");
      window.removeEventListener("keydown", onKey, true);
      if (restore) {
        btn.textContent = this.pasteHotkeyAccel
          ? formatAccelerator(this.pasteHotkeyAccel)
          : tSafe("settings.shortcutCapturing");
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        stopCapture(true);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // wait for a real modifier+key combo
      const prevAccel = this.pasteHotkeyAccel;
      const prevEnabled = this.current.pasteHotkeyEnabled;
      this.pasteHotkeyAccel = accel;
      stopCapture(false);
      btn.textContent = formatAccelerator(accel);
      // A freshly captured combo enables the paste hotkey.
      this.current = {
        ...this.current,
        pasteHotkeyAccelerator: accel,
        pasteHotkeyEnabled: true,
      };
      saveSettings(this.current);
      this.opts.onChange(this.current);
      // set_paste_hotkey may reject on an invalid accelerator — roll the UI
      // and stored state back so the button reflects what is actually bound.
      void tauriInvoke()
        ?.("set_paste_hotkey", { enabled: true, accelerator: accel })
        .catch(() => {
          this.pasteHotkeyAccel = prevAccel;
          this.current = {
            ...this.current,
            pasteHotkeyAccelerator: prevAccel,
            pasteHotkeyEnabled: prevEnabled,
          };
          saveSettings(this.current);
          this.opts.onChange(this.current);
          btn.textContent = prevAccel
            ? formatAccelerator(prevAccel)
            : tSafe("settings.shortcutCapturing");
        });
    };
    btn.addEventListener("click", () => {
      if (capturing) {
        stopCapture(true);
        return;
      }
      capturing = true;
      btn.classList.add("is-capturing");
      btn.textContent = tSafe("settings.shortcutCapturing");
      window.addEventListener("keydown", onKey, true);
    });

    wrap.append(label, btn, hint);
    this.mount(wrap);
  }

  /** Desktop-only Accessibility-permission status row: reads
   *  `accessibility_trusted()` (async) and shows granted / not-granted plus a
   *  button that opens the macOS Accessibility settings pane. */
  private buildAccessibilityRow(): void {
    const wrap = document.createElement("div");
    wrap.className = "settings-field settings-accessibility";
    const label = document.createElement("span");
    label.className = "settings-shortcut-label";
    label.textContent = tSafe("settings.accessibilityLabel");
    const status = document.createElement("span");
    status.className = "settings-accessibility-status";
    status.textContent = "…";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-accessibility-btn";
    btn.textContent = tSafe("settings.accessibilityGrant");
    btn.addEventListener("click", () => {
      void tauriInvoke()?.("open_accessibility_settings");
    });

    wrap.append(label, status, btn);
    this.mount(wrap);

    // Reflect the live permission state once the async probe resolves.
    void Promise.resolve(tauriInvoke()?.("accessibility_trusted"))
      .then((trusted) => {
        const granted = trusted === true;
        status.textContent = granted
          ? tSafe("settings.accessibilityGranted")
          : tSafe("settings.accessibilityNotGranted");
        status.dataset.granted = String(granted);
        // Hide the "open settings" button once permission is already granted.
        btn.hidden = granted;
      })
      .catch(() => {
        status.textContent = tSafe("settings.accessibilityNotGranted");
        status.dataset.granted = "false";
      });
  }

  private makeSectionTitle(text: string): void {
    const h = document.createElement("h3");
    h.className = "settings-section";
    h.textContent = text;
    this.mount(h);
  }
}

function clampRetention(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.retention;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

function clampMinutes(n: number, max: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.floor(n));
}

/**
 * Wrapper around `t()` that tolerates string keys not yet present in the
 * i18n table. Audio-replay i18n strings land in a separate task; until then
 * `t()` would type-error on the call site, so we cast through a permissive
 * signature and fall back to the literal key at runtime (matches the
 * fallback logic already inside `t()` itself).
 */
function tSafe(
  key: string,
  vars?: Record<string, string | number>,
): string {
  const fn = t as unknown as (
    key: string,
    vars?: Record<string, string | number>,
  ) => string;
  // Narrow the runtime path: real `t` accepts a `StringKey`. Cast at the
  // boundary so callers can keep using the documented contract keys.
  const _typed: StringKey = key as StringKey; // for future type-checker pass
  void _typed;
  return fn(key, vars);
}
