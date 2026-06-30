//! Integration tests for per-request ASR model selection
//! (per-request-asr-model). Driven through the shared zero-weights harness:
//! the `engine_for` selection seam and `?model=` on POST /transcribe.
//!
//! Cold-load + cache-reuse of a real model needs real weights (no cheap ASR
//! placeholder exists), so these cover the resolution + error-mapping surface;
//! reuse is a code-level guarantee of the get-or-insert in `engine_for`.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use common::{body_json, no_model_app, no_model_router, tiny_wav};

// `Arc<WhisperEngine>` isn't `Debug`, so `expect_err` won't compile — pull the
// error's status out by hand.
fn err_status(
    r: Result<
        std::sync::Arc<whisper_wrap_core::WhisperEngine>,
        whisper_wrap_server::routes::ApiError,
    >,
) -> StatusCode {
    match r {
        Err(e) => e.status,
        Ok(_) => panic!("expected an error, got an engine"),
    }
}

// ---------- task 2.1: the engine_for selection seam ----------

#[tokio::test]
async fn engine_for_default_path_is_503_without_active_engine() {
    let (_router, state) = no_model_app("pra-default");
    // No model requested -> default path; no engine loaded -> 503.
    assert_eq!(
        err_status(state.engine_for(None)),
        StatusCode::SERVICE_UNAVAILABLE
    );
    // The active model BY NAME also routes to the default path (not 409),
    // because the active engine is the default and simply isn't loaded.
    assert_eq!(
        err_status(state.engine_for(Some("breeze-asr-25"))),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn engine_for_unregistered_model_is_404() {
    let (_router, state) = no_model_app("pra-unknown");
    assert_eq!(
        err_status(state.engine_for(Some("ghost-model"))),
        StatusCode::NOT_FOUND
    );
}

// ---------- task 3.1: ?model= on POST /transcribe ----------

fn transcribe(query: &str) -> Request<Body> {
    Request::post(format!("/transcribe{query}"))
        .header("content-type", "audio/wav")
        .body(Body::from(tiny_wav()))
        .unwrap()
}

#[tokio::test]
async fn transcribe_unregistered_model_is_404() {
    let resp = no_model_router("pra-tx-unknown")
        .oneshot(transcribe("?model=ghost-model"))
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn transcribe_registered_nonactive_model_without_weights_is_409() {
    // whisper-small-test is registered (non-active) but its weights are absent.
    let resp = no_model_router("pra-tx-missing")
        .oneshot(transcribe("?model=whisper-small-test"))
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn transcribe_no_model_without_active_engine_is_503() {
    // Default path unchanged: no model requested, none loaded -> 503.
    let resp = no_model_router("pra-tx-default")
        .oneshot(transcribe(""))
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = body_json(resp).await;
    assert_eq!(body["detail"], serde_json::json!("no model loaded"));
}
