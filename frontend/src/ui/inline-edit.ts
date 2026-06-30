/**
 * Edit-in-place: swap a label element for a text input sitting in the same
 * spot, and resolve with the typed value (Enter / blur) or null (Escape).
 *
 * Used for speaker- and meeting-title rename. Preferred over a modal — the
 * user edits the label where it already is. Works identically in the browser
 * and the Tauri WKWebView shell (no native prompt, which no-ops there).
 */
export function inlineEdit(
  anchor: HTMLElement,
  value: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.value = value;

    // Park the input next to the hidden label so layout barely shifts.
    const prevDisplay = anchor.style.display;
    anchor.style.display = "none";
    anchor.after(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      anchor.style.display = prevDisplay;
      resolve(result);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });
    // Blur commits (matches the "click away to keep" expectation of inline
    // rename). Escape sets settled first, so the trailing blur is a no-op.
    input.addEventListener("blur", () => finish(input.value));
  });
}
