# whisper-wrap Roadmap

Post-v2.1 backlog. Items here are not yet specced — each becomes a `spectra-propose <name>`
when picked up. Order is recommended priority (highest CP at top).

---

## v2.2 — Streaming quality + ecosystem integration

> **silero-vad has been promoted to a Spectra change.** See `openspec/changes/v2-2-silero-vad/` (currently parked).
>
> **OpenAI Whisper API compatibility has been promoted to a Spectra change.** See `openspec/changes/v2-3-openai-compat/` (currently parked).

---

## Considered and deferred

| Item | Why deferred |
| ---- | ------------ |
| **LocalAgreement-2 (N=2 consensus)** | Adds one more inference round-trip before the first partial appears. Conflicts with the v2.1 user feedback that wanted partials faster. May revisit if the simplified N=1 filter shows visible thrashing in practice. |
| **ct-punc Chinese punctuation restoration** (FunASR) | High value — streaming `/listen` final transcripts currently come back without zh punctuation. ~2 days work. Move to v2.3 if the v2.2 items land cleanly. |
| **Multi-format response (SRT / VTT / verbose_json)** | Sub-task of the OpenAI-compat work above; included by virtue of `response_format` support. |
| **Two-pass decoding (streaming Parakeet + Whisper batch final)** | Real big-co architecture but ~2-3 weeks of work + 2× memory footprint. Only justified if this project pivots to live-captioning-first. Tracked for v3.x. |
| **PWA front-end for `/listen`** | Tracked under the v2 PRD as v2.x. The OpenAI-compat work above opens the door to using existing third-party WebUIs as a stop-gap, which may obsolete a custom PWA. |
| **Streaming-native ASR model with Taiwanese Mandarin support** | Does not exist as an open-source model today (WeNet, NeMo, FunASR streaming are all Mandarin / Putonghua oriented). This is the only thing that would break the Whisper-architecture latency plateau. Out of scope unless the community publishes one. |

---

## Process

When picking up an item from this file:

1. `spectra-propose <kebab-case-name>` — opens the change with proposal /
   design / specs / tasks scaffolding.
2. Lift the problem statement, proposed change, and verification notes from
   here into the proposal artifacts.
3. Remove the entry from this file in the same commit that creates the change
   (so the roadmap reflects only NOT-yet-specced work).
