/**
 * Two view modes for the Meeting Mode transcript:
 *
 *   - Detail: every VAD segment renders as its own card with the
 *     speaker chip + start time + text. Maximum fidelity, fattest layout.
 *   - Chat: consecutive same-speaker segments collapse into one "turn"
 *     bubble. Speaker name + start time appear once at the top of the
 *     bubble; subsequent segments append to the bubble's text. Reads
 *     like a Google Meet caption thread and is typically 3-5× more
 *     compact for natural conversation.
 *
 * Both modes share the same hover ✏️ rename affordance, the same
 * click-to-seek behavior, and the same per-speaker color palette so
 * users can switch freely without re-orienting.
 *
 * The renderer is extracted from meeting-page.ts so the page module
 * stays focused on lifecycle / orchestration and so this layer can be
 * unit-tested in isolation.
 */

import type { MeetingResult, Segment, Word } from "./types";

const EDIT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

export interface ChatTurn {
  raw_speaker: string;
  start: number;
  end: number;
  text: string;
  /** The source segments of this turn, in order — used by the word-
   *  level renderer so per-word seek survives the chat collapse. */
  segments: Segment[];
}

export interface RenderOptions {
  speakerColors: Map<string, string>;
  displaySpeakerName: (rawSpeaker: string) => string;
  formatTime: (totalSeconds: number) => string;
  cssSafe: (s: string) => string;
  seekTo: (seg: Segment) => void;
  /** `anchor` is the speaker-name label element the caller can edit in place. */
  onRename: (rawSpeaker: string, anchor: HTMLElement) => void;
  renameTooltip: string;
}

/**
 * Group consecutive segments with the same `speaker` into one ChatTurn.
 * The text of merged segments joins with a single space; start carries
 * the first segment's start (used for seek-to), end carries the last
 * segment's end (used for export-only metadata).
 *
 * The collapse boundary is purely speaker identity — we do NOT cap
 * turn length, because a single speaker speaking for 5 minutes is
 * still semantically one turn and breaking it would mislead the
 * reader about who's saying what.
 */
export function collapseToChatTurns(
  segments: ReadonlyArray<Segment>,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const seg of segments) {
    const last = turns.at(-1);
    if (last && last.raw_speaker === seg.speaker) {
      // Join with a space — segments are already whisper-normalised
      // (leading/trailing whitespace trimmed at the analyzer in
      // _merge), so a single space gives natural sentence flow.
      last.text = `${last.text} ${seg.text}`.replace(/\s+/g, " ");
      last.end = seg.end;
      last.segments.push(seg);
    } else {
      turns.push({
        raw_speaker: seg.speaker,
        start: seg.start,
        end: seg.end,
        text: seg.text,
        segments: [seg],
      });
    }
  }
  return turns;
}

/** One renderable slice of a segment's text: either plain text (word
 *  gaps — usually whitespace) or a span backed by a timed Word. */
export interface TextChunk {
  text: string;
  word?: Word;
}

/**
 * Map a segment's `words` back onto its display text.
 *
 * The server's word list drops the original inter-word spacing
 * (zh output like "7 月 1 號" becomes words ["7","月","1","號"]), so
 * rendering words directly would change the visible text. Instead we
 * walk `text` greedily: whitespace runs become plain chunks, and each
 * word must match the next non-space characters exactly. The engine
 * guarantees concat(words) === text-without-spaces, so alignment is
 * exact; if it ever isn't (older history rows, future engine drift),
 * return null and let the caller fall back to plain text.
 */
export function alignWordsToText(
  text: string,
  words: ReadonlyArray<Word>,
): TextChunk[] | null {
  const chunks: TextChunk[] = [];
  let i = 0;
  for (const w of words) {
    let ws = "";
    while (i < text.length && /\s/.test(text[i])) {
      ws += text[i];
      i += 1;
    }
    if (ws) chunks.push({ text: ws });
    if (text.slice(i, i + w.word.length) !== w.word) return null;
    chunks.push({ text: w.word, word: w });
    i += w.word.length;
  }
  if (i < text.length) {
    const rest = text.slice(i);
    if (rest.trim() !== "") return null;
    chunks.push({ text: rest });
  }
  return chunks;
}

/**
 * Fill `textEl` with the segment's text, wrapping each timed word in a
 * clickable span that seeks to that word's start. Segments without
 * words (pre-words history rows) render as plain text — identical to
 * the previous behavior.
 */
function appendSegmentText(
  textEl: HTMLElement,
  seg: Segment,
  opts: RenderOptions,
): void {
  const chunks = seg.words?.length
    ? alignWordsToText(seg.text, seg.words)
    : null;
  if (!chunks) {
    textEl.append(document.createTextNode(seg.text));
    return;
  }
  for (const chunk of chunks) {
    if (!chunk.word) {
      textEl.append(document.createTextNode(chunk.text));
      continue;
    }
    const word = chunk.word;
    const span = document.createElement("span");
    span.className = "segment-word";
    span.dataset.start = String(word.start);
    span.title = opts.formatTime(word.start);
    span.textContent = chunk.text;
    span.addEventListener("click", (e) => {
      // Don't let the parent segment/turn button seek to its own
      // start right after we seeked to the word.
      e.stopPropagation();
      opts.seekTo({ ...seg, start: word.start });
    });
    textEl.append(span);
  }
}

