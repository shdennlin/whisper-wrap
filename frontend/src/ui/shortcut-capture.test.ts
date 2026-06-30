import { describe, expect, it } from "vitest";
import { accelFromEvent, formatAccelerator } from "./shortcut-capture";

function key(
  code: string,
  mods: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  > = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, ...mods });
}

describe("accelFromEvent", () => {
  it("builds an Alt+Space accelerator", () => {
    expect(accelFromEvent(key("Space", { altKey: true }))).toBe("Alt+Space");
  });

  it("emits modifiers in Control→Alt→Shift→Super order, then the code", () => {
    const e = key("KeyK", { ctrlKey: true, shiftKey: true });
    expect(accelFromEvent(e)).toBe("Control+Shift+KeyK");
  });

  it("maps the Meta key to Super (Tauri's command token)", () => {
    expect(accelFromEvent(key("KeyL", { metaKey: true }))).toBe("Super+KeyL");
  });

  it("returns null for a modifier-only press (no main key yet)", () => {
    expect(accelFromEvent(key("AltLeft", { altKey: true }))).toBeNull();
    expect(accelFromEvent(key("ControlRight", { ctrlKey: true }))).toBeNull();
  });

  it("rejects a bare key with no modifier (would hijack it globally)", () => {
    expect(accelFromEvent(key("KeyA"))).toBeNull();
    expect(accelFromEvent(key("Space"))).toBeNull();
  });
});

describe("formatAccelerator", () => {
  it("renders ⌥Space for Alt+Space", () => {
    expect(formatAccelerator("Alt+Space")).toBe("⌥Space");
  });

  it("strips the Key/Digit prefixes and orders the symbols", () => {
    expect(formatAccelerator("Control+Shift+KeyK")).toBe("⌃⇧K");
    expect(formatAccelerator("Super+Digit1")).toBe("⌘1");
  });

  it("normalizes modifier order regardless of input order", () => {
    expect(formatAccelerator("Shift+Control+KeyA")).toBe("⌃⇧A");
  });

  it("renders arrow and named keys as glyphs", () => {
    expect(formatAccelerator("Alt+ArrowUp")).toBe("⌥↑");
    expect(formatAccelerator("Control+Escape")).toBe("⌃Esc");
  });
});
