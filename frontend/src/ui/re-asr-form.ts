/**
 * Inline re-transcription form.
 *
 * Rendered on-demand by `history-panel.ts` when a user clicks the
 * "Re-transcribe" button on a session card. The form lets the user tweak the
 * Whisper prompt + language for an existing recording's blob, POSTs the blob
 * to `/transcribe`, persists the result as an ActionRun (so it appears under
 * the same session's history), and tears itself down so the parent can
 * re-render the card with the new run visible.
 *
 * Contract: openspec/changes/audio-replay-and-re-asr/design.md
 *           (Implementation Contract — ReAsrForm).
 *
 * No real fetch lives in this file; the parent injects `transcribe` and
 * `appendActionRun` so the form is trivially testable against a stub blob.
 */

import { t, type StringKey } from "../i18n";

export interface ReAsrFormDefaults {
  /** Pre-filled value for the prompt input. */
  prompt: string;
  /** Pre-filled value for the language select (e.g. "en", "zh-TW", "" for auto). */
  language: string;
  /** Available language options for the select. */
  languages: Array<{ value: string; label: string }>;
}

export interface ReAsrFormDeps {
  /** POST the blob to /transcribe; returns the transcript text. */
  transcribe: (
    blob: Blob,
    opts: { prompt: string; language: string },
  ) => Promise<string>;
  /** Persist an ActionRun to history-store for the given session. */
  appendActionRun: (
    session_id: string,
    run: {
      action_id: "re_asr";
      prompt: string;
      answer: string;
      ran_at: number;
    },
  ) => void;
  /** Called after a successful submit so the parent can refresh its view. */
  onComplete?: () => void;
}

// The i18n keys land in task 3.3; cast through `as StringKey` so this file
// compiles today. `t()` falls back to the key string at runtime, which is
// fine for both tests and the temporary pre-3.3 UI.
const KEYS = {
  promptLabel: "audio.reTranscribePromptLabel" as StringKey,
  languageLabel: "audio.reTranscribeLanguageLabel" as StringKey,
  submit: "audio.reTranscribeSubmit" as StringKey,
  cancel: "audio.reTranscribeCancel" as StringKey,
  failed: "audio.reTranscribeFailed" as StringKey,
};

export class ReAsrForm {
  constructor(private readonly deps: ReAsrFormDeps) {}

  /**
   * Render the inline form into `root` for the given session.
   * Returns a teardown that removes the form and detaches all listeners.
   */
  mount(
    root: HTMLElement,
    session_id: string,
    blob: Blob,
    defaults: ReAsrFormDefaults,
  ): () => void {
    const form = document.createElement("form");
    form.className = "re-asr-form";
    form.dataset.state = "ready";
    // Prevent the implicit form submission from navigating away when a user
    // hits Enter inside the prompt input.
    const handleSubmit = (e: Event) => e.preventDefault();
    form.addEventListener("submit", handleSubmit);

    const promptLabel = document.createElement("label");
    promptLabel.className = "re-asr-prompt-label";
    promptLabel.textContent = t(KEYS.promptLabel);
    const promptInput = document.createElement("input");
    promptInput.type = "text";
    promptInput.className = "re-asr-prompt";
    promptInput.value = defaults.prompt;
    promptLabel.appendChild(promptInput);

    const languageLabel = document.createElement("label");
    languageLabel.className = "re-asr-language-label";
    languageLabel.textContent = t(KEYS.languageLabel);
    const select = document.createElement("select");
    select.className = "re-asr-language";
    for (const opt of defaults.languages) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }
    select.value = defaults.language;
    languageLabel.appendChild(select);

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "re-asr-submit";
    submitBtn.textContent = t(KEYS.submit);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "re-asr-cancel";
    cancelBtn.textContent = t(KEYS.cancel);

    const errorEl = document.createElement("div");
    errorEl.className = "re-asr-error";
    errorEl.hidden = true;

    form.append(promptLabel, languageLabel, submitBtn, cancelBtn, errorEl);
    root.appendChild(form);

    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      form.removeEventListener("submit", handleSubmit);
      // Only detach if still attached — a late-resolving fetch could fire the
      // teardown after the parent already cleared its container.
      if (form.parentNode) {
        form.parentNode.removeChild(form);
      }
    };

    const onCancel = () => {
      teardown();
    };

    const onSubmit = async () => {
      if (form.dataset.state === "submitting") return;
      const prompt = promptInput.value;
      const language = select.value;

      form.dataset.state = "submitting";
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      errorEl.hidden = true;
      errorEl.textContent = "";

      try {
        const answer = await this.deps.transcribe(blob, { prompt, language });
        if (torn) return;
        this.deps.appendActionRun(session_id, {
          action_id: "re_asr",
          prompt,
          answer,
          ran_at: Date.now(),
        });
        this.deps.onComplete?.();
        teardown();
      } catch (e) {
        if (torn) return;
        const message = e instanceof Error ? e.message : String(e);
        form.dataset.state = "error";
        errorEl.hidden = false;
        // The i18n template (audio.reTranscribeFailed) lands in task 3.3 and
        // expands {error}. Until then t() returns the bare key and drops
        // vars, so guarantee the message reaches the user by appending when
        // interpolation didn't fire.
        const rendered = t(KEYS.failed, { error: message });
        errorEl.textContent = rendered.includes(message)
          ? rendered
          : `${rendered}: ${message}`;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    };

    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);

    return teardown;
  }
}
