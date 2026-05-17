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
  retention: number;
  /** Stop Live recording after this many minutes with no speech. 0 = off. */
  liveIdleMinutes: number;
  /** Hard cap on Live recording wall-clock duration. 0 = off. */
  liveMaxMinutes: number;
  /** Persist per-session audio so transcripts can be replayed / re-ASR'd. */
  audioSave: boolean;
}

export const DEFAULTS: Settings = {
  deviceId: null,
  backendUrl: "",
  showPartials: true,
  autoScroll: true,
  autoCopy: true,
  retention: 20,
  liveIdleMinutes: 30,
  liveMaxMinutes: 240,
  audioSave: true,
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
}

export class SettingsPanel {
  private current: Settings;
  private deviceSelect!: HTMLSelectElement;
  private backendInput!: HTMLInputElement;
  private partialsInput!: HTMLInputElement;
  private autoscrollInput!: HTMLInputElement;
  private autocopyInput!: HTMLInputElement;
  private retentionInput!: HTMLInputElement;
  private liveIdleInput!: HTMLInputElement;
  private liveMaxInput!: HTMLInputElement;
  private audioSaveInput!: HTMLInputElement;
  private audioBudgetInput!: HTMLInputElement;
  private audioBudgetError!: HTMLSpanElement;
  private languageSelect!: HTMLSelectElement;

  constructor(private readonly opts: SettingsPanelOptions) {
    this.current = loadSettings();
    this.opts.root.classList.add("settings-panel");
    this.build();
  }

  getSettings(): Settings {
    return { ...this.current };
  }

  private build(): void {
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

    this.deviceSelect = this.makeSelect(t("settings.mic"));
    this.backendInput = this.makeInput(
      t("settings.backendUrl"),
      "url",
      this.current.backendUrl,
    );
    this.partialsInput = this.makeCheckbox(
      t("settings.showPartials"),
      this.current.showPartials,
    );
    this.autoscrollInput = this.makeCheckbox(
      t("settings.autoScroll"),
      this.current.autoScroll,
    );
    this.autocopyInput = this.makeCheckbox(
      t("settings.autoCopy"),
      this.current.autoCopy,
    );
    this.retentionInput = this.makeInput(
      t("settings.retention"),
      "number",
      String(this.current.retention),
    );
    this.retentionInput.min = "1";
    this.retentionInput.max = "50";

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

    // Audio retention controls — placed immediately below the Live timeout
    // fields so users see them next to other recording-related settings.
    this.audioSaveInput = this.makeCheckboxWithHint(
      tSafe("settings.audioSaveLabel"),
      this.current.audioSave,
      tSafe("settings.audioSaveHint"),
    );

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

    this.buildClearAllAudioButton();

    this.populateDevices();

    const onAnyChange = (): void => {
      this.current = {
        deviceId: this.deviceSelect.value || null,
        backendUrl: this.backendInput.value,
        showPartials: this.partialsInput.checked,
        autoScroll: this.autoscrollInput.checked,
        autoCopy: this.autocopyInput.checked,
        retention: clampRetention(this.retentionInput.valueAsNumber),
        liveIdleMinutes: clampMinutes(this.liveIdleInput.valueAsNumber, 180),
        liveMaxMinutes: clampMinutes(this.liveMaxInput.valueAsNumber, 720),
        audioSave: this.audioSaveInput.checked,
      };
      saveSettings(this.current);
      this.opts.onChange(this.current);
    };
    for (const el of [
      this.deviceSelect,
      this.backendInput,
      this.partialsInput,
      this.autoscrollInput,
      this.autocopyInput,
      this.retentionInput,
      this.liveIdleInput,
      this.liveMaxInput,
      this.audioSaveInput,
    ]) {
      el.addEventListener("change", onAnyChange);
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
    this.opts.root.appendChild(wrap);
  }

  private async handleClearAll(): Promise<void> {
    const dep = this.opts.clearAllAudio;
    if (!dep) return;
    // Double-confirm to match the mode-card discard pattern: prevents an
    // accidental click from wiping every recording.
    const prompt = tSafe("settings.audioClearAllConfirm");
    if (!window.confirm(prompt)) return;
    if (!window.confirm(prompt)) return;
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

  private makeSelect(label: string): HTMLSelectElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field";
    wrap.append(document.createTextNode(label));
    const sel = document.createElement("select");
    wrap.appendChild(sel);
    this.opts.root.appendChild(wrap);
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
    this.opts.root.appendChild(wrap);
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
    this.opts.root.appendChild(wrap);
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
    this.opts.root.appendChild(wrap);
    return { input, error: errEl };
  }

  private makeCheckbox(label: string, checked: boolean): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "settings-field settings-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    wrap.append(input, document.createTextNode(label));
    this.opts.root.appendChild(wrap);
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
    this.opts.root.appendChild(wrap);
    return input;
  }

  private makeSectionTitle(text: string): void {
    const h = document.createElement("h3");
    h.className = "settings-section";
    h.textContent = text;
    this.opts.root.appendChild(h);
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
