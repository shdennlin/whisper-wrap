/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientFetch, setClientFetch } from "../api/client";
import { createMeetingPage } from "./meeting-page";
import type { MeetingResult } from "./types";

// The migrated page routes its /status, /actions, /ask, and meeting-job calls
// through the shared openapi-fetch client; network-asserting tests stub the
// client's ONE `fetch` seam and route by the emitted Request.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
  // Reset the persisted view-mode so every test starts from a known
  // state. The page default is now "chat" (collapsed bubbles);
  // legacy tests that look for `.transcript-segment` either flip to
  // "detail" via the toggle or call switchToDetail() before asserting.
  window.localStorage.removeItem("whisper-wrap.meeting-view-mode.v1");
});

afterEach(() => resetClientFetch());

function mountAvailable() {
  const page = createMeetingPage({
    fetchStatus: async () => ({ available: true }),
    createObjectURL: () => "blob:fake",
  });
  document.body.appendChild(page.element);
  return page;
}

function switchToDetail(): void {
  const btn = document.querySelector<HTMLButtonElement>(
    '.view-toggle-btn[data-view="detail"]',
  )!;
  btn.click();
}

describe("createMeetingPage — rendering", () => {
  it("renders one .transcript-segment per result segment with speaker classes", () => {
    const page = mountAvailable();
    page.renderResult(SAMPLE_RESULT, "blob:fake");
    // Tests in this block target the per-segment Detail view; flip the
    // view-mode toggle before asserting. (Page default is now Chat.)
    switchToDetail();

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
    switchToDetail();
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
    switchToDetail();
    const bColors = Array.from(
      document.querySelectorAll<HTMLElement>(".transcript-segment"),
    ).map((el) => el.style.borderLeftColor);

    expect(aColors).toEqual(bColors);
  });

  it("clicking a segment seeks the audio player to its start time", () => {
    const page = mountAvailable();
    page.renderResult(SAMPLE_RESULT, "blob:fake");
    switchToDetail();

    const audio = document.querySelector<HTMLAudioElement>(".meeting-audio")!;
    audio.play = vi.fn(() => Promise.resolve());

    const secondSegment = document.querySelectorAll<HTMLElement>(
      ".transcript-segment",
    )[1];
    secondSegment.click();

    expect(audio.currentTime).toBe(5.0);
  });

  it("export buttons trigger a Blob download with the correct filename", () => {
    // Exports now route through saveTextFile, whose browser fallback uses the
    // GLOBAL URL.createObjectURL (happy-dom lacks it, so spy it in).
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:export-fake");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
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
      // The single TXT button was split into two explicit variants
      // (Chat vs Script) so users can grab either format without
      // having to flip the view-mode toggle first.
      const srtBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="srt"]',
      )!;
      const vttBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="vtt"]',
      )!;
      const txtChatBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="txt-chat"]',
      )!;
      const txtScriptBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="txt-script"]',
      )!;
      srtBtn.click();
      vttBtn.click();
      txtChatBtn.click();
      txtScriptBtn.click();
      const jsonBtn = document.querySelector<HTMLButtonElement>(
        '[data-export="json"]',
      )!;
      jsonBtn.click();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(clicks).toEqual([
      "meeting.srt",
      "meeting.vtt",
      "meeting-chat.txt",
      "meeting-script.txt",
      "meeting.json",
    ]);
    // createObjectURL was called once per export blob (5 total now
    // that TXT has two variants).
    expect(createObjectURL).toHaveBeenCalledTimes(5);
    vi.restoreAllMocks();
  });
});

