# Implementation Tasks — v2.1 Whisper-cpp Backend

Phase 1 (Backend Swap) must complete before Phase 2 (Streaming Quality) starts: Phase 2's regression measurements depend on the Phase 1 backend being live so the baseline-vs-target comparison is meaningful. Task numbering is continuous across phases for unambiguous reference.

## Phase 1: Backend Swap

### 1. Dependencies and platform plumbing

- [x] 1.0 Create `openspec/changes/v2-1-whisper-cpp-backend/verification-notes.md` with three empty H2 sections — `## v2 baseline latency` (target host, capture command, median ms), `## v2.1 measured latency` (same host, same capture, median ms, ratio vs baseline), and `## Partial-emission regression ratio` (filter-disabled count, filter-active count, ratio) — so the manual verification tasks 14.1, 14.2, and 13.3 have a destination file to write into; verify by `ls openspec/changes/v2-1-whisper-cpp-backend/verification-notes.md` and content review confirming the three H2 headings exist with no body content yet.
- [x] 1.1 [P] Add `pywhispercpp>=1.2,<2.0; sys_platform == "darwin"` to `pyproject.toml` so Decision 10: `pywhispercpp` version pinning strategy is satisfied; verify by running `uv sync` on macOS (pywhispercpp installs) and on Linux (pywhispercpp absent from the resolved environment), and by confirming `uv pip list` output differs across the two platforms.
- [x] 1.2 [P] Document the macOS Core ML build flag and the new `BACKEND_FORMAT` env var in `docs/INSTALLATION.md` and `.env.example`; verify by content review against the Implementation Contract "Interface / data shape" section of design.md (both files must name `BACKEND_FORMAT`, list its accepted values `ct2`/`ggml`, and describe the Core ML first-run compile behaviour).

### 2. WhisperBackend Protocol (TDD)

- [x] 2.1 Write failing test `tests/test_backend_protocol.py::test_protocol_surface` that asserts the `WhisperBackend` Protocol declares `transcribe`, `transcribe_pcm`, `WhisperLoadError`, `WhisperTranscriptionError`, and a common `WhisperBackendError` base — covering Decision 2: Abstract WhisperBackend Protocol up-front; verify the test runs and fails because the module does not yet exist.
- [x] 2.2 Implement `app/services/_whisper_backend.py` exposing the Pluggable WhisperBackend Protocol per the spec; verify by running `tests/test_backend_protocol.py::test_protocol_surface` to green and by importing the module via `python -c "from app.services._whisper_backend import WhisperBackend, WhisperBackendError"`.
- [x] 2.3 Write failing test `tests/test_backend_protocol.py::test_transcription_result_shape` asserting `TranscriptionResult` carries `text`, `segments`, `language`, `duration_seconds` and that `Segment` carries `text`, `start`, `end`; verify the test fails with the dataclasses unimplemented.
- [x] 2.4 Implement `TranscriptionResult` and `Segment` dataclasses inside `app/services/_whisper_backend.py`; verify by running `tests/test_backend_protocol.py::test_transcription_result_shape` to green.

### 3. CTranslate2 backend rename and adaptation (TDD)

- [x] 3.1 Write failing test `tests/test_whisper_ct2.py::test_satisfies_protocol` (moved/renamed from existing `tests/test_whisper.py` per Decision 9: Test mock refactor to backend Protocol surface) asserting that `CTranslate2Backend` constructs against a fake CT2 directory layout and satisfies the WhisperBackend Protocol — covering the CTranslate2 backend implementation requirement; verify the test fails because the class does not exist yet.
- [x] 3.2 Implement `app/services/whisper_ct2.py` containing `CTranslate2Backend` by moving the existing `faster_whisper.WhisperModel` wrapping logic out of `app/services/whisper.py`; verify by running `tests/test_whisper_ct2.py` to green and by ensuring `pytest tests/test_whisper.py` no longer exists or is empty.
- [x] 3.3 Write failing test `tests/test_whisper_ct2.py::test_raises_whisper_load_error_on_missing_model` asserting `CTranslate2Backend` raises `WhisperLoadError` when `model.bin` is absent; verify it fails until the error mapping is in place.
- [x] 3.4 Map `faster_whisper`/CT2 exceptions to `WhisperLoadError`/`WhisperTranscriptionError` inside `CTranslate2Backend`; verify by running `tests/test_whisper_ct2.py::test_raises_whisper_load_error_on_missing_model` to green.

