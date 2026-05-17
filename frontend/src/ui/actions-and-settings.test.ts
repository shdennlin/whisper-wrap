/**
 * Tests for actions-bar (fetch + chip + post /ask + grouping + fallback) and
 * settings-panel (persist + reload).
 */

import { describe, it, expect, beforeEach } from "vitest";
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

  it("renders all the documented controls", async () => {
    const panel = new SettingsPanel({
      root: host,
      enumerateDevices: async () => [
        { deviceId: "default", kind: "audioinput", label: "Built-in" } as MediaDeviceInfo,
      ],
      onChange: () => {},
    });
    void panel;
    // 2 selects (language + mic) + url input + 4 checkboxes + 3 number inputs
    expect(host.querySelectorAll("select").length).toBe(2);
    expect(host.querySelectorAll('input[type="url"]').length).toBe(1);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(4);
    expect(host.querySelectorAll('input[type="number"]').length).toBe(3);
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
