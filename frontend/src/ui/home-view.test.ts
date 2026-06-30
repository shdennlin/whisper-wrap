import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountHomeView, type HomeViewDeps } from "./home-view";
import { t } from "../i18n";
import type { Item } from "../library/items";

function makeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    kind: "session",
    title: null,
    starred: false,
    project: null,
    category: null,
    createdAt: 1_700_000_000_000,
    durationMs: 60_000,
    ...overrides,
  };
}

const FOUR_ITEMS: Item[] = [
  makeItem({
    id: "i1",
    title: "產品週會",
    kind: "meeting",
    category: "meeting",
    project: "v3 重構",
    starred: true,
    createdAt: 400,
  }),
  makeItem({ id: "i2", title: "靈感筆記", category: "quick", createdAt: 300 }),
  makeItem({ id: "i3", title: null, filename: "訪談0608.m4a", createdAt: 200 }),
  makeItem({ id: "i4", title: "第四個（不該出現）", createdAt: 100 }),
];

function makeDeps(overrides: Partial<HomeViewDeps> = {}): HomeViewDeps {
  return {
    homeDensity: "full",
    listItems: vi.fn(async () => FOUR_ITEMS),
    navigateToView: vi.fn(),
    onHeroStart: vi.fn(),
    onQuickStart: vi.fn(),
    onImportPick: vi.fn(),
    onMeeting: vi.fn(),
    liveCaptionsEnabled: false,
    onLiveCaptionsToggle: vi.fn(),
    ...overrides,
  };
}