/** Detail mode — one card per segment, tightened from the original. */
export function renderDetailMode(
  host: HTMLElement,
  result: MeetingResult,
  opts: RenderOptions,
): void {
  host.replaceChildren();
  for (const seg of result.segments) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `transcript-segment speaker-${opts.cssSafe(seg.speaker)}`;
    item.dataset.speaker = seg.speaker;
    item.dataset.start = String(seg.start);
    const color = opts.speakerColors.get(seg.speaker) ?? "#999";
    item.style.borderLeftColor = color;
    item.style.color = color;

    const metaEl = document.createElement("span");
    metaEl.className = "segment-meta";
    const chipText = document.createElement("span");
    chipText.className = "segment-meta-name";
    chipText.textContent = `${opts.displaySpeakerName(seg.speaker)} · ${opts.formatTime(seg.start)}`;

    const editBtn = document.createElement("span");
    editBtn.className = "segment-meta-edit";
    editBtn.setAttribute("role", "button");
    editBtn.setAttribute("aria-label", opts.renameTooltip);
    editBtn.title = opts.renameTooltip;
    editBtn.innerHTML = EDIT_ICON_SVG;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onRename(seg.speaker, chipText);
    });
    metaEl.append(chipText, editBtn);

    const textEl = document.createElement("span");
    textEl.className = "segment-text";
    appendSegmentText(textEl, seg, opts);

    item.append(metaEl, textEl);
    item.addEventListener("click", () => opts.seekTo(seg));
    host.appendChild(item);
  }
}

/** Chat mode — collapse consecutive turns; one bubble per turn. */
export function renderChatMode(
  host: HTMLElement,
  result: MeetingResult,
  opts: RenderOptions,
): void {
  host.replaceChildren();
  const turns = collapseToChatTurns(result.segments);
  for (const turn of turns) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `chat-turn speaker-${opts.cssSafe(turn.raw_speaker)}`;
    item.dataset.speaker = turn.raw_speaker;
    item.dataset.start = String(turn.start);
    const color = opts.speakerColors.get(turn.raw_speaker) ?? "#999";
    item.style.borderLeftColor = color;
    // Apply color as a CSS custom property so the chat-turn-name class
    // can pick it up via `color: var(--turn-speaker-color)` without
    // having to colour every <span> individually from JS.
    item.style.setProperty("--turn-speaker-color", color);

    const head = document.createElement("span");
    head.className = "chat-turn-head";
    const nameEl = document.createElement("span");
    nameEl.className = "chat-turn-name";
    nameEl.textContent = opts.displaySpeakerName(turn.raw_speaker);
    const timeEl = document.createElement("span");
    timeEl.className = "chat-turn-time";
    timeEl.textContent = opts.formatTime(turn.start);

    const editBtn = document.createElement("span");
    // Reuse `.segment-meta-edit` class so the existing hover-show CSS
    // works for chat mode too — same pencil, same opacity transition.
    editBtn.className = "segment-meta-edit";
    editBtn.setAttribute("role", "button");
    editBtn.setAttribute("aria-label", opts.renameTooltip);
    editBtn.title = opts.renameTooltip;
    editBtn.innerHTML = EDIT_ICON_SVG;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onRename(turn.raw_speaker, nameEl);
    });
    head.append(nameEl, timeEl, editBtn);

    const textEl = document.createElement("span");
    textEl.className = "chat-turn-text";
    if (turn.segments.some((s) => s.words?.length)) {
      // Render per source segment so word spans survive the collapse;
      // single-space joins mirror the turn.text merge above.
      turn.segments.forEach((seg, idx) => {
        if (idx > 0) textEl.append(document.createTextNode(" "));
        appendSegmentText(textEl, seg, opts);
      });
    } else {
      textEl.textContent = turn.text;
    }

    item.append(head, textEl);
    item.addEventListener("click", () =>
      // Seek to the start of the turn — the Segment shape needed by
      // seekTo is reconstructable from the turn's first segment data.
      opts.seekTo({
        speaker: turn.raw_speaker,
        start: turn.start,
        end: turn.end,
        text: turn.text,
      } as Segment),
    );
    host.appendChild(item);
  }
}

/**
 * Plain-text rendering of a transcript for AI Enhance prompts.
 *
 * Always uses the chat (collapsed-per-speaker) shape, regardless of
 * which view mode the user has open in the UI. LLMs handle
 * `speaker: text` lines much better than a flat list of timestamped
 * segments — they latch onto the speaker-as-actor framing and produce
 * cleaner summaries / meeting notes. We strip timestamps here so the
 * prompt stays compact and LLMs don't waste tokens on "[00:00]" noise.
 */
export function buildPromptText(
  result: MeetingResult,
  displaySpeakerName: (raw: string) => string,
): string {
  if (result.segments.length === 0) return "";
  const turns = collapseToChatTurns(result.segments);
  return turns
    .map((t) => `${displaySpeakerName(t.raw_speaker)}: ${t.text}`)
    .join("\n");
}
