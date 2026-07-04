//! Core route handlers (/transcribe, /status, /) + the shared audio
//! pipeline reused by /ask and the OpenAI-compat layer. Contracts
//! mirror the v2 FastAPI server verbatim.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Multipart, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use whisper_wrap_core::asr::TranscribeResult;
use whisper_wrap_core::postprocess::{filter_empty_transcription, FilterDecision};
use whisper_wrap_core::{audio, mime};

use crate::state::AppState;

/// Content-Type → temp-file suffix for raw bodies.
pub(crate) fn raw_body_suffix(content_type: &str) -> &'static str {
    match content_type {
        "audio/mpeg" | "audio/mp3" => ".mp3",
        "audio/wav" | "audio/x-wav" => ".wav",
        "audio/flac" => ".flac",
        "audio/ogg" => ".ogg",
        "audio/aac" => ".aac",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => ".m4a",
        "audio/webm" | "video/webm" => ".webm",
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        _ => ".audio",
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: String,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        ApiError {
            status,
            detail: detail.into(),
        }
    }
    pub fn internal(e: impl ToString) -> Self {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}

/// The `{ "detail": string }` body every [`ApiError`] serializes to. `ApiError`
/// itself is private and only implements `IntoResponse`, so it cannot derive
/// `ToSchema`; this is the single reusable schema every fallible operation
/// references for its non-200 error responses (rather than re-inlining the
/// shape per handler).
#[derive(utoipa::ToSchema)]
pub struct ApiErrorBody {
    /// Human-readable error description.
    #[schema(example = "Unsupported Content-Type: text/plain")]
    pub detail: String,
}

pub(crate) fn normalize_content_type(raw: Option<&str>) -> String {
    raw.unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

pub(crate) fn is_supported_dispatch_type(ct: &str) -> bool {
    ct == "multipart/form-data" || ct.starts_with("audio/") || ct == "application/octet-stream"
}

/// Shared pipeline: temp write → MIME sniff gate (415) → ffmpeg decode
/// → whisper inference. Size/empty checks stay caller-side (their
/// error shapes differ per endpoint family).
pub(crate) async fn decode_and_transcribe(
    state: &Arc<AppState>,
    body: &[u8],
    suffix: &str,
    language: &str,
    prompt: Option<String>,
    translate: bool,
    model: Option<&str>,
) -> Result<(TranscribeResult, String), ApiError> {
    let temp_input: PathBuf =
        state
            .config
            .temp_dir
            .join(format!("{}{}", uuid::Uuid::new_v4(), suffix));
    let result = async {
        std::fs::write(&temp_input, body).map_err(ApiError::internal)?;

        let detected = mime::detect_mime(&temp_input).map_err(ApiError::internal)?;
        log::info!("Transcribe: detected_mime={detected}, bytes={}", body.len());
        if !mime::is_supported_av(&detected) {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                format!("Unsupported file format. Detected: {detected}"),
            ));
        }

        let samples = {
            let input = temp_input.clone();
            let timeout = state.config.upload_timeout_seconds;
            tokio::task::spawn_blocking(move || audio::decode_to_samples(&input, timeout))
                .await
                .map_err(ApiError::internal)?
                .map_err(ApiError::internal)?
        };

        let engine = state.engine_for(model)?;
        let language = language.to_owned();
        let result = tokio::task::spawn_blocking(move || {
            engine.transcribe(&samples, &language, prompt.as_deref(), translate)
        })
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
        Ok((result, detected))
    }
    .await;
    let _ = std::fs::remove_file(&temp_input);
    result
}

pub(crate) async fn read_multipart_file(req: Request) -> Result<(Vec<u8>, String), ApiError> {
    use axum::extract::FromRequest;
    let mut multipart = Multipart::from_request(req, &())
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("audio.unknown").to_owned();
            let suffix = std::path::Path::new(&filename)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_else(|| ".audio".into());
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
            return Ok((bytes.to_vec(), suffix));
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "Missing form field 'file'",
    ))
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TranscribeQuery {
    #[serde(default = "default_language")]
    language: String,
    prompt: Option<String>,
    /// Optional per-request ASR model (per-request-asr-model). Absent selects
    /// the active engine; present selects that model with no global swap.
    model: Option<String>,
    // Accepted for v2 contract compatibility; session persistence
    // arrives with the history port.
    #[serde(default, rename = "log")]
    _log: Option<bool>,
}

