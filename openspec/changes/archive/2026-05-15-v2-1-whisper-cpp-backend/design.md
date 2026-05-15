## Context

v2 shipped a single-process FastAPI server backed by `faster-whisper` (CTranslate2) loaded in-process. CT2 has no Metal, Core ML, or MLX backend — `device=auto` on macOS falls back to CPU regardless of the host's GPU or Neural Engine. Measured behaviour on a Mac mini (Apple Silicon, 8 GB):

- `POST /transcribe` (batch): ~1× real-time (6 s audio ≈ 6–7 s wall clock) — usable for personal scripting.
- `WS /listen` (realtime): partial latency 3–5 s with significant text loss — feature is effectively broken.

VoiceInk on the same hardware reaches 5–7× real-time using Apple Neural Engine (ANE) via Core ML. The bottleneck is the backend, not the algorithm or hardware.

Whisper.cpp via the community Python binding `pywhispercpp` exposes Core ML encoder + GGML decoder paths and supports streaming. Prior whisper.cpp pain in this repo (v1 `examples/server` subprocess crashes) was specifically in the `examples/server` HTTP layer (multipart buffer leak, socket FD exhaustion) — `pywhispercpp` binds directly to `libwhisper` and bypasses that layer entirely. VoiceInk uses the same `libwhisper` core and runs stably 24/7.

A future Linux + CUDA deployment (PVE host with RTX 3070 Ti) is on the long-term roadmap, so removing the CT2 backend would burn a viable path. Both backends must coexist.

v2 has not been released externally — there are no migration constraints on configuration files, registry schema, or environment variables.

## Goals / Non-Goals

**Goals:**

- macOS `WS /listen` partial latency improves by ≥3× vs v2 on identical hardware (measured against a v2 baseline captured on the same Mac mini before merge).
- Both backends (`ct2` and `ggml`) compile, install, and run from the same codebase; the FastAPI lifespan picks one based on the platform and the active registry variant.
- The backend choice is hidden behind a single `WhisperBackend` Protocol; the rest of the codebase (`/transcribe`, `/ask`, `/listen`, stream wrapper, status endpoint) does not branch on backend type.
- Apple Silicon hosts default to ggml + Core ML/ANE with no environment variable changes; Linux hosts default to ct2 with no environment variable changes.
- A streaming-quality improvement (partial-consensus filter) ships in the same change, but in a clearly separable Phase 2 that has its own acceptance criterion.

**Non-Goals:**

- WhisperKit integration. Rejected because every Python integration path (per-request Swift subprocess, long-lived Swift sidecar, PyObjC bridge) reintroduces the dual-process architecture v2 just removed.
- MLX-Whisper backend. Retained only as a fallback option for v2.2+ if `pywhispercpp` is unstable in production; not implemented in v2.1.
- OpenAI Whisper API compatibility (`/v1/audio/transcriptions`). Tracked separately for v2.2+.
- Speaker diarisation, punctuation restoration, multi-format subtitle export. Tracked separately.
- Auto-migration of v2 `.env` or `registry/models.yaml`. v2 is unreleased; users update configuration files manually.
- Thermal-throttling mitigation for sustained ANE load. Observed empirically during stability testing; mitigation deferred unless stability test fails.
- `BACKEND_FORMAT` cross-platform combinations beyond what the variant declares (e.g. ggml on Linux is rejected at startup; ct2 on macOS is allowed as a fallback).

## Decisions

### Decision 1: pywhispercpp over WhisperKit and MLX-Whisper

Adopt `pywhispercpp` as the macOS-default backend. Scored across speed, model availability, Python integration ergonomics, streaming maturity, cross-platform portability, long-term maintenance, and implementation cost, pywhispercpp wins decisively: ggml models already published locally (no conversion work), pure-Python binding (no Swift sidecar), `libwhisper` is the same library VoiceInk uses (stability priors), and the binding's streaming examples align with the existing `stream.py` design.

WhisperKit is faster (+1–2× over pywhispercpp) but only via three integration paths that all reintroduce a 2-process architecture or rely on a niche bridge.

MLX-Whisper is acceptable but requires Breeze model conversion + publishing (1–2 days of work) and has a less mature streaming story.

Minimal pywhispercpp API shape expected by the `PyWhisperCppBackend` wrapper (verified against `pywhispercpp>=1.2` README):

