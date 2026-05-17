/**
 * Actions chip bar populated from `GET /actions`.
 *
 * Each chip wraps the joined transcript text via the action's template
 * (substituting the literal `{transcript}` token) and POSTs the result to
 * `/ask`, then renders the response's `answer` field.
 *
 * Chips are grouped under category headings declared by the top-level
 * `categories` array. Chips whose `category` is unknown or `null` go into a
 * trailing "Misc" group. The fallback path (registry unreachable / empty)
 * renders one passthrough chip with no heading.
 */

import type { ActionRun } from "../storage/history-store";
import { getLocale, t } from "../i18n";

export interface ActionTemplate {
  id: string;
  label: string;
  labels?: Record<string, string>;
  template: string;
  category?: string | null;
  categoryLabels?: Record<string, string> | null;
  description?: string | null;
  descriptionLabels?: Record<string, string> | null;
}

export interface Category {
  id: string;
  label: string;
  labels?: Record<string, string>;
}

export interface ActionsResponse {
  actions: ActionTemplate[];
  categories: Category[];
}

function resolveLocalisedLabel(
  labels: Record<string, string> | null | undefined,
  legacyLabel: string | null | undefined,
  fallbackId: string,
): string {
  const active = getLocale();
  if (labels) {
    if (labels[active]) return labels[active];
    if (labels.en) return labels.en;
    const first = Object.values(labels).find((v) => v);
    if (first) return first;
  }
  if (legacyLabel) return legacyLabel;
  return fallbackId;
}

function resolveLabel(action: ActionTemplate): string {
  return resolveLocalisedLabel(action.labels, action.label, action.id);
}

function resolveCategoryLabel(category: Category): string {
  return resolveLocalisedLabel(category.labels, category.label, category.id);
}

function resolveDescription(action: ActionTemplate): string | null {
  if (!action.descriptionLabels && !action.description) return null;
  const active = getLocale();
  if (action.descriptionLabels) {
    if (action.descriptionLabels[active]) return action.descriptionLabels[active];
    if (action.descriptionLabels.en) return action.descriptionLabels.en;
    const first = Object.values(action.descriptionLabels).find((v) => v);
    if (first) return first;
  }
  return action.description ?? null;
}

export interface AnswerMeta {
  /** True iff the /ask call resolved normally. False when the request threw
   *  and `run.answer` is the localised "request failed" placeholder. */
  succeeded: boolean;
}

export interface ActionsBarOptions {
  root: HTMLElement;
  fetchActions: () => Promise<ActionsResponse>;
  postAsk: (prompt: string) => Promise<{ answer: string }>;
  onAnswer: (run: ActionRun, meta: AnswerMeta) => void;
  onWarn: (message: string) => void;
  getTranscript: () => string;
  /** Optional: fired when a chip click starts / finishes the /ask round trip.
   *  Use to drive global loading affordances (e.g. clear the answer pane). */
  onLoading?: (info: { running: boolean; actionId: string | null }) => void;
}

/** Persisted preference: whether the touch-device card layout shows the
 *  inline description subtitle. Default true (show). Lives in localStorage
 *  rather than the global Settings panel because the toggle UI sits inline
 *  with the section heading — closer to where the effect happens. */
const SHOW_DESCRIPTIONS_STORAGE_KEY = "whisper-wrap.actions.showDescriptions";

function loadShowDescriptions(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(SHOW_DESCRIPTIONS_STORAGE_KEY);
  return v === null ? true : v !== "false";
}

function saveShowDescriptions(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SHOW_DESCRIPTIONS_STORAGE_KEY, String(value));
}

function fallbackPassthrough(): ActionTemplate {
  return {
    id: "passthrough",
    label: t("actions.passthroughLabel"),
    template: "{transcript}",
  };
}

/** Touch-device fingerprint: matches when the primary pointer is coarse AND
 *  hover is unavailable. iPad with a Magic Keyboard attached reports
 *  `(hover: hover)`, so the two conditions together avoid mis-classifying
 *  hybrid devices. happy-dom defaults `matchMedia` to `matches: false`, which
 *  is intentionally treated as "desktop" so existing tests keep their hover
 *  semantics without needing to mock matchMedia. */