fn default_language() -> String {
    "auto".into()
}

/// Success body of `POST /transcribe`. Two wire shapes descend from one struct:
/// the empty/filtered case serializes to exactly `{ "text": "" }` (language and
/// segments omitted via `skip_serializing_if`), and the kept case adds
/// `language` and `segments`. `segments` is kept as `Vec<serde_json::Value>`
/// because the element (`whisper_wrap_core::asr::Segment`) implements
/// `Serialize` but not `ToSchema` and lives in the core crate — typing it here
/// would require touching core, so the shape is preserved without over-typing.
#[derive(Serialize, utoipa::ToSchema)]
pub struct TranscribeResponse {
    /// Transcribed text (empty string when filtered/empty).
    text: String,
    /// Detected language — omitted in the empty/filtered case.
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    /// Timed segments — omitted in the empty/filtered case.
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<serde_json::Value>>,
}

#[utoipa::path(
    post,
    path = "/transcribe",
    tag = "transcription",
    params(TranscribeQuery),
    request_body(
        content_type = "application/octet-stream",
        description = "Audio payload — raw bytes with an `audio/*` (or \
            `application/octet-stream`) Content-Type, or `multipart/form-data` \
            with a `file` part.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "Transcription result — text plus timing/metadata.", body = TranscribeResponse),
        (status = 400, description = "Empty or unreadable audio body, or missing multipart `file` field.", body = ApiErrorBody),
        (status = 413, description = "Audio exceeds the configured maximum file size.", body = ApiErrorBody),
        (status = 415, description = "Unsupported Content-Type or media format.", body = ApiErrorBody),
        (status = 500, description = "Audio decode or inference failure.", body = ApiErrorBody),
        (status = 503, description = "No ASR model is loaded.", body = ApiErrorBody)
    )
)]
pub async fn transcribe(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TranscribeQuery>,
    req: Request,
) -> Result<Json<TranscribeResponse>, ApiError> {
    let content_type = normalize_content_type(
        req.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
    );

    if !is_supported_dispatch_type(&content_type) {
        let shown = if content_type.is_empty() {
            "<missing>"
        } else {
            &content_type
        };
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("Unsupported Content-Type: {shown}"),
        ));
    }

    let (body, suffix) = if content_type == "multipart/form-data" {
        read_multipart_file(req).await?
    } else {
        let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
        (bytes.to_vec(), raw_body_suffix(&content_type).to_owned())
    };

    if body.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Empty audio body"));
    }
    if body.len() as u64 > state.config.max_file_size_bytes() {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "File too large. Maximum size: {}MB",
                state.config.max_file_size_mb
            ),
        ));
    }

    let (result, _mime) = decode_and_transcribe(
        &state,
        &body,
        &suffix,
        &q.language,
        q.prompt.clone(),
        false,
        q.model.as_deref(),
    )
    .await?;

    match filter_empty_transcription(
        &result.text,
        None,
        state.config.filter_empty_enabled,
        state.config.filter_min_duration_ms,
    ) {
        FilterDecision::Drop(reason) => {
            log::info!(
                "transcription_filtered endpoint=/transcribe reason={} raw_text_len={}",
                reason.as_str(),
                result.text.len()
            );
            Ok(Json(TranscribeResponse {
                text: String::new(),
                language: None,
                segments: None,
            }))
        }
        FilterDecision::Keep(text) => {
            // Pipeline position (zh-convert-dictionary): empty-filter, then
            // zh conversion + word replacements — on the joined text AND the
            // per-segment texts, so every returned surface agrees.
            let text = state.dictionary.apply(&text);
            let segments = result
                .segments
                .iter()
                .map(|s| {
                    let mut s = s.clone();
                    s.text = state.dictionary.apply(&s.text);
                    serde_json::to_value(&s).expect("Segment is always serializable")
                })
                .collect::<Vec<_>>();
            Ok(Json(TranscribeResponse {
                text,
                language: Some(result.language),
                segments: Some(segments),
            }))
        }
    }
}

