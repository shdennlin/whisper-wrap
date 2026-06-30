/**
 * AI action picker modal for the item detail view.
 *
 * Reproduces the old "AI Enhance" panel — the categorised action chips from
 * `GET /actions` plus an inline AI response pane — but routes each pick through
 * the item's `ai` run stage, so every answer is recorded in the runs ledger
 * and shows up in 處理紀錄.
 *
 * The trick that lets us reuse ActionsBar verbatim: the `ai` stage appends the
 * transcript itself (`{prompt}\n\nTranscript:\n{transcript}`), so the chip's
 * template must reach it WITHOUT the transcript. Mounting ActionsBar with
 * `getTranscript: () => ""` makes its `{transcript}` substitution collapse to
 * the bare instruction — which is exactly what `runAi` should send.
 */

import { ActionsBar, type ActionsResponse, type ModelStatus } from "./actions-bar";
import { copyToClipboard } from "../platform/clipboard";
import { toast } from "./toast";
import { t } from "../i18n";

export interface AiActionModalOpts {
  loadActions: () => Promise<ActionsResponse>;
  /** Run the picked instruction through the ai stage; resolves to the answer.
   *  Throws on failure so ActionsBar surfaces its localised error. */
  runAi: (instruction: string) => Promise<string>;
  /** AI backend badge (provider/model) shown by ActionsBar; null hides it. */
  model?: ModelStatus | null;
}

export function openAiActionModal(opts: AiActionModalOpts): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-prompt-overlay ai-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "ai-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ai-modal-close";
  close.setAttribute("aria-label", t("aiModal.close"));
  close.textContent = "✕";

  // ActionsBar renders its own heading + model badge + categorised chips here.
  const barRoot = document.createElement("div");

  const answer = document.createElement("div");
  answer.className = "ai-modal-answer";
  answer.hidden = true;
  const answerHead = document.createElement("div");
  answerHead.className = "ai-modal-answer-head";
  const answerTitle = document.createElement("span");
  answerTitle.className = "ai-modal-answer-title";
  answerTitle.textContent = t("aiModal.title");
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "ai-modal-copy";
  copyBtn.textContent = t("aiModal.copy");
  copyBtn.disabled = true;
  answerHead.append(answerTitle, copyBtn);
  const answerBody = document.createElement("div");
  answerBody.className = "ai-modal-answer-body";
  answer.append(answerHead, answerBody);

  dialog.append(close, barRoot, answer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let answerText = "";
  copyBtn.addEventListener("click", () => {
    if (!answerText) return;
    void copyToClipboard(answerText).then((ok) => {
      if (ok) toast(t("aiModal.copied"));
    });
  });

  const bar = new ActionsBar({
    root: barRoot,
    fetchActions: opts.loadActions,
    getTranscript: () => "", // the ai stage appends the transcript itself
    postAsk: async (instruction) => ({ answer: await opts.runAi(instruction) }),
    onAnswer: (run) => {
      answerText = run.answer;
      answerBody.textContent = run.answer;
      copyBtn.disabled = !run.answer;
    },
    onLoading: ({ running }) => {
      answer.hidden = false;
      if (running) {
        answerText = "";
        answerBody.textContent = t("aiModal.processing");
        copyBtn.disabled = true;
      }
    },
    onWarn: (msg) => toast(`⚠ ${msg}`),
  });
  bar.setModel(opts.model ?? null);
  void bar.load();

  let settled = false;
  const dismiss = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
}