### 4. pywhispercpp backend implementation (TDD)

- [x] 4.1 Write failing test `tests/test_whisper_cpp.py::test_satisfies_protocol` that mocks `pywhispercpp.model.Model` and asserts the pywhispercpp backend implementation satisfies the WhisperBackend Protocol on macOS; verify the test fails because `app/services/whisper_cpp.py` does not exist.
- [x] 4.2 Implement `app/services/whisper_cpp.py` containing `PyWhisperCppBackend` per spec, including async wrapping via `asyncio.to_thread`; verify by running `tests/test_whisper_cpp.py::test_satisfies_protocol` to green on macOS and by `python -c "from app.services.whisper_cpp import PyWhisperCppBackend"` succeeding on macOS.
- [x] 4.3 Write failing test `tests/test_whisper_cpp.py::test_raises_load_error_when_coreml_encoder_missing` asserting `PyWhisperCppBackend` raises `WhisperLoadError` with a message naming the missing `.mlmodelc` path; verify the test fails until the existence check is added.
- [x] 4.4 Add the Core ML encoder existence check inside `PyWhisperCppBackend.__init__`; verify by running `tests/test_whisper_cpp.py::test_raises_load_error_when_coreml_encoder_missing` to green and by confirming the error message includes the suggestion `make download-model MODEL=<name>`.
- [x] 4.5 Write failing test `tests/test_whisper_cpp.py::test_import_raises_on_linux` (skipped on macOS) asserting that importing `app.services.whisper_cpp` on Linux raises `WhisperLoadError("pywhispercpp is not available on linux")`; verify the test fails when run on a Linux CI environment until guard logic exists.
- [x] 4.6 Add platform guard so importing `app.services.whisper_cpp` on non-macOS raises `WhisperLoadError` instead of a raw `ImportError`; verify by running `tests/test_whisper_cpp.py::test_import_raises_on_linux` to green on Linux.

### 5. Registry variants schema (TDD)

- [x] 5.1 Write failing test `tests/test_registry_variants.py::test_parses_two_variant_entry` that loads a YAML fixture containing the Registry file format described in `model-registry` (one model with both ct2 and ggml variants) and asserts the resolver returns both variants with their format-specific fields populated — covering Decision 3: variants schema for `registry/models.yaml`; verify the test fails before resolver changes.
- [x] 5.2 Refactor `app/services/registry.py` so the parser understands the per-variant `format` discriminator and the optional `default_on` field; verify by running `tests/test_registry_variants.py::test_parses_two_variant_entry` to green.
- [x] 5.3 Write failing tests `tests/test_registry_variants.py::test_rejects_empty_variants_list`, `tests/test_registry_variants.py::test_rejects_ct2_without_compute_type`, `tests/test_registry_variants.py::test_rejects_ggml_without_coreml_encoder`, and `tests/test_registry_variants.py::test_rejects_unknown_format` asserting the loader rejects malformed variant entries with errors naming the offending entry and variant index; verify each test fails before validation is added.
- [x] 5.4 Implement variant validation rules from the Registry file format requirement so the four failing tests above pass; verify with `pytest tests/test_registry_variants.py -k "rejects"`.
- [x] 5.5 Replace the shipped `registry/models.yaml` so the Built-in model entries requirement holds: `breeze-asr-25` declares both a ct2 variant (`default_on: [linux]`) and a ggml variant (`quant: q6_k`, `default_on: [darwin]`) — covering Decision 8: Default ggml quantisation: `q6_k`; `large-v3-turbo` declares one ct2 variant; verify by running `tests/test_registry_variants.py::test_built_in_entries` (new test asserting the shipped file matches the spec example) to green.
- [x] 5.6 Write failing tests `tests/test_registry_variants.py::test_user_extensible_single_variant` and `tests/test_registry_variants.py::test_user_extensible_multi_variant` asserting that user-added entries are surfaced identically to built-ins by `app/services/registry.py` — covering the Registry is user-extensible requirement; verify each fails before resolver changes and passes after.

