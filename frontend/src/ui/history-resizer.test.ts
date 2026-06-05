/**
 * Tests for HistoryResizer: pointer drag flow, clamping at min/max
 * (with viewport-aware max cap), and localStorage persistence.
 *
 * happy-dom provides PointerEvent and innerWidth — we drive both directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HistoryResizer } from "./history-resizer";

const STORAGE_KEY = "whisper-wrap.historyWidth";

function makeShell(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "recording-shell";
  document.body.appendChild(shell);
  return shell;
}

function pointerEvent(
  type: string,
  clientX: number,
  pointerId = 1,
): PointerEvent {
  const ev = new Event(type, { bubbles: true }) as PointerEvent;
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "pointerId", { value: pointerId });
  return ev;
}

function readWidth(shell: HTMLElement): number {
  const raw = shell.style.getPropertyValue("--history-width");
  return Number.parseInt(raw, 10);
}

describe("HistoryResizer", () => {
  beforeEach(() => {
    localStorage.clear();
    // Make max cap = 0.6 * 1600 = 960 → easier to assert.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("initializes --history-width to the stored value or default", () => {
    const shellA = makeShell();
    new HistoryResizer({ shell: shellA });
    expect(readWidth(shellA)).toBe(520);

    document.body.replaceChildren();
    localStorage.setItem(STORAGE_KEY, "450");
    const shellB = makeShell();
    new HistoryResizer({ shell: shellB });
    expect(readWidth(shellB)).toBe(450);
  });

  it("rejects out-of-range stored values and clamps to safe bounds", () => {
    // Below min → clamp to MIN (320).
    localStorage.setItem(STORAGE_KEY, "120");
    const shellA = makeShell();
    new HistoryResizer({ shell: shellA });
    expect(readWidth(shellA)).toBe(320);

    document.body.replaceChildren();

    // Above 60% of innerWidth=1600 (max=960) → clamp.
    localStorage.setItem(STORAGE_KEY, "2000");
    const shellB = makeShell();
    new HistoryResizer({ shell: shellB });
    expect(readWidth(shellB)).toBe(960);

    document.body.replaceChildren();

    // Garbage → fall back to DEFAULT.
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const shellC = makeShell();
    new HistoryResizer({ shell: shellC });
    expect(readWidth(shellC)).toBe(520);
  });

  it("drag right→left widens history; drag left→right narrows; release persists", () => {
    const shell = makeShell();
    const resizer = new HistoryResizer({ shell });
    const handle = resizer.element();
    document.body.appendChild(handle);

    // Initial 520, drag start at clientX=800.
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    // Drag LEFT by 100px → history grows to 620.
    handle.dispatchEvent(pointerEvent("pointermove", 700));
    expect(readWidth(shell)).toBe(620);
    // Drag RIGHT past start → narrows below 520.
    handle.dispatchEvent(pointerEvent("pointermove", 850));
    expect(readWidth(shell)).toBe(470);
    handle.dispatchEvent(pointerEvent("pointerup", 850));

    expect(localStorage.getItem(STORAGE_KEY)).toBe("470");
  });

  it("drag without prior pointerdown is ignored", () => {
    const shell = makeShell();
    const resizer = new HistoryResizer({ shell });
    const handle = resizer.element();
    document.body.appendChild(handle);

    handle.dispatchEvent(pointerEvent("pointermove", 400));
    expect(readWidth(shell)).toBe(520);
  });

  it("clamps drag within [MIN, viewport*0.6]", () => {
    const shell = makeShell();
    const resizer = new HistoryResizer({ shell });
    const handle = resizer.element();
    document.body.appendChild(handle);

    // Drag far LEFT → should cap at 960 (60% of 1600).
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    handle.dispatchEvent(pointerEvent("pointermove", 100));
    expect(readWidth(shell)).toBe(960);

    // Drag far RIGHT → should floor at 320.
    handle.dispatchEvent(pointerEvent("pointermove", 1500));
    expect(readWidth(shell)).toBe(320);
    handle.dispatchEvent(pointerEvent("pointerup", 1500));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("320");
  });

  it("toggles body class during drag for cursor + selection suppression", () => {
    const shell = makeShell();
    const resizer = new HistoryResizer({ shell });
    const handle = resizer.element();
    document.body.appendChild(handle);

    expect(document.body.classList.contains("is-resizing-history")).toBe(false);
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    expect(document.body.classList.contains("is-resizing-history")).toBe(true);
    handle.dispatchEvent(pointerEvent("pointerup", 800));
    expect(document.body.classList.contains("is-resizing-history")).toBe(false);
  });

  it("destroy() removes the handle from DOM", () => {
    const shell = makeShell();
    const resizer = new HistoryResizer({ shell });
    document.body.appendChild(resizer.element());
    expect(resizer.element().isConnected).toBe(true);
    resizer.destroy();
    expect(resizer.element().isConnected).toBe(false);
  });
});