```python
from pywhispercpp.model import Model

m = Model(
    model="/path/to/ggml-breeze-asr-25-q6_k.bin",
    n_threads=4,
    use_coreml=True,           # ANE path; library auto-locates the adjacent .mlmodelc
    language="zh",             # may also be overridden per-call on transcribe()
    print_progress=False,
)
segments = m.transcribe(
    media="/path/to/audio.wav",  # accepts either a path or a numpy.ndarray of float32 mono 16 kHz samples
)
for seg in segments:
    text, t0_ms, t1_ms = seg.text, seg.t0, seg.t1
```

If the upstream API shifts (e.g. `use_coreml` parameter is renamed), the implementer SHALL adjust the wrapper and update this section in the same commit so the contract stays accurate.

### Decision 2: Abstract WhisperBackend Protocol up-front

Introduce `app/services/_whisper_backend.py` defining a Protocol with `transcribe(wav_path, *, language, initial_prompt)`, `transcribe_pcm(samples, *, language)`, and the existing error type contracts (`WhisperLoadError`, `WhisperTranscriptionError`). Rename the existing `app/services/whisper.py` body into `app/services/whisper_ct2.py` and add `app/services/whisper_cpp.py` for the pywhispercpp implementation. `app/services/whisper.py` becomes a thin re-export module so existing callers (`app/api/transcribe.py`, `app/services/stream.py`, `app/api/ask.py`) continue importing from the same path.

Rationale: with two backends shipping at once, branching on backend type inside callers would scatter platform-aware logic across the codebase. Abstracting now also keeps the door open for MLX-Whisper to slot in by adding one file.

### Decision 3: variants schema for `registry/models.yaml`

Replace the flat schema with a per-model `variants` list. Example:

```yaml
breeze-asr-25:
  description: "Breeze ASR 25 Taiwanese Mandarin model"
  languages: [zh, en]
  default: true
  variants:
    - format: ct2
      repo_id: shdennlin/breeze-asr-25-ct2
      compute_type: int8_float16
      local_dir: breeze-asr-25-ct2
      default_on: [linux]
    - format: ggml
      repo_id: shdennlin/breeze-asr-25-ggml
      quant: q6_k
      filename: ggml-breeze-asr-25-q6_k.bin
      coreml_encoder: ggml-breeze-asr-25-encoder.mlmodelc
      local_dir: breeze-asr-25-ggml
      default_on: [darwin]
```

Considered and rejected: two flat entries (`breeze-asr-25-ct2`, `breeze-asr-25-ggml`) — clean schema diff but forces users to think about backend format when picking a model, splits `make models` listings, and has no structured place for platform default rules. The `variants` shape keeps "one model, multiple backings" coherent and gives a structured field (`default_on`) for the platform-routing rule.

### Decision 4: Platform-aware backend selection

Selection precedence at lifespan startup:

1. `MODEL_DIR` env var present → load directly from that path; format inferred from the directory layout (presence of `model.bin` in a ct2-style subdir vs `ggml-*.bin` file).
2. `BACKEND_FORMAT` env var present (one of `ct2` | `ggml`) → pick the variant of the active model with that format. If no matching variant exists, fail startup with a clear error.
3. Otherwise → pick the variant whose `default_on` list contains the current platform tag (`darwin` or `linux`). Multiple matches: pick the first; zero matches: fail startup with a clear error.

ggml on Linux is rejected at startup (pywhispercpp is macOS-only in `pyproject.toml`) — the import will fail, surfaced as `WhisperLoadError("pywhispercpp not available on this platform")`. ct2 on macOS is supported as a fallback when `BACKEND_FORMAT=ct2` is set explicitly.

### Decision 5: Block lifespan on first-run Core ML encoder compile

The first time a Core ML encoder is loaded on a given host, the runtime compiles `.mlmodelc` to ANE-optimised internal format (estimated 10–30 s, validated empirically during implementation). The lifespan SHALL block on this compile and emit one INFO log line per second of elapsed time during the compile, finishing with a single line reporting total compile duration. Subsequent loads use the cached compiled form.

Rationale: lazy compile on first request would push a 10–30 s latency spike onto an arbitrary user request and would conflict with the `/status` contract (`model.loaded=true` always means transcription is fully available).

### Decision 6: Simplified LocalAgreement-2 partial consensus in Phase 2

The stream wrapper currently emits a `partial` event for every sliding-window inference, which produces visible text thrashing while a sentence is being completed. Add a single-step consensus filter: cache the previous inference's transcript; emit a `partial` event only for the longest common prefix between the previous and current transcripts that ends at a word boundary (whitespace or punctuation). When the entire window stabilises across two inferences (LCP equals current transcript) and the in-flight buffer has been quiet for the VAD-final timeout, emit `final`.

