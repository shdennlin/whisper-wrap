/**
 * Actions chip bar populated from `GET /actions`.
 *
 * Each chip wraps the joined transcript text via the action's template
 * (substituting the literal `{transcript}` token) and POSTs the result to
 * `/ask`, then renders the response's `answer` field.
 *
 * Fallback: if `/actions` is unreachable or malformed, the bar renders a
 * single built-in `passthrough` chip whose template is `{transcript}` (so the
 * user can still send the raw transcript to /ask) and shows a warning toast.
 */

import type { ActionRun } from "../storage/history-store";

export interface ActionTemplate {
  id: string;
  label: string;
  template: string;
}

export interface ActionsBarOptions {
  root: HTMLElement;
  fetchActions: () => Promise<ActionTemplate[]>;
  postAsk: (prompt: string) => Promise<{ answer: string }>;
  onAnswer: (run: ActionRun) => void;
  onWarn: (message: string) => void;
  getTranscript: () => string;
}

const FALLBACK_PASSTHROUGH: ActionTemplate = {
  id: "passthrough",
  label: "直接送",
  template: "{transcript}",
};

export class ActionsBar {
  private actions: ActionTemplate[] = [];

  constructor(private readonly opts: ActionsBarOptions) {
    this.opts.root.classList.add("actions-bar");
  }

  async load(): Promise<void> {
    try {
      this.actions = await this.opts.fetchActions();
      if (!Array.isArray(this.actions) || this.actions.length === 0) {
        this.fallback("actions registry is empty");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.fallback(`actions registry unreachable: ${msg}`);
    }
    this.render();
  }

  private fallback(message: string): void {
    this.actions = [FALLBACK_PASSTHROUGH];
    this.opts.onWarn(message);
  }

  private render(): void {
    this.opts.root.replaceChildren();
    for (const action of this.actions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "actions-chip";
      chip.dataset.actionId = action.id;
      chip.textContent = action.label;
      chip.addEventListener("click", () => this.run(action));
      this.opts.root.appendChild(chip);
    }
  }

  private async run(action: ActionTemplate): Promise<void> {
    const transcript = this.opts.getTranscript();
    const prompt = action.template.split("{transcript}").join(transcript);
    let answer = "";
    try {
      const response = await this.opts.postAsk(prompt);
      answer = response.answer ?? "";
    } catch (e) {
      answer = e instanceof Error ? `（請求失敗：${e.message}）` : "（請求失敗）";
    }
    this.opts.onAnswer({
      action_id: action.id,
      prompt,
      answer,
      ran_at: Date.now(),
    });
  }
}
