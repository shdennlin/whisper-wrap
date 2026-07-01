//! OpenAI Whisper REST compatibility — port of `app/api/openai_compat.py`.
//! POST /v1/audio/transcriptions, POST /v1/audio/translations,
//! GET /v1/models. OpenAI error envelope, all five response_formats.

use std::sync::Arc;

use axum::extract::{Multipart, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;
use whisper_wrap_core::postprocess::{filter_empty_transcription, FilterDecision};
use whisper_wrap_core::subtitle::{format_srt, format_vtt};

use crate::routes::decode_and_transcribe;
use crate::state::AppState;

const ACCEPTED_FORMATS: [&str; 5] = ["json", "text", "srt", "verbose_json", "vtt"];
const RESERVED_ALIASES: [&str; 3] = ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"];

fn openai_error(
    status: StatusCode,
    message: &str,
    param: Option<&str>,
    error_type: &str,
) -> Response {
    (
        status,
        Json(json!({
            "error": {"message": message, "type": error_type, "param": param, "code": null}
        })),
    )
        .into_response()
}

fn invalid(status: StatusCode, message: &str, param: Option<&str>) -> Response {
    openai_error(status, message, param, "invalid_request_error")
}

#[derive(Default)]
struct Fields {
    file: Option<(Vec<u8>, String)>, // (bytes, suffix)
    model: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
    response_format: Option<String>,
}

async fn read_fields(req: Request) -> Result<Fields, String> {
    use axum::extract::FromRequest;
    let mut multipart = Multipart::from_request(req, &())
        .await
        .map_err(|e| format!("expected multipart/form-data body: {e}"))?;
    let mut fields = Fields::default();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| format!("multipart read failed: {e}"))?
    {
        match field.name() {
            Some("file") => {
                let filename = field.file_name().unwrap_or("audio.unknown").to_owned();
                let suffix = std::path::Path::new(&filename)
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_else(|| ".audio".into());
                let bytes = field.bytes().await.map_err(|e| e.to_string())?;
                fields.file = Some((bytes.to_vec(), suffix));
            }
            Some("model") => fields.model = field.text().await.ok(),
            Some("language") => fields.language = field.text().await.ok(),
            Some("prompt") => fields.prompt = field.text().await.ok(),
            Some("response_format") => fields.response_format = field.text().await.ok(),
            _ => {} // temperature etc. — accepted and ignored
        }
    }
    Ok(fields)
}

fn empty_response(format: &str, task: &str, language: &str, duration: f64) -> Response {
    match format {
        "json" => Json(json!({"text": ""})).into_response(),
        "text" | "srt" => plain("", "text/plain; charset=utf-8"),
        "vtt" => plain("WEBVTT\n\n", "text/vtt; charset=utf-8"),
        _ => Json(json!({
            "task": task, "language": language, "duration": duration,
            "text": "", "segments": [],
        }))
        .into_response(),
    }
}

fn plain(body: &str, content_type: &'static str) -> Response {
    ([(header::CONTENT_TYPE, content_type)], body.to_owned()).into_response()
}

