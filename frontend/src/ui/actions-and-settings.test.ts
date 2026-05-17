/**
 * Tests for actions-bar (fetch + chip + post /ask + fallback) and
 * settings-panel (persist + reload).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActionsBar, type ActionTemplate } from "./actions-bar";
import {
  SettingsPanel,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  DEFAULTS,
  AUDIO_BUDGET_MB_KEY,
  saveAudioBudgetMb,
} from "./settings-panel";

const FIVE_BUILTINS: ActionTemplate[] = [
  { id: "passthrough", label: "直接送", template: "{transcript}" },
  { id: "cleanup", label: "加標點", template: "clean:\n{transcript}" },
  { id: "summarize", label: "整理會議重點", template: "summarize:\n{transcript}" },
  { id: "translate-en", label: "翻譯成英文", template: "translate:\n{transcript}" },
  { id: "formalize", label: "改寫得更專業", template: "formalize:\n{transcript}" },
];

describe("ActionsBar", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("renders one chip per fetched action and runs the action via /ask on click", async () => {
    const recorded: { action_id: string; prompt: string; answer: string }[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => FIVE_BUILTINS,
      postAsk: async (prompt) => ({ answer: `echo:${prompt}` }),
      onAnswer: (run) =>
        recorded.push({
          action_id: run.action_id,
          prompt: run.prompt,
          answer: run.answer,
        }),
      onWarn: () => {},
      getTranscript: () => "今天天氣不錯",
    });
    await bar.load();

    const chips = host.querySelectorAll("button.actions-chip");
    expect(chips.length).toBe(5);
    expect(Array.from(chips).map((c) => c.textContent)).toEqual([
      "直接送",
      "加標點",
      "整理會議重點",
      "翻譯成英文",
      "改寫得更專業",
    ]);

    // Click "summarize" — the wrapped prompt SHALL substitute {transcript}.
    const summarize = host.querySelector(
      'button[data-action-id="summarize"]',
    ) as HTMLButtonElement;
    summarize.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].action_id).toBe("summarize");
    expect(recorded[0].prompt).toBe("summarize:\n今天天氣不錯");
    expect(recorded[0].answer).toBe("echo:summarize:\n今天天氣不錯");
  });

  it("falls back to a single passthrough chip + warning on fetch failure", async () => {
    const warnings: string[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => {
        throw new Error("502 Bad Gateway");
      },
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: (m) => warnings.push(m),
      getTranscript: () => "x",
    });
    await bar.load();

    const chips = host.querySelectorAll("button.actions-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe("Send as-is");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("502 Bad Gateway");
  });

  it("renders the /ask error message in the answer when /ask fails", async () => {
    const recorded: { answer: string }[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => [FIVE_BUILTINS[0]],
      postAsk: async () => {
        throw new Error("LLM not configured");
      },
      onAnswer: (run) => recorded.push({ answer: run.answer }),
      onWarn: () => {},
      getTranscript: () => "hi",
    });
    await bar.load();
    (host.querySelector("button.actions-chip") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded[0].answer).toContain("LLM not configured");
  });
});

describe("SettingsPanel + persistence helpers", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("renders all the documented controls", async () => {
    const panel = new SettingsPanel({
      root: host,
      enumerateDevices: async () => [
        { deviceId: "default", kind: "audioinput", label: "Built-in" } as MediaDeviceInfo,
      ],
      onChange: () => {},
    });
    void panel;
    // 2 selects (language + mic) + url input + 4 checkboxes (showPartials,
    // autoScroll, autoCopy, audioSave) + 4 number inputs (retention,
    // liveIdle, liveMax, audioBudgetMb).
    expect(host.querySelectorAll("select").length).toBe(2);
    expect(host.querySelectorAll('input[type="url"]').length).toBe(1);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(4);
    expect(host.querySelectorAll('input[type="number"]').length).toBe(4);
  });

  it("persists settings to localStorage and reloadSettings reads them back", () => {
    saveSettings({
      deviceId: "airpods-id",
      backendUrl: "http://example.local:8000",
      showPartials: false,
      autoScroll: false,
      autoCopy: false,
      retention: 5,
      liveIdleMinutes: 15,
      liveMaxMinutes: 120,
      audioSave: false,
    });
    const reloaded = loadSettings();
    expect(reloaded.deviceId).toBe("airpods-id");
    expect(reloaded.backendUrl).toBe("http://example.local:8000");
    expect(reloaded.showPartials).toBe(false);
    expect(reloaded.autoScroll).toBe(false);
    expect(reloaded.autoCopy).toBe(false);
    expect(reloaded.retention).toBe(5);
    expect(reloaded.liveIdleMinutes).toBe(15);
    expect(reloaded.liveMaxMinutes).toBe(120);
    expect(reloaded.audioSave).toBe(false);
  });

  it("changing a control fires onChange with the merged Settings and writes localStorage", async () => {
    const seen: { showPartials: boolean }[] = [];
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: (s) => seen.push({ showPartials: s.showPartials }),
    });
    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    expect(seen).toHaveLength(1);
    expect(seen[0].showPartials).toBe(false);
    // localStorage SHALL reflect the change so a reload picks it up.
    const persisted = JSON.parse(
      window.localStorage.getItem(SETTINGS_KEY) ?? "{}",
    );
    expect(persisted.showPartials).toBe(false);
  });
});

describe("SettingsPanel audio controls", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  // (1) DEFAULTS.audioSave is true.
  it("DEFAULTS.audioSave is true", () => {
    expect(DEFAULTS.audioSave).toBe(true);
  });

  // (2) Settings panel renders audio.save checkbox checked by default.
  it("renders the audio.save checkbox checked by default", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    // 4 checkboxes: showPartials, autoScroll, autoCopy, audioSave.
    const checkboxes = host.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(4);
    // The audio.save checkbox is the last one (appended after the existing
    // Settings, immediately below the Live timeout inputs).
    const audioSave = checkboxes[checkboxes.length - 1];
    expect(audioSave.checked).toBe(true);
  });

  // (3) Toggling audio.save persists audioSave:false into whisper-wrap.settings.
  it("toggling the audio.save checkbox persists audioSave:false into whisper-wrap.settings", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    const checkboxes = host.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    const audioSave = checkboxes[checkboxes.length - 1];
    audioSave.checked = false;
    audioSave.dispatchEvent(new Event("change"));

    const persisted = JSON.parse(
      window.localStorage.getItem(SETTINGS_KEY) ?? "{}",
    );
    expect(persisted.audioSave).toBe(false);
  });

  // (4) Audio budget numeric input renders with default 100.
  it("renders the audio budget numeric input with default 100", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    const budgetInput = host.querySelector(
      'input[type="number"][min="10"][max="1000"]',
    ) as HTMLInputElement | null;
    expect(budgetInput).not.toBeNull();
    expect(budgetInput!.value).toBe("100");
  });

  // (5) saveAudioBudgetMb(50) writes 52428800 (= 50 MB in bytes).
  it("saveAudioBudgetMb(50) writes 52428800 bytes to localStorage", () => {
    saveAudioBudgetMb(50);
    expect(window.localStorage.getItem(AUDIO_BUDGET_MB_KEY)).toBe("52428800");
  });

  // (6) saveAudioBudgetMb(5) throws RangeError (below min).
  it("saveAudioBudgetMb(5) throws RangeError", () => {
    expect(() => saveAudioBudgetMb(5)).toThrow(RangeError);
  });

  // (7) saveAudioBudgetMb(2000) throws RangeError (above max).
  it("saveAudioBudgetMb(2000) throws RangeError", () => {
    expect(() => saveAudioBudgetMb(2000)).toThrow(RangeError);
  });

  // (8) saveAudioBudgetMb(100.5) throws RangeError (non-integer).
  it("saveAudioBudgetMb(100.5) throws RangeError", () => {
    expect(() => saveAudioBudgetMb(100.5)).toThrow(RangeError);
  });

  // (9) Setting an out-of-range budget in the UI shows inline error and does
  //     NOT overwrite localStorage with the bad value.
  it("shows inline error and does NOT update localStorage for out-of-range budget", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    const budgetInput = host.querySelector(
      'input[type="number"][min="10"][max="1000"]',
    ) as HTMLInputElement;
    expect(budgetInput).not.toBeNull();

    const before = window.localStorage.getItem(AUDIO_BUDGET_MB_KEY);
    budgetInput.value = "5";
    budgetInput.dispatchEvent(new Event("change"));

    const errorEl = host.querySelector(".settings-error") as HTMLElement | null;
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent ?? "").not.toBe("");

    // A 5-MB byte value would be 5 * 1024 * 1024 = 5242880. Assert that the
    // bad value was NOT written.
    const after = window.localStorage.getItem(AUDIO_BUDGET_MB_KEY);
    expect(after).not.toBe("5242880");
    // It should either still match the previous value or remain null.
    expect(after).toBe(before);
  });

  // (10) Clear-all button calls clearAllAudio after double-confirm, emits a
  //      toast containing the deleted count, and aborts on cancelled confirm.
  it("clear-all button double-confirms then calls clearAllAudio and emits toast", async () => {
    const toasts: string[] = [];
    const clearAllAudio = vi.fn(() => Promise.resolve(7));
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
      clearAllAudio,
      onToast: (t) => toasts.push(t),
    });

    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    const button = host.querySelector(
      "button.settings-clear-audio",
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button!.click();
    // Allow the awaited clearAllAudio promise + toast emit to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearAllAudio).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("7");

    // Second click: cancel on the second confirm — clearAllAudio not called.
    confirmSpy.mockReset();
    confirmSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);
    button!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(clearAllAudio).toHaveBeenCalledTimes(1); // unchanged

    confirmSpy.mockRestore();
  });
});
