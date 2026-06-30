import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderLibrary } from "./library-view";
import type { Item } from "../library/items";

const ITEMS: Item[] = [
  { id: "m1", kind: "meeting", title: "Standup", starred: true, project: "Q3", category: "meeting", createdAt: 300, durationMs: 60000 },
  { id: "s1", kind: "session", title: "靈感 A", starred: false, project: null, category: "quick", createdAt: 200, durationMs: 4000, preview: "今天的天氣不錯" },
  { id: "s2", kind: "session", title: "靈感 B", starred: true, project: null, category: "quick", createdAt: 100, durationMs: 3000 },
];

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".lib-row")]
    .map((r) => r.dataset.itemId!)
    .sort();
}

function typeSearch(container: HTMLElement, q: string): void {
  const input = container.querySelector<HTMLInputElement>(".library-search-input")!;
  input.value = q;
  input.dispatchEvent(new Event("input"));
}

describe("renderLibrary", () => {
  let container: HTMLElement;

  beforeEach(() => {
    history.replaceState(null, "", "#/library");
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    history.replaceState(null, "", "#/");
  });

  it("renders a search box and a star filter", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    expect(container.querySelector(".library-search-input")).toBeTruthy();
    expect(container.querySelector(".library-starfilter")).toBeTruthy();
  });

  it("renders every item as a flat .lib-row with a time + transcript line", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    const rows = [...container.querySelectorAll<HTMLElement>(".lib-row")];
    expect(rows).toHaveLength(3);
    // No old chrome: no segmented control, quick group, or emoji thumbs.
    expect(container.querySelector(".seg")).toBeNull();
    expect(container.querySelector(".quickgroup")).toBeNull();
    expect(container.querySelector(".thumb")).toBeNull();
    const first = rows[0];
    expect(first.querySelector(".lib-row-time")!.textContent).toBeTruthy();
    expect(first.querySelector(".lib-row-chev")).toBeTruthy();
  });

  it("leads with the transcript preview, falling back to the title", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    const s1 = container.querySelector<HTMLElement>('.lib-row[data-item-id="s1"]')!;
    expect(s1.querySelector(".lib-row-text")!.textContent).toBe("今天的天氣不錯");
    // m1 has no preview → falls back to its title.
    const m1 = container.querySelector<HTMLElement>('.lib-row[data-item-id="m1"]')!;
    expect(m1.querySelector(".lib-row-text")!.textContent).toContain("Standup");
  });

  it("filters by the search query (matches preview or title)", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    typeSearch(container, "天氣");
    expect(rowIds(container)).toEqual(["s1"]);
    typeSearch(container, "靈感 B");
    expect(rowIds(container)).toEqual(["s2"]);
    typeSearch(container, "");
    expect(rowIds(container)).toEqual(["m1", "s1", "s2"]);
  });

  it("shows an empty-state line when the search matches nothing", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    typeSearch(container, "zzzznope");
    expect(container.querySelectorAll(".lib-row")).toHaveLength(0);
    expect(container.querySelector(".library-empty")!.textContent).toContain("No matching");
  });

  it("filters to starred only when the star filter is toggled", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    const starBtn = container.querySelector<HTMLButtonElement>(".library-starfilter")!;
    starBtn.click();
    expect(rowIds(container)).toEqual(["m1", "s2"]);
    expect(starBtn.classList.contains("on")).toBe(true);
  });

  it("clicking a row navigates to that item's detail route", async () => {
    await renderLibrary(container, { load: async () => ITEMS });
    container.querySelector<HTMLElement>('.lib-row[data-item-id="m1"]')!.click();
    expect(window.location.hash).toBe("#/item/m1");
  });

  it("toggling a row's star calls the persistence hook", async () => {
    const toggleStar = vi.fn(async () => undefined);
    await renderLibrary(container, { load: async () => ITEMS, toggleStar });
    const star = container.querySelector<HTMLElement>(
      '.lib-row[data-item-id="m1"] .lib-row-star',
    )!;
    star.click();
    expect(toggleStar).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), false);
  });

  it("initialStarred opens with the star filter pre-applied", async () => {
    await renderLibrary(container, {
      load: async () => ITEMS.map((i) => ({ ...i, starred: i.id !== "s1" })),
      initialStarred: true,
    });
    expect(rowIds(container)).toEqual(["m1", "s2"]);
    expect(container.querySelector(".library-starfilter")!.classList.contains("on")).toBe(true);
  });
});
