## Context

Four HTTP/WS surfaces share one transcription pipeline: each ultimately calls `WhisperBackend.transcribe(audio, language=..., prompt=...)` from `app/services/_whisper_backend.py`. Backend output is currently consumed differently per surface:

- `/listen` uses `app/services/stream.py::sliding_window_pipeline`, which already knows utterance `duration_ms` (computed from VAD endpointing). This is the only call site where audio duration is naturally available without re-measuring.
- `/transcribe` calls the backend directly with a temp WAV file, returns `{"text": result.text}`.
- `/ask` calls `/transcribe`'s helper (or duplicates it), then forwards to `LLMClient.generate(...)` or its streaming variant.
- `/v1/audio/transcriptions` and `/v1/audio/translations` call the backend then format the result based on `response_format`.

The current empty-input situation:

- `stream.py` already calls `text.strip()` and skips emission on empty, but `text.strip()` does NOT remove standalone punctuation (`"。"`, `","`, `"."`). A `"。"` passes through as a `final` event.
- `/transcribe`, `/ask`, and OpenAI-compat have no empty-check at all. They forward whatever the backend produces.

The fix is a shared post-process helper that every call site runs after backend output. Each call site translates the helper's decision into its surface's native shape (WS event vs HTTP body vs SSE frame).

Single-tenant FastAPI; no concurrency primitives needed for the helper. The two new env vars piggyback on the existing `Config` pattern (read in `__init__`, cached on the instance).

## Goals / Non-Goals

**Goals**

- One canonical "is this transcription content?" decision, shared by all four surfaces.
- No SQLite-side noise: filtered transcriptions SHALL NOT reach `sessions` or `finals` tables (the frontend, which writes them, never receives a filtered final because the WS event is suppressed and the HTTP `/transcribe` returns `text: ""` which the PWA already drops).
- Save Gemini tokens: filtered STT on `/ask` early-exits before any LLM call.
- OpenAI contract preserved: no new fields on the OpenAI-compat response schemas.
- Auditable: every Drop logs an INFO line with structured `extra={...}` for grepability.

**Non-Goals**

- Pattern-based hallucination detection beyond empty / punctuation-only.
- Per-request filter override.
- Language-specific minimum durations.
- Recording filtered events anywhere outside the log stream.

## Decisions

### Decision 1: One pure helper module, not a middleware

**Chosen**: `app/services/postprocess.py::filter_empty_transcription(text, duration_ms, *, enabled, min_duration_ms) -> FilterDecision` where `FilterDecision = Keep(text: str) | Drop(reason: str)`.

**Why**: Per-surface response shaping (WS event vs HTTP body vs SSE frame vs OpenAI verbose_json) is incompatible with a generic FastAPI middleware. A pure helper gives each call site the decision and lets the surface translate it. Pure means easy to unit-test in isolation without spinning up the pipeline.

**Alternative — FastAPI dependency that mutates `request.state`**: dependencies can't intercept WebSocket frames, and the OpenAI verbose_json case needs to keep `language`/`duration` alongside the empty `segments` array — a dependency-based wrap-and-modify pattern would be too coupled to each route's response model.

### Decision 2: Filter inside `stream.py` for `/listen`, not in the WS handler

**Chosen**: `stream.py::sliding_window_pipeline` calls `filter_empty_transcription(text, utterance_duration_ms, ...)` before constructing each `final` event payload. When the decision is Drop, the pipeline emits no event; the WS handler in `app/api/listen.py` never sees the dropped final.

**Why**: `stream.py` is the only layer with `utterance_duration_ms` already in hand (computed from VAD endpoint timestamps). Filtering in `listen.py` would require either passing duration up or remeasuring — both lose context. Co-locating the filter with the duration source keeps the helper inputs sourced from one place.

**Alternative — filter in the WS handler**: would need to pass `start_ms`/`end_ms` up to the handler and recompute duration there. Adds duplicated arithmetic for zero benefit.

### Decision 3: `/ask` audio path 400, not 200-with-empty-answer