function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/** Shared singleton tooltip — one DOM node, positioned per hover.
 *  Lives at body level so its viewport-clamped positioning isn't constrained
 *  by any ancestor's overflow / transform / position-context. */
class TooltipController {
  private el: HTMLDivElement | null = null;
  private readonly margin = 8; // px from viewport edge

  private ensure(): HTMLDivElement {
    if (this.el && this.el.isConnected) return this.el;
    const el = document.createElement("div");
    el.className = "actions-tooltip";
    el.setAttribute("role", "tooltip");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  show(anchor: HTMLElement, text: string): void {
    if (!text || typeof window === "undefined") return;
    const tip = this.ensure();
    tip.textContent = text;
    // Make tooltip measurable before final positioning (visibility: hidden
    // would also work, but opacity keeps it part of the layout flow simpler).
    tip.style.left = "0px";
    tip.style.top = "-9999px";
    tip.classList.add("is-visible");
    tip.setAttribute("aria-hidden", "false");

    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer above the anchor, fall back to below if there's no room.
    const gap = 6;
    let top = anchorRect.top - tipRect.height - gap;
    if (top < this.margin) {
      top = anchorRect.bottom + gap;
    }
    top = Math.max(
      this.margin,
      Math.min(top, vh - tipRect.height - this.margin),
    );

    // Center horizontally on the anchor, clamped to viewport.
    let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
    left = Math.max(
      this.margin,
      Math.min(left, vw - tipRect.width - this.margin),
    );

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  hide(): void {
    if (!this.el) return;
    this.el.classList.remove("is-visible");
    this.el.setAttribute("aria-hidden", "true");
  }
}

const tooltipController = new TooltipController();

/** Current AI backend status surfaced next to the section heading. Null
 *  means "not yet resolved" (hide badge); a populated object means we know. */
export interface ModelStatus {
  configured: boolean;
  /** Model identifier when `configured: true` (e.g. "gemini-2.5-flash"). */
  model?: string;
}

export class ActionsBar {
  private actions: ActionTemplate[] = [];
  private categories: Category[] = [];
  private inFallback = false;
  private runningActionId: string | null = null;
  private showDescriptions = loadShowDescriptions();
  private modelStatus: ModelStatus | null = null;
  private modelBadgeEl: HTMLSpanElement | null = null;

  constructor(private readonly opts: ActionsBarOptions) {
    this.opts.root.classList.add("actions-bar");
    // Reflect persisted preference into the DOM so the touch-device CSS
    // revert rules apply on first paint (no flash of card mode).
    this.opts.root.classList.toggle("descriptions-off", !this.showDescriptions);
  }

  /** Update the AI backend badge shown next to the section heading. Pass
   *  `null` to hide it (e.g. while /status is still loading). Safe to call
   *  before or after `.load()` — the badge element is updated in place when
   *  it exists, and the latest status is read from `modelStatus` on next
   *  render(). */
  setModel(status: ModelStatus | null): void {
    this.modelStatus = status;
    this.applyModelBadge();
  }

  /** Resolve an action ID to its currently localised label using the loaded
   *  registry. Returns `null` if the action is unknown (registry not loaded
   *  yet, or the action was removed from the server-side registry after this
   *  session's action_run was persisted). Callers should fall back to the
   *  raw `action_id` in that case so historical entries remain identifiable. */
  getActionLabel(id: string): string | null {
    const action = this.actions.find((a) => a.id === id);
    return action ? resolveLabel(action) : null;
  }

  /** Update the model badge DOM in place. No-op if the badge element hasn't
   *  been built yet (load() hasn't run) — render() will read the latest
   *  modelStatus when it does build the badge. */
  private applyModelBadge(): void {
    if (!this.modelBadgeEl) return;
    const status = this.modelStatus;
    if (!status) {
      this.modelBadgeEl.hidden = true;
      this.modelBadgeEl.textContent = "";
      delete this.modelBadgeEl.dataset.state;
      return;
    }
    if (status.configured && status.model) {
      this.modelBadgeEl.textContent = status.model;
      this.modelBadgeEl.title = t("llmIndicator.title", { model: status.model });
      this.modelBadgeEl.dataset.state = "ok";
      this.modelBadgeEl.hidden = false;
    } else {
      this.modelBadgeEl.textContent = t("llmIndicator.notConfigured");
      this.modelBadgeEl.title = t("llmIndicator.notConfiguredTitle");
      this.modelBadgeEl.dataset.state = "down";
      this.modelBadgeEl.hidden = false;
    }
  }

  async load(): Promise<void> {
    try {
      const response = await this.opts.fetchActions();
      this.actions = Array.isArray(response?.actions) ? response.actions : [];
      this.categories = Array.isArray(response?.categories)
        ? response.categories
        : [];
      if (this.actions.length === 0) {
        this.fallback("actions registry is empty");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.fallback(`actions registry unreachable: ${msg}`);
    }
    this.render();
  }

  private fallback(message: string): void {
    this.actions = [fallbackPassthrough()];
    this.categories = [];
    this.inFallback = true;
    this.opts.onWarn(message);
  }

  private render(): void {
    this.opts.root.replaceChildren();

    if (this.inFallback) {
      for (const action of this.actions) {
        this.opts.root.appendChild(this.makeChip(action));
      }
      return;
    }

    // Section header: [heading + model badge] on the left, (touch-only)
    // "show descriptions" toggle on the right. The toggle is rendered on all
    // platforms but CSS hides it on hover devices — there it would be
    // meaningless because descriptions surface through hover tooltips, not
    // inline subtitles. The model badge replaces the old header-level
    // llm-indicator pill so the AI backend info lives next to where it
    // actually matters.
    const sectionHeader = document.createElement("div");
    sectionHeader.className = "actions-section-header";

    const sectionTitle = document.createElement("div");
    sectionTitle.className = "actions-section-title";

    const sectionHeading = document.createElement("h3");
    sectionHeading.className = "actions-section-heading";
    sectionHeading.textContent = t("actions.sectionHeading");
    sectionTitle.appendChild(sectionHeading);

    this.modelBadgeEl = document.createElement("span");
    this.modelBadgeEl.className = "actions-model-badge";
    sectionTitle.appendChild(this.modelBadgeEl);
    this.applyModelBadge();

    sectionHeader.appendChild(sectionTitle);

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "actions-description-toggle";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = this.showDescriptions;
    toggleInput.addEventListener("change", () => {
      this.showDescriptions = toggleInput.checked;
      saveShowDescriptions(this.showDescriptions);
      this.opts.root.classList.toggle(
        "descriptions-off",
        !this.showDescriptions,
      );
    });
    const toggleText = document.createElement("span");
    toggleText.textContent = t("actions.showDescriptionsLabel");
    toggleLabel.append(toggleInput, toggleText);
    sectionHeader.appendChild(toggleLabel);

    this.opts.root.appendChild(sectionHeader);

    const knownIds = new Set(this.categories.map((c) => c.id));
    const grouped = new Map<string, ActionTemplate[]>();
    for (const cat of this.categories) {
      grouped.set(cat.id, []);
    }
    const misc: ActionTemplate[] = [];

    for (const action of this.actions) {
      if (action.category && knownIds.has(action.category)) {
        grouped.get(action.category)!.push(action);
      } else {
        misc.push(action);
      }
    }

    for (const cat of this.categories) {
      const chips = grouped.get(cat.id)!;
      if (chips.length === 0) continue;
      this.appendGroup(resolveCategoryLabel(cat), chips);
    }

    if (misc.length > 0) {
      this.appendGroup(t("actions.miscCategoryLabel"), misc);
    }
  }

  private appendGroup(headingText: string, chips: ActionTemplate[]): void {
    const wrapper = document.createElement("div");
    wrapper.className = "actions-category-group";

    const heading = document.createElement("div");
    heading.className = "actions-category-heading";
    heading.textContent = headingText;
    wrapper.appendChild(heading);

    const chipContainer = document.createElement("div");
    chipContainer.className = "actions-category-chips";
    for (const action of chips) {
      chipContainer.appendChild(this.makeChip(action));
    }
    wrapper.appendChild(chipContainer);

    this.opts.root.appendChild(wrapper);
  }

  private makeChip(action: ActionTemplate): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "actions-chip";
    chip.dataset.actionId = action.id;

    const label = resolveLabel(action);
    const labelSpan = document.createElement("span");
    labelSpan.className = "actions-chip-label";
    labelSpan.textContent = label;
    chip.appendChild(labelSpan);

    const description = resolveDescription(action);
    if (description) {
      // Description is rendered inline so the touch-device card layout
      // (driven by CSS @media (hover: none) and (pointer: coarse)) can show
      // it as a subtitle without needing a separate render path. On hover
      // devices it's hidden via CSS and the description surfaces through the
      // JS-driven tooltipController instead.
      const descSpan = document.createElement("span");
      descSpan.className = "actions-chip-description";
      descSpan.textContent = description;
      chip.appendChild(descSpan);

      // `aria-label` overrides the visible text for screen readers — so we
      // include both label and description in one canonical string, regardless
      // of whether the description span is visually present.
      chip.setAttribute("aria-label", `${label}. ${description}`);

      // Hover/focus tooltip — only attached on hover-capable devices. On touch,
      // a tap would briefly fire mouseenter and flash the tooltip before
      // running the action, which is the "double tooltip" UX problem we're
      // avoiding. The description is already visible inline as a card subtitle
      // on those devices, so no tooltip is needed.
      // We previously also set `chip.title = description` as a long-press
      // fallback, but it caused the browser to render its own native tooltip
      // simultaneously with ours on desktop. `aria-label` covers a11y.
      if (!isTouchDevice()) {
        chip.addEventListener("mouseenter", () =>
          tooltipController.show(chip, description),
        );
        chip.addEventListener("mouseleave", () => tooltipController.hide());
        chip.addEventListener("focus", () =>
          tooltipController.show(chip, description),
        );
        chip.addEventListener("blur", () => tooltipController.hide());
      }
    }
    chip.addEventListener("click", () => {
      // Hide tooltip on click so it doesn't linger over the answer pane while
      // the request is in flight.
      tooltipController.hide();
      void this.run(action);
    });
    return chip;
  }

  private async run(action: ActionTemplate): Promise<void> {
    // Single-flight: if another chip is already running, ignore. Keeps the
    // answer pane and history attribution unambiguous.
    if (this.runningActionId !== null) return;

    this.runningActionId = action.id;
    this.setBusy(action.id, true);
    this.opts.onLoading?.({ running: true, actionId: action.id });

    const transcript = this.opts.getTranscript();
    const prompt = action.template.split("{transcript}").join(transcript);
    let answer = "";
    let succeeded = false;
    try {
      const response = await this.opts.postAsk(prompt);
      answer = response.answer ?? "";
      succeeded = true;
    } catch (e) {
      answer =
        e instanceof Error
          ? t("actions.requestFailedWithMessage", { error: e.message })
          : t("actions.requestFailed");
    } finally {
      this.setBusy(action.id, false);
      this.runningActionId = null;
      this.opts.onLoading?.({ running: false, actionId: action.id });
    }

    this.opts.onAnswer(
      {
        action_id: action.id,
        prompt,
        answer,
        ran_at: Date.now(),
      },
      { succeeded },
    );
  }

  private setBusy(activeId: string, busy: boolean): void {
    for (const chip of Array.from(
      this.opts.root.querySelectorAll<HTMLButtonElement>("button.actions-chip"),
    )) {
      if (busy) {
        chip.disabled = true;
        if (chip.dataset.actionId === activeId) {
          chip.dataset.loading = "true";
        }
      } else {
        chip.disabled = false;
        delete chip.dataset.loading;
      }
    }
  }
}
