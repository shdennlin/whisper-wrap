/**
 * Platform-aware "save text as file".
 *
 * Browsers: classic invisible-anchor blob download.
 * Tauri desktop shell: WKWebView ignores the `download` attribute on blob:
 * anchors — a.click() fires but nothing downloads. There we invoke the
 * desktop crate's `save_text_file` command, which opens the native save
 * dialog and writes the file in Rust.
 */

type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** withGlobalTauri exposes window.__TAURI__ in the desktop shell only. */
function tauriInvoke(): TauriInvoke | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
  };
  return w.__TAURI__?.core?.invoke ?? null;
}

export async function saveTextFile(
  filename: string,
  contents: string,
  mime = "text/plain;charset=utf-8",
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("save_text_file", { filename, contents });
    return;
  }
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
