/**
 * Connection-state pill with optional manual-retry button on the `failed` state.
 *
 * States:
 *   idle         — neutral grey (user has not pressed Record)
 *   open         — green
 *   reconnecting — yellow
 *   failed       — red, Retry button visible
 */

import type { ConnectionState } from "../capture/listen-socket";
import { t } from "../i18n";

const LABEL_KEYS = {
  idle: "connection.idle",
  open: "connection.open",
  reconnecting: "connection.reconnecting",
  failed: "connection.failed",
} as const;

export class ConnectionIndicator {
  private dot: HTMLSpanElement;
  private label: HTMLSpanElement;
  private retry: HTMLButtonElement;

  constructor(
    public readonly root: HTMLElement,
    private readonly onRetry: () => void,
  ) {
    this.root.classList.add("conn-indicator");
    this.dot = document.createElement("span");
    this.dot.className = "conn-dot";
    this.label = document.createElement("span");
    this.label.className = "conn-label";
    this.retry = document.createElement("button");
    this.retry.type = "button";
    this.retry.className = "conn-retry";
    this.retry.textContent = t("connection.retry");
    this.retry.hidden = true;
    this.retry.addEventListener("click", () => this.onRetry());
    this.root.append(this.dot, this.label, this.retry);
    this.setState("idle");
  }

  setState(state: ConnectionState): void {
    this.root.dataset.state = state;
    this.label.textContent = t(LABEL_KEYS[state]);
    this.retry.hidden = state !== "failed";
  }
}