### 6. Platform-aware backend selection (TDD)

- [x] 6.1 Write failing test `tests/test_registry_variants.py::test_variant_resolution_darwin_default` asserting that on darwin with no `BACKEND_FORMAT` and `MODEL_NAME=breeze-asr-25`, the resolver returns the ggml variant — covering Decision 4: Platform-aware backend selection and the "Lifespan selects backend based on resolved variant format" requirement; verify the test fails before resolver logic exists.
- [x] 6.2 Implement platform `default_on` matching in `app/services/registry.py` and document the precedence (MODEL_DIR → BACKEND_FORMAT → default_on); verify by running `tests/test_registry_variants.py::test_variant_resolution_*` to green for darwin and linux fixtures.
- [x] 6.3 Write failing tests `tests/test_registry_variants.py::test_variant_resolution_backend_format_override`, `tests/test_registry_variants.py::test_variant_resolution_no_match_fails`, and `tests/test_registry_variants.py::test_variant_resolution_ggml_on_linux_fails` covering the variant-resolution decision table from the whisper-backend spec; verify each fails until the resolver enforces them.
- [x] 6.4 Implement the failure-path error messages so `BACKEND_FORMAT=ggml` on Linux fails fast and "no `default_on` match" surfaces the suggested `BACKEND_FORMAT` hint; verify by running the three failing tests above to green.

### 7. Lifespan integration and /status backend metadata (TDD)

- [x] 7.1 Write failing test `tests/test_lifespan_integration.py::test_macos_default_loads_pywhispercpp` (skipped on Linux) asserting that the lifespan instantiates `PyWhisperCppBackend` for `MODEL_NAME=breeze-asr-25` and exposes the active backend instance via `app.state.whisper` — covering the "Lifespan selects backend based on resolved variant format" requirement; verify the test fails before lifespan refactor.
- [x] 7.2 Refactor `app/main.py` lifespan to instantiate the resolved backend via the WhisperBackend Protocol and store it on `app.state.whisper`; verify by running `tests/test_lifespan_integration.py::test_macos_default_loads_pywhispercpp` (macOS) and `tests/test_lifespan_integration.py::test_linux_default_loads_ctranslate2` (Linux) to green.
- [x] 7.3 Update `app/services/whisper.py` to be a thin re-export module (`from app.services._whisper_backend import WhisperBackend, WhisperLoadError, WhisperTranscriptionError`) so existing callers (`app/api/transcribe.py`, `app/api/ask.py`, `app/services/stream.py`) keep their import paths; verify by running `make test` and confirming no caller imports `whisper_ct2` or `whisper_cpp` directly (`grep -rn "from app.services.whisper_ct2\|from app.services.whisper_cpp" app/` returns only those two implementation files themselves).
- [x] 7.4 Write failing test `tests/test_status.py::test_status_includes_backend_block` asserting the `/status` JSON contains the `backend` object documented in the "/status surfaces backend metadata" requirement; verify the test fails before the response shape change.
- [x] 7.5 Extend `app/api/status.py` to populate the `backend` field with `backend`, `format`, `compute_type` (ct2 only), `quant` (ggml only), `coreml_encoder_compiled` (ggml only); verify by running `tests/test_status.py::test_status_includes_backend_block` to green and by hitting a running server with `curl http://localhost:8000/status | jq .backend` on both backends.

### 8. Core ML first-run compile lifecycle (TDD)

- [x] 8.1 Write failing test `tests/test_whisper_cpp.py::test_compile_emits_per_second_progress` (skipped on Linux) using a fake slow encoder load that takes ≥3 s, asserting at least three INFO log lines naming the encoder path and elapsed seconds are emitted, plus one final "compile complete in Ns" line — covering Decision 5: Block lifespan on first-run Core ML encoder compile; verify the test fails until the progress-logging coroutine is added.
- [x] 8.2 Implement the per-second progress logger inside `PyWhisperCppBackend.__init__` so the "First-run Core ML encoder compile blocks lifespan" requirement holds; verify by running `tests/test_whisper_cpp.py::test_compile_emits_per_second_progress` to green and by manually starting the server against a freshly downloaded ggml variant on macOS to observe the logs.
- [ ] 8.3 Validate empirically that the cached `.mlmodelc` skip path holds: start the server twice on the same host and capture both startup durations; verify the second start completes within the existing CT2 model-load time budget (no per-second compile logs).

