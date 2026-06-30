/**
 * Snapshot-style tests for the connection-indicator component. The transcript
 * rendering moved into the recording layer (retire-v2-recording-shell) and is
 * covered by recording-view.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionIndicator } from "./connection-indicator";

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

  it("renders an English label appropriate to each state (default locale)", () => {
    const ind = new ConnectionIndicator(host, () => {});
    ind.setState("open");
    expect(host.querySelector(".conn-label")?.textContent).toBe("Connected");
    ind.setState("reconnecting");
    expect(host.querySelector(".conn-label")?.textContent).toBe("Reconnecting…");
    ind.setState("failed");
    expect(host.querySelector(".conn-label")?.textContent).toBe("Connection failed");
  });
});
