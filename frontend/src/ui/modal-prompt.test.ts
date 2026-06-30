/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";

import { modalPrompt } from "./modal-prompt";

afterEach(() => {
  document.body.replaceChildren();
});

function dialog() {
  const el = document.querySelector<HTMLElement>(".modal-prompt");
  if (!el) throw new Error("modal not mounted");
  return el;
}

describe("modalPrompt", () => {
  it("seeds the input with the default value and resolves it on OK", async () => {
    const p = modalPrompt("New name?", "Speaker 1");
    const input = dialog().querySelector<HTMLInputElement>(".modal-prompt-input")!;
    expect(input.value).toBe("Speaker 1");

    input.value = "Alice";
    dialog().querySelector<HTMLButtonElement>(".modal-prompt-ok")!.click();

    expect(await p).toBe("Alice");
    expect(document.querySelector(".modal-prompt")).toBeNull(); // cleaned up
  });

  it("resolves null on Cancel", async () => {
    const p = modalPrompt("New name?");
    dialog().querySelector<HTMLButtonElement>(".modal-prompt-cancel")!.click();
    expect(await p).toBeNull();
  });

  it("resolves the input on Enter and null on Escape", async () => {
    const p1 = modalPrompt("q", "x");
    const input1 = dialog().querySelector<HTMLInputElement>(".modal-prompt-input")!;
    input1.value = "typed";
    input1.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(await p1).toBe("typed");

    const p2 = modalPrompt("q");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await p2).toBeNull();
  });
});
