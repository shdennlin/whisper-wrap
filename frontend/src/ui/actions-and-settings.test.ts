/**
 * Tests for actions-bar (fetch + chip + post /ask + grouping + fallback) and
 * settings-panel (persist + reload).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ActionsBar,
  type ActionTemplate,
  type ActionsResponse,
  type Category,
} from "./actions-bar";
import { LOCALE_STORAGE_KEY, loadLocale } from "../i18n";
import {
  SettingsPanel,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  DEFAULTS,
  AUDIO_BUDGET_MB_KEY,
  saveAudioBudgetMb,
} from "./settings-panel";

const FOUR_CATEGORIES: Category[] = [
  { id: "raw", label: "Raw", labels: { en: "Raw", "zh-TW": "原文" } },
  { id: "cleanup", label: "Cleanup", labels: { en: "Cleanup", "zh-TW": "清理" } },
  {
    id: "structure",
    label: "Structure",
    labels: { en: "Structure", "zh-TW": "結構化" },
  },
  {
    id: "transform",
    label: "Transform",
    labels: { en: "Transform", "zh-TW": "轉換" },
  },
];

const SEVEN_BUILTINS: ActionTemplate[] = [
  {
    id: "passthrough",
    label: "Send as-is",
    labels: { en: "Send as-is", "zh-TW": "直接送" },
    category: "raw",
    template: "{transcript}",
  },
  {
    id: "cleanup-light",
    label: "Light cleanup (no punctuation)",
    labels: {
      en: "Light cleanup (no punctuation)",
      "zh-TW": "輕度整理（不加標點）",
    },
    category: "cleanup",
    template: "light:\n{transcript}",
  },
  {
    id: "punctuate",
    label: "Add punctuation",
    labels: { en: "Add punctuation", "zh-TW": "加標點 / 改寫流暢" },
    category: "cleanup",
    template: "punctuate:\n{transcript}",
  },
  {
    id: "polish",
    label: "Polished rewrite",
    labels: { en: "Polished rewrite", "zh-TW": "改寫得流暢易讀" },
    category: "cleanup",
    template: "polish:\n{transcript}",
  },
  {
    id: "meeting-notes",
    label: "Meeting notes",
    labels: { en: "Meeting notes", "zh-TW": "整理會議紀錄" },
    category: "structure",
    template: "meeting:\n{transcript}",
  },
  {
    id: "translate-en",
    label: "Translate to English",
    labels: { en: "Translate to English", "zh-TW": "翻譯成英文" },
    category: "transform",
    template: "translate:\n{transcript}",
  },
  {
    id: "formalize",
    label: "Formal tone",
    labels: { en: "Formal tone", "zh-TW": "改寫得更專業" },
    category: "transform",
    template: "formalize:\n{transcript}",
  },
];

const SEVEN_RESPONSE: ActionsResponse = {
  actions: SEVEN_BUILTINS,
  categories: FOUR_CATEGORIES,
};

describe("ActionsBar", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    loadLocale();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("interfaces accept new category fields", () => {
    const fixture: ActionTemplate = {
      id: "x",
      label: "X",
      labels: { en: "X" },
      category: "cleanup",
      categoryLabels: { en: "Cleanup", "zh-TW": "清理" },
      template: "{transcript}",
    };
    const cat: Category = {
      id: "cleanup",
      label: "Cleanup",
      labels: { en: "Cleanup", "zh-TW": "清理" },
    };
    const resp: ActionsResponse = { actions: [fixture], categories: [cat] };
    expect(resp.actions[0].category).toBe("cleanup");
    expect(resp.categories[0].id).toBe("cleanup");
  });

  it("renders one chip per fetched action and runs the action via /ask on click", async () => {
    const recorded: {
      action_id: string;
      prompt: string;
      answer: string;
      succeeded: boolean;
    }[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async (prompt) => ({ answer: `echo:${prompt}` }),
      onAnswer: (run, meta) =>
        recorded.push({
          action_id: run.action_id,
          prompt: run.prompt,
          answer: run.answer,
          succeeded: meta.succeeded,
        }),
      onWarn: () => {},
      getTranscript: () => "今天天氣不錯",
    });
    await bar.load();

    const chips = host.querySelectorAll("button.actions-chip");
    expect(chips.length).toBe(7);

    const meeting = host.querySelector(
      'button[data-action-id="meeting-notes"]',
    ) as HTMLButtonElement;
    meeting.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].action_id).toBe("meeting-notes");
    expect(recorded[0].prompt).toBe("meeting:\n今天天氣不錯");
    expect(recorded[0].answer).toBe("echo:meeting:\n今天天氣不錯");
    expect(recorded[0].succeeded).toBe(true);
  });

  it("onAnswer meta reports succeeded=false when postAsk throws", async () => {
    const recorded: { answer: string; succeeded: boolean }[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => {
        throw new Error("LLM not configured");
      },
      onAnswer: (run, meta) =>
        recorded.push({ answer: run.answer, succeeded: meta.succeeded }),
      onWarn: () => {},
      getTranscript: () => "x",
    });
    await bar.load();
    (host.querySelector("button.actions-chip") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded[0].succeeded).toBe(false);
    expect(recorded[0].answer).toContain("LLM not configured");
  });

  it("shows a viewport-clamped tooltip on hover that never extends past the left edge", async () => {
    // Shrink the viewport to make the clamping easy to observe.
    Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 300, writable: true, configurable: true });

    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: [
          {
            id: "leftmost",
            label: "Leftmost",
            labels: { en: "Leftmost" },
            category: "structure",
            description:
              "A description long enough that naive centring would overflow the viewport left edge by a noticeable margin.",
            descriptionLabels: {
              en: "A description long enough that naive centring would overflow the viewport left edge by a noticeable margin.",
            },
            template: "{transcript}",
          },
        ],
        categories: FOUR_CATEGORIES,
      }),
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const chip = host.querySelector(
      'button[data-action-id="leftmost"]',
    ) as HTMLButtonElement;
    // Force the chip to report a near-left-edge position. happy-dom doesn't
    // do layout, so we stub getBoundingClientRect to a realistic value.
    chip.getBoundingClientRect = () =>
      ({
        left: 8,
        top: 150,
        right: 80,
        bottom: 180,
        width: 72,
        height: 30,
        x: 8,
        y: 150,
        toJSON() {
          return this;
        },
      }) as DOMRect;

    chip.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const tip = document.querySelector(".actions-tooltip") as HTMLElement;
    expect(tip).toBeTruthy();
    expect(tip.classList.contains("is-visible")).toBe(true);
    // Even though the chip is near x=0, the tooltip left SHALL be clamped
    // to be >= the controller's 8px viewport margin.
    const left = parseFloat(tip.style.left);
    expect(left).toBeGreaterThanOrEqual(8);

    chip.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(tip.classList.contains("is-visible")).toBe(false);
  });

  it("renders the description inline without setting the native title attribute (avoids double tooltip on desktop)", async () => {
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: [
          {
            id: "with-desc",
            label: "Polish",
            labels: { en: "Polish" },
            category: "cleanup",
            description: "Polishes the transcript without adding info.",
            descriptionLabels: {
              en: "Polishes the transcript without adding info.",
              "zh-TW": "改寫得通順，不加新資訊。",
            },
            template: "{transcript}",
          },
          {
            id: "no-desc",
            label: "Bare",
            labels: { en: "Bare" },
            category: "raw",
            template: "{transcript}",
          },
        ],
        categories: FOUR_CATEGORIES,
      }),
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const withDesc = host.querySelector(
      'button[data-action-id="with-desc"]',
    ) as HTMLButtonElement;
    // No native title — the browser would otherwise render its own tooltip
    // simultaneously with our JS-driven one. aria-label covers a11y.
    expect(withDesc.title).toBe("");
    expect(withDesc.getAttribute("aria-label")).toBe(
      "Polish. Polishes the transcript without adding info.",
    );
    // Label + description live in their own spans so the touch-device card
    // layout can show the description as a subtitle (hidden via CSS on
    // hover-capable devices).
    const label = withDesc.querySelector(".actions-chip-label");
    expect(label?.textContent).toBe("Polish");
    const desc = withDesc.querySelector(".actions-chip-description");
    expect(desc?.textContent).toBe(
      "Polishes the transcript without adding info.",
    );

    const noDesc = host.querySelector(
      'button[data-action-id="no-desc"]',
    ) as HTMLButtonElement;
    expect(noDesc.title).toBe("");
    expect(noDesc.querySelector(".actions-chip-description")).toBeNull();
    // No aria-label override when there's no description — screen readers fall
    // back to the visible label text inside the .actions-chip-label span.
    expect(noDesc.hasAttribute("aria-label")).toBe(false);
  });

  it("does not attach hover tooltip listeners on touch devices (no tap-flash UX)", async () => {
    // Mock matchMedia to report a touch device (no hover + coarse pointer).
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches:
        query.includes("hover: none") || query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;

    try {
      const bar = new ActionsBar({
        root: host,
        fetchActions: async () => ({
          actions: [
            {
              id: "touch-test",
              label: "Polish",
              labels: { en: "Polish" },
              category: "cleanup",
              description: "Polishes the transcript without adding info.",
              descriptionLabels: {
                en: "Polishes the transcript without adding info.",
              },
              template: "{transcript}",
            },
          ],
          categories: FOUR_CATEGORIES,
        }),
        postAsk: async () => ({ answer: "" }),
        onAnswer: () => {},
        onWarn: () => {},
        getTranscript: () => "",
      });
      await bar.load();

      const chip = host.querySelector(
        'button[data-action-id="touch-test"]',
      ) as HTMLButtonElement;

      // Simulating a hover on a touch device must NOT show the tooltip — on
      // touch this event would fire briefly during a tap and the tooltip
      // flash is the UX problem we're avoiding.
      chip.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      const tip = document.querySelector(".actions-tooltip");
      // Either the tooltip element wasn't created at all (no hover listeners
      // attached), or it exists but is not in the visible state.
      expect(tip === null || !tip.classList.contains("is-visible")).toBe(true);

      // The description is still rendered inline so the CSS card layout can
      // surface it as a subtitle.
      const desc = chip.querySelector(".actions-chip-description");
      expect(desc?.textContent).toBe(
        "Polishes the transcript without adding info.",
      );
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it("renders a section header (title group + touch-only toggle) before the category groups", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
    loadLocale();
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const header = host.querySelector(".actions-section-header");
    expect(header).toBeTruthy();
    expect(host.firstElementChild).toBe(header);

    // Left side: title wrapper containing heading + model badge.
    const title = header?.querySelector(".actions-section-title");
    expect(title).toBeTruthy();
    const heading = title?.querySelector(".actions-section-heading");
    expect(heading?.textContent).toBe("AI 增強");
    const badge = title?.querySelector(".actions-model-badge");
    // Badge element exists from first render, hidden until setModel() runs.
    expect(badge).toBeTruthy();
    expect((badge as HTMLElement).hidden).toBe(true);

    // Right side: toggle in DOM on all platforms; CSS hides it on hover devices.
    const toggle = header?.querySelector(
      ".actions-description-toggle input[type=checkbox]",
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
  });

  it("setModel surfaces the AI backend label next to the section heading", async () => {
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const badge = host.querySelector(".actions-model-badge") as HTMLElement;
    expect(badge.hidden).toBe(true);

    // Configured + model → shown as ok.
    bar.setModel({ configured: true, model: "gemini-2.5-flash" });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("gemini-2.5-flash");
    expect(badge.dataset.state).toBe("ok");
    expect(badge.title).toContain("gemini-2.5-flash");

    // Not configured → show the localised "not configured" message + red state.
    bar.setModel({ configured: false });
    expect(badge.hidden).toBe(false);
    expect(badge.dataset.state).toBe("down");
    expect(badge.textContent).toBeTruthy();

    // Null → hidden again (used when /status hasn't resolved yet).
    bar.setModel(null);
    expect(badge.hidden).toBe(true);
  });

  it("show-descriptions toggle persists and applies descriptions-off class", async () => {
    window.localStorage.removeItem("whisper-wrap.actions.showDescriptions");

    const makeBar = () =>
      new ActionsBar({
        root: host,
        fetchActions: async () => SEVEN_RESPONSE,
        postAsk: async () => ({ answer: "" }),
        onAnswer: () => {},
        onWarn: () => {},
        getTranscript: () => "",
      });

    const bar1 = makeBar();
    await bar1.load();
    // Default: no descriptions-off class (descriptions ARE shown).
    expect(host.classList.contains("descriptions-off")).toBe(false);

    // User toggles OFF.
    const toggle = host.querySelector(
      ".actions-description-toggle input[type=checkbox]",
    ) as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));

    // Class flips immediately so CSS can revert cards to pill layout.
    expect(host.classList.contains("descriptions-off")).toBe(true);
    // Persisted to localStorage.
    expect(
      window.localStorage.getItem("whisper-wrap.actions.showDescriptions"),
    ).toBe("false");

    // Fresh ActionsBar reads the persisted value on construction and applies
    // the class BEFORE first render (no flash of card mode on reload).
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.appendChild(host);
    const bar2 = makeBar();
    expect(host.classList.contains("descriptions-off")).toBe(true);
    await bar2.load();
    expect(host.classList.contains("descriptions-off")).toBe(true);
    const toggle2 = host.querySelector(
      ".actions-description-toggle input[type=checkbox]",
    ) as HTMLInputElement;
    expect(toggle2.checked).toBe(false);
  });

  it("does not render a section heading in the fallback path (looks out of proportion above one chip)", async () => {
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => {
        throw new Error("registry down");
      },
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    expect(host.querySelector(".actions-section-heading")).toBeNull();
    expect(host.querySelectorAll("button.actions-chip").length).toBe(1);
  });

  it("renders four category headings in declared order", async () => {
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const headings = host.querySelectorAll(".actions-category-heading");
    expect(Array.from(headings).map((h) => h.textContent)).toEqual([
      "Raw",
      "Cleanup",
      "Structure",
      "Transform",
    ]);
  });

  it("category headings localise on locale switch", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
    loadLocale();
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const headings = host.querySelectorAll(".actions-category-heading");
    expect(Array.from(headings).map((h) => h.textContent)).toEqual([
      "原文",
      "清理",
      "結構化",
      "轉換",
    ]);
  });

  it("category groups have distinct DOM containers", async () => {
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const groups = host.querySelectorAll(".actions-category-group");
    expect(groups.length).toBe(4);
    for (const group of Array.from(groups)) {
      const heading = group.querySelector(".actions-category-heading");
      const chips = group.querySelector(".actions-category-chips");
      expect(heading).toBeTruthy();
      expect(chips).toBeTruthy();
      expect(chips!.querySelectorAll(".actions-chip").length).toBeGreaterThan(0);
    }
  });

  it("unknown category falls into Misc bucket", async () => {
    const experimental: ActionTemplate = {
      id: "experimental-chip",
      label: "Experimental",
      labels: { en: "Experimental" },
      category: "experimental",
      template: "{transcript}",
    };
    const known: ActionTemplate = {
      id: "passthrough",
      label: "Send as-is",
      labels: { en: "Send as-is" },
      category: "raw",
      template: "{transcript}",
    };
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: [known, experimental],
        categories: FOUR_CATEGORIES,
      }),
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const headings = host.querySelectorAll(".actions-category-heading");
    const headingTexts = Array.from(headings).map((h) => h.textContent);
    // Raw appears (one chip), then Misc trails after — Cleanup/Structure/Transform
    // are skipped because they have no chips.
    expect(headingTexts).toEqual(["Raw", "Misc"]);

    const groups = host.querySelectorAll(".actions-category-group");
    const lastGroup = groups[groups.length - 1];
    const lastChip = lastGroup.querySelector(
      'button[data-action-id="experimental-chip"]',
    );
    expect(lastChip).toBeTruthy();
  });

  it("renders chip text from labels[activeLocale]", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
    loadLocale();
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const chips = host.querySelectorAll("button.actions-chip");
    expect(Array.from(chips).map((c) => c.textContent)).toEqual([
      "直接送",
      "輕度整理（不加標點）",
      "加標點 / 改寫流暢",
      "改寫得流暢易讀",
      "整理會議紀錄",
      "翻譯成英文",
      "改寫得更專業",
    ]);
  });

  it("falls back through labels.en → first labels entry → label → id when active locale missing", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
    loadLocale();
    const partials: ActionTemplate[] = [
      // labels has only `en` while active is zh-TW → renders `en`
      {
        id: "en-only",
        label: "Send",
        labels: { en: "Send" },
        category: "raw",
        template: "{transcript}",
      },
      // labels has only `zh-TW` while active is zh-TW — first mapping entry wins
      {
        id: "zh-only",
        label: "送出",
        labels: { "zh-TW": "送出" },
        category: "raw",
        template: "{transcript}",
      },
      // labels field absent → renders `label` string
      {
        id: "no-labels",
        label: "Legacy",
        category: "raw",
        template: "{transcript}",
      },
      // no usable label anywhere → renders action id
      { id: "blank", label: "", category: "raw", template: "{transcript}" },
    ];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: partials,
        categories: FOUR_CATEGORIES,
      }),
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const chipText = Array.from(host.querySelectorAll("button.actions-chip")).map(
      (c) => c.textContent,
    );
    expect(chipText).toEqual(["Send", "送出", "Legacy", "blank"]);
  });

  it("first mapping entry wins when neither active nor en is in labels", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    loadLocale();
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: [
          {
            id: "zh-only-mapping",
            label: "fallback-label",
            labels: { "zh-TW": "送出" },
            category: "raw",
            template: "{transcript}",
          },
        ],
        categories: FOUR_CATEGORIES,
      }),
      postAsk: async () => ({ answer: "" }),
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "",
    });
    await bar.load();

    const chip = host.querySelector("button.actions-chip");
    expect(chip?.textContent).toBe("送出");
  });

  it("fallback path renders no category headings", async () => {
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
    expect(host.querySelectorAll(".actions-category-heading").length).toBe(0);
    expect(host.querySelectorAll(".actions-category-group").length).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("502 Bad Gateway");
  });

  it("fires onLoading and marks the active chip while postAsk is pending", async () => {
    const events: { running: boolean; actionId: string | null }[] = [];
    let resolveAsk!: (v: { answer: string }) => void;
    const pending = new Promise<{ answer: string }>((r) => {
      resolveAsk = r;
    });
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: () => pending,
      onAnswer: () => {},
      onLoading: (info) => events.push(info),
      onWarn: () => {},
      getTranscript: () => "x",
    });
    await bar.load();

    const meeting = host.querySelector(
      'button[data-action-id="meeting-notes"]',
    ) as HTMLButtonElement;
    meeting.click();
    // Tick the microtask queue so the chip-click handler reaches its await.
    await Promise.resolve();

    expect(events).toEqual([{ running: true, actionId: "meeting-notes" }]);
    expect(meeting.dataset.loading).toBe("true");
    expect(meeting.disabled).toBe(true);
    // All chips disabled while one is running.
    for (const chip of Array.from(
      host.querySelectorAll<HTMLButtonElement>("button.actions-chip"),
    )) {
      expect(chip.disabled).toBe(true);
    }

    resolveAsk({ answer: "done" });
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toEqual([
      { running: true, actionId: "meeting-notes" },
      { running: false, actionId: "meeting-notes" },
    ]);
    expect(meeting.dataset.loading).toBeUndefined();
    expect(meeting.disabled).toBe(false);
  });

  it("ignores chip clicks while another action is in flight (single-flight)", async () => {
    let askCallCount = 0;
    let resolveAsk!: (v: { answer: string }) => void;
    const first = new Promise<{ answer: string }>((r) => {
      resolveAsk = r;
    });
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => SEVEN_RESPONSE,
      postAsk: () => {
        askCallCount++;
        return first;
      },
      onAnswer: () => {},
      onWarn: () => {},
      getTranscript: () => "x",
    });
    await bar.load();

    const meeting = host.querySelector(
      'button[data-action-id="meeting-notes"]',
    ) as HTMLButtonElement;
    const polish = host.querySelector(
      'button[data-action-id="polish"]',
    ) as HTMLButtonElement;

    meeting.click();
    await Promise.resolve();
    // Even attempting to bypass the disabled state, run() is a no-op while busy.
    polish.disabled = false;
    polish.click();
    await Promise.resolve();

    expect(askCallCount).toBe(1);

    resolveAsk({ answer: "done" });
    await new Promise((r) => setTimeout(r, 0));
  });

  it("renders the /ask error message in the answer when /ask fails", async () => {
    const recorded: { answer: string }[] = [];
    const bar = new ActionsBar({
      root: host,
      fetchActions: async () => ({
        actions: [SEVEN_BUILTINS[0]],
        categories: FOUR_CATEGORIES,
      }),
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

  function hotkeyToggle(): HTMLInputElement | undefined {
    return [...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox")]
      .find((l) => l.textContent?.includes("⌥Space"))
      ?.querySelector("input") as HTMLInputElement | undefined;
  }

  it("omits the global-hotkey toggle in a plain browser", () => {
    new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {} });
    expect(hotkeyToggle()).toBeUndefined();
  });

  it("renders the global-hotkey toggle on desktop and invokes set_global_hotkey", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const toggle = hotkeyToggle();
      expect(toggle).toBeTruthy();
      expect(toggle!.checked).toBe(true); // default enabled
      toggle!.checked = false;
      toggle!.dispatchEvent(new Event("change"));
      // Re-registration carries the current accelerator (default ⌥Space).
      expect(invoke).toHaveBeenCalledWith("set_global_hotkey", {
        enabled: false,
        accelerator: "Alt+Space",
      });
      // The flip persists to the stored Settings.
      expect(loadSettings().globalHotkeyEnabled).toBe(false);
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("rebinds the shortcut: captures a combo, re-registers, and persists", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const btn = host.querySelector(
        ".settings-shortcut-btn",
      ) as HTMLButtonElement | null;
      expect(btn).toBeTruthy();
      expect(btn!.textContent).toBe("⌥Space"); // default

      // Enter capture mode, then press ⌃⇧K.
      btn!.click();
      expect(btn!.classList.contains("is-capturing")).toBe(true);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyK",
          ctrlKey: true,
          shiftKey: true,
        }),
      );

      expect(btn!.classList.contains("is-capturing")).toBe(false);
      expect(btn!.textContent).toBe("⌃⇧K");
      // Default toggle is enabled, so the new binding re-registers at the OS.
      expect(invoke).toHaveBeenCalledWith("set_global_hotkey", {
        enabled: true,
        accelerator: "Control+Shift+KeyK",
      });
      expect(loadSettings().globalHotkeyAccelerator).toBe("Control+Shift+KeyK");
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("rebind ignores modifier-only presses and Esc cancels capture", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const btn = host.querySelector(
        ".settings-shortcut-btn",
      ) as HTMLButtonElement | null;
      btn!.click();
      // A lone modifier keeps capture mode active (no full combo yet).
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "AltLeft", altKey: true }),
      );
      expect(btn!.classList.contains("is-capturing")).toBe(true);
      // Esc abandons the rebind without changing the binding.
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
      expect(btn!.classList.contains("is-capturing")).toBe(false);
      expect(btn!.textContent).toBe("⌥Space");
      expect(loadSettings().globalHotkeyAccelerator).toBe("Alt+Space");
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  function autoPasteToggle(): HTMLInputElement | undefined {
    return [...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox")]
      .find((l) => l.textContent?.includes("Auto-paste transcript"))
      ?.querySelector("input") as HTMLInputElement | undefined;
  }

  it("omits the auto-paste toggle in a plain browser", () => {
    new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {} });
    expect(autoPasteToggle()).toBeUndefined();
  });

  it("renders the auto-paste toggle on desktop and invokes set_auto_paste on change", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const toggle = autoPasteToggle();
      expect(toggle).toBeTruthy();
      expect(toggle!.checked).toBe(false); // default disabled
      toggle!.checked = true;
      toggle!.dispatchEvent(new Event("change"));
      expect(invoke).toHaveBeenCalledWith("set_auto_paste", { enabled: true });
      expect(loadSettings().autoPasteEnabled).toBe(true);
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  function autoPauseMediaToggle(): HTMLInputElement | undefined {
    return [...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox")]
      .find((l) => l.textContent?.includes("Pause media while recording"))
      ?.querySelector("input") as HTMLInputElement | undefined;
  }

  it("omits the Experimental auto-pause-media toggle in a plain browser", () => {
    new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {} });
    expect(autoPauseMediaToggle()).toBeUndefined();
  });

  it("renders the auto-pause-media toggle on desktop and invokes set_auto_pause_media on change", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const toggle = autoPauseMediaToggle();
      expect(toggle).toBeTruthy();
      expect(toggle!.checked).toBe(false); // default disabled
      toggle!.checked = true;
      toggle!.dispatchEvent(new Event("change"));
      expect(invoke).toHaveBeenCalledWith("set_auto_pause_media", { enabled: true });
      expect(loadSettings().autoPauseMediaEnabled).toBe(true);
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("rebinds the paste-last shortcut: captures a combo, invokes set_paste_hotkey, persists", () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    try {
      new SettingsPanel({ root: host, enumerateDevices: async () => [], onChange: () => {}, showDesktopShortcuts: true, showExperimental: true });
      const btn = host.querySelector(
        ".settings-paste-shortcut-btn",
      ) as HTMLButtonElement | null;
      expect(btn).toBeTruthy();

      btn!.click();
      expect(btn!.classList.contains("is-capturing")).toBe(true);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyV",
          ctrlKey: true,
          shiftKey: true,
        }),
      );

      expect(btn!.classList.contains("is-capturing")).toBe(false);
      expect(btn!.textContent).toBe("⌃⇧V");
      // Capturing a combo enables the paste hotkey at the OS level.
      expect(invoke).toHaveBeenCalledWith("set_paste_hotkey", {
        enabled: true,
        accelerator: "Control+Shift+KeyV",
      });
      expect(loadSettings().pasteHotkeyAccelerator).toBe("Control+Shift+KeyV");
      expect(loadSettings().pasteHotkeyEnabled).toBe(true);
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
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
    // 2 selects (language + mic) + url input + 5 checkboxes (showPartials,
    // autoScroll, autoCopy, autoCopyAnswer, audioSave) + 4 number inputs
    // (retention, liveIdle, liveMax, audioBudgetMb).
    expect(host.querySelectorAll("select").length).toBe(2);
    expect(host.querySelectorAll('input[type="url"]').length).toBe(1);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(5);
    expect(host.querySelectorAll('input[type="number"]').length).toBe(4);
  });

  it("persists settings to localStorage and reloadSettings reads them back", () => {
    saveSettings({
      deviceId: "airpods-id",
      backendUrl: "http://example.local:8000",
      showPartials: false,
      autoScroll: false,
      autoCopy: false,
      autoCopyAnswer: false,
      retention: 5,
      liveIdleMinutes: 15,
      liveMaxMinutes: 120,
      audioSave: false,
      globalHotkeyEnabled: true,
      globalHotkeyAccelerator: "Control+Shift+KeyK",
      autoPasteEnabled: true,
      pasteHotkeyEnabled: true,
      pasteHotkeyAccelerator: "Alt+V",
      autoPauseMediaEnabled: false,
    });
    const reloaded = loadSettings();
    expect(reloaded.deviceId).toBe("airpods-id");
    expect(reloaded.backendUrl).toBe("http://example.local:8000");
    expect(reloaded.showPartials).toBe(false);
    expect(reloaded.autoScroll).toBe(false);
    expect(reloaded.autoCopy).toBe(false);
    expect(reloaded.autoCopyAnswer).toBe(false);
    expect(reloaded.retention).toBe(5);
    expect(reloaded.liveIdleMinutes).toBe(15);
    expect(reloaded.liveMaxMinutes).toBe(120);
    expect(reloaded.audioSave).toBe(false);
    expect(reloaded.globalHotkeyAccelerator).toBe("Control+Shift+KeyK");
    expect(reloaded.autoPasteEnabled).toBe(true);
    expect(reloaded.pasteHotkeyEnabled).toBe(true);
    expect(reloaded.pasteHotkeyAccelerator).toBe("Alt+V");
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
    // 5 checkboxes: showPartials, autoScroll, autoCopy, autoCopyAnswer, audioSave.
    // (HEAD added autoCopyAnswer; worktree added audioSave; both land here.)
    const checkboxes = host.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(5);
    // Locate by label (cards reorder checkboxes, so index is unreliable).
    const audioSave = [
      ...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox"),
    ]
      .find((l) => l.textContent?.includes("Save audio for replay"))
      ?.querySelector("input") as HTMLInputElement;
    expect(audioSave.checked).toBe(true);
  });

  // (3) Toggling audio.save persists audioSave:false into whisper-wrap.settings.
  it("toggling the audio.save checkbox persists audioSave:false into whisper-wrap.settings", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    const audioSave = [
      ...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox"),
    ]
      .find((l) => l.textContent?.includes("Save audio for replay"))
      ?.querySelector("input") as HTMLInputElement;
    audioSave.checked = false;
    audioSave.dispatchEvent(new Event("change"));

    const persisted = JSON.parse(
      window.localStorage.getItem(SETTINGS_KEY) ?? "{}",
    );
    expect(persisted.audioSave).toBe(false);
  });

  // (3b) Settings render grouped into titled cards, with controls inside them.
  it("groups settings into titled cards", () => {
    new SettingsPanel({
      root: host,
      enumerateDevices: async () => [],
      onChange: () => {},
    });
    expect(host.querySelectorAll(".settings-card").length).toBeGreaterThanOrEqual(
      4,
    );
    expect(host.querySelector(".settings-card-title")).toBeTruthy();
    const audioSaveLabel = [
      ...host.querySelectorAll<HTMLLabelElement>(".settings-checkbox"),
    ].find((l) => l.textContent?.includes("Save audio for replay"));
    expect(audioSaveLabel?.closest(".settings-card")).toBeTruthy();
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

    // Confirmation is now an in-DOM modalConfirm (window.confirm no-ops in
    // the WKWebView shell). Each clear double-confirms, so resolve two modals
    // in sequence; a microtask between them lets the handler mount the next.
    const answerModal = (ok: boolean) => {
      const sel = ok ? ".modal-prompt-ok" : ".modal-prompt-cancel";
      document.querySelector<HTMLButtonElement>(sel)?.click();
    };
    const button = host.querySelector(
      "button.settings-clear-audio",
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    button!.click();
    answerModal(true);
    await Promise.resolve();
    answerModal(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(clearAllAudio).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("7");

    // Second click: cancel on the second confirm — clearAllAudio not called.
    button!.click();
    answerModal(true);
    await Promise.resolve();
    answerModal(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(clearAllAudio).toHaveBeenCalledTimes(1); // unchanged
  });
});
