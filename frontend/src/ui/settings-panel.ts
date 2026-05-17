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

export const SETTINGS_KEY = "whisper-wrap.settings";

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
  private liveIdleInput!: HTMLInputElement;
  private liveMaxInput!: HTMLInputElement;

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

    this.makeSectionTitle("Live 模式自動停止");
    this.liveIdleInput = this.makeInputWithHint(
      "閒置幾分鐘自動停止（0 = 永不）",
      "number",
      String(this.current.liveIdleMinutes),
      "持續這麼久沒有新字幕就自動停止錄音 — 適合會議結束忘記按停。",
    );
    this.liveIdleInput.min = "0";
    this.liveIdleInput.max = "180";
    this.liveMaxInput = this.makeInputWithHint(
      "最長錄音上限（分鐘，0 = 永不）",
      "number",
      String(this.current.liveMaxMinutes),
      "保命用 hard cap，從按下開始算到這個分鐘數一定停。預設 4 小時。",
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
