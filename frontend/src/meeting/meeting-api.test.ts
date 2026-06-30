/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { submitMeeting } from "./meeting-api";

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      calls.push(String(input));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ job_id: "j1", status_url: "/transcribe/meeting/j1" }),
      } as Response);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const file = () => new File([new Uint8Array([0, 1])], "m.wav", { type: "audio/wav" });

describe("submitMeeting quality serialization", () => {
  it("omits quality by default (backend default = fast)", async () => {
    const calls = stubFetch();
    await submitMeeting(file(), {});
    expect(calls[0]).not.toContain("quality=");
  });

  it("omits quality when explicitly fast (opt-in pattern)", async () => {
    const calls = stubFetch();
    await submitMeeting(file(), { quality: "fast" });
    expect(calls[0]).not.toContain("quality=");
  });

  it("sends quality=balanced when selected", async () => {
    const calls = stubFetch();
    await submitMeeting(file(), { quality: "balanced" });
    expect(calls[0]).toContain("quality=balanced");
  });
});