/** Flush the listItems microtask chain so the recent section settles. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function caps(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".cap")];
}

function capByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const found = caps(container).find((c) => c.textContent?.includes(label));
  if (!found) throw new Error(`capsule not found: ${label}`);
  return found;
}

describe("mountHomeView", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("renders the hero, three capsules, and the enhance hint", async () => {
    mountHomeView(container, makeDeps());
    await flush();

    const root = container.querySelector(".home-view");
    expect(root).toBeTruthy();
    const heroBtn = container.querySelector<HTMLButtonElement>(
      ".hero .rec-btn",
    );
    expect(heroBtn).toBeTruthy();
    expect(heroBtn!.getAttribute("aria-label")).toBe(t("home.heroAria"));
    expect(heroBtn!.querySelector("i")).toBeTruthy();
    expect(container.querySelector(".hero h2")!.textContent).toBe(
      t("home.heroTitle"),
    );
    expect(container.querySelector(".hero p")!.textContent).toBe(
      t("home.heroSubtitle"),
    );

    expect(caps(container)).toHaveLength(3);
    expect(capByLabel(container, t("home.capQuick")).textContent).toContain(
      "⚡",
    );
    expect(capByLabel(container, t("home.capMeeting")).textContent).toContain(
      "🖥️",
    );
    expect(capByLabel(container, t("home.capImport")).textContent).toContain(
      "📄",
    );
    expect(container.querySelector(".enh")!.textContent).toBe(
      t("home.enhanceHint"),
    );
  });

  it("shows the ⌥Space kbd hint only in full (desktop) density", async () => {
    mountHomeView(container, makeDeps({ homeDensity: "full" }));
    await flush();
    const quick = capByLabel(container, t("home.capQuick"));
    expect(quick.querySelector("kbd")).toBeTruthy();
    expect(quick.querySelector("kbd")!.textContent).toBe("⌥Space");

    container.replaceChildren();
    mountHomeView(container, makeDeps({ homeDensity: "compact" }));
    await flush();
    expect(
      capByLabel(container, t("home.capQuick")).querySelector("kbd"),
    ).toBeNull();
  });

  it("compact density omits the recent + activity rows that full renders", async () => {
    mountHomeView(container, makeDeps({ homeDensity: "full" }));
    await flush();
    expect(container.querySelector(".cards")).toBeTruthy();
    expect(container.querySelector(".activity")).toBeTruthy();

    container.replaceChildren();
    const compactDeps = makeDeps({ homeDensity: "compact" });
    mountHomeView(container, compactDeps);
    await flush();
    // Heavy dashboard rows are gone; the capture entry stays prominent.
    expect(container.querySelector(".cards")).toBeNull();
    expect(container.querySelector(".activity")).toBeNull();
    expect(container.querySelector(".rec-btn")).toBeTruthy();
    // Capture-first: no backend round-trip when the rows it feeds are omitted.
    expect(compactDeps.listItems).not.toHaveBeenCalled();
  });

  it("exposes a live-captions toggle and keeps the capture entry working", async () => {
    const deps = makeDeps({ liveCaptionsEnabled: false });
    mountHomeView(container, deps);
    await flush();

    const toggle = container.querySelector<HTMLInputElement>(
      ".home-live-toggle .live-toggle-input",
    )!;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(deps.onLiveCaptionsToggle).toHaveBeenCalledWith(true);

    // The capture entry still starts a recording (no batch-vs-live buttons).
    container.querySelector<HTMLButtonElement>(".rec-btn")!.click();
    expect(deps.onHeroStart).toHaveBeenCalledTimes(1);
  });

  it("reflects the stored live-captions preference in the toggle", async () => {
    mountHomeView(container, makeDeps({ liveCaptionsEnabled: true }));
    await flush();
    const toggle = container.querySelector<HTMLInputElement>(
      ".home-live-toggle .live-toggle-input",
    )!;
    expect(toggle.checked).toBe(true);
  });

  it("fires the matching callback for the hero and each capsule", async () => {
    const deps = makeDeps();
    mountHomeView(container, deps);
    await flush();

    container.querySelector<HTMLButtonElement>(".rec-btn")!.click();
    expect(deps.onHeroStart).toHaveBeenCalledTimes(1);

    capByLabel(container, t("home.capQuick")).click();
    expect(deps.onQuickStart).toHaveBeenCalledTimes(1);

    capByLabel(container, t("home.capMeeting")).click();
    expect(deps.onMeeting).toHaveBeenCalledTimes(1);

    capByLabel(container, t("home.capImport")).click();
    expect(deps.onImportPick).toHaveBeenCalledTimes(1);
  });

  it("renders at most three recent cards with badges and titles", async () => {
    mountHomeView(container, makeDeps());
    await flush();

    const cards = [...container.querySelectorAll<HTMLElement>(".cards .card")];
    expect(cards).toHaveLength(3);

    // First item: category + project badges and a star.
    const first = cards[0];
    const badges = [...first.querySelectorAll(".badge")].map(
      (b) => b.textContent,
    );
    expect(badges).toContain("meeting");
    expect(badges).toContain("📂 v3 重構");
    expect(first.querySelector(".star")!.textContent).toBe("⭐");
    expect(first.querySelector("b")!.textContent).toBe("產品週會");
    expect(first.querySelector(".meta-line")).toBeTruthy();

    // Second item: no project, not starred.
    const second = cards[1];
    expect(second.querySelector(".badge.proj")).toBeNull();
    expect(second.querySelector(".star")).toBeNull();

    // Third item: title falls back to filename.
    expect(cards[2].querySelector("b")!.textContent).toBe("訪談0608.m4a");
  });

  it("navigates to detail when a card is clicked", async () => {
    const deps = makeDeps();
    mountHomeView(container, deps);
    await flush();

    const cards = [...container.querySelectorAll<HTMLElement>(".cards .card")];
    cards[1].click();
    expect(deps.navigateToView).toHaveBeenCalledWith({
      name: "detail",
      itemId: "i2",
    });
  });

  it("navigates to the library from the show-all link", async () => {
    const deps = makeDeps();
    mountHomeView(container, deps);
    await flush();

    const showAll = container.querySelector<HTMLElement>(".row-title a")!;
    expect(showAll.textContent).toBe(t("home.showAll"));
    expect(
      container.querySelector(".row-title h3")!.textContent,
    ).toBe(t("home.recentTitle"));
    showAll.click();
    expect(deps.navigateToView).toHaveBeenCalledWith({ name: "library" });
  });

  it("omits the recent section entirely when listItems resolves empty", async () => {
    mountHomeView(container, makeDeps({ listItems: vi.fn(async () => []) }));
    await flush();
    // No recent cards — the activity section (with its empty hint) still
    // renders its own .row-title, so assert on the cards grid specifically.
    expect(container.querySelector(".cards")).toBeNull();
    // Hero is still functional.
    expect(container.querySelector(".rec-btn")).toBeTruthy();
  });

  it("omits the recent section and keeps Home alive when listItems rejects", async () => {
    const deps = makeDeps({
      listItems: vi.fn(async () => {
        throw new Error("backend down");
      }),
    });
    mountHomeView(container, deps);
    await flush();
    expect(container.querySelector(".row-title")).toBeNull();
    expect(container.querySelector(".cards")).toBeNull();
    container.querySelector<HTMLButtonElement>(".rec-btn")!.click();
    expect(deps.onHeroStart).toHaveBeenCalledTimes(1);
  });

  it("setEntriesDisabled toggles hero/quick/import but never the meeting capsule", async () => {
    const view = mountHomeView(container, makeDeps());
    await flush();

    const hero = container.querySelector<HTMLButtonElement>(".rec-btn")!;
    const quick = capByLabel(container, t("home.capQuick"));
    const meeting = capByLabel(container, t("home.capMeeting"));
    const importCap = capByLabel(container, t("home.capImport"));

    view.setEntriesDisabled(true, "x");
    for (const btn of [hero, quick, importCap]) {
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toBe("x");
    }
    expect(meeting.disabled).toBe(false);
    expect(meeting.getAttribute("title")).toBeNull();

    view.setEntriesDisabled(false);
    for (const btn of [hero, quick, importCap]) {
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("title")).toBeNull();
    }
  });

  it("refresh() re-pulls items and replaces the recent cards in place", async () => {
    let items: Item[] = [makeItem({ id: "a", title: "第一筆" })];
    const deps = makeDeps({ listItems: vi.fn(async () => items) });
    const view = mountHomeView(container, deps);
    await flush();
    let cards = [...container.querySelectorAll<HTMLElement>(".cards .card")];
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector("b")!.textContent).toBe("第一筆");

    // A capture lands: a new item appears, then refresh() without remounting.
    items = [
      makeItem({ id: "b", title: "剛錄的" }),
      makeItem({ id: "a", title: "第一筆" }),
    ];
    view.refresh();
    await flush();
    cards = [...container.querySelectorAll<HTMLElement>(".cards .card")];
    // Rows are replaced, not stacked.
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("b")!.textContent).toBe("剛錄的");
    // Exactly one activity dashboard (no duplication on refresh).
    expect(container.querySelectorAll(".activity")).toHaveLength(1);
    expect(deps.listItems).toHaveBeenCalledTimes(2);
  });

  it("destroy removes everything it mounted", async () => {
    const view = mountHomeView(container, makeDeps());
    await flush();
    expect(container.querySelector(".home-view")).toBeTruthy();
    view.destroy();
    expect(container.querySelector(".home-view")).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it("renders the activity section (banner + 4 stat cards + sparkline) from one items read", async () => {
    const deps = makeDeps();
    mountHomeView(container, deps);
    await flush();
    const activity = container.querySelector<HTMLElement>(".activity")!;
    expect(activity).toBeTruthy();
    expect(activity.querySelector(".stat-banner")).toBeTruthy();
    expect(activity.querySelector("canvas.sparkline")).toBeTruthy();
    const cards = [...activity.querySelectorAll(".stat-card")];
    expect(cards.length).toBe(4);
    expect(cards[2]!.textContent).toContain("4"); // totalItems
    expect(deps.listItems).toHaveBeenCalledTimes(1);
  });

  it("shows the empty activity hint with zero items (no sparkline)", async () => {
    mountHomeView(container, makeDeps({ listItems: vi.fn(async () => []) }));
    await flush();
    const activity = container.querySelector<HTMLElement>(".activity")!;
    expect(activity).toBeTruthy();
    expect(activity.querySelector(".activity-empty")).toBeTruthy();
    expect(activity.querySelector("canvas.sparkline")).toBeNull();
  });

  it("hides the activity section entirely when the items read fails", async () => {
    mountHomeView(
      container,
      makeDeps({
        listItems: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    );
    await flush();
    expect(container.querySelector(".activity")).toBeNull();
  });
});
