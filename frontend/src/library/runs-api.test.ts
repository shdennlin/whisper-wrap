import { afterEach, describe, expect, it, vi } from "vitest";

import { resetClientFetch, setClientFetch } from "../api/client";
import { listItemRuns, pollRun, runStage } from "./runs-api";

afterEach(() => {
  resetClientFetch();
  vi.restoreAllMocks();
});

/** A JSON Response for the client's injectable `fetch` seam. */
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The single `Request` the client emitted (the seam replaces the old
 * per-call `fetchImpl` — assert on the emitted Request's method/URL/body). */
function emittedRequest(mock: ReturnType<typeof vi.fn>): Request {
  return mock.mock.calls[0][0] as Request;
}

describe("runs-api", () => {
  it("listItemRuns GETs the item's runs and returns the array", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({ runs: [{ id: "r1", kind: "transcribe" }] }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    const runs = await listItemRuns("item-1");

    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("r1");
    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/items/item-1/runs");
  });

  it("listItemRuns preserves the origin provenance field", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp({
        runs: [{ id: "capture:s1", kind: "transcribe", origin: "capture" }],
      }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    const runs = await listItemRuns("s1");

    expect(runs[0].origin).toBe("capture");
  });

  it("listItemRuns throws on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ detail: "boom" }, 500));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await expect(listItemRuns("item-1")).rejects.toThrow(/500/);
  });

  it("runStage POSTs the right url and returns the run id", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ run_id: "run-x" }, 202));
    setClientFetch(fetchMock as unknown as typeof fetch);

    const id = await runStage("item-1", "diarize", { quality: "fast" });

    expect(id).toBe("run-x");
    const req = emittedRequest(fetchMock);
    expect(req.method).toBe("POST");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/items/item-1/diarize");
    expect(url.search).toBe("?quality=fast");
  });

  it("runStage for transcribe passes the model query", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ run_id: "t-1" }, 202));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await runStage("item-1", "transcribe", { model: "small" });

    const url = new URL(emittedRequest(fetchMock).url);
    expect(url.pathname).toBe("/items/item-1/transcribe");
    expect(url.search).toBe("?model=small");
  });

  it("runStage for ai posts a JSON prompt body", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ run_id: "ai-1" }, 202));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await runStage("item-1", "ai", { prompt: "摘要" });

    const req = emittedRequest(fetchMock);
    expect(new URL(req.url).pathname).toBe("/items/item-1/ai");
    expect(await req.json()).toEqual({ prompt: "摘要" });
  });

  it("runStage throws on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ detail: "nope" }, 404));
    setClientFetch(fetchMock as unknown as typeof fetch);

    await expect(runStage("item-1", "transcribe")).rejects.toThrow(/404/);
  });

  it("pollRun resolves when the run reaches a terminal status", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () =>
      jsonResp({ id: "r", status: calls++ < 1 ? "running" : "done" }),
    );
    setClientFetch(fetchMock as unknown as typeof fetch);

    const run = await pollRun("r", undefined, { intervalMs: 1, tries: 5 });

    expect(run.status).toBe("done");
  });
});
