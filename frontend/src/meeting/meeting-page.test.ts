/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMeetingPage } from "./meeting-page";
import type { MeetingResult } from "./types";

const SAMPLE_RESULT: MeetingResult = {
  language: "en",
  duration_seconds: 11.2,
  speakers: ["SPEAKER_00", "SPEAKER_01"],
  segments: [
    { speaker: "SPEAKER_00", start: 0.5, end: 4.18, text: "First speaker." },
    { speaker: "SPEAKER_01", start: 5.0, end: 9.7, text: "Second speaker." },
    { speaker: "SPEAKER_00", start: 10.0, end: 11.2, text: "First again." },
  ],
};

beforeEach(() => {
  document.body.replaceChildren();
});

function mountAvailable() {
  const page = createMeetingPage({
    fetchStatus: async () => ({ available: true }),
    createObjectURL: () => "blob:fake",
  });
  document.body.appendChild(page.element);
  return page;
}

describe("createMeetingPage — rendering", () => {
  it("renders one .transcript-segment per result segment with speaker classes", () => {
    const page = mountAvailable();
    page.renderResult(SAMPLE_RESULT, "blob:fake");

    const segs = document.querySelectorAll<HTMLElement>(".transcript-segment");
    expect(segs).toHaveLength(3);
    expect(segs[0].dataset.speaker).toBe("SPEAKER_00");
    expect(segs[1].dataset.speaker).toBe("SPEAKER_01");
    expect(segs[0].textContent).toContain("First speaker.");
    expect(segs[1].textContent).toContain("Second speaker.");

    // One CSS class per distinct speaker — used for theming hooks.
    const classes = new Set<string>();
    segs.forEach((el) =>
      el.classList.forEach((c) => {
        if (c.startsWith("speaker-")) classes.add(c);
      }),
    );
    expect(classes.size).toBe(2);
  });

  it("colours each speaker deterministically (same input → same colour)", () => {
    const a = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
    });
    document.body.appendChild(a.element);
    a.renderResult(SAMPLE_RESULT, "blob:fake");
    const aColors = Array.from(
      document.querySelectorAll<HTMLElement>(".transcript-segment"),
    ).map((el) => el.style.borderLeftColor);

    document.body.replaceChildren();
    const b = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
    });
    document.body.appendChild(b.element);
    b.renderResult(SAMPLE_RESULT, "blob:fake");
    const bColors = Array.from(
      document.querySelectorAll<HTMLElement>(".transcript-segment"),
    ).map((el) => el.style.borderLeftColor);

    expect(aColors).toEqual(bColors);
  });

  it("clicking a segment seeks the audio player to its start time", () => {
    const page = mountAvailable();
    page.renderResult(SAMPLE_RESULT, "blob:fake");

    const audio = document.querySelector<HTMLAudioElement>(".meeting-audio")!;
    audio.play = vi.fn(() => Promise.resolve());

    const secondSegment = document.querySelectorAll<HTMLElement>(
      ".transcript-segment",
    )[1];
    secondSegment.click();

    expect(audio.currentTime).toBe(5.0);
  });

  it("export buttons trigger a Blob download with the correct filename", () => {
    const createObjectURL = vi.fn(() => "blob:export-fake");
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL,
    });
    document.body.appendChild(page.element);
    page.renderResult(SAMPLE_RESULT, "blob:fake");

    const clicks: string[] = [];
    // Stub HTMLAnchorElement.click to record the download filename.
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicks.push((this as HTMLAnchorElement).download);
    };
    try {
      const srtBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="srt"]',
      )!;
      const vttBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="vtt"]',
      )!;
      const txtBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="txt"]',
      )!;
      srtBtn.click();
      vttBtn.click();
      txtBtn.click();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(clicks).toEqual(["meeting.srt", "meeting.vtt", "meeting.txt"]);
    // createObjectURL was called once for the audio source + 3 export blobs.
    expect(createObjectURL).toHaveBeenCalledTimes(3);
  });
});

describe("createMeetingPage — unavailability", () => {
  it("disables the upload control when /status reports unavailable", async () => {
    const page = createMeetingPage({
      fetchStatus: async () => ({
        available: false,
        reason: "HF_TOKEN is not configured",
      }),
      createObjectURL: () => "blob:fake",
    });
    document.body.appendChild(page.element);
    await new Promise((r) => setTimeout(r, 0));

    const fileInput = document.querySelector<HTMLInputElement>(
      ".meeting-upload input[type=file]",
    )!;
    expect(fileInput.disabled).toBe(true);
    const unavailable =
      document.querySelector<HTMLDivElement>(".meeting-unavailable")!;
    expect(unavailable.hidden).toBe(false);
    expect(unavailable.textContent).toContain("HF_TOKEN");
  });
});

describe("createMeetingPage — upload flow", () => {
  it("polls until done and renders the final result", async () => {
    const responses = [
      {
        ok: true,
        json: async () => ({
          job_id: "abc",
          status_url: "/transcribe/meeting/abc",
        }),
      },
      {
        ok: true,
        json: async () => ({
          status: "running",
          progress: 0.4,
          stage: "align",
          result: null,
        }),
      },
      {
        ok: true,
        json: async () => ({
          status: "done",
          progress: 1.0,
          stage: "complete",
          result: SAMPLE_RESULT,
        }),
      },
    ];
    const fetchFn = vi.fn(
      async () => responses.shift() as unknown as Response,
    );
    // submitMeeting / pollUntilDone use the global fetch directly; for an
    // end-to-end page test we stub it here. The page's `fetchFn` opt is only
    // used by `fetchStatus`'s default impl, which we override below.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
      pollIntervalMs: 1,
    });
    document.body.appendChild(page.element);

    const fileInput = document.querySelector<HTMLInputElement>(
      ".meeting-upload input[type=file]",
    )!;
    const file = new File([new Uint8Array([0, 1])], "meeting.wav", {
      type: "audio/wav",
    });
    Object.defineProperty(fileInput, "files", {
      value: [file],
      writable: false,
    });
    fileInput.dispatchEvent(new Event("change"));

    // Wait for the polling chain to settle.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (document.querySelectorAll(".transcript-segment").length > 0) break;
    }

    try {
      expect(document.querySelectorAll(".transcript-segment")).toHaveLength(3);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      // Submit URL first, then two polls of the status URL.
      expect(
        (fetchFn.mock.calls[0][0] as string).startsWith("/transcribe/meeting"),
      ).toBe(true);
      expect(fetchFn.mock.calls[1][0]).toBe("/transcribe/meeting/abc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
