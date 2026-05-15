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

const LABELS: Record<ConnectionState, string> = {
  idle: "未連線",
  open: "已連線",
  reconnecting: "重連中…",
  failed: "連線失敗",
};

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
    this.retry.textContent = "重試";
    this.retry.hidden = true;
    this.retry.addEventListener("click", () => this.onRetry());
    this.root.append(this.dot, this.label, this.retry);
    this.setState("idle");
  }

  setState(state: ConnectionState): void {
    this.root.dataset.state = state;
    this.label.textContent = LABELS[state];
    this.retry.hidden = state !== "failed";
  }
}
