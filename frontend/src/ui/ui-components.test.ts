/**
 * Snapshot-style tests for the transcript-view + connection-indicator
 * components (Decision 3 + Real-time captioning UI).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TranscriptView } from "./transcript-view";
import { ConnectionIndicator } from "./connection-indicator";

describe("TranscriptView", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("renders a partial-then-final sequence: partial appears grey then is replaced by final", () => {
    const view = new TranscriptView(host);
    view.setPartial("hello wor");
    expect(host.querySelector(".transcript-partial")?.textContent).toBe("hello wor");
    expect(host.querySelectorAll(".transcript-final").length).toBe(0);

    view.appendFinal({ text: "hello world.", start_ms: 0, end_ms: 1200 });
    expect(host.querySelector(".transcript-partial")?.textContent).toBe("");
    const finals = host.querySelectorAll(".transcript-final");
    expect(finals.length).toBe(1);
    expect(finals[0].querySelector(".transcript-text")?.textContent).toBe(
      "hello world.",
    );
    expect(finals[0].querySelector(".transcript-ts")?.textContent).toBe("00:00");
  });

  it("each new partial replaces the prior partial", () => {
    const view = new TranscriptView(host);
    view.setPartial("foo");
    view.setPartial("foo bar");
    view.setPartial("foo bar baz");
    expect(host.querySelector(".transcript-partial")?.textContent).toBe("foo bar baz");
  });

  it("appendFinal preserves order in the DOM", () => {
    const view = new TranscriptView(host);
    view.appendFinal({ text: "a", start_ms: 0, end_ms: 100 });
    view.appendFinal({ text: "b", start_ms: 100, end_ms: 200 });
    view.appendFinal({ text: "c", start_ms: 200, end_ms: 300 });
    const texts = Array.from(host.querySelectorAll(".transcript-text")).map(
      (el) => el.textContent,
    );
    expect(texts).toEqual(["a", "b", "c"]);
  });
});

describe("ConnectionIndicator", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("initialises in idle state with no retry button", () => {
    const ind = new ConnectionIndicator(host, () => {});
    expect(host.dataset.state).toBe("idle");
    expect(
      (host.querySelector("button.conn-retry") as HTMLButtonElement | null)?.hidden,
    ).toBe(true);
    void ind;
  });

  it("setState reflects in data-state attribute for CSS hooks", () => {
    const ind = new ConnectionIndicator(host, () => {});
    for (const state of ["open", "reconnecting", "failed", "idle"] as const) {
      ind.setState(state);
      expect(host.dataset.state).toBe(state);
    }
  });

  it("Retry button appears only on the failed state and triggers the callback", () => {
    let retried = 0;
    const ind = new ConnectionIndicator(host, () => {
      retried += 1;
    });
    const retryBtn = host.querySelector("button.conn-retry") as HTMLButtonElement;

    ind.setState("open");
    expect(retryBtn.hidden).toBe(true);
    ind.setState("reconnecting");
    expect(retryBtn.hidden).toBe(true);
    ind.setState("failed");
    expect(retryBtn.hidden).toBe(false);
    retryBtn.click();
    expect(retried).toBe(1);
  });

  it("renders a Chinese label appropriate to each state", () => {
    const ind = new ConnectionIndicator(host, () => {});
    ind.setState("open");
    expect(host.querySelector(".conn-label")?.textContent).toBe("已連線");
    ind.setState("reconnecting");
    expect(host.querySelector(".conn-label")?.textContent).toBe("重連中…");
    ind.setState("failed");
    expect(host.querySelector(".conn-label")?.textContent).toBe("連線失敗");
  });
});
