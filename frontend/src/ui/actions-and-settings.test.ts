/**
 * Tests for actions-bar (fetch + chip + post /ask + fallback) and
 * settings-panel (persist + reload).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ActionsBar, type ActionTemplate } from "./actions-bar";
import {
  SettingsPanel,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
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
    expect(chips[0].textContent).toBe("直接送");
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
    // Mic select + url input + 2 checkboxes + retention number
    expect(host.querySelectorAll("select").length).toBe(1);
    expect(host.querySelectorAll('input[type="url"]').length).toBe(1);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(host.querySelectorAll('input[type="number"]').length).toBe(1);
  });

  it("persists settings to localStorage and reloadSettings reads them back", () => {
    saveSettings({
      deviceId: "airpods-id",
      backendUrl: "http://example.local:8000",
      showPartials: false,
      autoScroll: false,
      retention: 5,
    });
    const reloaded = loadSettings();
    expect(reloaded.deviceId).toBe("airpods-id");
    expect(reloaded.backendUrl).toBe("http://example.local:8000");
    expect(reloaded.showPartials).toBe(false);
    expect(reloaded.autoScroll).toBe(false);
    expect(reloaded.retention).toBe(5);
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
