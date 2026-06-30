/**
 * In-DOM replacement for window.prompt().
 *
 * The Tauri WKWebView shell does not implement window.prompt / alert /
 * confirm — they silently no-op (return null), which broke speaker- and
 * meeting-title rename in the desktop app. This modal works identically in
 * browsers and the shell. Returns the entered string, or null if cancelled.
 */
import { t } from "../i18n";
export function modalPrompt(
  message: string,
  defaultValue = "",
  opts: { okLabel?: string; cancelLabel?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-prompt-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-prompt";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const label = document.createElement("label");
    label.className = "modal-prompt-message";
    label.textContent = message;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-prompt-input";
    input.value = defaultValue;

    const actions = document.createElement("div");
    actions.className = "modal-prompt-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-prompt-cancel";
    cancel.textContent = opts.cancelLabel ?? t("common.cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "modal-prompt-ok";
    ok.textContent = opts.okLabel ?? t("common.ok");

    label.appendChild(input);
    actions.append(cancel, ok);
    dialog.append(label, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    input.focus();
    input.select();

    let settled = false;
    const close = (value: string | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(input.value);
      }
    };

    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close(input.value));
    // Click on the backdrop (but not the dialog) cancels.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

/**
 * In-DOM replacement for window.confirm() — also a no-op in the WKWebView
 * shell, which silently cancelled every delete confirmation. Resolves true
 * on OK / Enter, false on Cancel / Escape / backdrop click.
 */
export function modalConfirm(
  message: string,
  opts: { okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-prompt-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-prompt";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const text = document.createElement("p");
    text.className = "modal-prompt-message";
    text.textContent = message;

    const actions = document.createElement("div");
    actions.className = "modal-prompt-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-prompt-cancel";
    cancel.textContent = opts.cancelLabel ?? t("common.cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "modal-prompt-ok";
    ok.textContent = opts.okLabel ?? t("common.ok");

    actions.append(cancel, ok);
    dialog.append(text, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    ok.focus();

    let settled = false;
    const close = (value: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    };

    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
  });
}
