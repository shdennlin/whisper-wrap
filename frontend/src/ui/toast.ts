/**
 * Transient bottom-of-screen notifications. Extracted from main.ts so any
 * component (history panel, history view, …) can surface feedback without a
 * callback threaded through its options.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function toast(message: string): void {
  const node = el("div", "toast");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

/** Toast with an inline action button. Used for SW update prompts where the
 * user MUST get an interaction surface — iOS standalone PWAs have no native
 * "refresh" otherwise. Click dismisses the toast and calls onAction. */
export function toastWithAction(
  message: string,
  actionLabel: string,
  onAction: () => void,
): void {
  const node = el("div", "toast toast-with-action");
  const text = el("span");
  text.textContent = message;
  const btn = el("button", "toast-action");
  btn.type = "button";
  btn.textContent = actionLabel;
  btn.addEventListener("click", () => {
    node.remove();
    onAction();
  });
  node.append(text, btn);
  document.body.appendChild(node);
  // Longer dwell time than plain toast — user needs reading + clicking time.
  setTimeout(() => node.remove(), 10000);
}
