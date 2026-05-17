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
 */

import {
  AVAILABLE_LOCALES,
  getLocale,
  saveLocale,
  t,
  type Locale,
} from "../i18n";

export const SETTINGS_KEY = "whisper-wrap.settings";

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

export interface SettingsPanelOptions {
  root: HTMLElement;
  enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  onChange: (s: Settings) => void;
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
    this.autocopyAnswerInput = this.makeCheckbox(
      t("settings.autoCopyAnswer"),
      this.current.autoCopyAnswer,
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
      this.autocopyAnswerInput,
      this.retentionInput,
      this.liveIdleInput,
      this.liveMaxInput,
    ]) {
      el.addEventListener("change", onAnyChange);
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