### 9. Model manager CLI for variants

- [x] 9.1 Refactor `scripts/model-manager.sh` so `make download-model MODEL=<name>` iterates over the entry's variants and fetches each with `huggingface-cli download` plus optional `--revision`/`--include` flags — covering the Download model by name requirement; verify with `tests/test_model_manager.py::test_download_fetches_all_variants` (mock-shell unit test) and by manually running `make download-model MODEL=breeze-asr-25` and confirming both `models/breeze-asr-25-ct2` and `models/breeze-asr-25-ggml` (with `.mlmodelc`) materialise.
- [x] 9.2 Update `make models` listing logic so each variant is shown on its own sub-line with format/identifier/install-status, and the active model and active variant are visually distinguished — covering the List models command requirement; verify with `tests/test_model_manager.py::test_list_shows_variants` (snapshot-style assertion) and by inspecting `make models` output manually.
- [x] 9.3 Update `make set-model` so it accepts a model whose only requirement is "at least one variant installed" and refuses otherwise — covering the Set active model requirement; verify with `tests/test_model_manager.py::test_set_model_requires_at_least_one_variant` (mock both states).
- [x] 9.4 Update `make delete-model` so it removes every variant's `local_dir` for the named model and refuses to delete the active model — covering the Delete model requirement; verify with `tests/test_model_manager.py::test_delete_removes_all_variants` and `test_delete_refuses_active`.

### 10. Cleanup of v1 warning shim

- [x] 10.1 Remove the v1-deprecated environment variable warning code from `app/config.py` so the "Server warns about obsolete v1 environment variables" requirement is REMOVED per the model-management delta; verify by running `pytest tests/test_config.py::test_no_v1_warning_emitted` (new test that sets all seven v1 vars and asserts log output is silent for them) to green and by `grep -n "WHISPER_SERVER_HOST\|WHISPER_BINARY_PATH\|MODEL_PATH" app/config.py` returning no matches.

### 11. Active-model resolution behaviour

- [x] 11.1 Write failing tests `tests/test_lifespan_integration.py::test_model_dir_override_ggml` and `tests/test_lifespan_integration.py::test_model_dir_override_ct2` asserting that `MODEL_DIR` short-circuits the registry and selects the correct backend by inspecting the directory layout — covering the "Lifespan selects backend based on resolved variant format" requirement (MODEL_DIR precedence rule); verify each fails before override logic exists.
- [x] 11.2 Implement `MODEL_DIR` layout inspection inside the lifespan startup path so the two failing tests pass; verify by running both tests to green.
- [x] 11.3 Write failing test `tests/test_lifespan_integration.py::test_default_model_fallback_with_no_installed_variant` asserting the lifespan exits with a clear error directing the user to `make download-model MODEL=breeze-asr-25` when no variant of the default model is installed; verify the test fails until the diagnostic is added and then passes.

### Phase 1 done criterion

- [ ] 11.4 Run `make test && make lint` on macOS with the ggml variant of `breeze-asr-25` installed and on Linux with the ct2 variant of `breeze-asr-25` installed; verify both runs complete green and that `/status` on each platform reports the expected backend metadata per the "/status surfaces backend metadata" requirement.

## Phase 2: Streaming Quality

### 12. Partial-consensus filter (TDD)

