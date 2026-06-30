/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";

import { inlineEdit } from "./inline-edit";

afterEach(() => {
  document.body.replaceChildren();
});

function mountLabel(text = "Speaker 1"): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  document.body.appendChild(span);
  return span;
}

function input(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(".inline-edit-input");
  if (!el) throw new Error("inline input not mounted");
  return el;
}

describe("inlineEdit", () => {
  it("swaps the label for a focused input seeded with the value", () => {
    const label = mountLabel("Speaker 1");
    void inlineEdit(label, "Speaker 1");
    expect(label.style.display).toBe("none");
    expect(input().value).toBe("Speaker 1");
  });

  it("resolves the typed value on Enter and restores the label", async () => {
    const label = mountLabel();
    const p = inlineEdit(label, "Speaker 1");
    const el = input();
    el.value = "Alice";
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(await p).toBe("Alice");
    expect(document.querySelector(".inline-edit-input")).toBeNull();
    expect(label.style.display).not.toBe("none");
  });

  it("resolves null on Escape (the trailing blur is ignored)", async () => {
    const label = mountLabel();
    const p = inlineEdit(label, "Speaker 1");
    const el = input();
    el.value = "discard me";
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur"));

    expect(await p).toBeNull();
  });

  it("commits on blur (click-away keeps the edit)", async () => {
    const label = mountLabel();
    const p = inlineEdit(label, "Speaker 1");
    const el = input();
    el.value = "Bob";
    el.dispatchEvent(new FocusEvent("blur"));

    expect(await p).toBe("Bob");
  });
});
