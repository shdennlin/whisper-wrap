/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetClientFetch, setClientFetch } from "../api/client";
import { submitMeeting } from "./meeting-api";

// The migrated meeting-api routes through the shared openapi-fetch client; we
// stub the client's ONE `fetch` seam and assert on the emitted Request (method,
// URL, query) rather than a bare global `fetch`.
let requests: Request[];

beforeEach(() => {
  requests = [];
  setClientFetch(async (input) => {
    requests.push(input as Request);
    return new Response(
      JSON.stringify({ job_id: "j1", status_url: "/transcribe/meeting/j1" }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  });
});
afterEach(() => resetClientFetch());

const file = () =>
  new File([new Uint8Array([0, 1])], "m.wav", { type: "audio/wav" });

describe("submitMeeting quality serialization", () => {
  it("omits quality by default (backend default = fast)", async () => {
    await submitMeeting(file(), {});
    expect(new URL(requests[0].url).search).not.toContain("quality=");
  });

  it("omits quality when explicitly fast (opt-in pattern)", async () => {
    await submitMeeting(file(), { quality: "fast" });
    expect(new URL(requests[0].url).search).not.toContain("quality=");
  });

  it("sends quality=balanced when selected", async () => {
    await submitMeeting(file(), { quality: "balanced" });
    expect(new URL(requests[0].url).searchParams.get("quality")).toBe(
      "balanced",
    );
  });

  it("POSTs to /transcribe/meeting and returns the job handle", async () => {
    const handle = await submitMeeting(file(), {});
    expect(requests[0].method).toBe("POST");
    expect(new URL(requests[0].url).pathname).toBe("/transcribe/meeting");
    expect(handle.job_id).toBe("j1");
    expect(handle.status_url).toBe("/transcribe/meeting/j1");
  });
});
