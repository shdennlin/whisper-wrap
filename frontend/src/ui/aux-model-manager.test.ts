import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuxModelManager } from "./aux-model-manager";
import { resetClientFetch, setClientFetch } from "../api/client";

// label/description now come from i18n (keyed by id), not the API. The list
// only carries id + status fields; the rows derive their text from the i18n
// English defaults (tests run with the default `en` locale).
const LIST = {
  models: [
    { id: "diarize-segmentation", stage: "diarize", size_bytes: 6_000_000, required: true, recommended: false, installed: false },
    { id: "diarize-embedding-fast", stage: "diarize", size_bytes: 28_000_000, required: false, recommended: true, installed: true },
    { id: "vad-silero", stage: "vad", size_bytes: 644_000, required: false, recommended: false, installed: false },
  ],
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

describe("AuxModelManager", () => {
  let root: HTMLElement;
  // The migrated manager talks to the shared `openapi-fetch` client's ONE
  // injectable `fetch`. Tests keep expressing intent as `fetchMock(url, init)`
  // returning a lightweight `{ ok, status, json }` shape; the seam adapter
  // below translates the emitted `Request` into that call and re-wraps the
  // result as a real `Response` the client can parse.
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    fetchMock = vi.fn(async () => jsonResponse(LIST));
    setClientFetch((async (input: Request) => {
      const pseudo = (await fetchMock(input.url, { method: input.method })) as Response;
      const body = await pseudo.json();
      return new Response(JSON.stringify(body ?? {}), {
        status: pseudo.status ?? (pseudo.ok ? 200 : 500),
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    root.remove();
    for (const el of document.querySelectorAll(".modal-prompt-overlay")) el.remove();
    resetClientFetch();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("groups models by stage and shows install status", async () => {
    new AuxModelManager(root);
    await flush();
    const groups = root.querySelectorAll(".aux-stage-group");
    expect(groups).toHaveLength(2); // diarize + vad
    const titles = [...root.querySelectorAll(".aux-stage-title")].map((t) => t.textContent);
    expect(titles).toContain("Speaker separation");
    expect(titles).toContain("Live (VAD)");
    // Installed model shows a chip; a missing one shows a Download button.
    const installed = root.querySelector('.model-row[data-id="diarize-embedding-fast"]')!;
    expect(installed.querySelector(".model-chip-active")!.textContent).toBe("Installed");
    const missing = root.querySelector('.model-row[data-id="diarize-segmentation"]')!;
    expect(missing.querySelector(".model-btn")!.textContent).toBe("Download");
    // Required badge on the required model.
    expect(missing.querySelector(".model-chip-required")).toBeTruthy();
  });

  it("shows descriptions, a Recommended badge for the fast tier, and the pick-one note", async () => {
    new AuxModelManager(root);
    await flush();
    const fast = root.querySelector('.model-row[data-id="diarize-embedding-fast"]')!;
    expect(fast.querySelector(".model-chip-recommended")!.textContent).toBe("Recommended");
    expect(fast.querySelector(".model-row-desc")!.textContent).toContain("voiceprint");
    // Segmentation is the genuinely-required one (no Recommended).
    const seg = root.querySelector('.model-row[data-id="diarize-segmentation"]')!;
    expect(seg.querySelector(".model-chip-required")!.textContent).toBe("Required");
    expect(seg.querySelector(".model-chip-recommended")).toBeNull();
    // The diarize group explains the embeddings are a choice; VAD has no note.
    const groupFor = (titleText: string) =>
      [...root.querySelectorAll<HTMLElement>(".aux-stage-group")].find(
        (g) => g.querySelector(".aux-stage-title")?.textContent === titleText,
      )!;
    expect(groupFor("Speaker separation").querySelector(".aux-stage-note")!.textContent).toContain("pick");
    expect(groupFor("Live (VAD)").querySelector(".aux-stage-note")).toBeNull();
  });

  it("shows a relaunch note (not nothing) when /aux-models 404s on an old engine", async () => {
    fetchMock.mockImplementation(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response,
    );
    new AuxModelManager(root);
    await flush();
    expect(root.querySelector(".aux-models-note")).toBeTruthy();
    expect(root.querySelectorAll(".aux-stage-group")).toHaveLength(0);
  });

  it("shows a Remove button only on installed models", async () => {
    new AuxModelManager(root);
    await flush();
    const installed = root.querySelector('.model-row[data-id="diarize-embedding-fast"]')!;
    expect(installed.querySelector(".model-btn-remove")!.textContent).toBe("Remove");
    const missing = root.querySelector('.model-row[data-id="diarize-segmentation"]')!;
    expect(missing.querySelector(".model-btn-remove")).toBeNull();
  });

  it("clicking Remove confirms then DELETEs the model", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return jsonResponse(LIST);
    });
    new AuxModelManager(root);
    await flush();
    root
      .querySelector<HTMLButtonElement>('.model-row[data-id="diarize-embedding-fast"] .model-btn-remove')!
      .click();
    await flush();
    // Confirm the modal.
    document.querySelector<HTMLButtonElement>(".modal-prompt-ok")!.click();
    await flush();
    const del = calls.find(
      (c) => c.method === "DELETE" && c.url.includes("/aux-models/diarize-embedding-fast"),
    );
    expect(del).toBeTruthy();
  });

  it("clicking Download POSTs the id and begins polling progress", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith("/aux-models")) return jsonResponse(LIST);
      if (url.endsWith("/aux-models/download")) return jsonResponse({ id: "diarize-segmentation", status: "downloading" });
      // progress poll
      return jsonResponse({ id: "diarize-segmentation", status: "downloading", downloaded_bytes: 3_000_000, total_bytes: 6_000_000 });
    });

    new AuxModelManager(root);
    await flush();
    const btn = root.querySelector<HTMLButtonElement>('.model-row[data-id="diarize-segmentation"] .model-btn')!;
    btn.click();
    await flush();

    const post = calls.find((c) => c.url.endsWith("/aux-models/download"));
    expect(post?.method).toBe("POST");
    // Progress bar rendered in the action slot.
    const slot = root.querySelector('.model-row[data-id="diarize-segmentation"] .model-row-action')!;
    expect(slot.querySelector(".model-progress")).toBeTruthy();
  });
});
