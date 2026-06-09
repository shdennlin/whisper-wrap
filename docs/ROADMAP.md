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

## Strategic direction: desktop app pivot (post-v2.x)

**Not yet committed.** Captured here as the outcome of the 2026-06-09
positioning discussion so the strategic frame survives across sessions.
Promote to a Spectra change only after the validation gates below pass.

### Problem this addresses

Today whisper-wrap assumes the user has an always-on server they can
self-host on. That filters out ~97% of would-be users before they ever read
the README. The model-running hardware barrier (Apple Silicon / NVIDIA GPU)
is far weaker than the "operate a server" barrier — most people who could
run Whisper locally already own the hardware; they just don't own a homelab.

### Persona shift

- **Before**: engineers who self-host (~3% TAM).
- **After**: prosumers with a capable Mac (M-series, ANE) or Windows +
  NVIDIA GPU (~36% TAM — creators, researchers, knowledge workers,
  privacy-conscious power users).

### Form factor

Tauri-based desktop app, embedded FastAPI sidecar, the existing PWA frontend
reused as the Tauri window content. Menu-bar dictation (VoiceInk-shaped
surface) is the primary entry point; meeting / Q&A / live-captioning are
secondary windows under the same icon. Server stays at `127.0.0.1:8000` —
"server" becomes an implementation detail, not a deployment task.

### Phased rollout

1. **Phase 1** (~3-4 mo) — menu-bar dictation + simple
   "open file → transcribe" window. Differentiates from VoiceInk by hinting
   at the superset features without shipping them yet.
2. **Phase 2** (~3 mo) — meeting mode UI inside the app
   (speaker-coloured transcript, click-to-seek, exports). This is where
   whisper-wrap pulls away from VoiceInk / Superwhisper / MacWhisper.
3. **Phase 3** (~3 mo) — Windows port. The CT2 + CUDA backend path
   already exists in code; needs platform testing, Tauri Windows build,
   NVIDIA driver detection.

### Open decisions still to make

- **Tech stack**: Tauri (likely) vs Swift-native (macOS-only) vs Electron.
- **Repo structure**: monorepo (`apps/desktop/`) vs separate engine + GUI repos.
- **Product naming**: "whisper-wrap" works for the engine but is too
  engineering-coded for a consumer app — pick a name closer to launch.
- **License posture**: MIT covers code but does not prevent SaaS forks; if
  a commercial desktop product ships, decide between staying MIT
  (engine) + proprietary (app bundle), AGPL-3.0, FSL, or BSL. See the
  separate license discussion log if/when it's recorded.

### Validation gates (before committing engineering time)

1. **Tauri + PWA + Python sidecar prototype** (~1 day) — proves the
   technical assumption that the existing `frontend/` reuses cleanly
   inside Tauri and the FastAPI sidecar starts/stops reliably.
2. **User interviews** (~5 sessions) — three target users (e.g. a
   podcaster, a researcher, a privacy-conscious knowledge worker).
   Question the *current* pain ("how do you transcribe today?"), not
   the *proposed solution*. Kill the pivot if their pain doesn't map.

---

## Process

When picking up an item from this file:

1. `spectra-propose <kebab-case-name>` — opens the change with proposal /
   design / specs / tasks scaffolding.
2. Lift the problem statement, proposed change, and verification notes from
   here into the proposal artifacts.
3. Remove the entry from this file in the same commit that creates the change
   (so the roadmap reflects only NOT-yet-specced work).
