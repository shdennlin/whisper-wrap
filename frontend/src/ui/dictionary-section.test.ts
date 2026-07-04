/**
 * Tests for the Settings Dictionary section (zh-convert-dictionary task 4.2).
 *
 * Pins the behavioural contract: the conversion toggle round-trips
 * `zh_convert` via PUT, the replacement editor adds/edits/deletes pairs,
 * comma-separated originals expand to one stored pair per original, PUT
 * failures surface the engine's error detail, and the section participates
 * in the settings search filter via its `filter()` handle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DictionaryConfig } from "../api/dictionary-config";
import {
  mountDictionarySection,
  type DictionarySectionDeps,
} from "./dictionary-section";

const EMPTY: DictionaryConfig = { zh_convert: "off", replacements: [] };

const ONE_PAIR: DictionaryConfig = {
  zh_convert: "s2tw",
  replacements: [{ from: "Cloud Code", to: "Claude Code" }],
};

function makeDeps(initial: DictionaryConfig = EMPTY): {
  deps: DictionarySectionDeps;
  put: ReturnType<typeof vi.fn>;
} {
  // The stub echoes the submitted config back, like the real endpoint.
  const put = vi.fn(async (cfg: DictionaryConfig) => cfg);
  const deps: DictionarySectionDeps = {
    get: vi.fn(async () => initial),
    put,
  };
  return { deps, put };
}

async function mount(deps: DictionarySectionDeps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = await mountDictionarySection(host, deps);
  return { host, handle };
}

function toggle(host: HTMLElement): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>("[data-dict-toggle]");
  if (!el) throw new Error("toggle not rendered");
  return el;
}

function fromInput(host: HTMLElement): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>("[data-dict-from]");
  if (!el) throw new Error("from input not rendered");
  return el;
}

function toInput(host: HTMLElement): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>("[data-dict-to]");
  if (!el) throw new Error("to input not rendered");
  return el;
}

function addButton(host: HTMLElement): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>("[data-dict-add]");
  if (!el) throw new Error("add button not rendered");
  return el;
}

function rows(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-dict-row]"));
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("dictionary section", () => {
  it("renders the toggle from the loaded config", async () => {
    const { deps } = makeDeps(ONE_PAIR);
    const { host } = await mount(deps);
    expect(toggle(host).checked).toBe(true);
    expect(rows(host)).toHaveLength(1);
  });

  it("flipping the toggle PUTs the new zh_convert mode", async () => {
    const { deps, put } = makeDeps(EMPTY);
    const { host } = await mount(deps);
    const box = toggle(host);
    expect(box.checked).toBe(false);

    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith({ zh_convert: "s2tw", replacements: [] });
  });

  it("adding a pair with comma-separated originals expands to one pair per original", async () => {
    const { deps, put } = makeDeps(EMPTY);
    const { host } = await mount(deps);

    fromInput(host).value = "Cloud Code, cloud kode";
    toInput(host).value = "Claude Code";
    addButton(host).click();

    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith({
      zh_convert: "off",
      replacements: [
        { from: "Cloud Code", to: "Claude Code" },
        { from: "cloud kode", to: "Claude Code" },
      ],
    });
    // The editor re-renders from the server's echo: two rows, inputs cleared.
    expect(rows(host)).toHaveLength(2);
    expect(fromInput(host).value).toBe("");
  });

  it("editing a row input PUTs the updated pair", async () => {
    const { deps, put } = makeDeps(ONE_PAIR);
    const { host } = await mount(deps);
    const row = rows(host)[0];
    const to = row.querySelector<HTMLInputElement>("[data-dict-row-to]");
    if (!to) throw new Error("row to-input not rendered");

    to.value = "Claude Code CLI";
    to.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith({
      zh_convert: "s2tw",
      replacements: [{ from: "Cloud Code", to: "Claude Code CLI" }],
    });
  });

  it("deleting a row PUTs the table without the pair", async () => {
    const { deps, put } = makeDeps(ONE_PAIR);
    const { host } = await mount(deps);
    const del = rows(host)[0].querySelector<HTMLButtonElement>("[data-dict-delete]");
    if (!del) throw new Error("delete button not rendered");

    del.click();

    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith({ zh_convert: "s2tw", replacements: [] });
    expect(rows(host)).toHaveLength(0);
  });

  it("a failed PUT surfaces the engine's error detail", async () => {
    const { deps } = makeDeps(EMPTY);
    deps.put = vi.fn(async () => {
      throw new Error("replacements[0].from must be non-empty after trimming");
    });
    const { host } = await mount(deps);

    fromInput(host).value = "x";
    toInput(host).value = "y";
    addButton(host).click();

    await vi.waitFor(() => {
      const status = host.querySelector("[data-dict-status]");
      expect(status?.textContent ?? "").toContain("non-empty after trimming");
    });
  });

  it("filter() hides the section when the query matches nothing in it", async () => {
    const { deps } = makeDeps(ONE_PAIR);
    const { host, handle } = await mount(deps);

    handle.filter("zzzz-no-match");
    expect(host.hidden).toBe(true);
    // Matching text (a stored pair) shows it again; empty query always shows.
    handle.filter("claude");
    expect(host.hidden).toBe(false);
    handle.filter("");
    expect(host.hidden).toBe(false);
  });
});