This is intentionally simpler than the academic LocalAgreement-2 (which keeps a longer history); the goal is "partial doesn't thrash" not "publish-quality streaming ASR research". The two-inference window is the minimum to validate stability and matches the existing sliding-window inference cadence.

### Decision 7: Phase 1 / Phase 2 boundary inside one change

`tasks.md` is divided into `## Phase 1: Backend Swap` and `## Phase 2: Streaming Quality`. Phase 1 completes when all existing tests pass on macOS via ggml backend and on Linux via ct2 backend; Phase 2 completes when the partial-consensus filter is in place and a captured-audio test shows ≤50% partial-rewrite frequency vs v2.

The phases are sequenced (Phase 1 must complete before Phase 2 starts) because Phase 2 measures latency improvements that include the Phase 1 backend swap.

### Decision 8: Default ggml quantisation: `q6_k`

Among the seven quantisations published in the local Breeze ggml build (`q4_0`, `q4_k`, `q5_0`, `q5_k`, `q6_k`, `q8_0`, `f16`), `q6_k` is chosen as the default for v2.1. Trade-off: ~1.2 GB on disk, ~1.15× speed vs f16, accuracy loss expected <1% (whisper.cpp community benchmarks on other models; not yet measured for Breeze).

A formal Breeze quantisation A/B against `q5_0` and `q8_0` is deferred to v2.1.x — the registry permits overriding the default per-user.

### Decision 9: Test mock refactor to backend Protocol surface

Existing whisper tests mock `faster_whisper.WhisperModel`. With dual backends, these become CT2-specific. Move the shared mocking surface to the `WhisperBackend` Protocol level: tests that exercise behaviour that should hold for any backend (timeout handling, error mapping, async wrapping) mock the Protocol; tests that exercise CT2-specific code (CTranslate2 dtype handling, compute_type negotiation) keep their existing CT2 mock; the new pywhispercpp implementation gets its own test file mocking the `pywhispercpp.model.Model` surface.

### Decision 10: `pywhispercpp` version pinning strategy

Pin `pywhispercpp` to a known-good version range in `pyproject.toml` (`pywhispercpp>=1.2,<2.0; sys_platform == "darwin"`) and rely on `uv.lock` for exact reproducibility. Vendoring is rejected for v2.1 — added complexity outweighs benefit until we see evidence the binding lags upstream `whisper.cpp` in a way that affects us.

## Implementation Contract

#### Behavior

- **macOS, default config**: `MODEL_NAME=breeze-asr-25` resolves to the `ggml` variant; lifespan loads via pywhispercpp + Core ML encoder; `/status` reports `backend: "pywhispercpp"`, `format: "ggml"`, `quant: "q6_k"`. `WS /listen` partial latency drops to ≥3× faster than v2 baseline on same hardware.
- **Linux, default config**: `MODEL_NAME=breeze-asr-25` resolves to the `ct2` variant; lifespan loads via faster-whisper; `/status` reports `backend: "ctranslate2"`, `format: "ct2"`, `compute_type: "int8_float16"`. No behaviour change vs v2.
- **macOS, `BACKEND_FORMAT=ct2`**: lifespan uses the ct2 variant; behaviour matches v2 on macOS.
- **Linux, `BACKEND_FORMAT=ggml`**: lifespan fails to start with `WhisperLoadError("pywhispercpp not available on this platform")`; no transcription is attempted.
- **Phase 2 partial-consensus filter active**: `WS /listen` clients receive fewer `partial` events for the same input audio; final transcript text is unchanged.

#### Interface / data shape

- `WhisperBackend` Protocol exposes: `async transcribe(wav_path: str, *, language: str, initial_prompt: str | None) -> TranscriptionResult`, `async transcribe_pcm(samples: np.ndarray, *, language: str) -> TranscriptionResult`. `TranscriptionResult` is a dataclass with fields `text: str`, `segments: list[Segment]`, `language: str`, `duration_seconds: float`.
- Error types: `WhisperLoadError` raised during backend construction or model load; `WhisperTranscriptionError` raised during inference failures. Both inherit from a common base for callers that want to catch any backend error.
- Registry variant schema: each `variants[]` item is a YAML mapping requiring `format` and `local_dir`; ct2 variants additionally require `compute_type`; ggml variants additionally require `filename` and `coreml_encoder`; all variants accept optional `repo_id`, `revision`, `subfolder`, `default_on`.
- `/status` JSON gains a `backend` object: `{"backend": "pywhispercpp" | "ctranslate2", "format": "ct2" | "ggml", "compute_type"?: string, "quant"?: string, "coreml_encoder_compiled": boolean}`.
- `make download-model MODEL=<name>`: downloads every variant of `<name>`; if any variant download fails, the command exits non-zero with the failing variant identified.

