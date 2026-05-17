/**
 * Dot + label that mirrors the HealthMonitor's current state in the header.
 *
 * Distinct from `ConnectionIndicator`, which tracks the `/listen` WebSocket
 * only and is surfaced inside the Live-recording UI.
 */

import type { HealthState } from "../health/health-monitor";

const LABELS: Record<HealthState, string> = {
  checking: "檢查中…",
  ok: "已連線",
  down: "後端離線",
};

export class BackendIndicator {
  private dot: HTMLSpanElement;
  private label: HTMLSpanElement;

  constructor(public readonly root: HTMLElement) {
    root.classList.add("backend-indicator");
    this.dot = document.createElement("span");
    this.dot.className = "dot";
    this.label = document.createElement("span");
    this.label.className = "label";
    root.append(this.dot, this.label);
    this.setState("checking");
  }

  setState(state: HealthState): void {
    this.root.dataset.state = state;
    this.label.textContent = LABELS[state];
  }
}
