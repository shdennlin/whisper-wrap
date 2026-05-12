# Transcript Cleanup Prompts (備用)

> **狀態**：暫不整合進 v2.0
> **來源**：使用者既有 prompt（2026-05-12 提交）
> **未來去處**：v2.1+ 可能新增 `POST /cleanup` endpoint，三份 prompt 對應三個 level
> **觸發條件**：當 use case 從「voice Q&A」擴展到「voice → notes / 文章草稿 / 字幕」時啟用

## 為什麼不在 v2.0

PRD v2.0 的 `/ask` 流程是 audio → STT → Gemini → answer，中間 transcript 只是 LLM 的輸入，**現代 LLM 對未標點口語的容忍度足夠高**，所以原始 transcript 直接送 Gemini 已可用。

只有當「輸出就是 transcript 本身」時才需要這些 prompt：
- 語音 → Notion / Obsidian 筆記
- 字幕檔生成
- 部落格草稿

## 未來整合構想

```
POST /cleanup
  Body: {"text": "...", "level": "light|punctuated|polished"}
  → {"text": "處理後"}
```

對應關係：
- `level=light` → Prompt 1
- `level=punctuated` → Prompt 2
- `level=polished` → Prompt 3

組合用例：
```
POST /transcribe → 原始 transcript
POST /cleanup level=punctuated → 帶標點版本
POST /cleanup level=polished → 潤稿版本
```

各端點各司其職，符合 PRD §3 設計原則。

---

## Prompt 1: Light cleanup（保留無標點口語流）

```
Process the <TRANSCRIPT> text. Your task is LIGHT cleanup only: fix obvious ASR errors and remove fillers, but DO NOT add punctuation. Output goes to a large language model that handles unpunctuated speech well.

DO NOT ADD PUNCTUATION:
- Do NOT add 。, ? ! : ; or any full-width Chinese punctuation.
- Do NOT add . , ? ! ; : or any half-width English punctuation.
- Sentence boundaries are conveyed by spaces and line breaks, not punctuation.

ASR ERROR FIXES (main value of this mode):
- Fix Chinese homophone errors when context makes the correct character obvious:
  在 vs 再, 想 vs 像, 的 vs 得 vs 地, 化 vs 話, 一 vs 已, 做 vs 作, 是 vs 試, 他 vs 她 vs 它
- Fix English split-word or homophone errors when context is clear:
  "use effect" → "useEffect" (in React context)
  "type script" → "TypeScript"
  "their" vs "there" vs "they're"
- Only fix when context makes the right answer unambiguous. If genuinely uncertain, keep the original.

CLEANUP RULES:
- Remove filler words: 嗯, 欸, 那個, 就是, 然後然後, um, uh, like, you know, sort of, basically.
- Collapse stutters and repetitions: 我我我覺得 → 我覺得, "I I think" → "I think".
- Handle self-corrections: when the speaker says "actually scratch that", "啊不對是", "wait no", "我是說" — keep only the corrected version.
- Keep a space around English words embedded in Chinese: "我用 React 寫" not "我用React寫".

PRESERVE STRICTLY:
- All names, proper nouns, numbers, dates, file paths, error messages, technical terms — verbatim.
- Original word choice and phrasing — do NOT substitute synonyms.
- Original sentence order — do NOT reorganize.
- Original voice and register.

DO NOT:
- Add punctuation of any kind.
- Rewrite or paraphrase.
- Add structure, labels, or formatting.
- Add information not present in the input.
- Translate between languages.

OUTPUT ONLY THE PROCESSED TEXT. No explanations, no preamble, no closing remarks.
```

---

## Prompt 2: Punctuated cleanup（加標點 + 清理）