describe("createMeetingPage — speaker rename", () => {
  // renameSpeaker awaits promptFn (now async — the modal returns a promise),
  // so the DOM updates a microtask after the click. flush() drains it.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("rename via inline edit updates every chip of that speaker", async () => {
    const editFn = vi.fn(() => "Alice");
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
      editFn,
    });
    document.body.appendChild(page.element);
    page.renderResult(SAMPLE_RESULT, "blob:fake");
    // Detail view: one .transcript-segment per segment so chip count
    // matches segment count (3). Chat view would collapse consecutive
    // segments — covered by transcript-renderer.test.ts.
    switchToDetail();

    // SPEAKER_00 occurs in segments 0 + 2; rename via the edit icon on
    // segment 0 SHALL update both occurrences.
    const editBtns = document.querySelectorAll<HTMLElement>(
      ".transcript-segment .segment-meta-edit",
    );
    expect(editBtns.length).toBeGreaterThan(0);
    editBtns[0].click();
    await flush();

    expect(editFn).toHaveBeenCalledTimes(1);
    const chips = document.querySelectorAll<HTMLElement>(".segment-meta-name");
    // Two segments for SPEAKER_00 (segments 0 + 2), one for SPEAKER_01.
    expect(chips[0].textContent).toContain("Alice");
    expect(chips[1].textContent).toContain("SPEAKER_01"); // untouched
    expect(chips[2].textContent).toContain("Alice");
  });

  it("rename to empty string reverts to raw SPEAKER_xx label", async () => {
    let returnValue: string | null = "Bob";
    const editFn = vi.fn(() => returnValue);
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
      editFn,
    });
    document.body.appendChild(page.element);
    page.renderResult(SAMPLE_RESULT, "blob:fake");
    switchToDetail();

    document
      .querySelector<HTMLElement>(".transcript-segment .segment-meta-edit")!
      .click();
    await flush();
    // Now rename back to "" — should revert.
    returnValue = "";
    document
      .querySelector<HTMLElement>(".transcript-segment .segment-meta-edit")!
      .click();
    await flush();
    const chip = document.querySelector<HTMLElement>(".segment-meta-name")!;
    expect(chip.textContent).toContain("SPEAKER_00");
  });

  it("renamed speakers flow into JSON export payload", async () => {
    const editFn = vi.fn(() => "Charlie");
    let downloadedJson: string | null = null;
    // Exports route through saveTextFile → global URL.createObjectURL; spy it
    // to capture the Blob payload the JSON export path passes through.
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => {
      if (b instanceof Blob) {
        void b.text().then((t) => {
          if (t.startsWith("{")) downloadedJson = t;
        });
      }
      return "blob:export";
    });
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true }),
      createObjectURL: () => "blob:fake",
      editFn,
    });
    document.body.appendChild(page.element);
    page.renderResult(SAMPLE_RESULT, "blob:fake");
    switchToDetail();

    // Rename SPEAKER_00 → Charlie via the icon on the first segment.
    // renameSpeaker awaits the (async) prompt, so flush before exporting.
    document
      .querySelector<HTMLElement>(".transcript-segment .segment-meta-edit")!
      .click();
    await new Promise((r) => setTimeout(r, 0));

    // Trigger JSON download.
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.querySelector<HTMLButtonElement>('[data-export="json"]')!.click();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }

    // Drain the microtask queue so the Blob.text() promise resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(downloadedJson).not.toBeNull();
    const parsed = JSON.parse(downloadedJson!);
    // SPEAKER_00 was renamed to Charlie in segments 0 and 2.
    expect(parsed.speakers).toContain("Charlie");
    expect(parsed.segments[0].speaker).toBe("Charlie");
    expect(parsed.segments[0].raw_speaker).toBe("SPEAKER_00");
    expect(parsed.segments[1].speaker).toBe("SPEAKER_01");
    vi.restoreAllMocks();
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

