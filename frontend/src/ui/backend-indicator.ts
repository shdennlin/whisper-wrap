/**
 * Dot + label that mirrors the HealthMonitor's current state in the header.
 *
 * Distinct from `ConnectionIndicator`, which tracks the `/listen` WebSocket
 * only and is surfaced inside the Live-recording UI.
 */

import type { HealthState } from "../health/health-monitor";
import { t } from "../i18n";

const LABEL_KEYS = {
  checking: "backend.checking",
  ok: "backend.ok",
  down: "backend.down",
} as const;

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
    this.label.textContent = t(LABEL_KEYS[state]);
  }
}