```
Process the <TRANSCRIPT> text. Your task is to add missing Chinese punctuation, fix obvious ASR errors, and apply light cleanup. The input may have no punctuation at all — add it.

CHINESE PUNCTUATION RULES:
- Use full-width Chinese punctuation: ,。?!:;「」『』() — never half-width .,?!
- Insert commas at natural pause points within sentences.
- End each sentence with 。
- Use ? for questions, ! for emphasis or exclamation.
- Use 「」 for quoted speech, 『』 for nested quotes.
- Numbers, English words, and code identifiers stay half-width and unchanged (e.g. 1080p, API, useEffect must not be split or translated).

CODE-SWITCHING RULES (Mandarin + English):
- Keep a space around English words embedded in Chinese: "我用 React 寫" not "我用React寫".
- The dominant language determines the punctuation style. If the sentence is mostly Chinese, use full-width Chinese punctuation even after English words.
- Never translate English to Chinese or vice versa. Preserve original word choice.

ASR ERROR FIXES:
- Fix Chinese homophone errors when context makes the correct character obvious:
  在 vs 再, 想 vs 像, 的 vs 得 vs 地, 化 vs 話, 一 vs 已, 做 vs 作, 是 vs 試, 他 vs 她 vs 它
- Fix English split-word or homophone errors when context is clear:
  "use effect" → "useEffect", "type script" → "TypeScript"
- Only fix when context is unambiguous. If uncertain, keep original.

CLEANUP RULES:
- Remove filler words: 嗯, 欸, 那個, 就是, 然後然後, um, uh, like, you know.
- Collapse stutters and repetitions.
- Handle self-corrections: keep only the corrected version.

PRESERVE STRICTLY:
- All names, proper nouns, numbers, dates, technical terms — verbatim.
- Original word choice — do NOT substitute synonyms.
- Original sentence order — do NOT reorganize.

DO NOT:
- Rewrite or paraphrase.
- Add information not in the input.

PURE-ENGLISH FALLBACK:
- If the input is entirely English, use standard English punctuation . , ? ! ; : — instead.

OUTPUT ONLY THE PROCESSED TEXT. No explanations, no preamble, no closing remarks.
```

---

## Prompt 3: Polished rewrite（潤稿）

```
Process the <TRANSCRIPT> text. Your task is to produce a polished version: improve clarity, sentence flow, and word choice. You MAY rewrite, paraphrase, and reorganize sentences within each topic to improve readability.

PUNCTUATION & FORMATTING:
- Add full-width Chinese punctuation: ,。?!:;「」『』() for Chinese-dominant input.
- Add standard English punctuation . , ? ! ; : — for English-dominant input.
- Numbers, English words, and code identifiers stay half-width and unchanged.
- Insert paragraph breaks at clear topic shifts (every 3-5 sentences).
- Keep a space around English words embedded in Chinese.

REWRITE PERMISSIONS:
- Improve sentence structure for natural flow and rhythm.
- Substitute words with clearer or more concise alternatives — BUT only when meaning is preserved exactly.
- Reorder sentences within a single topic for logical progression.
- Combine fragmented thoughts into coherent sentences.
- Match register: informal stays informal, formal stays formal, technical stays technical.

ASR ERROR FIXES:
- Fix Chinese homophone errors based on context:
  在 vs 再, 想 vs 像, 的 vs 得 vs 地, 化 vs 話, 做 vs 作, 是 vs 試, 他 vs 她 vs 它
- Fix English split-word errors: "use effect" → "useEffect", "type script" → "TypeScript".

CLEANUP RULES:
- Remove fillers and stutters.
- Handle self-corrections: keep only the corrected version.

HARD CONSTRAINTS — NEVER VIOLATE:
- DO NOT add information not present in the input.
- DO NOT change facts, names, proper nouns, numbers, dates, file paths, error messages, or technical terms.
- DO NOT shift the speaker's tone or stance.
- DO NOT add new examples, claims, or context.
- DO NOT translate between languages.
- DO NOT change the input's intent or main argument.
- If you cannot improve a sentence without violating these constraints, leave it unchanged.

OUTPUT ONLY THE POLISHED TEXT. No explanations, no preamble, no closing remarks.
```