- [x] 12.1 Write failing test `tests/test_stream_consensus.py::test_two_stable_inferences_emit_partial` injecting two consecutive synthetic transcripts "今天" and "今天天氣" into the stream wrapper and asserting one `partial` event with `text="今天"` is emitted — covering the "Partial-consensus filter stabilises partial emissions" requirement and Decision 6: Simplified LocalAgreement-2 partial consensus in Phase 2; verify the test fails before consensus logic exists.
- [x] 12.2 Write failing tests `tests/test_stream_consensus.py::test_unstable_emissions_suppressed`, `tests/test_stream_consensus.py::test_idempotent_partial_suppressed`, and `tests/test_stream_consensus.py::test_final_still_emitted_with_no_partial` covering the remaining scenarios from the "Partial-consensus filter stabilises partial emissions" requirement (no LCP at word boundary → no emission; same prefix as last partial → no emission; single-inference utterance → final still arrives); verify each fails before consensus logic exists.
- [x] 12.3 Implement the LCP + word-boundary truncation + dedup state inside `app/services/stream.py`'s sliding-window inference loop; verify by running all `tests/test_stream_consensus.py::test_*` tests to green.
- [x] 12.4 Add an LCP-truncation unit table test `tests/test_stream_consensus.py::test_lcp_truncation_table` driven by the example table in the transcribe-stream spec (covering mixed-language transcripts including "Hello wor" → "Hello"); verify the table passes for every row.

### 13. Partial-emission rate regression

- [ ] 13.1 Capture a 10 s Mandarin PCM fixture at `tests/fixtures/streaming/mandarin_10s.pcm` by synthesising 10 s of Mandarin speech with the macOS built-in TTS (`say -v Mei-Jia '今天天氣很好，我們一起去公園走走，順便買杯咖啡。' -o /tmp/sample.aiff`) and converting to 16 kHz mono `pcm_s16le` (`ffmpeg -i /tmp/sample.aiff -ar 16000 -ac 1 -f s16le tests/fixtures/streaming/mandarin_10s.pcm`); if the synthesised duration deviates from 10 s ±0.5 s, repeat with a longer/shorter prompt. Verify the resulting fixture is exactly `320000 bytes` (`10s × 16000Hz × 2 bytes`) and audible via `ffplay -f s16le -ar 16000 -ac 1 tests/fixtures/streaming/mandarin_10s.pcm`.
- [ ] 13.2 Write `tests/test_stream_consensus.py::test_partial_count_ratio_le_half` that replays the fixture through the stream wrapper twice — once with the consensus filter active, once with it disabled via a feature flag — and asserts the active-count ÷ disabled-count ratio is ≤0.5 — covering the "Partial-consensus filter reduces emission rate" requirement; verify the test fails until the filter is enabled by default and the ratio holds.
- [ ] 13.3 Run the regression test and record the actual ratio in a comment inside the test (e.g. `# actual: 0.39 on commit abc123`); verify the recorded ratio is ≤0.5.

### 14. Real-hardware latency check (manual verification)

- [ ] 14.1 Record a v2 baseline manually on the target Mac mini by checking out `feat/v2-server-redesign`, starting the server, streaming 30 s of Mandarin through `WS /listen`, and capturing median partial latency (timestamp diff between PCM-frame submission and corresponding `partial` event); verify by storing the result in `openspec/changes/v2-1-whisper-cpp-backend/verification-notes.md` with the host model identifier and the measured median.
- [ ] 14.2 Repeat the latency capture on the same Mac mini with v2.1 head (ggml variant active); verify by storing the v2.1 measured median next to the v2 baseline in `verification-notes.md` and confirming v2.1 ≤ v2/3 (i.e. ≥3× improvement) per the proposal's success criterion.

### 15. Documentation finalisation

- [x] 15.1 [P] Update `README.md` to describe the new dual-backend story (macOS uses ggml + ANE by default; Linux uses ct2; `BACKEND_FORMAT` overrides) — referencing Decision 1: pywhispercpp over WhisperKit and MLX-Whisper; verify by content review against the design.md Goals section.
- [x] 15.2 [P] Update `CLAUDE.md` development guidance with the new variants schema (referencing Decision 3) and Phase 1/Phase 2 development workflow (referencing Decision 7: Phase 1 / Phase 2 boundary inside one change); verify by content review and by confirming the file's "Configuration" section lists `BACKEND_FORMAT`.

### Phase 2 done criterion

- [ ] 15.3 Run `make test && make lint` on macOS with v2.1 head; verify all tests pass including `tests/test_stream_consensus.py::test_partial_count_ratio_le_half` and that `verification-notes.md` documents both the regression ratio and the manual latency ≥3× improvement, satisfying the proposal's success criteria.