#### Failure modes

- pywhispercpp import fails (not installed, wrong platform): `WhisperLoadError` with clear message naming `pywhispercpp` and the host platform.
- Core ML encoder `.mlmodelc` missing while ggml variant is selected: `WhisperLoadError("Core ML encoder not found at <path>; run `make download-model MODEL=<name>`")`.
- Registry variant has no `default_on` match for current platform and no `BACKEND_FORMAT` is set: startup fails with `RegistryError("No variant of <model> targets <platform>; set BACKEND_FORMAT to choose explicitly")`.
- Both variants of a model are absent on disk: same `make download-model` error as v2.
- Partial-consensus filter starvation (e.g. one-word utterances where two inferences never agree): final event still emits at VAD-final timeout; no `partial` is required to precede `final`.

#### Acceptance criteria

- Unit tests in `tests/test_whisper_cpp.py` cover the pywhispercpp wrapper using a mocked `pywhispercpp.model.Model`; tests in `tests/test_backend_protocol.py` validate that both backends satisfy the Protocol; tests in `tests/test_registry_variants.py` cover variant resolution including platform routing; tests in `tests/test_stream_consensus.py` cover the partial-consensus filter with deterministic synthetic transcripts.
- Phase 1 done: `make test` passes on macOS with the ggml variant selected and on Linux with the ct2 variant selected; `/status` reports the expected backend metadata in both cases.
- Phase 2 done: a captured-audio regression test (10 s Mandarin sample) shows the v2.1 partial-emission count is ≤50% of the v2 baseline captured on the same audio.
- Manual latency check on Mac mini: 30 s Mandarin streaming session shows median partial latency ≥3× faster than the v2 baseline (specific numbers recorded in the change's verification notes; baseline must be captured against the same hardware).

#### Scope boundaries

**In scope:**

- New `whisper-backend` capability and supporting Protocol module.
- ggml backend implementation and platform-aware lifespan dispatch.
- Registry variants schema and matching CLI changes in `scripts/model-manager.sh`.
- Partial-consensus filter inside `app/services/stream.py`.
- Documentation updates in `README.md`, `CLAUDE.md`, `docs/INSTALLATION.md`, `.env.example`.

**Out of scope:**

- VAD threshold tuning, alternative VAD (silero) integration — captured as a separate Phase 2 stretch item if time permits, otherwise v2.2.
- Multi-model lifecycle (loading >1 model in the same process) — current single-model lifespan is preserved.
- `/transcribe` and `/ask` request/response shapes — unchanged.
- Docker image refresh beyond pyproject lock updates — base Dockerfile structure preserved.

## Risks / Trade-offs

- [pywhispercpp is community-maintained, not by ggml-org] → Pin version range in pyproject; track upstream `whisper.cpp` releases in CHANGELOG; if a critical fix lags >2 weeks, evaluate vendoring or switching to MLX fallback.
- [ANE thermal throttling during sustained 24/7 streaming load] → Add a 4-hour `WS /listen` stress test to the verification checklist; if degradation observed, document workarounds (`BACKEND_FORMAT=ct2` failover) without blocking ship.
- [In-process segfault from C binding would take down the FastAPI process] → Accepted trade-off vs v1's 2-process architecture; mitigation is supervisor restart (`restart: unless-stopped` in compose already configured); document the trade-off in CLAUDE.md.
- [First-run Core ML compile blocks startup 10–30 s] → Documented behaviour in `docs/INSTALLATION.md`; lifespan emits a progress log line per second so users see it is making progress, not hung.
- [Breaking registry schema with no migration helper] → Mitigated because v2 has no external users; `.env.example` and README updated; an explicit error message guides users hitting an old-format file.
- [Partial-consensus filter could starve very short utterances of any `partial` event] → Acceptable: `final` still arrives; documented behaviour.
- [Variants schema increases registry YAML complexity for model authors adding their own entries] → Mitigated by providing a complete worked example in `registry/models.yaml` shipped in the repo and documenting the schema in CLAUDE.md.
