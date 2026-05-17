/**
 * One-click capture card: pressing the card both selects the mode and starts
 * recording. Renders disabled when the backend is unreachable so the user
 * isn't tricked into recording 10 minutes of audio that has nowhere to go.
 */

import type { CaptureMode } from "../capture/mode-store";

export interface ModeCardOptions {
  mode: CaptureMode;
  icon: string;
  label: string;
  description: string;
  onClick: () => void;
}

export class ModeCard {
  public readonly root: HTMLButtonElement;

  constructor(private readonly opts: ModeCardOptions) {
    this.root = document.createElement("button");
    this.root.type = "button";
    this.root.className = "mode-card";
    this.root.dataset.mode = opts.mode;
    this.root.setAttribute(
      "aria-label",
      `${opts.label} mode — ${opts.description}`,
    );

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = opts.icon;

    const info = document.createElement("span");
    info.className = "info";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = opts.label;

    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = opts.description;

    info.append(label, desc);
    this.root.append(icon, info);

    this.root.addEventListener("click", () => this.opts.onClick());
  }

  setDisabled(disabled: boolean, title?: string): void {
    this.root.disabled = disabled;
    if (title !== undefined) {
      this.root.title = title;
    } else if (!disabled) {
      this.root.removeAttribute("title");
    }
  }
}
