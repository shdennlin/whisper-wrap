/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelManager } from "./model-manager";
import { resetClientFetch, setClientFetch } from "../api/client";

interface RowSpec {
  name: string;
  installed: boolean;
  runnable: boolean;
  recommended?: boolean;
  size?: string;
  languages?: string[];
  tags?: string[];
  speed?: number;
  accuracy?: number;
}

function modelsResponse(active: string, loaded: boolean, rows: RowSpec[]) {
  return {
    active,
    loaded,
    models: rows.map((r) => ({
      name: r.name,
      description: null,
      license: null,
      size: r.size ?? null,
      languages: r.languages ?? [],
      tags: r.tags ?? [],
      recommended: r.recommended ?? false,
      speed: r.speed ?? null,
      accuracy: r.accuracy ?? null,
      formats: ["ggml"],
      installed: r.installed,
      runnable: r.runnable,
    })),
  };
}

type FetchHandler = (url: string, init?: RequestInit) => unknown;

// The migrated ModelManager talks to the shared `openapi-fetch` client, which
// builds a full `Request` and calls ONE injectable `fetch`. Tests stub that
// seam (`setClientFetch`) and assert on the emitted `Request` (URL + method) —
// the same route/method guarantee the old per-call `fetch` mock asserted.
function mockFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: Request) => {
    const init: RequestInit = { method: input.method };
    calls.push({ url: input.url, init });
    // Run the handler at fetch time, not lazily in json() — handlers carry
    // side effects (loaded/installed flips) and the response body is what the
    // client parses.
    const body = handler(input.url, init);
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  setClientFetch(impl as unknown as typeof fetch);
  return calls;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetClientFetch();
  vi.useRealTimers();
});

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function actionText(root: HTMLElement, name: string): string {
  const row = Array.from(root.querySelectorAll(".model-row")).find(
    (r) => r.querySelector(".model-row-name")?.textContent === name,
  );
  return row?.querySelector(".model-row-action")?.textContent ?? "";
}

