/**
 * Global-shortcut capture + display (desktop-global-hotkey rebind).
 *
 * The Settings rebind control records a key combination from a `keydown` and
 * turns it into a Tauri accelerator string (e.g. "Alt+Space",
 * "Control+Shift+KeyK") that the Rust `set_global_hotkey` command parses. The
 * key token is just `KeyboardEvent.code`, which already matches the accelerator
 * parser's key names ("Space", "KeyA", "Digit1", "ArrowUp", "Escape", …).
 */

/** Modifier `KeyboardEvent.code`s — pressing only these isn't a full combo. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Build a Tauri accelerator string from a keydown, or null when the press is
 * not a usable global shortcut (modifier-only, or a bare key with no modifier —
 * binding a plain key globally would hijack it everywhere).
 */
export function accelFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (mods.length === 0) return null;
  if (!e.code) return null;
  return [...mods, e.code].join("+");
}

const MOD_SYMBOLS: Record<string, string> = {
  Control: "⌃",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Super: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  Meta: "⌘",
};

// Symbols render in the canonical macOS order regardless of input order.
const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
};

/** Display a stored accelerator as macOS-style symbols, e.g. "Alt+Space" → "⌥Space". */
export function formatAccelerator(accel: string): string {
  const tokens = accel.split("+").map((t) => t.trim());
  const mods: string[] = [];
  let key = "";
  for (const tok of tokens) {
    const sym = MOD_SYMBOLS[tok];
    if (sym) {
      if (!mods.includes(sym)) mods.push(sym);
    } else {
      key = labelKey(tok);
    }
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return mods.join("") + key;
}

function labelKey(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3); // KeyA → A
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 → 1
  if (code.startsWith("Numpad")) return code.slice(6); // Numpad1 → 1
  return code;
}
