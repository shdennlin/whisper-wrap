/**
 * Tests for ReAsrForm — the inline form rendered on-demand when a user clicks
 * the "Re-transcribe" button on a session card (history-panel wires the
 * button; this component owns the form itself).
 *
 * Contract: see openspec/changes/audio-replay-and-re-asr/design.md
 * (Implementation Contract).
 *
 * Assertions target CSS classes, data-attributes, and behaviour rather than
 * the rendered English copy — the i18n keys (audio.reTranscribe*) land in a
 * later task; until then t(key) returns the key string and that's fine.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReAsrForm } from "./re-asr-form";

interface MountOpts {
  prompt?: string;
  language?: string;
  languages?: Array<{ value: string; label: string }>;
  transcribe?: ReturnType<typeof vi.fn>;
  appendActionRun?: ReturnType<typeof vi.fn>;
  onComplete?: ReturnType<typeof vi.fn>;
  blob?: Blob;
  sessionId?: string;
}

interface MountResult {
  form: ReAsrForm;
  root: HTMLElement;
  stop: () => void;
  blob: Blob;
  sessionId: string;
  transcribe: ReturnType<typeof vi.fn>;
  appendActionRun: ReturnType<typeof vi.fn>;
  onComplete: ReturnType<typeof vi.fn>;
}

function mountForm(opts: MountOpts = {}): MountResult {
  const root = document.createElement("div");
  document.body.appendChild(root);

  const blob = opts.blob ?? new Blob(["fake-audio"], { type: "audio/webm" });
  const sessionId = opts.sessionId ?? "sess-1";
  const transcribe = opts.transcribe ?? vi.fn(async () => "transcribed text");
  const appendActionRun = opts.appendActionRun ?? vi.fn();
  const onComplete = opts.onComplete ?? vi.fn();

  const form = new ReAsrForm({ transcribe, appendActionRun, onComplete });
  const stop = form.mount(root, sessionId, blob, {
    prompt: opts.prompt ?? "initial prompt",
    language: opts.language ?? "en",
    languages: opts.languages ?? [
      { value: "", label: "Auto" },
      { value: "en", label: "English" },
      { value: "zh-TW", label: "Traditional Chinese" },
    ],
  });

  return { form, root, stop, blob, sessionId, transcribe, appendActionRun, onComplete };
}

describe("ReAsrForm", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders prompt input, language select, submit/cancel buttons, and a hidden error element", () => {
    const { root } = mountForm({
      prompt: "say something useful",
      language: "zh-TW",
      languages: [
        { value: "", label: "Auto" },
        { value: "en", label: "English" },
        { value: "zh-TW", label: "Traditional Chinese" },
      ],
    });

    const formEl = root.querySelector(".re-asr-form") as HTMLElement;
    expect(formEl).not.toBeNull();
    expect(formEl.dataset.state).toBe("ready");

    const promptInput = formEl.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    expect(promptInput).not.toBeNull();
    expect(promptInput.value).toBe("say something useful");

    const select = formEl.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("zh-TW");
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["", "en", "zh-TW"]);

    const submitBtn = formEl.querySelector(".re-asr-submit") as HTMLButtonElement;
    const cancelBtn = formEl.querySelector(".re-asr-cancel") as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    expect(cancelBtn).not.toBeNull();
    expect(submitBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);

    const errorEl = formEl.querySelector(".re-asr-error") as HTMLElement;
    expect(errorEl).not.toBeNull();
    expect(errorEl.hidden).toBe(true);
  });

  it("cancel removes the form from the DOM", () => {
    const { root } = mountForm();
    const cancelBtn = root.querySelector(".re-asr-cancel") as HTMLButtonElement;
    cancelBtn.click();
    expect(root.children.length).toBe(0);
  });

  it("submit calls transcribe with the modified prompt and language values", async () => {
    const transcribe = vi.fn(async () => "ok");
    const { root, blob } = mountForm({ transcribe });

    const promptInput = root.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    promptInput.value = "edited prompt";
    promptInput.dispatchEvent(new Event("input"));

    const select = root.querySelector("select") as HTMLSelectElement;
    select.value = "zh-TW";
    select.dispatchEvent(new Event("change"));

    const submitBtn = root.querySelector(".re-asr-submit") as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(blob, {
      prompt: "edited prompt",
      language: "zh-TW",
    });
  });

  it("on successful submit, appends an ActionRun with action_id='re_asr' and calls onComplete", async () => {
    const transcribe = vi.fn(async () => "hello world");
    const appendActionRun = vi.fn();
    const onComplete = vi.fn();
    const { root, sessionId } = mountForm({
      transcribe,
      appendActionRun,
      onComplete,
      prompt: "summarise this",
    });

    const submitBtn = root.querySelector(".re-asr-submit") as HTMLButtonElement;
    const before = Date.now();
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    const after = Date.now();

    expect(appendActionRun).toHaveBeenCalledTimes(1);
    const [calledSession, calledRun] = appendActionRun.mock.calls[0];
    expect(calledSession).toBe(sessionId);
    expect(calledRun.action_id).toBe("re_asr");
    expect(calledRun.prompt).toBe("summarise this");
    expect(calledRun.answer).toBe("hello world");
    expect(typeof calledRun.ran_at).toBe("number");
    expect(calledRun.ran_at).toBeGreaterThanOrEqual(before);
    expect(calledRun.ran_at).toBeLessThanOrEqual(after);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("on failed submit, shows inline error, skips ActionRun, re-enables buttons", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("server boom");
    });
    const appendActionRun = vi.fn();
    const onComplete = vi.fn();
    const { root } = mountForm({ transcribe, appendActionRun, onComplete });

    const submitBtn = root.querySelector(".re-asr-submit") as HTMLButtonElement;
    const cancelBtn = root.querySelector(".re-asr-cancel") as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(appendActionRun).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    const formEl = root.querySelector(".re-asr-form") as HTMLElement;
    expect(formEl).not.toBeNull();
    expect(formEl.dataset.state).toBe("error");

    const errorEl = formEl.querySelector(".re-asr-error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent ?? "").toContain("server boom");

    expect(submitBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
  });

  it("disables both buttons during submission and reflects data-state='submitting'", () => {
    let resolveFn: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const transcribe = vi.fn(() => pending);
    const { root } = mountForm({ transcribe });

    const submitBtn = root.querySelector(".re-asr-submit") as HTMLButtonElement;
    const cancelBtn = root.querySelector(".re-asr-cancel") as HTMLButtonElement;
    submitBtn.click();

    const formEl = root.querySelector(".re-asr-form") as HTMLElement;
    expect(formEl.dataset.state).toBe("submitting");
    expect(submitBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);

    // Resolve so we don't leak the pending promise into other tests.
    resolveFn("done");
  });

  it("the teardown function returned by mount removes the form", () => {
    const { root, stop } = mountForm();
    expect(root.children.length).toBe(1);
    stop();
    expect(root.children.length).toBe(0);
  });
});
