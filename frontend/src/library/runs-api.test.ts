import { afterEach, describe, expect, it, vi } from "vitest";

import { listItemRuns, pollRun, runStage } from "./runs-api";

afterEach(() => vi.restoreAllMocks());

function jsonResp(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

describe("runs-api", () => {
  it("listItemRuns returns the runs array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResp({ runs: [{ id: "r1", kind: "transcribe" }] })),
    );
    const runs = await listItemRuns("item-1");
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("r1");
  });

  it("listItemRuns preserves the origin provenance field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResp({
          runs: [{ id: "capture:s1", kind: "transcribe", origin: "capture" }],
        }),
      ),
    );
    const runs = await listItemRuns("s1");
    expect(runs[0].origin).toBe("capture");
  });

  it("runStage POSTs the right url and returns the run id", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ run_id: "run-x" }));
    vi.stubGlobal("fetch", fetchMock);
    const id = await runStage("item-1", "diarize", { quality: "fast" });
    expect(id).toBe("run-x");
    expect(fetchMock).toHaveBeenCalledWith(
      "/items/item-1/diarize?quality=fast",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("runStage for ai posts a JSON prompt body", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ run_id: "ai-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await runStage("item-1", "ai", { prompt: "摘要" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/items/item-1/ai");
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "摘要" });
  });

  it("pollRun resolves when the run reaches a terminal status", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResp({ id: "r", status: calls++ < 1 ? "running" : "done" })),
    );
    const run = await pollRun("r", undefined, { intervalMs: 1, tries: 5 });
    expect(run.status).toBe("done");
  });
});