/// Active-model sub-object of [`StatusResponse`].
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusModel {
    name: String,
    path: String,
    compute_type: String,
    device: String,
    /// false on a fresh install until `POST /models/active` loads weights.
    loaded: bool,
    /// Model load time; `null` until weights are loaded.
    load_time_ms: Option<u128>,
}

/// Backend sub-object of [`StatusResponse`].
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusBackend {
    backend: String,
    format: String,
    /// Quantization label; `null` when the format carries none.
    quant: Option<String>,
}

/// Legacy `gemini` sub-object of [`StatusResponse`] (back-compat).
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusGemini {
    configured: bool,
    model: String,
}

/// AI-provider privacy indicator sub-object of [`StatusResponse`].
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusAi {
    configured: bool,
    provider: String,
    endpoint: String,
    model: String,
}

/// Meeting/diarization availability sub-object of [`StatusResponse`].
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusMeeting {
    available: bool,
    quality_tiers: Vec<String>,
    hf_token_configured: bool,
    extras_installed: bool,
}

/// Success body of `GET /status` — engine health + active-model snapshot.
#[derive(Serialize, utoipa::ToSchema)]
pub struct StatusResponse {
    status: String,
    version: String,
    uptime_seconds: u64,
    model: StatusModel,
    backend: StatusBackend,
    gemini: StatusGemini,
    ai: StatusAi,
    meeting: StatusMeeting,
}

#[utoipa::path(
    get,
    path = "/status",
    tag = "system",
    security(()),
    responses((status = 200, description = "Engine health + active-model snapshot. Token-exempt.", body = StatusResponse))
)]
pub async fn status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let model = state.model_snapshot();
    let engine = state.engine_handle();
    let llm = state.llm();
    Json(StatusResponse {
        status: "ok".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        uptime_seconds: state.started.elapsed().as_secs(),
        model: StatusModel {
            name: model.name,
            path: model.bin_path.to_string_lossy().into_owned(),
            compute_type: "default".to_owned(),
            device: "auto".to_owned(),
            // false on a fresh install until POST /models/active loads weights;
            // the PWA's first-run gate keys off this.
            loaded: engine.is_some(),
            load_time_ms: engine.as_ref().map(|e| e.load_time_ms()),
        },
        backend: StatusBackend {
            backend: "whisper-rs".to_owned(),
            format: model.format.to_owned(),
            quant: model.quant,
        },
        // v2 PWA reads `gemini`; kept for back-compat, now derived from the
        // active provider.
        gemini: StatusGemini {
            configured: llm.configured(),
            model: llm.model().to_owned(),
        },
        // Privacy indicator (llm-provider-abstraction): which provider +
        // endpoint an AI run would send the transcript to. The key is never
        // exposed.
        ai: StatusAi {
            configured: llm.configured(),
            provider: llm.provider_name().to_owned(),
            endpoint: llm.endpoint().to_owned(),
            model: llm.model().to_owned(),
        },
        // The PWA's Meeting page reads meeting.available off /status to
        // decide whether to show the upload UI. v3 needs no HF token and
        // no optional extras (sherpa-onnx diarization is built into the
        // binary), so availability is purely "are the ONNX models on
        // disk" — same gate the meeting endpoints enforce.
        meeting: StatusMeeting {
            // Need segmentation + AT LEAST ONE embedding (fast or balanced) —
            // the two embeddings are interchangeable quality tiers, not both
            // required.
            available: state.config.diarize_seg_model.is_file()
                && (state.config.diarize_emb_model.is_file()
                    || state.config.diarize_emb_model_balanced.is_file()),
            // Installed diarization tiers ("fast"/"balanced") — the PWA's
            // quality dropdown only offers what's actually on disk.
            quality_tiers: crate::meeting::available_tiers(&state.config)
                .into_iter()
                .map(String::from)
                .collect(),
            hf_token_configured: true,
            extras_installed: true,
        },
    })
}

/// One entry in the [`DiscoveryResponse`] endpoint list.
#[derive(Serialize, utoipa::ToSchema)]
pub struct EndpointDescriptor {
    method: String,
    path: String,
    description: String,
}

impl EndpointDescriptor {
    fn new(method: &str, path: &str, description: &str) -> Self {
        EndpointDescriptor {
            method: method.to_owned(),
            path: path.to_owned(),
            description: description.to_owned(),
        }
    }
}