describe("ModelManager metadata", () => {
  it("shows a Recommended badge and size · languages in the row meta", async () => {
    mockFetch(() =>
      modelsResponse("breeze", true, [
        { name: "breeze", installed: true, runnable: true, recommended: true, size: "1.6 GB", languages: ["zh-TW", "en"] },
      ]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    const row = [...root.querySelectorAll<HTMLElement>(".model-row")].find(
      (r) => r.querySelector(".model-row-name")?.textContent?.includes("breeze"),
    )!;
    expect(row.querySelector(".model-chip-recommended")!.textContent).toBe("Recommended");
    const meta = row.querySelector(".model-row-meta")!.textContent!;
    expect(meta).toContain("1.6 GB");
    expect(meta).toContain("zh-TW, en");
  });

  it("renders speed/accuracy ratings as 5 dots + the value", async () => {
    mockFetch(() =>
      modelsResponse("breeze", true, [
        { name: "breeze", installed: true, runnable: true, speed: 6.5, accuracy: 9.2 },
      ]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    const ratings = root.querySelector(".model-row-ratings")!;
    const groups = ratings.querySelectorAll(".model-rating");
    expect(groups).toHaveLength(2); // speed + accuracy
    // accuracy 9.2 → 5 dots, round(9.2/2)=5 filled, value shown.
    const acc = groups[1];
    expect(acc.querySelectorAll(".model-rating-dots i")).toHaveLength(5);
    expect(acc.querySelector(".model-rating-num")!.textContent).toBe("9.2");
  });

  it("the Recommended tab filters to recommended models only", async () => {
    mockFetch(() =>
      modelsResponse("a", true, [
        { name: "a", installed: true, runnable: true, recommended: true },
        { name: "b", installed: false, runnable: true, recommended: false },
      ]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    expect(root.querySelectorAll(".model-row")).toHaveLength(2); // default: 全部
    [...root.querySelectorAll<HTMLButtonElement>(".model-tab")]
      .find((t) => t.textContent === "Recommended")!
      .click();
    const rows = [...root.querySelectorAll<HTMLElement>(".model-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.name).toBe("a");
  });
});

describe("ModelManager action states", () => {
  it("active + loaded → Active chip", async () => {
    mockFetch(() =>
      modelsResponse("breeze", true, [{ name: "breeze", installed: true, runnable: true }]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    expect(actionText(root, "breeze")).toBe("Active");
  });

  it("active but NOT installed → Download button (fresh-install gate bug)", async () => {
    mockFetch(() =>
      modelsResponse("breeze", false, [{ name: "breeze", installed: false, runnable: true }]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    const btn = root.querySelector<HTMLButtonElement>(".model-row-action button");
    expect(btn?.textContent).toBe("Download");
  });

  it("active + installed but NOT loaded → Load button", async () => {
    mockFetch(() =>
      modelsResponse("breeze", false, [{ name: "breeze", installed: true, runnable: true }]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    const btn = root.querySelector<HTMLButtonElement>(".model-row-action button");
    expect(btn?.textContent).toBe("Load");
  });

  it("installed + not active → Set active button", async () => {
    mockFetch(() =>
      modelsResponse("other", true, [{ name: "breeze", installed: true, runnable: true }]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    const btn = root.querySelector<HTMLButtonElement>(".model-row-action button");
    expect(btn?.textContent).toBe("Set active");
  });

  it("not runnable → Not supported chip even when named active", async () => {
    mockFetch(() =>
      modelsResponse("turbo", false, [{ name: "turbo", installed: false, runnable: false }]),
    );
    const root = mount();
    new ModelManager(root);
    await flush();
    expect(actionText(root, "turbo")).toBe("Not supported");
  });
});

describe("ModelManager load flow", () => {
  it("Load click POSTs /models/active and notifies onActiveChange", async () => {
    let loaded = false;
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/models/active") && init?.method === "POST") {
        loaded = true;
        return { active: "breeze", swapped: true };
      }
      return modelsResponse("breeze", loaded, [
        { name: "breeze", installed: true, runnable: true },
      ]);
    });
    const root = mount();
    const onActiveChange = vi.fn();
    new ModelManager(root, { onActiveChange });
    await flush();

    root.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await flush();
    await flush();

    expect(calls.some((c) => c.url.endsWith("/models/active") && c.init?.method === "POST")).toBe(
      true,
    );
    expect(onActiveChange).toHaveBeenCalled();
    expect(actionText(root, "breeze")).toBe("Active");
  });

  it("shows live progress with a bar and a Cancel button while downloading", async () => {
    vi.useFakeTimers();
    mockFetch((url, init) => {
      if (url.endsWith("/models/download") && init?.method === "POST") {
        return { name: "breeze", status: "downloading" };
      }
      if (url.includes("/models/download/")) {
        return {
          name: "breeze",
          status: "downloading",
          downloaded_bytes: 5_000_000,
          total_bytes: 10_000_000,
        };
      }
      return modelsResponse("breeze", false, [
        { name: "breeze", installed: false, runnable: true },
      ]);
    });
    const root = mount();
    new ModelManager(root);
    await vi.advanceTimersByTimeAsync(0);

    root.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(2000); // one poll tick

    const label = root.querySelector(".model-progress-label");
    expect(label?.textContent).toContain("50%");
    expect(label?.textContent).toContain("5");
    expect(label?.textContent).toContain("10");
    const fill = root.querySelector<HTMLElement>(".model-progress-fill");
    expect(fill?.style.width).toBe("50%");
    expect(root.querySelector(".model-btn-cancel")).not.toBeNull();
  });

  it("Cancel issues DELETE and the row returns to Download once cancelled lands", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/models/download") && init?.method === "POST") {
        return { name: "breeze", status: "downloading" };
      }
      if (url.includes("/models/download/") && init?.method === "DELETE") {
        cancelled = true;
        return { name: "breeze", status: "cancelling" };
      }
      if (url.includes("/models/download/")) {
        return cancelled
          ? { name: "breeze", status: "cancelled" }
          : { name: "breeze", status: "downloading", downloaded_bytes: 1, total_bytes: 10 };
      }
      return modelsResponse("breeze", false, [
        { name: "breeze", installed: false, runnable: true },
      ]);
    });
    const root = mount();
    new ModelManager(root);
    await vi.advanceTimersByTimeAsync(0);

    root.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(2000); // downloading tick → progress UI

    root.querySelector<HTMLButtonElement>(".model-btn-cancel")!.click();
    await vi.advanceTimersByTimeAsync(2000); // cancelled lands → refresh

    expect(
      calls.some((c) => c.url.includes("/models/download/") && c.init?.method === "DELETE"),
    ).toBe(true);
    const btn = root.querySelector<HTMLButtonElement>(".model-row-action button");
    expect(btn?.textContent).toBe("Download");
  });

  it("notifies onDownloadStart when a download begins", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/models/download") && init?.method === "POST") {
        return { name: "breeze", status: "downloading" };
      }
      return modelsResponse("breeze", false, [
        { name: "breeze", installed: false, runnable: true },
      ]);
    });
    const root = mount();
    const onDownloadStart = vi.fn();
    new ModelManager(root, { onDownloadStart });
    await flush();

    root.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await flush();
    expect(onDownloadStart).toHaveBeenCalledOnce();
  });

  it("routes error messages to the onError hook (and still renders inline)", async () => {
    vi.useFakeTimers();
    mockFetch((url, init) => {
      if (url.endsWith("/models/download") && init?.method === "POST") {
        return { name: "breeze", status: "downloading" };
      }
      if (url.includes("/models/download/")) {
        return { name: "breeze", status: "error", error: "disk full" };
      }
      return modelsResponse("breeze", false, [
        { name: "breeze", installed: false, runnable: true },
      ]);
    });
    const root = mount();
    const onError = vi.fn();
    new ModelManager(root, { onError });
    await vi.advanceTimersByTimeAsync(0);

    root.querySelector<HTMLButtonElement>(".model-row-action button")!.click();
    await vi.advanceTimersByTimeAsync(2000); // poll tick → error status

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(root.querySelector(".model-manager-error")?.textContent).toContain("disk full");
  });

  it("auto-activates the active-named model after its download completes", async () => {
    vi.useFakeTimers();
    let installed = false;
    let loaded = false;
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/models/download") && init?.method === "POST") {
        return { name: "breeze", status: "downloading" };
      }
      if (url.includes("/models/download/")) {
        installed = true;
        return { name: "breeze", status: "done" };
      }
      if (url.endsWith("/models/active") && init?.method === "POST") {
        loaded = true;
        return { active: "breeze", swapped: true };
      }
      return modelsResponse("breeze", loaded, [
        { name: "breeze", installed, runnable: true },
      ]);
    });
    const root = mount();
    const onActiveChange = vi.fn();
    new ModelManager(root, { onActiveChange });
    await vi.advanceTimersByTimeAsync(0);

    // Fresh install: the active-named model shows Download.
    const btn = root.querySelector<HTMLButtonElement>(".model-row-action button");
    expect(btn?.textContent).toBe("Download");
    btn!.click();
    await vi.advanceTimersByTimeAsync(0);

    // First poll tick: download reports done → auto Load (POST /models/active).
    await vi.advanceTimersByTimeAsync(2000);

    expect(calls.some((c) => c.url.endsWith("/models/active") && c.init?.method === "POST")).toBe(
      true,
    );
    expect(onActiveChange).toHaveBeenCalled();
    expect(actionText(root, "breeze")).toBe("Active");
  });
});

describe("ModelManager language/tag filter", () => {
  const rows = [
    { name: "breeze-asr-25", installed: true, runnable: true, languages: ["zh-TW", "en"], tags: ["code-switching"] },
    { name: "large-v3-turbo", installed: true, runnable: true, languages: ["multilingual"], tags: ["fast"] },
    { name: "whisper-tiny", installed: true, runnable: true, languages: ["multilingual"], tags: ["fast"] },
  ];

  const visibleNames = (root: HTMLElement): (string | undefined)[] =>
    [...root.querySelectorAll<HTMLElement>(".model-rows .model-row")].map((r) => r.dataset.name);

  const optionCheckbox = (root: HTMLElement, value: string): HTMLInputElement | undefined =>
    [...root.querySelectorAll<HTMLInputElement>(".model-filter-option input")].find(
      (c) => c.value === value,
    );

  it("shows all rows with no filter selected", async () => {
    mockFetch(() => modelsResponse("breeze-asr-25", true, rows));
    const root = mount();
    new ModelManager(root);
    await flush();
    expect(visibleNames(root)).toEqual(["breeze-asr-25", "large-v3-turbo", "whisper-tiny"]);
  });

  it("selecting the zh-TW option leaves only breeze-asr-25 visible", async () => {
    mockFetch(() => modelsResponse("breeze-asr-25", true, rows));
    const root = mount();
    new ModelManager(root);
    await flush();

    const cb = optionCheckbox(root, "zh-TW");
    expect(cb).toBeTruthy();
    cb!.checked = true;
    cb!.dispatchEvent(new Event("change"));

    expect(visibleNames(root)).toEqual(["breeze-asr-25"]);
  });

  it("selecting the fast tag shows the two multilingual fast models (OR over union)", async () => {
    mockFetch(() => modelsResponse("breeze-asr-25", true, rows));
    const root = mount();
    new ModelManager(root);
    await flush();

    const cb = optionCheckbox(root, "fast");
    cb!.checked = true;
    cb!.dispatchEvent(new Event("change"));

    expect(visibleNames(root)).toEqual(["large-v3-turbo", "whisper-tiny"]);
  });

  it("clearing the selection restores all rows", async () => {
    mockFetch(() => modelsResponse("breeze-asr-25", true, rows));
    const root = mount();
    new ModelManager(root);
    await flush();

    const cb = optionCheckbox(root, "zh-TW");
    cb!.checked = true;
    cb!.dispatchEvent(new Event("change"));
    expect(visibleNames(root)).toEqual(["breeze-asr-25"]);

    cb!.checked = false;
    cb!.dispatchEvent(new Event("change"));
    expect(visibleNames(root)).toEqual(["breeze-asr-25", "large-v3-turbo", "whisper-tiny"]);
  });

  it("separates options into distinct Language and Tag groups (each sorted)", async () => {
    mockFetch(() => modelsResponse("breeze-asr-25", true, rows));
    const root = mount();
    new ModelManager(root);
    await flush();

    const groupValues = (group: string): string[] => {
      const el = root.querySelector<HTMLElement>(`.model-filter-group[data-group="${group}"]`);
      expect(el).toBeTruthy();
      return [...el!.querySelectorAll<HTMLInputElement>("input")].map((c) => c.value);
    };
    expect(groupValues("language")).toEqual(["en", "multilingual", "zh-TW"]);
    expect(groupValues("tag")).toEqual(["code-switching", "fast"]);
  });
});