describe("createMeetingPage — quality tiers", () => {
  function mountWithTiers(tiers: string[] | undefined): void {
    const page = createMeetingPage({
      fetchStatus: async () => ({ available: true, qualityTiers: tiers }),
      createObjectURL: () => "blob:fake",
    });
    document.body.appendChild(page.element);
    const fileInput = document.querySelector<HTMLInputElement>(
      ".meeting-upload input[type=file]",
    )!;
    const file = new File([new Uint8Array([0, 1])], "meeting.wav", {
      type: "audio/wav",
    });
    Object.defineProperty(fileInput, "files", { value: [file], writable: false });
    fileInput.dispatchEvent(new Event("change"));
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  const qualityField = () =>
    document.querySelector<HTMLElement>(".confirm-field-quality")!;

  it("hides the quality select when only the fast tier is installed", async () => {
    mountWithTiers(["fast"]);
    await flush();
    expect(qualityField().hidden).toBe(true);
  });

  it("hides the quality select when the backend predates quality_tiers", async () => {
    mountWithTiers(undefined);
    await flush();
    expect(qualityField().hidden).toBe(true);
  });

  // Route the page's client calls: capture meeting-submit POSTs, answer the
  // mount-time /actions + /v1/meetings prime, and satisfy the poll + audio
  // upload so the flow completes.
  function stubSubmit(submitReqs: Request[]): void {
    setClientFetch(async (input) => {
      const req = input as Request;
      const path = new URL(req.url).pathname;
      if (path === "/actions") return json({ actions: [], categories: [] });
      if (path.startsWith("/v1/meetings")) {
        if (req.method === "POST")
          return json({
            audio_path: "a",
            audio_mime_type: "audio/wav",
            audio_size_bytes: 2,
          });
        return json({ meetings: [], next_before_ms: null });
      }
      if (req.method === "POST" && path === "/transcribe/meeting") {
        submitReqs.push(req);
        return json({ job_id: "j1", status_url: "/transcribe/meeting/j1" }, 202);
      }
      if (path.startsWith("/transcribe/meeting/"))
        return json({
          status: "done",
          progress: 1,
          stage: "complete",
          result: SAMPLE_RESULT,
        });
      return json({});
    });
  }

  it("shows the quality select when balanced is installed and submits quality=balanced", async () => {
    const submitReqs: Request[] = [];
    stubSubmit(submitReqs);
    mountWithTiers(["fast", "balanced"]);
    await flush();
    expect(qualityField().hidden).toBe(false);

    const select = qualityField().querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("fast"); // default
    select.value = "balanced";

    document
      .querySelector<HTMLButtonElement>(".meeting-confirm .btn-primary")!
      .click();
    await flush();
    await flush();

    expect(submitReqs).toHaveLength(1);
    expect(new URL(submitReqs[0].url).searchParams.get("quality")).toBe(
      "balanced",
    );
  });

  it("submits quality=balanced when balanced is the ONLY installed tier (no manual pick)", async () => {
    const submitReqs: Request[] = [];
    stubSubmit(submitReqs);
    // Only the balanced embedding is installed (fast absent).
    mountWithTiers(["balanced"]);
    await flush();

    // Upload as-is — the user never touches a quality dropdown.
    document
      .querySelector<HTMLButtonElement>(".meeting-confirm .btn-primary")!
      .click();
    await flush();
    await flush();

    expect(submitReqs).toHaveLength(1);
    expect(new URL(submitReqs[0].url).searchParams.get("quality")).toBe(
      "balanced",
    );
  });
});

describe("createMeetingPage — fast mode", () => {
  // The fast-mode checkbox default depends on platform detection (userAgent
  // and navigator.platform). happy-dom defaults to a Linux-ish ua, so for
  // the "macOS default ON" case we monkey-patch userAgent for the duration
  // of the test and restore afterwards.

  function mountWithFile(): { file: File; fileInput: HTMLInputElement } {
    const page = mountAvailable();
    void page;
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
    return { file, fileInput };
  }

  function fastModeCheckbox(): HTMLInputElement {
    // The fast-mode checkbox is the LAST .confirm-field-checkbox in
    // confirmOptions (appended after word-ts in meeting-page.ts).
    const boxes = document.querySelectorAll<HTMLInputElement>(
      ".confirm-field-checkbox input[type=checkbox]",
    );
    return boxes[boxes.length - 1];
  }

  function wordTsCheckbox(): HTMLInputElement {
    // First checkbox; word-ts appears before fast-mode in confirmOptions.
    return document.querySelector<HTMLInputElement>(
      ".confirm-field-checkbox input[type=checkbox]",
    )!;
  }

  it("defaults fast-mode ON for macOS users", () => {
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      configurable: true,
    });
    try {
      mountWithFile();
      expect(fastModeCheckbox().checked).toBe(true);
      // Word-ts default OFF (independent of platform).
      expect(wordTsCheckbox().checked).toBe(false);
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: origUA,
        configurable: true,
      });
    }
  });

  it("defaults fast-mode OFF for non-macOS users", () => {
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (X11; Linux x86_64)",
      configurable: true,
    });
    // Also clear platform — happy-dom may default to a Mac-ish value.
    const origPlatform = (navigator as { platform?: string }).platform;
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });
    try {
      mountWithFile();
      expect(fastModeCheckbox().checked).toBe(false);
      expect(wordTsCheckbox().checked).toBe(false);
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: origUA,
        configurable: true,
      });
      Object.defineProperty(navigator, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it("checking fast-mode clears the word-ts checkbox (one-shot interlock)", () => {
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (X11; Linux x86_64)",
      configurable: true,
    });
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });
    try {
      mountWithFile();
      // Manually flip word-ts on first to simulate a user who wanted both.
      const wts = wordTsCheckbox();
      wts.checked = true;
      // Then turn on fast-mode — the change handler should reset word-ts.
      const fast = fastModeCheckbox();
      fast.checked = true;
      fast.dispatchEvent(new Event("change"));
      expect(wts.checked).toBe(false);
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: origUA,
        configurable: true,
      });
    }
  });

  it("Start with fast-mode ON sends ?fast=true in the submit URL", async () => {
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      configurable: true,
    });
    const submitReqs: Request[] = [];
    setClientFetch(async (input) => {
      const req = input as Request;
      const path = new URL(req.url).pathname;
      if (path === "/actions") return json({ actions: [], categories: [] });
      if (path.startsWith("/v1/meetings")) {
        if (req.method === "POST")
          return json({
            audio_path: "a",
            audio_mime_type: "audio/wav",
            audio_size_bytes: 2,
          });
        return json({ meetings: [], next_before_ms: null });
      }
      if (req.method === "POST" && path === "/transcribe/meeting") {
        submitReqs.push(req);
        return json(
          { job_id: "fast-1", status_url: "/transcribe/meeting/fast-1" },
          202,
        );
      }
      if (path.startsWith("/transcribe/meeting/"))
        return json({
          status: "done",
          progress: 1,
          stage: "complete",
          result: SAMPLE_RESULT,
        });
      return json({});
    });
    try {
      mountWithFile();
      // Default-on for Mac; just click Start.
      const startBtn = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".confirm-actions button"),
      ).find((b) => b.textContent?.includes("Start"))!;
      startBtn.click();
      // Drain one tick so the fetch resolves.
      await new Promise((r) => setTimeout(r, 5));
      // The page mounts an ActionsBar (GET /actions) + primes history (GET
      // /v1/meetings) on construction; the submit is captured separately.
      expect(submitReqs).toHaveLength(1);
      expect(new URL(submitReqs[0].url).searchParams.get("fast")).toBe("true");
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: origUA,
        configurable: true,
      });
    }
  });
});