/// Success body of `GET /` — the hand-maintained API discovery document.
///
/// The wire shape is an object `{ "endpoints": [...] }`, so this is typed as a
/// named object with an `endpoints` array property (NOT a top-level array — the
/// live handler wraps the list under `endpoints`, and the wire shape is
/// preserved byte-for-byte).
#[derive(Serialize, utoipa::ToSchema)]
pub struct DiscoveryResponse {
    endpoints: Vec<EndpointDescriptor>,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "system",
    security(()),
    responses((status = 200, description = "API discovery document — a hand-maintained list of top-level routes. Token-exempt.", body = DiscoveryResponse))
)]
pub async fn discovery() -> Json<DiscoveryResponse> {
    Json(DiscoveryResponse {
        endpoints: vec![
            EndpointDescriptor::new(
                "POST",
                "/transcribe",
                "Transcribe an audio body (multipart or raw)",
            ),
            EndpointDescriptor::new(
                "WS",
                "/listen",
                "Live captions over WebSocket (pcm_s16le frames)",
            ),
            EndpointDescriptor::new(
                "POST",
                "/ask",
                "Audio or text question, Gemini answer (?stream=true for SSE)",
            ),
            EndpointDescriptor::new(
                "POST",
                "/v1/audio/transcriptions",
                "OpenAI-compatible transcription",
            ),
            EndpointDescriptor::new(
                "POST",
                "/v1/audio/translations",
                "OpenAI-compatible translation (English out)",
            ),
            EndpointDescriptor::new("GET", "/v1/models", "OpenAI-compatible model list"),
            EndpointDescriptor::new("GET", "/actions", "Prompt-action templates"),
            EndpointDescriptor::new("GET", "/models", "Registry models + installed status"),
            EndpointDescriptor::new("POST", "/models/active", "Hot-swap the active model"),
            EndpointDescriptor::new("GET", "/status", "Service health and model status"),
            EndpointDescriptor::new("GET", "/app/", "PWA static bundle"),
            EndpointDescriptor::new("GET", "/", "API discovery"),
        ],
    })
}

/// Success body of `GET /actions` — the prompt-action registry.
///
/// `actions` and `categories` are kept as `Vec<serde_json::Value>` because
/// their element types (`whisper_wrap_core::actions::Action` / `Category`)
/// implement `Serialize` but not `ToSchema` and live in the core crate; typing
/// them here would require touching core, so the element shape is preserved
/// without over-typing.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ActionsResponse {
    actions: Vec<serde_json::Value>,
    categories: Vec<serde_json::Value>,
}

#[utoipa::path(
    get,
    path = "/actions",
    tag = "system",
    responses((status = 200, description = "The prompt-action registry (categories + actions).", body = ActionsResponse))
)]
pub async fn actions(State(state): State<Arc<AppState>>) -> Json<ActionsResponse> {
    Json(ActionsResponse {
        actions: state
            .actions
            .iter()
            .map(|a| serde_json::to_value(a).expect("Action is always serializable"))
            .collect(),
        categories: state
            .action_categories
            .iter()
            .map(|c| serde_json::to_value(c).expect("Category is always serializable"))
            .collect(),
    })
}

#[cfg(test)]
mod response_wire_shape_tests {
    //! Wire-shape guards: each typed success body SHALL serialize to the exact
    //! JSON the handler produced before this retyping (a `serde_json::Value`
    //! comparison, so key order is irrelevant but field names, casing, and
    //! null-vs-omit are pinned).
    use super::*;
    use serde_json::json;

    #[test]
    fn transcribe_empty_case_serializes_to_text_only() {
        let s = TranscribeResponse {
            text: String::new(),
            language: None,
            segments: None,
        };
        // Empty/filtered case omits language + segments entirely.
        assert_eq!(serde_json::to_value(&s).unwrap(), json!({ "text": "" }));
    }

