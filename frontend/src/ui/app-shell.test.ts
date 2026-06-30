import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountAppShell } from "./app-shell";
import { navigateToView } from "../routing/view-route";
import { t } from "../i18n";

describe("mountAppShell", () => {
  let root: HTMLElement;
  let shell: { destroy(): void };

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("div");
    document.body.appendChild(root);
    shell = mountAppShell(root);
  });

  afterEach(() => {
    shell.destroy();
    root.remove();
    history.replaceState(null, "", "#/");
  });

  it("renders the toolbar, a sidebar nav per view, and a view container", () => {
    expect(root.querySelector(".shell-toolbar")).toBeTruthy();
    expect(root.querySelector(".shell-toolbar .model-pill")).toBeTruthy();
    const nav = root.querySelectorAll(".shell-sidebar .nav-item");
    expect(nav).toHaveLength(4); // home, library, models, settings
    expect(root.querySelector(".shell-view")).toBeTruthy();
  });

  it("boots on Home with its placeholder active", () => {
    expect(root.querySelector(".nav-item.active")?.getAttribute("data-view")).toBe("home");
    expect(
      root.querySelector(".shell-view .view-placeholder")?.getAttribute("data-view"),
    ).toBe("home");
  });

  it("navigating swaps the active nav item and the view body", () => {
    navigateToView({ name: "library" }, { replace: true });
    expect(root.querySelector(".nav-item.active")?.getAttribute("data-view")).toBe("library");
    expect(
      root.querySelector(".shell-view .view-placeholder")?.getAttribute("data-view"),
    ).toBe("library");
  });

  it("destroy() tears the shell down", () => {
    shell.destroy();
    expect(root.querySelector(".shell-toolbar")).toBeNull();
    expect(root.classList.contains("app-shell")).toBe(false);
  });
});

