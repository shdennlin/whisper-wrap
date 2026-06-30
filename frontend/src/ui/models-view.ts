/**
 * Models view (fe-models-settings): a first-class shell view that hosts the
 * model managers, grouped by pipeline stage — ASR (transcribe) plus the
 * auxiliary diarization / VAD models. `main.ts` injects the real mounts (it
 * owns the backend-URL dependency); tests inject spies.
 */

export interface ModelsViewDeps {
  /** Mount the ASR (transcribe) model manager. */
  mount?: (host: HTMLElement) => void;
  /** Mount the auxiliary (diarization + VAD) model manager. */
  mountAux?: (host: HTMLElement) => void;
}

function frame(): { frame: HTMLElement; host: HTMLElement } {
  const frame = document.createElement("div");
  frame.className = "mrow-frame";
  const host = document.createElement("div");
  host.className = "models-host";
  frame.appendChild(host);
  return { frame, host };
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "models-section-title";
  el.textContent = text;
  return el;
}

export function renderModels(container: HTMLElement, deps: ModelsViewDeps = {}): void {
  container.replaceChildren();
  container.classList.add("models-view");

  const rowTitle = document.createElement("div");
  rowTitle.className = "row-title";
  const heading = document.createElement("h3");
  heading.textContent = "模型";
  rowTitle.appendChild(heading);
  container.appendChild(rowTitle);

  // ASR (transcribe) section.
  container.appendChild(sectionTitle("轉錄 (ASR)"));
  const asr = frame();
  container.appendChild(asr.frame);
  deps.mount?.(asr.host);

  // Auxiliary models (diarization + VAD) — the manager renders its own
  // per-stage sub-headings inside this frame.
  if (deps.mountAux) {
    const aux = frame();
    container.appendChild(aux.frame);
    deps.mountAux(aux.host);
  }
}