async fn transcribe_or_translate(state: Arc<AppState>, req: Request, translate: bool) -> Response {
    let fields = match read_fields(req).await {
        Ok(f) => f,
        Err(e) => return invalid(StatusCode::BAD_REQUEST, &e, None),
    };

    let Some((body, suffix)) = fields.file else {
        return invalid(
            StatusCode::BAD_REQUEST,
            "Missing required form field 'file'",
            Some("file"),
        );
    };
    let Some(model) = fields.model.filter(|m| !m.is_empty()) else {
        return invalid(
            StatusCode::BAD_REQUEST,
            "Missing required form field 'model'",
            Some("model"),
        );
    };

    let response_format = fields.response_format.unwrap_or_else(|| "json".into());
    if !ACCEPTED_FORMATS.contains(&response_format.as_str()) {
        return invalid(
            StatusCode::BAD_REQUEST,
            &format!(
                "Invalid response_format {response_format:?}. Accepted values: {}.",
                ACCEPTED_FORMATS.join(", ")
            ),
            Some("response_format"),
        );
    }
    if translate && fields.language.is_some() {
        return invalid(
            StatusCode::BAD_REQUEST,
            "Translations always output English; the 'language' form field is not accepted on /v1/audio/translations.",
            Some("language"),
        );
    }

    let active = state.model_snapshot().name;
    if !RESERVED_ALIASES.contains(&model.as_str()) && model != active {
        log::warn!(
            "openai-compat: client requested model={model:?}; serving with active model={active:?}"
        );
    }

    if body.is_empty() {
        return invalid(
            StatusCode::BAD_REQUEST,
            "Uploaded file is empty",
            Some("file"),
        );
    }
    if body.len() as u64 > state.config.max_file_size_bytes() {
        return invalid(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!(
                "File too large. Maximum size: {}MB",
                state.config.max_file_size_mb
            ),
            Some("file"),
        );
    }

    let task = if translate { "translate" } else { "transcribe" };
    let language = if translate {
        None
    } else {
        fields.language.clone()
    };
    let result = match decode_and_transcribe(
        &state,
        &body,
        &suffix,
        language.as_deref().unwrap_or("auto"),
        fields.prompt,
        translate,
        // Per-request ASR model is out of scope for the OpenAI-compat route
        // (its `model` field keeps the active engine); per-request-asr-model
        // adds selection on POST /transcribe only.
        None,
    )
    .await
    {
        Ok((r, _mime)) => r,
        Err(e) if e.status == StatusCode::UNSUPPORTED_MEDIA_TYPE => {
            return invalid(StatusCode::UNSUPPORTED_MEDIA_TYPE, &e.detail, Some("file"));
        }
        Err(e) => {
            log::error!("openai-compat: backend failure: {}", e.detail);
            return openai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error during audio inference",
                None,
                "server_error",
            );
        }
    };

    let language_field = if translate {
        "en".to_owned()
    } else {
        language.unwrap_or_else(|| result.language.clone())
    };

    match filter_empty_transcription(
        &result.text,
        None,
        state.config.filter_empty_enabled,
        state.config.filter_min_duration_ms,
    ) {
        FilterDecision::Drop(reason) => {
            log::info!(
                "transcription_filtered endpoint=/v1/audio/{task} reason={} response_format={response_format}",
                reason.as_str()
            );
            empty_response(
                &response_format,
                task,
                &language_field,
                result.duration_seconds,
            )
        }
        FilterDecision::Keep(text) => {
            let cues: Vec<(f64, f64, String)> = result
                .segments
                .iter()
                .map(|s| (s.start, s.end, s.text.clone()))
                .collect();
            match response_format.as_str() {
                "json" => Json(json!({"text": text})).into_response(),
                "text" => plain(&text, "text/plain; charset=utf-8"),
                "srt" => plain(&format_srt(&cues), "text/plain; charset=utf-8"),
                "vtt" => plain(&format_vtt(&cues), "text/vtt; charset=utf-8"),
                _ => Json(json!({
                    "task": task,
                    "language": language_field,
                    "duration": result.duration_seconds,
                    "text": text,
                    "segments": result.segments.iter().enumerate().map(|(i, s)| json!({
                        "id": i, "seek": 0, "start": s.start, "end": s.end, "text": s.text,
                        "tokens": [], "temperature": 0.0, "avg_logprob": null,
                        "compression_ratio": null, "no_speech_prob": null,
                    })).collect::<Vec<_>>(),
                }))
                .into_response(),
            }
        }
    }
}

#[utoipa::path(
    post,
    path = "/v1/audio/transcriptions",
    tag = "openai-compat",
    request_body(
        content_type = "multipart/form-data",
        description = "OpenAI-compatible transcription request — `multipart/form-data` \
            with a `file` part (audio) plus optional `model`/`language`/`response_format` fields.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "Transcription in OpenAI JSON shape (e.g. `{\"text\": …}`)."),
        (status = 400, description = "Malformed request or missing `file` part."),
        (status = 413, description = "Audio exceeds the configured maximum file size."),
        (status = 415, description = "Unsupported media format."),
        (status = 500, description = "Decode or inference failure."),
        (status = 503, description = "No ASR model loaded.")
    )
)]
pub async fn transcriptions(State(state): State<Arc<AppState>>, req: Request) -> Response {
    transcribe_or_translate(state, req, false).await
}

#[utoipa::path(
    post,
    path = "/v1/audio/translations",
    tag = "openai-compat",
    request_body(
        content_type = "multipart/form-data",
        description = "OpenAI-compatible translation request (transcribe + translate to \
            English) — `multipart/form-data` with a `file` part plus optional \
            `model`/`response_format` fields.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "English translation in OpenAI JSON shape (e.g. `{\"text\": …}`)."),
        (status = 400, description = "Malformed request or missing `file` part."),
        (status = 413, description = "Audio exceeds the configured maximum file size."),
        (status = 415, description = "Unsupported media format."),
        (status = 500, description = "Decode or inference failure."),
        (status = 503, description = "No ASR model loaded.")
    )
)]
pub async fn translations(State(state): State<Arc<AppState>>, req: Request) -> Response {
    transcribe_or_translate(state, req, true).await
}

#[utoipa::path(
    get,
    path = "/v1/models",
    tag = "openai-compat",
    operation_id = "openai_models",
    responses((status = 200, description = "OpenAI-compatible model list `{object:\"list\", data:[…]}` describing the active ASR model."))
)]
pub async fn models(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "object": "list",
        "data": [{
            "id": state.model_snapshot().name,
            "object": "model",
            "created": state.started_unix,
            "owned_by": "whisper-wrap",
        }],
    }))
}