    #[test]
    fn transcribe_kept_case_serializes_full_shape() {
        let s = TranscribeResponse {
            text: "hello world".to_owned(),
            language: Some("en".to_owned()),
            segments: Some(vec![
                json!({ "text": "hello world", "start": 0.0, "end": 1.5 }),
            ]),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "text": "hello world",
                "language": "en",
                "segments": [{ "text": "hello world", "start": 0.0, "end": 1.5 }],
            })
        );
    }

    #[test]
    fn status_serializes_full_nested_shape_with_loaded_model() {
        let s = StatusResponse {
            status: "ok".to_owned(),
            version: "3.1.4".to_owned(),
            uptime_seconds: 42,
            model: StatusModel {
                name: "base".to_owned(),
                path: "/models/base.bin".to_owned(),
                compute_type: "default".to_owned(),
                device: "auto".to_owned(),
                loaded: true,
                load_time_ms: Some(1234),
            },
            backend: StatusBackend {
                backend: "whisper-rs".to_owned(),
                format: "gguf".to_owned(),
                quant: Some("q4_0".to_owned()),
            },
            gemini: StatusGemini {
                configured: true,
                model: "gemini-1.5".to_owned(),
            },
            ai: StatusAi {
                configured: true,
                provider: "gemini".to_owned(),
                endpoint: "https://example.test".to_owned(),
                model: "gemini-1.5".to_owned(),
            },
            meeting: StatusMeeting {
                available: true,
                quality_tiers: vec!["fast".to_owned(), "balanced".to_owned()],
                hf_token_configured: true,
                extras_installed: true,
            },
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "status": "ok",
                "version": "3.1.4",
                "uptime_seconds": 42,
                "model": {
                    "name": "base",
                    "path": "/models/base.bin",
                    "compute_type": "default",
                    "device": "auto",
                    "loaded": true,
                    "load_time_ms": 1234,
                },
                "backend": {
                    "backend": "whisper-rs",
                    "format": "gguf",
                    "quant": "q4_0",
                },
                "gemini": { "configured": true, "model": "gemini-1.5" },
                "ai": {
                    "configured": true,
                    "provider": "gemini",
                    "endpoint": "https://example.test",
                    "model": "gemini-1.5",
                },
                "meeting": {
                    "available": true,
                    "quality_tiers": ["fast", "balanced"],
                    "hf_token_configured": true,
                    "extras_installed": true,
                },
            })
        );
    }

    #[test]
    fn status_fresh_install_emits_null_load_time_and_quant() {
        // Fresh install: no engine loaded, no quant — both are plain `Option`
        // (not skipped), so they MUST serialize as `null`, never be omitted.
        let s = StatusResponse {
            status: "ok".to_owned(),
            version: "3.1.4".to_owned(),
            uptime_seconds: 0,
            model: StatusModel {
                name: "base".to_owned(),
                path: "/models/base.bin".to_owned(),
                compute_type: "default".to_owned(),
                device: "auto".to_owned(),
                loaded: false,
                load_time_ms: None,
            },
            backend: StatusBackend {
                backend: "whisper-rs".to_owned(),
                format: "gguf".to_owned(),
                quant: None,
            },
            gemini: StatusGemini {
                configured: false,
                model: String::new(),
            },
            ai: StatusAi {
                configured: false,
                provider: "gemini".to_owned(),
                endpoint: String::new(),
                model: String::new(),
            },
            meeting: StatusMeeting {
                available: false,
                quality_tiers: vec![],
                hf_token_configured: true,
                extras_installed: true,
            },
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["model"]["load_time_ms"], json!(null));
        assert!(v["model"].as_object().unwrap().contains_key("load_time_ms"));
        assert_eq!(v["backend"]["quant"], json!(null));
        assert!(v["backend"].as_object().unwrap().contains_key("quant"));
    }

    #[test]
    fn discovery_serializes_to_endpoints_object() {
        let s = DiscoveryResponse {
            endpoints: vec![EndpointDescriptor::new("GET", "/", "API discovery")],
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "endpoints": [
                    { "method": "GET", "path": "/", "description": "API discovery" }
                ]
            })
        );
    }

    #[test]
    fn actions_serializes_to_actions_and_categories() {
        let s = ActionsResponse {
            actions: vec![json!({ "id": "summarize", "label": "Summarize" })],
            categories: vec![json!({ "id": "general", "label": "General" })],
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "actions": [{ "id": "summarize", "label": "Summarize" }],
                "categories": [{ "id": "general", "label": "General" }],
            })
        );
    }
}