**Chosen**: When audio STT for `/ask` yields a Drop, return HTTP 400 `{"error": "no_speech_detected"}` (blocking) or `event: error\ndata: {"error": "no_speech_detected"}` then close (streaming). The LLM SHALL NOT be invoked.

**Why**: Two reasons. (1) Avoids billing Gemini for empty content (Gemini 2.5 Flash charges a minimum input-token fee even for empty prompts). (2) `/ask`'s contract is "you asked a question, here is the answer" — there is no meaningful answer to silence. 400 is the right HTTP shape (client-side input issue). The existing `Question-answering endpoint validates input bodies` requirement already returns 400 with `{"error": "..."}` shape for `text=""`, so this is consistent.

**Alternative — 200 with `{"transcript": "", "answer": "I didn't catch that."}`**: Polite but expensive (still pays Gemini). And the PWA already shows a toast on 4xx, so the user gets visible feedback either way.

**Alternative — re-prompt loop**: completely out of scope.

### Decision 4: OpenAI compat preserves `{"text": ""}` for filtered output

**Chosen**: For `/v1/audio/transcriptions` and `/v1/audio/translations`, when STT yields a Drop the response shape is:

- `json` format: `{"text": ""}`
- `text` format: empty string body, `Content-Type: text/plain`
- `verbose_json` format: `{"task": "transcribe", "language": "<detected or 'unknown'>", "duration": <input duration s>, "text": "", "segments": []}`
- `srt` format: `1\n00:00:00,000 --> 00:00:00,000\n\n` (single empty cue) or fully empty body — OpenAI's empirical behavior is empty body for fully silent audio, so the chosen shape is the empty body
- `vtt` format: `WEBVTT\n\n` (header + one blank line) — matches OpenAI's empirical shape for silent input

**Why**: Third-party clients enforce the OpenAI schema strictly. Adding `meta: {"filtered": true}` would break strict-typed Go and Rust SDKs that reject unknown fields. The existing `verbose_json` schema already permits empty `segments`; that is the OpenAI-native way to signal "no content detected."

**Alternative — return 204 No Content**: not in the OpenAI API spec; would break clients that expect a body.

**Alternative — return 422 Unprocessable Entity**: OpenAI does NOT return 422 for silent audio; it returns 200 with empty text. Diverging breaks the compat promise.

### Decision 5: Two env vars, both with safe defaults

**Chosen**:

- `FILTER_EMPTY_ENABLED` (string `"true"|"false"`, default `"true"`). Parsed case-insensitively. Anything other than `"true"`/`"false"` → log WARN + use default `True`.
- `FILTER_MIN_DURATION_MS` (integer, default `500`). Anything non-integer or negative → log WARN + use default `500`.

**Why**: Defaults-on, opt-out via env. Filtering is a noise-correction fix; new installs should benefit without configuration. Disabling exists for the case where a user reports "I said something and the system ignored it" — flipping the var lets them confirm the filter was responsible.

**Alternative — defaults-off**: punishes users who never touch env. The filter is a quality fix, not a behavioral change for normal-content cases.

**Alternative — default min duration 1000 ms**: too aggressive. Chinese 単 characters ("好", "對", "是") run 300-600 ms typically; 500 ms is the conservative cutoff that catches most pure-noise hits while allowing genuine short utterances.

## Implementation Contract

### 1. `app/services/postprocess.py` (new module)

**Exports**:

```python
from dataclasses import dataclass
from typing import Literal, Union

@dataclass(frozen=True)
class Keep:
    text: str

@dataclass(frozen=True)
class Drop:
    reason: Literal["empty_text", "below_min_duration"]

FilterDecision = Union[Keep, Drop]

def filter_empty_transcription(
    text: str,
    duration_ms: float | None,
    *,
    enabled: bool,
    min_duration_ms: int,
) -> FilterDecision: ...
```

**Behavior**:

