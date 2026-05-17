/**
 * Settings panel persisting user preferences to localStorage.
 *
 * Controls:
 *   - microphone deviceId (from navigator.mediaDevices.enumerateDevices())
 *   - backend base URL (default: window.location.origin)
 *   - show partials toggle
 *   - auto-scroll toggle
 *   - history retention count (1–50, default 20)
 */

export const SETTINGS_KEY = "whisper-wrap.settings";

export interface Settings {
  deviceId: string | null;
  backendUrl: string;
  showPartials: boolean;
  autoScroll: boolean;
  autoCopy: boolean;
  retention: number;
}

export const DEFAULTS: Settings = {
  deviceId: null,
  backendUrl: "",
  showPartials: true,
  autoScroll: true,
  autoCopy: true,
  retention: 20,
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
  private retentionInput!: HTMLInputElement;

  constructor(private readonly opts: SettingsPanelOptions) {
    this.current = loadSettings();
    this.opts.root.classList.add("settings-panel");
    this.build();
  }

  getSettings(): Settings {
    return { ...this.current };
  }

  private build(): void {
    this.deviceSelect = this.makeSelect("麥克風裝置");
    this.backendInput = this.makeInput("後端位址", "url", this.current.backendUrl);
    this.partialsInput = this.makeCheckbox("顯示 partial", this.current.showPartials);
    this.autoscrollInput = this.makeCheckbox("自動捲到最底", this.current.autoScroll);
    this.autocopyInput = this.makeCheckbox(
      "錄音結束自動複製逐字稿",
      this.current.autoCopy,
    );
    this.retentionInput = this.makeInput(
      "對話記錄保留筆數",
      "number",
      String(this.current.retention),
    );
    this.retentionInput.min = "1";
    this.retentionInput.max = "50";

    this.populateDevices();

    const onAnyChange = (): void => {
      this.current = {
        deviceId: this.deviceSelect.value || null,
        backendUrl: this.backendInput.value,
        showPartials: this.partialsInput.checked,
        autoScroll: this.autoscrollInput.checked,
        autoCopy: this.autocopyInput.checked,
        retention: clampRetention(this.retentionInput.valueAsNumber),
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
    auto.textContent = "（系統預設）";
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
}

function clampRetention(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.retention;
  return Math.min(50, Math.max(1, Math.floor(n)));
}
