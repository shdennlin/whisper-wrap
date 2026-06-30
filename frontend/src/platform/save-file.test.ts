import { afterEach, describe, expect, it, vi } from "vitest";

import { saveTextFile } from "./save-file";

type TauriWindow = Window & {
  __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } };
};

afterEach(() => {
  delete (window as TauriWindow).__TAURI__;
  vi.restoreAllMocks();
});

describe("saveTextFile", () => {
  it("routes through the Tauri command when the desktop shell is present", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };

    await saveTextFile("captions.srt", "1\n00:00 --> 00:01\nhi\n");

    expect(invoke).toHaveBeenCalledWith("save_text_file", {
      filename: "captions.srt",
      contents: "1\n00:00 --> 00:01\nhi\n",
    });
  });

  it("falls back to an anchor download in plain browsers", async () => {
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake");
    const revokeUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await saveTextFile("notes.txt", "hello");

    expect(createUrl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith("blob:fake");
  });
});