- When `enabled=False` → return `Keep(text)` unconditionally. No filter side-effects.
- When `duration_ms is not None and duration_ms < min_duration_ms` → return `Drop("below_min_duration")`.
- When the text, with all whitespace AND unicode punctuation stripped, is empty → return `Drop("empty_text")`. Implementation note: use a regex that matches Unicode property `\p{P}` (Python: `regex` library) OR a hand-rolled set that includes ASCII punctuation + CJK punctuation (`。`, `，`, `、`, `；`, `：`, `？`, `！`, `「`, `」`, `『`, `』`, `（`, `）`, `《`, `》`, `〈`, `〉`, `…`, `—`, `·`). The hand-rolled set is acceptable because the regex library is not in current deps; the project already imports `re` everywhere. The chosen approach SHALL be documented in the module docstring.
- Otherwise → return `Keep(text)`.

**Verification target**: `tests/test_postprocess.py` parameterised over: enabled=False bypass, sub-duration drop, empty-string drop, whitespace-only drop, ASCII-punctuation-only drop, CJK-punctuation-only drop, mixed punctuation+space drop, valid Chinese single char "好" Keep, valid English "Hi." Keep, `duration_ms=None` skips the duration check.

### 2. `app/config.py` updates

**New fields**:

```python
self.FILTER_EMPTY_ENABLED: bool = _parse_bool(os.getenv("FILTER_EMPTY_ENABLED"), default=True)
self.FILTER_MIN_DURATION_MS: int = _parse_int(os.getenv("FILTER_MIN_DURATION_MS"), default=500)
```

`_parse_bool` and `_parse_int` are local helpers (module-level or static method on Config) that:

- For bool: accept `"true"`/`"false"` (case-insensitive). On any other non-None value, log WARN + return default.
- For int: accept any integer-parseable string; reject negatives. On any other non-None value, log WARN + return default.

**Verification target**: `tests/test_config.py` cases — defaults, valid override, empty string falls to default, invalid value logs warning + falls to default, negative integer logs warning + falls to default.

### 3. `/listen` integration (`app/services/stream.py`)

**Change**: in `sliding_window_pipeline` (or whichever function constructs final events), wrap the existing `text.strip()` + emit block with:

```python
decision = filter_empty_transcription(
    text=raw_text,
    duration_ms=utterance_duration_ms,
    enabled=config.FILTER_EMPTY_ENABLED,
    min_duration_ms=config.FILTER_MIN_DURATION_MS,
)
match decision:
    case Drop(reason):
        logger.info(
            "transcription_filtered",
            extra={"endpoint": "/listen", "reason": reason, "duration_ms": utterance_duration_ms, "raw_text_len": len(raw_text)},
        )
        # do not emit
        continue
    case Keep(text):
        # existing emit path with text
```

**Behavior**: no `final` event reaches the WS client when Drop. Partial events (which emit before utterance completion) are not subject to the duration filter — they still flow through the partial-consensus filter as today.

**Verification target**: `tests/test_listen.py` — extend `test_partial_consensus_filter` neighbors with: (a) sub-min-duration utterance produces no `final` event; (b) punctuation-only result produces no `final` event; (c) when `FILTER_EMPTY_ENABLED=false`, an empty final IS emitted.

### 4. `/transcribe` integration (`app/api/transcribe.py`)

**Change**: after `await backend.transcribe(...)`, run the filter with `duration_ms=None` (the endpoint does not currently compute duration; passing None skips the duration check, leaving only the empty-text check). On Drop, return `{"text": ""}` and log.

**Verification target**: `tests/test_api.py` — add cases: punctuation-only backend output returns `{"text": ""}` body; logger asserts via `caplog.records` for `"transcription_filtered"` with `endpoint="/transcribe"`.

### 5. `/ask` integration (`app/api/ask.py`)

**Change**: after STT for audio inputs (multipart, raw audio, octet-stream paths), run the filter with `duration_ms=None`. On Drop:

- Blocking response: return `JSONResponse({"error": "no_speech_detected"}, status_code=400)`. The LLM SHALL NOT be invoked.
- SSE response: emit `event: error\ndata: {"error": "no_speech_detected"}\n\n` then close. The LLM SHALL NOT be invoked.

