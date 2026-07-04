export interface paths {
    "/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["discovery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["actions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["ask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/aux-models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["aux_models_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/aux-models/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start (or report an already-running) download. Returns immediately; poll
         *     GET /aux-models/download/{id}.
         */
        post: operations["aux_models_download"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/aux-models/download/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["aux_models_download_status"];
        put?: never;
        post?: never;
        /**
         * Cancel an in-flight aux download (mirror of models::cancel_download, keyed
         *     by aux id). The worker notices the flag between chunks.
         */
        delete: operations["aux_models_cancel_download"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/aux-models/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Uninstall an aux model (delete its ONNX file from disk). */
        delete: operations["aux_models_delete_model"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/config/ai": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** `GET /config/ai` — masked read of the active config. */
        get: operations["get_config"];
        /**
         * `PUT /config/ai` — validate, save, swap the live client, return the masked
         *     view. Invalid provider -> 400. Empty `apiKey` keeps the stored key.
         */
        put: operations["put_config"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/config/ai/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * `GET /config/ai/models` — list provider models using the SUBMITTED
         *     provider/base-url/key. Any fetch failure -> 200 with `models: []` + a
         *     non-null `error` (never a 5xx).
         */
        get: operations["list_models"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/config/ai/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * `POST /config/ai/test` — build a transient client from the submitted body,
         *     do one minimal non-streaming `ask`, report `{ ok, error }`. Never persists.
         */
        post: operations["test_config"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/config/dictionary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** `GET /config/dictionary` — the current effective dictionary config. */
        get: operations["get_dictionary"];
        /** `PUT /config/dictionary` — validate, persist, return the stored config. */
        put: operations["put_dictionary"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items/{id}/ai": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * `POST /items/{id}/ai?model=` — run a prompt over the item's transcript (D5).
         *     Hard DAG gate: the item must exist (404) and have a transcript (409); the
         *     LLM must be configured (503). `?model=` is recorded but does not switch the
         *     LLM until llm-provider-abstraction.
         */
        post: operations["items_ai"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items/{id}/diarize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * `POST /items/{id}/diarize?quality=` — diarize the item's stored audio (D4).
         *     When the item has a transcript the diarization is merged into
         *     speaker-attributed segments; otherwise the raw speaker turns are recorded.
         */
        post: operations["items_diarize"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * `GET /items/{id}/runs` — every run recorded against an item (oldest first),
         *     each with its job-status contract + result snapshot. The run inspector
         *     (fe-item-detail-runs) reads this to show the re-runnable pipeline history.
         *     An item with no runs returns an empty list (not a 404).
         */
        get: operations["list_item_runs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items/{id}/transcribe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * `POST /items/{id}/transcribe?model=` — transcribe the item's stored audio on
         *     the chosen model, snapshotting the transcript into a transcribe run (D3).
         */
        post: operations["items_transcribe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/listen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description WebSocket endpoint for live captioning. The client performs a WebSocket upgrade, then streams 16 kHz mono `pcm_s16le` audio as binary frames. The server emits JSON text messages: `{"type":"partial"|"final","text","start_ms","end_ms"}`, `{"type":"warning","message":...}`, or `{"type":"error","message":...}` followed by close code 1003. OpenAPI 3.1 cannot model the bidirectional frame protocol, so this entry is descriptive only and declares no request or response body schema. */
        get: operations["listen"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/models/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["set_active"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/models/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start (or report an already-running) download of a model's ggml
         *     weights. Returns immediately; poll GET /models/download/{name}.
         */
        post: operations["download"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/models/download/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["download_status"];
        put?: never;
        post?: never;
        /**
         * Request cancellation of an in-flight download. The worker notices the
         *     flag between chunks, removes the partial file, then flips the job to
         *     "cancelled" — poll GET /models/download/{name} to observe it land.
         */
        delete: operations["cancel_download"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/models/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Uninstall a model's on-disk weights (the "D" in model CRUD). Refuses to
         *     remove the currently-loaded model — switch away first.
         */
        delete: operations["delete_model"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * `GET /runs/{id}` (D5): the job-status contract for any run, served from the
         *     persisted row — so it answers correctly after a restart, when no in-memory
         *     job remains. An unknown id is a 404 with the standard error envelope.
         */
        get: operations["get_run"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transcribe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["transcribe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transcribe/meeting": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transcribe/meeting/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["poll"];
        put?: never;
        post?: never;
        delete: operations["cancel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/audio/transcriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["transcriptions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/audio/translations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["translations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/meetings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list_meetings"];
        put?: never;
        post: operations["create_meeting"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/meetings/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_meeting"];
        put?: never;
        post?: never;
        delete: operations["delete_meeting"];
        options?: never;
        head?: never;
        patch: operations["patch_meeting"];
        trace?: never;
    };
    "/v1/meetings/{id}/audio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["stream_meeting_audio"];
        put?: never;
        post: operations["upload_meeting_audio"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["openai_models"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list_sessions"];
        put?: never;
        post: operations["create_session"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/audio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["bulk_clear_audio"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * `GET /v1/sessions/events` — Server-Sent Events stream (live-library-push).
         * @description Server-Sent Events stream of session-list changes. On connect the server emits a `ready` event, then a `changed` event whenever any session is created, updated, or deleted; comment heartbeats keep idle connections alive. Clients re-fetch `GET /v1/sessions` on each `changed`.
         */
        get: operations["stream_session_events"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_session"];
        put?: never;
        post?: never;
        delete: operations["delete_session"];
        options?: never;
        head?: never;
        patch: operations["patch_session"];
        trace?: never;
    };
    "/v1/sessions/{id}/audio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["stream_session_audio"];
        put?: never;
        post: operations["upload_session_audio"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/finals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["append_final"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description Success body of `GET /actions` — the prompt-action registry.
         *
         *     `actions` and `categories` are kept as `Vec<serde_json::Value>` because
         *     their element types (`whisper_wrap_core::actions::Action` / `Category`)
         *     implement `Serialize` but not `ToSchema` and live in the core crate; typing
         *     them here would require touching core, so the element shape is preserved
         *     without over-typing.
         */
        ActionsResponse: {
            actions: unknown[];
            categories: unknown[];
        };
        AiBody: {
            prompt: string;
        };
        /** @description Update body for `PUT /config/ai`. camelCase on the wire. */
        AiConfigUpdate: {
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            provider: string;
            systemPrompt?: string | null;
        };
        /** @description The masked, read-safe view of the active config. Wire shape is camelCase. */
        AiConfigView: {
            baseUrl: string;
            keyHint: string;
            keySet: boolean;
            model: string;
            provider: string;
            systemPromptSet: boolean;
        };
        /**
         * @description Connectivity-test result for `POST /config/ai/test`. Wire shape is
         *     `{ "ok": bool, "error": string | null }`: `error` is always present and is
         *     `null` on success, so it is a plain `Option<String>` (emitted as `null`, not
         *     omitted) to match today's `json!()` output byte-for-byte.
         */
        AiTestResult: {
            error?: string | null;
            ok: boolean;
        };
        /**
         * @description The `{ "detail": string }` body every [`ApiError`] serializes to. `ApiError`
         *     itself is private and only implements `IntoResponse`, so it cannot derive
         *     `ToSchema`; this is the single reusable schema every fallible operation
         *     references for its non-200 error responses (rather than re-inlining the
         *     shape per handler).
         */
        ApiErrorBody: {
            /**
             * @description Human-readable error description.
             * @example Unsupported Content-Type: text/plain
             */
            detail: string;
        };
        /**
         * @description Non-streaming answer body of `POST /ask` (`stream=false`). `transcript`
         *     is the STT text for audio input and `null` for a text question — the key
         *     is always present, never omitted. The streaming (`stream=true`) branch is
         *     an SSE `text/event-stream` and is not described by this type.
         */
        AskResponse: {
            /** @description The LLM's answer to the question. */
            answer: string;
            /** @description Transcript of the audio input, or `null` when the question was text. */
            transcript?: string | null;
        };
        /**
         * @description Shared body of `POST /v1/{sessions,meetings}/{id}/audio`: the stored blob's
         *     path, size, and mime. Both upload handlers emit the same three keys.
         */
        AudioUploadResponse: {
            audio_mime_type: string;
            audio_path: string;
            /** Format: int64 */
            audio_size_bytes: number;
        };
        /**
         * @description `DELETE /aux-models/download/{id}` acknowledgement: the aux id and the
         *     resulting download `status` — `"cancelling"` when a live download was asked
         *     to stop, otherwise the job's current (terminal) status.
         */
        AuxCancelDownloadResponse: {
            id: string;
            status: string;
        };
        /**
         * @description `DELETE /aux-models/{id}` acknowledgement: the removed id and a constant
         *     `removed: true` flag.
         */
        AuxDeleteModelResponse: {
            id: string;
            removed: boolean;
        };
        AuxDownloadRequest: {
            id: string;
        };
        /**
         * @description `POST /aux-models/download` success body. Mirrors `models::DownloadResponse`
         *     but keyed by `id`: two states share the `id` + `status` discriminant — a
         *     `status = "done"` response carries `already_present: true`, a
         *     `status = "downloading"` response omits `already_present`.
         */
        AuxDownloadResponse: {
            already_present?: boolean | null;
            id: string;
            status: string;
        };
        /**
         * @description `GET /aux-models/download/{id}` progress body. Mirrors
         *     `models::DownloadStatusResponse` but keyed by `id`: two disjoint wire shapes
         *     → an untagged enum (utoipa emits a `oneOf`) so `installed` never mixes with
         *     the progress byte-counters.
         *
         *     - [`Installed`](Self::Installed) — weights on disk (`status = "done"`,
         *       `installed = true`) or nothing happening (`status = "idle"`,
         *       `installed = false`).
         *     - [`Progress`](Self::Progress) — a job's byte counters; `total_bytes` and
         *       `error` are emitted as `null` when unknown (never omitted).
         */
        AuxDownloadStatusResponse: {
            id: string;
            installed: boolean;
            status: string;
        } | {
            /** Format: int64 */
            downloaded_bytes: number;
            error?: string | null;
            id: string;
            status: string;
            /** Format: int64 */
            total_bytes?: number | null;
        };
        /**
         * @description `GET /aux-models` success body: the fixed auxiliary-model catalogue with
         *     per-entry install state.
         */
        AuxListResponse: {
            models: components["schemas"]["AuxModelEntry"][];
        };
        /**
         * @description One row of `GET /aux-models` — a catalogue entry plus its on-disk install
         *     state. Keys and types mirror the prior ad-hoc JSON exactly.
         */
        AuxModelEntry: {
            id: string;
            installed: boolean;
            recommended: boolean;
            required: boolean;
            /** Format: int64 */
            size_bytes: number;
            stage: string;
        };
        /** @description Body of `DELETE /v1/sessions/audio`: how many stored blobs were removed. */
        BulkClearAudioResponse: {
            /** Format: int64 */
            deleted_count: number;
        };
        /**
         * @description `DELETE /models/download/{name}` acknowledgement: the model name and the
         *     resulting download `status` — `"cancelling"` when a live download was asked
         *     to stop, otherwise the job's current (terminal) status.
         */
        CancelDownloadResponse: {
            name: string;
            status: string;
        };
        /** @description 202 acknowledgement returned by `DELETE /transcribe/meeting/{id}`. */
        CancelResponse: {
            /** @description Id of the job whose cancellation was requested. */
            job_id: string;
            /** @description Advisory note about cancellation latency. */
            note: string;
            /** @description Always `"cancel_requested"`. */
            status: string;
        };
        /**
         * @description `DELETE /models/{name}` acknowledgement: the removed model name and a
         *     constant `removed: true` flag.
         */
        DeleteModelResponse: {
            name: string;
            removed: boolean;
        };
        /**
         * @description The on-disk document AND the wire shape of both endpoints (they are
         *     identical by design — no secrets to mask here).
         */
        DictionaryConfig: {
            replacements?: components["schemas"]["ReplacementPair"][];
            zh_convert?: components["schemas"]["ZhConvertSetting"];
        };
        /**
         * @description Success body of `GET /` — the hand-maintained API discovery document.
         *
         *     The wire shape is an object `{ "endpoints": [...] }`, so this is typed as a
         *     named object with an `endpoints` array property (NOT a top-level array — the
         *     live handler wraps the list under `endpoints`, and the wire shape is
         *     preserved byte-for-byte).
         */
        DiscoveryResponse: {
            endpoints: components["schemas"]["EndpointDescriptor"][];
        };
        DownloadRequest: {
            name: string;
        };
        /**
         * @description `POST /models/download` success body. Two states share the `name` + `status`
         *     discriminant: a `status = "done"` response carries `already_present: true`
         *     (weights already on disk, nothing queued); a `status = "downloading"`
         *     response omits `already_present`. `already_present` is emitted **only** in
         *     the done state, exactly as the prior ad-hoc JSON did.
         */
        DownloadResponse: {
            already_present?: boolean | null;
            name: string;
            status: string;
        };
        /**
         * @description `GET /models/download/{name}` progress body. Two genuinely-disjoint wire
         *     shapes → an untagged enum (utoipa emits a `oneOf`), so the schema can never
         *     mix the `installed` flag with the progress byte-counters:
         *
         *     - [`Installed`](Self::Installed) — no live job drives progress: either the
         *       weights are on disk (`status = "done"`, `installed = true`) or nothing is
         *       happening (`status = "idle"`, `installed = false`).
         *     - [`Progress`](Self::Progress) — a live or terminal job's counters;
         *       `total_bytes` and `error` are emitted as `null` when unknown (never
         *       omitted), matching the prior ad-hoc JSON.
         */
        DownloadStatusResponse: {
            installed: boolean;
            name: string;
            status: string;
        } | {
            /** Format: int64 */
            downloaded_bytes: number;
            error?: string | null;
            name: string;
            status: string;
            /** Format: int64 */
            total_bytes?: number | null;
        };
        /** @description One entry in the [`DiscoveryResponse`] endpoint list. */
        EndpointDescriptor: {
            description: string;
            method: string;
            path: string;
        };
        FinalIn: {
            /** Format: int64 */
            end_ms?: number | null;
            kind?: string | null;
            /** Format: int64 */
            start_ms?: number | null;
            text: string;
        };
        /**
         * @description The `GET /items/{id}/runs` body: `{ "runs": RunRecord[] }`. A trivial
         *     wrapper over the run list, reusing the already-typed `RunRecord` element so
         *     the wire shape stays byte-identical to the prior `json!({ "runs": ... })`.
         */
        ItemRunsResponse: {
            runs: components["schemas"]["RunRecord"][];
        };
        MeetingCreate: {
            /** Format: int64 */
            created_at?: number | null;
            /** Format: double */
            duration_seconds?: number | null;
            filename: string;
            id: string;
            language?: string | null;
            result: unknown;
            speaker_names?: unknown;
            /** Format: int64 */
            speakers_count?: number | null;
            status?: string;
        };
        /**
         * @description Full meeting detail: the `meeting_analyses` row. `result` (per-kind diarize
         *     snapshot) and `speaker_names` (free-form id→name map) are dynamic and stay
         *     `serde_json::Value`. Returned by `get_meeting`, `create_meeting` (201),
         *     `patch_meeting`, and as each element of the meeting list.
         */
        MeetingFull: {
            audio_mime_type?: string | null;
            audio_path?: string | null;
            /** Format: int64 */
            audio_size_bytes?: number | null;
            category?: string | null;
            /** Format: int64 */
            created_at: number;
            /** Format: double */
            duration_seconds?: number | null;
            filename: string;
            id: string;
            language?: string | null;
            project?: string | null;
            /** @description Per-kind diarization result snapshot — shape varies, kept dynamic. */
            result: unknown;
            /** @description Free-form speaker id→name map — kept dynamic. */
            speaker_names: unknown;
            /** Format: int64 */
            speakers_count?: number | null;
            starred: boolean;
            status: string;
            title?: string | null;
        };
        /** @description Paged meeting list: `{ meetings: [...], next_before_ms: <cursor|null> }`. */
        MeetingListResponse: {
            meetings: components["schemas"]["MeetingFull"][];
            /** Format: int64 */
            next_before_ms?: number | null;
        };
        MeetingPatch: {
            category?: string | null;
            filename?: string | null;
            project?: string | null;
            speaker_names?: unknown;
            starred?: boolean | null;
            title?: string | null;
        };
        /**
         * @description Schema mirror of [`registry::ModelListing`] (core crate: derives
         *     `Serialize` but not `ToSchema`). It is referenced only via `value_type` for
         *     the OpenAPI schema of the `models` array — the wire value is the real
         *     `ModelListing`, whose snake_case keys and null-for-`None` optionals this
         *     mirrors byte-for-byte, so serialization is unchanged.
         */
        ModelEntry: {
            /** Format: double */
            accuracy?: number | null;
            /**
             * @description Inference backend kind, kebab-case: `"whisper-ggml"` or
             *     `"parakeet-nemotron"` (mirrors `registry::BackendKind`'s serde
             *     rename_all = "kebab-case").
             */
            backend: string;
            description?: string | null;
            formats: string[];
            installed: boolean;
            languages: string[];
            license?: string | null;
            name: string;
            recommended: boolean;
            runnable: boolean;
            size?: string | null;
            /** Format: double */
            speed?: number | null;
            /**
             * @description True when the backend transcribes a live stream natively
             *     (parakeet-nemotron), rather than via chunked whisper passes.
             */
            supports_native_stream: boolean;
            tags: string[];
        };
        /**
         * @description `GET /models` success body: the active model name, whether its weights are
         *     actually loaded, and the registry listing.
         */
        ModelsListResponse: {
            active: string;
            loaded: boolean;
            models: components["schemas"]["ModelEntry"][];
        };
        /** @description A single entry in the OpenAI-compatible model list (`GET /v1/models`). */
        OpenAiModel: {
            /**
             * Format: int64
             * @description Unix creation timestamp (server start time).
             */
            created: number;
            /** @description Model identifier (the active ASR model name). */
            id: string;
            /** @description Object type — always `"model"`. */
            object: string;
            /** @description Owning organization — always `"whisper-wrap"`. */
            owned_by: string;
        };
        /** @description The OpenAI-compatible model listing envelope returned by `GET /v1/models`. */
        OpenAiModelList: {
            /** @description The listed models (the single active ASR model). */
            data: components["schemas"]["OpenAiModel"][];
            /** @description Object type — always `"list"`. */
            object: string;
        };
        /**
         * @description The default (`response_format=json`) transcription/translation body:
         *     `{ "text": string }`. Non-default formats (`text`/`srt`/`vtt`/`verbose_json`)
         *     are format-dependent and not schematized — see the operation descriptions.
         */
        OpenAiTranscription: {
            /** @description The transcribed (or translated) text. */
            text: string;
        };
        /**
         * @description Terminal-error detail spliced into a poll response only when the job
         *     failed. Omitted entirely for pending/running/done/cancelled jobs.
         */
        PollError: {
            /** @description Machine-readable error code (e.g. `asr_failed`, `diarize_failed`). */
            code: string;
            /** @description Human-readable failure message. */
            message: string;
        };
        /**
         * @description Job-status body returned by `GET /transcribe/meeting/{id}`. `result` is the
         *     per-kind analysis snapshot — `null` until the job is `done` — and is always
         *     present. `error` is present only for a failed job.
         */
        PollResponse: {
            error?: null | components["schemas"]["PollError"];
            /**
             * Format: double
             * @description Fractional progress in `[0, 1]`.
             */
            progress: number;
            /** @description Analysis result once `done`, otherwise `null` (always present). */
            result?: unknown;
            /** @description Current pipeline stage (asr | diarize | complete | failed | …). */
            stage: string;
            /** @description pending | running | done | error | cancelled. */
            status: string;
        };
        /**
         * @description One ordered replacement pair. `from` matches ASCII-case-insensitively;
         *     `to` is inserted exactly as authored (see `whisper_wrap_core::replace`).
         */
        ReplacementPair: {
            /** @example Cloud Code */
            from: string;
            /** @example Claude Code */
            to: string;
        };
        /**
         * @description The 202 run-accepted descriptor shared by every stage launcher: the opened
         *     run's id and the poll URL for its job-status contract (`GET /runs/{id}`).
         *     Wire shape: `{ "run_id": string, "status_url": string }` — field names map
         *     1:1 to the JSON keys, so no `#[serde(rename)]` is needed.
         */
        RunAccepted: {
            run_id: string;
            status_url: string;
        };
        /**
         * @description The operation a run records. The `runs` table is the eventual superset of
         *     all three kinds; this change writes only `Diarize` (the meeting pipeline).
         * @enum {string}
         */
        RunKind: "transcribe" | "diarize" | "ai";
        /**
         * @description Provenance of a run in the item listing (unify-run-ledger). `Stage` is a
         *     real row in the `runs` ledger; `Capture` and `Legacy` are read-only runs
         *     synthesized at list time from a session's `finals` / legacy `action_runs`,
         *     so a read surface sees one unified history without reconciling the storage
         *     split. Synthesized runs are never re-runnable.
         * @enum {string}
         */
        RunOrigin: "stage" | "capture" | "legacy";
        /**
         * @description The job-status contract JSON returned by `GET /runs/{id}`. `params` is
         *     stored in the table (D1) but deliberately NOT part of the status contract,
         *     so it does not appear here.
         */
        RunRecord: {
            /** Format: int64 */
            created_at: number;
            error?: string | null;
            id: string;
            item_id: string;
            kind: components["schemas"]["RunKind"];
            model?: string | null;
            /**
             * @description Provenance (unify-run-ledger): `stage` for a real ledger row,
             *     `capture`/`legacy` for a run synthesized at list time. Ledger reads are
             *     always `stage`; the synthesizers set the other two.
             */
            origin: components["schemas"]["RunOrigin"];
            /** Format: double */
            progress: number;
            /**
             * @description The run's immutable result snapshot (stage-run-endpoints, D8), parsed
             *     from `result_json`. Serialized as `result`: null when the run has no
             *     snapshot. Additive to the job-status contract.
             */
            result?: unknown;
            result_ref?: string | null;
            stage?: string | null;
            status: components["schemas"]["RunStatus"];
            /** Format: int64 */
            updated_at: number;
        };
        /**
         * @description The five lifecycle states every run reports (job-status contract).
         * @enum {string}
         */
        RunStatus: "queued" | "running" | "done" | "error" | "cancelled";
        /** @description One legacy `action_runs` row surfaced inside a session detail. */
        SessionActionRun: {
            action_id: string;
            answer: string;
            /** Format: int64 */
            id: number;
            model_used?: string | null;
            prompt: string;
            /** Format: int64 */
            ran_at: number;
            session_id: string;
            succeeded: boolean;
        };
        SessionCreate: {
            id: string;
            mode: string;
            /** Format: int64 */
            started_at: number;
        };
        /**
         * @description One finalized transcript segment inside a session (a `finals` row). Also the
         *     standalone `201` body of `POST /v1/sessions/{id}/finals`, whose shape is
         *     exactly this row.
         */
        SessionFinal: {
            /** Format: int64 */
            end_ms?: number | null;
            kind?: string | null;
            /** Format: int64 */
            ord: number;
            session_id: string;
            /** Format: int64 */
            start_ms?: number | null;
            text: string;
        };
        /**
         * @description Full session detail: the `sessions` row plus its `finals` and legacy
         *     `action_runs`. Returned by `get_session`, `create_session` (201),
         *     `patch_session`, and as each element of the session list.
         */
        SessionFull: {
            action_runs: components["schemas"]["SessionActionRun"][];
            audio_mime_type?: string | null;
            audio_path?: string | null;
            /** Format: int64 */
            audio_size_bytes?: number | null;
            category?: string | null;
            /** Format: int64 */
            duration_ms?: number | null;
            /** Format: int64 */
            ended_at?: number | null;
            finals: components["schemas"]["SessionFinal"][];
            id: string;
            mode: string;
            project?: string | null;
            starred: boolean;
            /** Format: int64 */
            started_at: number;
            title?: string | null;
        };
        /** @description Paged session list: `{ sessions: [...], next_before_ms: <cursor|null> }`. */
        SessionListResponse: {
            /** Format: int64 */
            next_before_ms?: number | null;
            sessions: components["schemas"]["SessionFull"][];
        };
        SessionPatch: {
            audio_mime_type?: string | null;
            audio_path?: string | null;
            /** Format: int64 */
            audio_size_bytes?: number | null;
            category?: string | null;
            /** Format: int64 */
            duration_ms?: number | null;
            /** Format: int64 */
            ended_at?: number | null;
            project?: string | null;
            starred?: boolean | null;
            title?: string | null;
        };
        /**
         * @description `POST /models/active` success body. `load_time_ms` is present **only** when
         *     a load actually happened (`swapped = true`); it is omitted on the no-op path
         *     (`swapped = false`, the model was already active and loaded). The key is
         *     snake_case on the wire, matching the prior ad-hoc JSON.
         */
        SetActiveResponse: {
            active: string;
            load_time_ms?: number | null;
            swapped: boolean;
        };
        /** @description AI-provider privacy indicator sub-object of [`StatusResponse`]. */
        StatusAi: {
            configured: boolean;
            endpoint: string;
            model: string;
            provider: string;
        };
        /** @description Backend sub-object of [`StatusResponse`]. */
        StatusBackend: {
            backend: string;
            format: string;
            /** @description Quantization label; `null` when the format carries none. */
            quant?: string | null;
        };
        /** @description Legacy `gemini` sub-object of [`StatusResponse`] (back-compat). */
        StatusGemini: {
            configured: boolean;
            model: string;
        };
        /** @description Meeting/diarization availability sub-object of [`StatusResponse`]. */
        StatusMeeting: {
            available: boolean;
            extras_installed: boolean;
            hf_token_configured: boolean;
            quality_tiers: string[];
        };
        /** @description Active-model sub-object of [`StatusResponse`]. */
        StatusModel: {
            compute_type: string;
            device: string;
            /** @description Model load time; `null` until weights are loaded. */
            load_time_ms?: number | null;
            /** @description false on a fresh install until `POST /models/active` loads weights. */
            loaded: boolean;
            name: string;
            path: string;
        };
        /** @description Success body of `GET /status` — engine health + active-model snapshot. */
        StatusResponse: {
            ai: components["schemas"]["StatusAi"];
            backend: components["schemas"]["StatusBackend"];
            gemini: components["schemas"]["StatusGemini"];
            meeting: components["schemas"]["StatusMeeting"];
            model: components["schemas"]["StatusModel"];
            status: string;
            /** Format: int64 */
            uptime_seconds: number;
            version: string;
        };
        /** @description 202 job descriptor returned by `POST /transcribe/meeting`. */
        SubmitResponse: {
            /** @description Opaque job id — poll `status_url` for progress. */
            job_id: string;
            /** @description Relative URL of the poll endpoint for this job. */
            status_url: string;
        };
        SwapRequest: {
            name: string;
        };
        TestBody: {
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            provider?: string;
        };
        /**
         * @description Success body of `POST /transcribe`. Two wire shapes descend from one struct:
         *     the empty/filtered case serializes to exactly `{ "text": "" }` (language and
         *     segments omitted via `skip_serializing_if`), and the kept case adds
         *     `language` and `segments`. `segments` is kept as `Vec<serde_json::Value>`
         *     because the element (`whisper_wrap_core::asr::Segment`) implements
         *     `Serialize` but not `ToSchema` and lives in the core crate — typing it here
         *     would require touching core, so the shape is preserved without over-typing.
         */
        TranscribeResponse: {
            /** @description Detected language — omitted in the empty/filtered case. */
            language?: string | null;
            /** @description Timed segments — omitted in the empty/filtered case. */
            segments?: unknown[] | null;
            /** @description Transcribed text (empty string when filtered/empty). */
            text: string;
        };
        /**
         * @description The conversion mode. `s2twp` is deliberately not offered — phrase-level
         *     localization would rewrite words the speaker never said (design Non-Goal).
         * @enum {string}
         */
        ZhConvertSetting: "off" | "s2tw";
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    discovery: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description API discovery document — a hand-maintained list of top-level routes. Token-exempt. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DiscoveryResponse"];
                };
            };
        };
    };
    actions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The prompt-action registry (categories + actions). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionsResponse"];
                };
            };
        };
    };
    ask: {
        parameters: {
            query?: {
                stream?: boolean;
                language?: string;
                prompt?: string;
                /**
                 * @description Optional per-call model override (llm-provider-abstraction). Absent
                 *     selects the active provider's default model.
                 */
                model?: string;
                log?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Either a JSON body `{"text": "…"}` for a text question, or raw/multipart audio (`audio/*`, `application/octet-stream`, or `multipart/form-data` with a `file` part) to transcribe-then-ask. */
        requestBody: {
            content: {
                "application/json": number[];
            };
        };
        responses: {
            /** @description Answer. When `stream=true` the response is a `text/event-stream` (SSE) of incremental `data:` chunks terminated by a final event; otherwise a single JSON answer object. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AskResponse"];
                };
            };
            /** @description Empty or malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Unsupported Content-Type or media format. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Transcription or LLM failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No ASR model loaded (audio input) or no LLM provider configured. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    aux_models_list: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Auxiliary (diarization + VAD) models with install state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuxListResponse"];
                };
            };
        };
    };
    aux_models_download: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The auxiliary model id to download. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuxDownloadRequest"];
            };
        };
        responses: {
            /** @description Download started/queued, or already present. `status = "done"` adds `already_present: true`; `status = "downloading"` omits it. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuxDownloadResponse"];
                };
            };
            /** @description Unknown auxiliary model id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Download setup failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    aux_models_download_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Auxiliary model id whose download progress to read. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current download progress: an `installed` form (`status` "done"/"idle" + `installed`) or a `progress` form (byte counters). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuxDownloadStatusResponse"];
                };
            };
        };
    };
    aux_models_cancel_download: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Auxiliary model id whose download to cancel. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Download cancellation acknowledged. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuxCancelDownloadResponse"];
                };
            };
            /** @description No active download for that auxiliary model. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    aux_models_delete_model: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Auxiliary model id to uninstall. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Auxiliary model weights removed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuxDeleteModelResponse"];
                };
            };
            /** @description Unknown auxiliary model id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Filesystem error removing the weights. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    get_config: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The masked, read-safe AI provider config. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiConfigView"];
                };
            };
        };
    };
    put_config: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Partial AI provider config update (camelCase). Unknown keys are ignored; the runtime accepts a lenient JSON object. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AiConfigUpdate"];
            };
        };
        responses: {
            /** @description The updated masked config. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiConfigView"];
                };
            };
            /** @description Malformed or invalid config body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    list_models: {
        parameters: {
            query?: {
                provider?: string;
                baseUrl?: string;
                apiKey?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Available models for the given provider/baseUrl/apiKey, or an error descriptor embedded in the JSON. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    test_config: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Provider credentials/settings to test-connect against. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestBody"];
            };
        };
        responses: {
            /** @description Connectivity test result `{ok, error}` (failures are reported in the body, not as a non-200 status). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiTestResult"];
                };
            };
        };
    };
    get_dictionary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The effective dictionary config (conversion mode + replacement table). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DictionaryConfig"];
                };
            };
        };
    };
    put_dictionary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Full dictionary config document. Missing fields default (off / empty table). */
        requestBody: {
            content: {
                "application/json": components["schemas"]["DictionaryConfig"];
            };
        };
        responses: {
            /** @description The stored dictionary config. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DictionaryConfig"];
                };
            };
            /** @description Invalid mode, empty `from`, or table over the cap. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    items_ai: {
        parameters: {
            query?: {
                model?: string;
            };
            header?: never;
            path: {
                /** @description Item id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description The prompt to run against the item's transcript. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AiBody"];
            };
        };
        responses: {
            /** @description AI run accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            /** @description No item for that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description The item has no transcript yet, or an AI run is already in progress. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    items_diarize: {
        parameters: {
            query?: {
                quality?: string;
            };
            header?: never;
            path: {
                /** @description Item id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Diarization run accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            /** @description Invalid quality tier. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No item or stored audio for that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description A diarization run is already in progress for the item. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list_item_runs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Item id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All runs for the item (oldest first) as `{ "runs": RunRecord[] }`; an empty list when the item has no runs. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemRunsResponse"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    items_transcribe: {
        parameters: {
            query?: {
                model?: string;
            };
            header?: never;
            path: {
                /** @description Item (session or meeting) id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Transcription run accepted — returns the run descriptor; poll `GET /runs/{id}`. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunAccepted"];
                };
            };
            /** @description No item or stored audio for that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description A transcription run is already in progress for the item. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listen: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Switching Protocols — the connection is upgraded to WebSocket. */
            101: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Installed + registered ASR models with active/loaded state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelsListResponse"];
                };
            };
            /** @description Registry read error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    set_active: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The model name to load as the active engine. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SwapRequest"];
            };
        };
        responses: {
            /** @description Model activated (or a no-op when already active + loaded). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetActiveResponse"];
                };
            };
            /** @description Unknown model name. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Model weights missing or unusable. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Load failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    download: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The model name to download. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["DownloadRequest"];
            };
        };
        responses: {
            /** @description Download started/queued, or already present. `status = "done"` adds `already_present: true`; `status = "downloading"` omits it. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DownloadResponse"];
                };
            };
            /** @description Unknown model name. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description A download for this model is already in progress. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Download setup failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    download_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model name whose download progress to read. */
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current download progress: an `installed` form (`status` "done"/"idle" + `installed`) or a `progress` form (byte counters). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DownloadStatusResponse"];
                };
            };
            /** @description No active download for that model. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    cancel_download: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model name whose download to cancel. */
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Download cancellation acknowledged. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CancelDownloadResponse"];
                };
            };
            /** @description No active download for that model. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    delete_model: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Model name to uninstall. */
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model weights removed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteModelResponse"];
                };
            };
            /** @description Unknown model name. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Model weights missing or cannot be removed. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Filesystem error removing the weights. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    get_run: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Run id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The run's job-status contract plus result snapshot. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunRecord"];
                };
            };
            /** @description No run with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    status: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Engine health + active-model snapshot. Token-exempt. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatusResponse"];
                };
            };
        };
    };
    transcribe: {
        parameters: {
            query?: {
                language?: string;
                prompt?: string;
                /**
                 * @description Optional per-request ASR model (per-request-asr-model). Absent selects
                 *     the active engine; present selects that model with no global swap.
                 */
                model?: string;
                log?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Audio payload — raw bytes with an `audio/*` (or `application/octet-stream`) Content-Type, or `multipart/form-data` with a `file` part. */
        requestBody: {
            content: {
                "application/octet-stream": number[];
            };
        };
        responses: {
            /** @description Transcription result — text plus timing/metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TranscribeResponse"];
                };
            };
            /** @description Empty or unreadable audio body, or missing multipart `file` field. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Audio exceeds the configured maximum file size. */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Unsupported Content-Type or media format. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description Audio decode or inference failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No ASR model is loaded. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    submit: {
        parameters: {
            query?: {
                filename?: string;
                /** @description fast (default) | balanced — diarization quality tier. */
                quality?: string;
                /**
                 * @description Optional per-request ASR model (stage-run-endpoints D7). Absent selects
                 *     the active engine — the v2 behavior.
                 */
                model?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Multipart upload with a `file` part carrying the meeting audio. Query params select the filename, diarization quality tier (`fast`|`balanced`), and optional per-request ASR model. */
        requestBody: {
            content: {
                "multipart/form-data": number[];
            };
        };
        responses: {
            /** @description Job accepted — returns a job descriptor; poll `GET /transcribe/meeting/{id}` for progress. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubmitResponse"];
                };
            };
            /** @description Invalid quality tier or malformed upload (ad-hoc `{detail:{error,reason}}` body). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Audio exceeds the configured maximum file size. */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unsupported Content-Type or media format. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    poll: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting job id returned by the submit call. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current job status and, when finished, the result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PollResponse"];
                };
            };
            /** @description No job with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting job id to cancel. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancellation requested for an in-flight job. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CancelResponse"];
                };
            };
            /** @description No job with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Job already finished (done/error/cancelled). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    transcriptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description OpenAI-compatible transcription request — `multipart/form-data` with a `file` part (audio) plus optional `model`/`language`/`response_format` fields. */
        requestBody: {
            content: {
                "multipart/form-data": number[];
            };
        };
        responses: {
            /** @description Transcription result. The response shape varies by the `response_format` field: the default `json` returns `{"text": string}` (documented by the `OpenAiTranscription` schema below); `text`/`srt`/`vtt` return a `text/plain` (or `text/vtt`) body; `verbose_json` returns an extended JSON object with `segments`. The schema documents the default `json` form. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenAiTranscription"];
                };
            };
            /** @description Malformed request or missing `file` part. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Audio exceeds the configured maximum file size. */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unsupported media format. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Decode or inference failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No ASR model loaded. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    translations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description OpenAI-compatible translation request (transcribe + translate to English) — `multipart/form-data` with a `file` part plus optional `model`/`response_format` fields. */
        requestBody: {
            content: {
                "multipart/form-data": number[];
            };
        };
        responses: {
            /** @description English translation result. The response shape varies by the `response_format` field: the default `json` returns `{"text": string}` (documented by the `OpenAiTranscription` schema below); `text`/`srt`/`vtt` return a `text/plain` (or `text/vtt`) body; `verbose_json` returns an extended JSON object with `segments`. The schema documents the default `json` form. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenAiTranscription"];
                };
            };
            /** @description Malformed request or missing `file` part. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Audio exceeds the configured maximum file size. */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unsupported media format. */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Decode or inference failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No ASR model loaded. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    list_meetings: {
        parameters: {
            query?: {
                limit?: number;
                before_ms?: number;
                category?: string;
                starred?: string;
                project?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paged meeting list with item-metadata filters applied. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeetingListResponse"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    create_meeting: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description New meeting metadata. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MeetingCreate"];
            };
        };
        responses: {
            /** @description Meeting created (the full new meeting). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeetingFull"];
                };
            };
            /** @description Malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    get_meeting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The meeting with its items. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeetingFull"];
                };
            };
            /** @description No meeting with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    delete_meeting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Meeting deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No meeting with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    patch_meeting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description Partial meeting update (title, item metadata, …). */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MeetingPatch"];
            };
        };
        responses: {
            /** @description Updated meeting. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeetingFull"];
                };
            };
            /** @description Malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No meeting with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    stream_meeting_audio: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The stored audio blob (binary, original media type). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                };
            };
            /** @description No meeting or no stored audio for that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    upload_meeting_audio: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Meeting id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description Multipart upload carrying the meeting's audio blob in a `file` part. */
        requestBody: {
            content: {
                "multipart/form-data": number[];
            };
        };
        responses: {
            /** @description Audio stored. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioUploadResponse"];
                };
            };
            /** @description Missing or malformed upload. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No meeting with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    openai_models: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OpenAI-compatible model list `{object:"list", data:[…]}` describing the active ASR model. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenAiModelList"];
                };
            };
        };
    };
    list_sessions: {
        parameters: {
            query?: {
                limit?: number;
                before_ms?: number;
                category?: string;
                starred?: string;
                project?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paged session list with item-metadata filters applied. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionListResponse"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    create_session: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description New session metadata. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionCreate"];
            };
        };
        responses: {
            /** @description Session created (the full new session). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionFull"];
                };
            };
            /** @description Malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    bulk_clear_audio: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cleared stored audio blobs across sessions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BulkClearAudioResponse"];
                };
            };
            /** @description History store error. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    stream_session_events: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description An SSE stream of `ready` then `changed` events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": unknown;
                };
            };
        };
    };
    get_session: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session with its items and finals. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionFull"];
                };
            };
            /** @description No session with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    delete_session: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    patch_session: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description Partial session update (title, item metadata, …). */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionPatch"];
            };
        };
        responses: {
            /** @description Updated session. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionFull"];
                };
            };
            /** @description Malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No session with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    stream_session_audio: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The stored audio blob (binary, original media type). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                };
            };
            /** @description No session or no stored audio for that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    upload_session_audio: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description Multipart upload carrying the session's audio blob in a `file` part. */
        requestBody: {
            content: {
                "multipart/form-data": number[];
            };
        };
        responses: {
            /** @description Audio stored. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioUploadResponse"];
                };
            };
            /** @description Missing or malformed upload. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No session with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
    append_final: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Session id. */
                id: string;
            };
            cookie?: never;
        };
        /** @description A finalized transcript segment to append to the session. */
        requestBody: {
            content: {
                "application/json": components["schemas"]["FinalIn"];
            };
        };
        responses: {
            /** @description Segment appended (the stored final segment). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionFinal"];
                };
            };
            /** @description Malformed body. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
            /** @description No session with that id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorBody"];
                };
            };
        };
    };
}