describe("createMeetingPage — upload flow", () => {
  it("polls until done and renders the final result", async () => {
    // Route by the emitted Request so out-of-band calls fired at page mount
    // don't eat a meeting-flow response:
    //   - /actions      → ActionsBar.load() on mount
    //   - /v1/meetings  → prime() pulls history sidebar (+ audio-upload POST)
    const meetingReqs: Request[] = [];
    let pollCount = 0;
    setClientFetch(async (input) => {
      const req = input as Request;
      const path = new URL(req.url).pathname;
      if (path === "/actions") return json({ actions: [], categories: [] });
      if (path.startsWith("/v1/meetings")) {
        if (req.method === "POST")
          return json({
            audio_path: "a",
            audio_mime_type: "audio/wav",
            audio_size_bytes: 2,
          });
        return json({ meetings: [], next_before_ms: null });
      }
      if (req.method === "POST" && path === "/transcribe/meeting") {
        meetingReqs.push(req);
        return json(
          { job_id: "abc", status_url: "/transcribe/meeting/abc" },
          202,
        );
      }
      if (req.method === "GET" && path.startsWith("/transcribe/meeting/")) {
        meetingReqs.push(req);
        pollCount += 1;
        return json(
          pollCount === 1
            ? { status: "running", progress: 0.4, stage: "align", result: null }
            : {
                status: "done",
                progress: 1.0,
                stage: "complete",
                result: SAMPLE_RESULT,
              },
        );
      }
      return json({});
    });

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
    // New confirm-card flow: file pick shows the confirm card with Start +
    // Change buttons; we click Start to kick off the upload.
    const startBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".confirm-actions button"),
    ).find((b) => b.textContent?.includes("Start"))!;
    startBtn.click();

    // Wait for the polling chain to settle. Page default view is Chat
    // (collapsed turns) — use `.chat-turn` as the readiness signal so
    // we don't race the renderer's mode dispatch.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (document.querySelectorAll(".chat-turn").length > 0) break;
    }

    // SAMPLE_RESULT has SPEAKER_00 / SPEAKER_01 / SPEAKER_00 — chat
    // mode collapses consecutive same-speaker segments into one turn,
    // but here every consecutive pair has a speaker change, so 3
    // turns survive unchanged.
    expect(document.querySelectorAll(".chat-turn")).toHaveLength(3);
    // The meeting flow itself emits exactly 3 calls: submit + 2 status polls.
    // The /actions + /v1/meetings mount calls are routed separately, so
    // meetingReqs holds only the meeting-job requests.
    expect(meetingReqs).toHaveLength(3);
    // Submit path first, then two polls of the status URL.
    expect(new URL(meetingReqs[0].url).pathname).toBe("/transcribe/meeting");
    expect(new URL(meetingReqs[1].url).pathname).toBe(
      "/transcribe/meeting/abc",
    );
  });
});