describe("mountAppShell — REC pill", () => {
  let root: HTMLElement;
  let shell: { destroy(): void };
  let recCb: (s: { active: boolean; elapsedLabel: string }) => void;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("div");
    document.body.appendChild(root);
    unsubscribe = vi.fn();
    shell = mountAppShell(root, {
      recordingState: (cb) => {
        recCb = cb;
        return unsubscribe;
      },
    });
  });

  afterEach(() => {
    shell.destroy();
    root.remove();
    history.replaceState(null, "", "#/");
  });

  const pill = () => root.querySelector(".shell-toolbar .pill.reclive");

  it("is absent until the recording state reports active", () => {
    expect(pill()).toBeNull();
  });

  it("appears in the toolbar before the model pill when recording starts", () => {
    recCb({ active: true, elapsedLabel: "00:12" });
    const el = pill();
    expect(el).toBeTruthy();
    expect(el?.tagName).toBe("BUTTON");
    expect(el?.querySelector("span.dot")).toBeTruthy();
    expect(el?.textContent).toBe("REC 00:12");
    expect(el?.getAttribute("aria-label")).toBe(t("rec.pillAria"));
    expect(el?.nextElementSibling?.classList.contains("model-pill")).toBe(true);
  });

  it("updates the elapsed label in place on subsequent ticks", () => {
    recCb({ active: true, elapsedLabel: "00:12" });
    const el = pill();
    recCb({ active: true, elapsedLabel: "00:13" });
    expect(pill()).toBe(el); // same node, not recreated
    expect(el?.textContent).toBe("REC 00:13");
  });

  it("persists across view changes while recording is active", () => {
    recCb({ active: true, elapsedLabel: "00:12" });
    navigateToView({ name: "library" }, { replace: true });
    expect(pill()?.textContent).toBe("REC 00:12");
    navigateToView({ name: "settings" }, { replace: true });
    expect(pill()?.textContent).toBe("REC 00:12");
  });

  it("clicking the pill navigates to home", () => {
    recCb({ active: true, elapsedLabel: "00:12" });
    navigateToView({ name: "library" }, { replace: true });
    (pill() as HTMLButtonElement).click();
    expect(root.querySelector(".nav-item.active")?.getAttribute("data-view")).toBe("home");
  });

  it("is removed when recording stops", () => {
    recCb({ active: true, elapsedLabel: "00:12" });
    recCb({ active: false, elapsedLabel: "" });
    expect(pill()).toBeNull();
  });

  it("destroy() unsubscribes from the recording state", () => {
    expect(unsubscribe).not.toHaveBeenCalled();
    shell.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("mountAppShell — desktop drag region", () => {
  it("marks the toolbar as the Tauri drag region (inert in browsers)", () => {
    history.replaceState(null, "", "#/");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const shell = mountAppShell(root);
    expect(
      root
        .querySelector(".shell-toolbar")
        ?.hasAttribute("data-tauri-drag-region"),
    ).toBe(true);
    shell.destroy();
    root.remove();
  });
});

describe("mountAppShell — sidebar summary", () => {
  let root: HTMLElement;
  let shell: { destroy(): void } | null;

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("div");
    document.body.appendChild(root);
    shell = null;
  });

  afterEach(() => {
    shell?.destroy();
    root.remove();
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("renders counts, a recent section, and bottom-pinned Models/Settings", async () => {
    shell = mountAppShell(root, {
      sidebarSummary: async () => ({
        counts: { library: 5, starred: 2 },
        recent: [
          {
            id: "a1",
            title: "產品週會",
            hint: "今天 · 42 分",
            preview: "大家好 今天的議程是",
          },
          { id: "a2", title: "靈感筆記", hint: "昨天" },
        ],
      }),
    });
    await flush();
    const sidebar = root.querySelector(".shell-sidebar")!;
    const libNav = sidebar.querySelector('[data-view="library"]')!;
    expect(libNav.querySelector("small")?.textContent).toBe("5");
    expect(sidebar.querySelector(".starred-nav small")?.textContent).toBe("2");
    expect(sidebar.querySelector(".sec")?.textContent).toContain(
      t("home.recentTitle"),
    );
    const recents = [...sidebar.querySelectorAll(".recent")];
    expect(recents.length).toBe(2);
    // The first row shows the transcript preview; the second (no preview) omits it.
    expect(recents[0].querySelector(".recent-preview")?.textContent).toBe(
      "大家好 今天的議程是",
    );
    expect(recents[1].querySelector(".recent-preview")).toBeNull();
    (recents[0] as HTMLButtonElement).click();
    expect(window.location.hash).toBe("#/item/a1");
    // Models/Settings pinned after the spacer.
    const spacer = sidebar.querySelector(".spacer")!;
    expect(spacer.nextElementSibling?.getAttribute("data-view")).toBe("models");
  });

  it("routes the ⭐ entry through onStarredNav when provided", async () => {
    const onStarredNav = vi.fn();
    shell = mountAppShell(root, {
      sidebarSummary: async () => ({
        counts: { library: 1, starred: 1 },
        recent: [],
      }),
      onStarredNav,
    });
    await flush();
    root.querySelector<HTMLAnchorElement>(".starred-nav")!.click();
    expect(onStarredNav).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain nav when the summary source rejects", async () => {
    shell = mountAppShell(root, {
      sidebarSummary: async () => {
        throw new Error("offline");
      },
    });
    await flush();
    const sidebar = root.querySelector(".shell-sidebar")!;
    expect(sidebar.querySelector(".sec")).toBeNull();
    expect(sidebar.querySelector(".recent")).toBeNull();
    expect(sidebar.querySelector("small")).toBeNull();
    expect(sidebar.querySelectorAll(".nav-item").length).toBe(4);
  });
});

describe("mountAppShell — nav from profile", () => {
  let root: HTMLElement;
  let shell: { destroy(): void };

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    shell.destroy();
    root.remove();
    history.replaceState(null, "", "#/");
  });

  function navViews(): (string | null)[] {
    return [...root.querySelectorAll(".shell-sidebar .nav-item")].map((el) =>
      el.getAttribute("data-view"),
    );
  }

  it("renders Home/Library/Settings and no Models on the web nav", () => {
    shell = mountAppShell(root, { nav: ["home", "library", "settings"] });
    expect(navViews()).toEqual(["home", "library", "settings"]);
    expect(navViews()).not.toContain("models");
  });

  it("renders Models on the desktop nav", () => {
    shell = mountAppShell(root, {
      nav: ["home", "library", "models", "settings"],
    });
    expect(navViews()).toEqual(["home", "library", "models", "settings"]);
  });

  it("defaults to the full nav when no profile nav is given", () => {
    shell = mountAppShell(root);
    expect(navViews()).toEqual(["home", "library", "models", "settings"]);
  });
});

describe("mountAppShell — refresh()", () => {
  let root: HTMLElement;
  let shell: ReturnType<typeof mountAppShell>;

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    shell.destroy();
    root.remove();
    history.replaceState(null, "", "#/");
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("re-pulls the sidebar summary on demand (capture lands, no navigation)", async () => {
    let library = 1;
    const sidebarSummary = vi.fn(async () => ({
      counts: { library, starred: 0 },
      recent: [],
    }));
    shell = mountAppShell(root, { sidebarSummary });
    await flush();
    expect(sidebarSummary).toHaveBeenCalledTimes(1);
    expect(
      root.querySelector('.shell-sidebar [data-view="library"] small')
        ?.textContent,
    ).toBe("1");

    // A capture lands: count changes, then refresh() without navigating.
    library = 2;
    shell.refresh();
    await flush();
    expect(sidebarSummary).toHaveBeenCalledTimes(2);
    expect(
      root.querySelector('.shell-sidebar [data-view="library"] small')
        ?.textContent,
    ).toBe("2");
  });
});
