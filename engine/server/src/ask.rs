//! POST /ask — port of `app/api/ask.py`. Content-Type dispatch matrix
//! = /transcribe + an `application/json {"text": ...}` branch that
//! skips STT. `?stream=true` → SSE: transcript → token* → done; error
//! paths emit a terminating `event: error`.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;
use serde_json::json;
use whisper_wrap_core::postprocess::{filter_empty_transcription, FilterDecision};

use crate::llm::LlmError;
use crate::routes::{
    decode_and_transcribe, is_supported_dispatch_type, normalize_content_type, raw_body_suffix,
    read_multipart_file, ApiError, ApiErrorBody,
};
use crate::state::AppState;

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AskQuery {
    #[serde(default)]
    stream: bool,
    #[serde(default = "default_language")]
    language: String,
    prompt: Option<String>,
    /// Optional per-call model override (llm-provider-abstraction). Absent
    /// selects the active provider's default model.
    model: Option<String>,
    #[serde(default, rename = "log")]
    _log: Option<bool>,
}

fn default_language() -> String {
    "auto".into()
}

enum AskInput {
    Text(String),
    Audio { body: Vec<u8>, suffix: String },
}

#[utoipa::path(
    post,
    path = "/ask",
    tag = "transcription",
    params(AskQuery),
    request_body(
        content_type = "application/json",
        description = "Either a JSON body `{\"text\": \"…\"}` for a text question, \
            or raw/multipart audio (`audio/*`, `application/octet-stream`, or \
            `multipart/form-data` with a `file` part) to transcribe-then-ask.",
        content = Vec<u8>
    ),
    responses(
        (status = 200, description = "Answer. When `stream=true` the response is a \
            `text/event-stream` (SSE) of incremental `data:` chunks terminated by \
            a final event; otherwise a single JSON answer object."),
        (status = 400, description = "Empty or malformed body.", body = ApiErrorBody),
        (status = 415, description = "Unsupported Content-Type or media format.", body = ApiErrorBody),
        (status = 500, description = "Transcription or LLM failure.", body = ApiErrorBody),
        (status = 503, description = "No ASR model loaded (audio input) or no LLM provider configured.", body = ApiErrorBody)
    )
)]
pub async fn ask(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AskQuery>,
    req: Request,
) -> Result<Response, ApiError> {
    let content_type = normalize_content_type(
        req.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
    );

    if !is_supported_dispatch_type(&content_type) && content_type != "application/json" {
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

    // Validation phase — before any SSE framing begins.
    let input = if content_type == "application/json" {
        let raw = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .map_err(|e| {
                ApiError::new(StatusCode::BAD_REQUEST, format!("Failed to read body: {e}"))
            })?;
        if raw.is_empty() {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "Empty JSON body"));
        }
        let v: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Malformed JSON: {e}")))?;
        if !v.is_object() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "JSON body must be an object",
            ));
        }
        match v["text"].as_str().map(str::trim) {
            Some(t) if !t.is_empty() => AskInput::Text(v["text"].as_str().unwrap().to_owned()),
            _ => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Missing or empty 'text' field",
                ))
            }
        }
    } else {
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
                format!("File too large (max {}MB)", state.config.max_file_size_mb),
            ));
        }
        AskInput::Audio { body, suffix }
    };

    if q.stream {
        Ok(stream_response(state, q, input))
    } else {
        blocking_response(state, q, input).await
    }
}

/// Run the STT phase and apply the empty filter. `Ok(text)` is the LLM
/// input; `Err(...)` carries the endpoint-appropriate failure.
async fn stt_phase(
    state: &Arc<AppState>,
    q: &AskQuery,
    body: &[u8],
    suffix: &str,
) -> Result<String, ApiError> {
    let (result, _mime) = decode_and_transcribe(
        state,
        body,
        suffix,
        &q.language,
        q.prompt.clone(),
        false,
        None,
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
                "transcription_filtered endpoint=/ask reason={} raw_text_len={}",
                reason.as_str(),
                result.text.len()
            );
            Err(ApiError::new(StatusCode::BAD_REQUEST, "no_speech_detected"))
        }
        FilterDecision::Keep(text) => Ok(text),
    }
}

async fn blocking_response(
    state: Arc<AppState>,
    q: AskQuery,
    input: AskInput,
) -> Result<Response, ApiError> {
    let (llm_input, transcript) = match input {
        AskInput::Text(t) => (t, None),
        AskInput::Audio { body, suffix } => {
            let text = match stt_phase(&state, &q, &body, &suffix).await {
                Ok(t) => t,
                // The noise case returns the v2 shape {"error": "no_speech_detected"}.
                Err(e) if e.detail == "no_speech_detected" => {
                    return Ok((
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error": "no_speech_detected"})),
                    )
                        .into_response());
                }
                Err(e) => return Err(e),
            };
            (text.clone(), Some(text))
        }
    };

    let answer = state
        .llm()
        .ask(&llm_input, q.model.as_deref())
        .await
        .map_err(|e| match e {
            LlmError::NotConfigured => ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()),
            LlmError::Upstream(_) => ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()),
        })?;

    Ok(Json(json!({ "transcript": transcript, "answer": answer })).into_response())
}

fn sse_event(event_type: &str, payload: serde_json::Value) -> Event {
    Event::default().event(event_type).data(payload.to_string())
}

fn stream_response(state: Arc<AppState>, q: AskQuery, input: AskInput) -> Response {
    let stream = async_stream::stream! {
        let llm = state.llm();
        if !llm.configured() {
            yield Ok::<_, Infallible>(sse_event("error", json!({"error": "the AI provider is not configured"})));
            return;
        }

        let llm_input = match input {
            AskInput::Text(t) => {
                yield Ok(sse_event("transcript", json!({"text": null})));
                t
            }
            AskInput::Audio { body, suffix } => {
                match stt_phase(&state, &q, &body, &suffix).await {
                    Ok(text) => {
                        yield Ok(sse_event("transcript", json!({"text": text})));
                        text
                    }
                    Err(e) => {
                        yield Ok(sse_event("error", json!({"error": e.detail})));
                        return;
                    }
                }
            }
        };

        let mut tokens = match llm.ask_stream(&llm_input, q.model.as_deref()).await {
            Ok(s) => Box::pin(s),
            Err(e) => {
                yield Ok(sse_event("error", json!({"error": e.to_string()})));
                return;
            }
        };
        use futures_util::StreamExt;
        while let Some(delta) = tokens.next().await {
            match delta {
                Ok(text) => yield Ok(sse_event("token", json!({"text": text}))),
                Err(e) => {
                    yield Ok(sse_event("error", json!({"error": e.to_string()})));
                    return;
                }
            }
        }
        yield Ok(sse_event("done", json!({"finish_reason": "stop"})));
    };
    Sse::new(stream).into_response()
}
