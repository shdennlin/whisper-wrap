//! Core route handlers (/transcribe, /status, /) + the shared audio
//! pipeline reused by /ask and the OpenAI-compat layer. Contracts
//! mirror the v2 FastAPI server verbatim.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Multipart, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;
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
        (status = 200, description = "Transcription result — text plus timing/metadata (ad-hoc JSON object)."),
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
) -> Result<Json<serde_json::Value>, ApiError> {
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
            Ok(Json(json!({ "text": "" })))
        }
        FilterDecision::Keep(text) => Ok(Json(json!({
            "text": text,
            "language": result.language,
            "segments": result.segments,
        }))),
    }
}

#[utoipa::path(
    get,
    path = "/status",
    tag = "system",
    security(()),
    responses((status = 200, description = "Engine health + active-model snapshot (ad-hoc JSON). Token-exempt."))
)]
pub async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let model = state.model_snapshot();
    let engine = state.engine_handle();
    let llm = state.llm();
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": state.started.elapsed().as_secs(),
        "model": {
            "name": model.name,
            "path": model.bin_path.to_string_lossy(),
            "compute_type": "default",
            "device": "auto",
            // false on a fresh install until POST /models/active loads weights;
            // the PWA's first-run gate keys off this.
            "loaded": engine.is_some(),
            "load_time_ms": engine.as_ref().map(|e| e.load_time_ms),
        },
        "backend": {
            "backend": "whisper-rs",
            "format": model.format,
            "quant": model.quant,
        },
        // v2 PWA reads `gemini`; kept for back-compat, now derived from the
        // active provider.
        "gemini": { "configured": llm.configured(), "model": llm.model() },
        // Privacy indicator (llm-provider-abstraction): which provider +
        // endpoint an AI run would send the transcript to. The key is never
        // exposed.
        "ai": {
            "configured": llm.configured(),
            "provider": llm.provider_name(),
            "endpoint": llm.endpoint(),
            "model": llm.model(),
        },
        // The PWA's Meeting page reads meeting.available off /status to
        // decide whether to show the upload UI. v3 needs no HF token and
        // no optional extras (sherpa-onnx diarization is built into the
        // binary), so availability is purely "are the ONNX models on
        // disk" — same gate the meeting endpoints enforce.
        "meeting": {
            // Need segmentation + AT LEAST ONE embedding (fast or balanced) —
            // the two embeddings are interchangeable quality tiers, not both
            // required.
            "available": state.config.diarize_seg_model.is_file()
                && (state.config.diarize_emb_model.is_file()
                    || state.config.diarize_emb_model_balanced.is_file()),
            // Installed diarization tiers ("fast"/"balanced") — the PWA's
            // quality dropdown only offers what's actually on disk.
            "quality_tiers": crate::meeting::available_tiers(&state.config),
            "hf_token_configured": true,
            "extras_installed": true,
        },
    }))
}

#[utoipa::path(
    get,
    path = "/",
    tag = "system",
    security(()),
    responses((status = 200, description = "API discovery document — a hand-maintained list of top-level routes (ad-hoc JSON). Token-exempt."))
)]
pub async fn discovery() -> Json<serde_json::Value> {
    Json(json!({
        "endpoints": [
            {"method": "POST", "path": "/transcribe", "description": "Transcribe an audio body (multipart or raw)"},
            {"method": "WS",   "path": "/listen",     "description": "Live captions over WebSocket (pcm_s16le frames)"},
            {"method": "POST", "path": "/ask",        "description": "Audio or text question, Gemini answer (?stream=true for SSE)"},
            {"method": "POST", "path": "/v1/audio/transcriptions", "description": "OpenAI-compatible transcription"},
            {"method": "POST", "path": "/v1/audio/translations",   "description": "OpenAI-compatible translation (English out)"},
            {"method": "GET",  "path": "/v1/models",  "description": "OpenAI-compatible model list"},
            {"method": "GET",  "path": "/actions",    "description": "Prompt-action templates"},
            {"method": "GET",  "path": "/models",     "description": "Registry models + installed status"},
            {"method": "POST", "path": "/models/active", "description": "Hot-swap the active model"},
            {"method": "GET",  "path": "/status",     "description": "Service health and model status"},
            {"method": "GET",  "path": "/app/",       "description": "PWA static bundle"},
            {"method": "GET",  "path": "/",           "description": "API discovery"},
        ]
    }))
}

#[utoipa::path(
    get,
    path = "/actions",
    tag = "system",
    responses((status = 200, description = "The prompt-action registry (categories + actions) as ad-hoc JSON."))
)]
pub async fn actions(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "actions": state.actions,
        "categories": state.action_categories,
    }))
}