The text-input JSON path is unaffected — it is not transcribing.

**Verification target**: `tests/test_ask.py` — add cases: audio path with mocked backend returning `"。"` returns 400 + LLM mock asserted not called; SSE mode same input emits error event then closes + LLM mock not called.

### 6. OpenAI-compat integration (`app/api/openai_compat.py`)

**Change**: after STT, run the filter with `duration_ms=None`. On Drop, return per-format empty shapes per Decision 4. Logger emits with `endpoint="/v1/audio/transcriptions"` or `endpoint="/v1/audio/translations"` and the resolved `response_format`.

**Verification target**: `tests/test_openai_compat.py` — add per-format cases: `json` returns `{"text": ""}`, `text` returns empty body, `verbose_json` returns the agreed schema with empty `segments`, `srt` returns empty body, `vtt` returns `WEBVTT\n\n`. For translations endpoint, additionally assert the answer shape matches and that no model call beyond STT occurred.

### 7. Documentation

`.env.example` SHALL gain the two new entries with comments. `README.md` Configuration section SHALL gain a one-paragraph note explaining the filter, its defaults, and how to disable.

### Scope boundaries

**In scope**:

- New `postprocess.py` module + tests.
- Two new Config fields + tests.
- Integration in `stream.py`, `transcribe.py`, `ask.py`, `openai_compat.py` + tests.
- `.env.example` and `README.md` documentation entries.
- Structured logging at each Drop site.

**Out of scope**:

- WS `/listen` server-side persistence (separate concern).
- Hallucination pattern matching beyond empty/punctuation.
- Per-request override params.
- Language-specific durations.
- Recording filtered events to SQLite.
- Changes to actual transcription / VAD logic (this is post-process only).
- Changes to `/v1/models` or any non-transcription endpoint.

## Risks / Trade-offs

- **Legitimate sub-500 ms speech is dropped** → Mitigation: `FILTER_MIN_DURATION_MS` is user-configurable; document in `.env.example` and README that single CJK character utterances may need a lower threshold (e.g., 300 ms).
- **`/ask` 400 surprises existing callers that expect 200** → Mitigation: the existing JSON-text path already returns 400 for `{"text": ""}`; audio path behavior was previously undocumented (silent forward to LLM), so the new 400 is consistent rather than disruptive. README + API.md SHALL note the new 400 in the `/ask` section.
- **OpenAI compat clients depending on `verbose_json.segments` always non-empty** → Mitigation: `segments=[]` is OpenAI-spec-valid for silent audio. Clients that crash on empty arrays are violating the OpenAI contract; we match OpenAI's empirical behavior.
- **Filter accidentally drops a long quiet pause that contained a single quiet "Hi"** → Mitigation: this is the duration filter biting; user can lower `FILTER_MIN_DURATION_MS`. The empty-text filter would not affect this case because "Hi" has letters.
- **Logging volume spike when filter fires frequently** → Mitigation: INFO level is appropriate (operators can see it without DEBUG); each line is structured and one per drop. If volume becomes a problem, a follow-up can move to DEBUG. Not pre-optimizing.

## Migration Plan

No data migration. Existing `sessions` and `finals` rows are unaffected (already-stored empty rows stay; the filter is post-process, not retro). No DB schema change. No client-side change required for the PWA (the existing client already handles `text: ""` from `/transcribe` and dropped WS events).

Rollout order (each step independently verifiable):

1. `postprocess.py` module + tests — pure code, no integration impact.
2. `Config` updates + tests — adds fields, no side effects until consumed.
3. Per-surface integration, in any order:
   - `stream.py` / `/listen` (most user-visible).
   - `/transcribe` (downstream of step 1; client already tolerates empty).
   - `/ask` (introduces 400 — update README simultaneously).
   - OpenAI compat (preserves contract; safe last).

Each integration ships independently; pre-step states continue to work because the filter is additive.
