//! Integration: the server boots with zero model weights (fresh install)
//! and degrades correctly — /status and /models report not-loaded,
//! transcription answers 503 — instead of crashing at startup.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use whisper_wrap_server::models::DownloadJob;

use common::{body_json, get_json, no_model_app, no_model_router, tiny_wav};

#[tokio::test]
async fn status_reports_not_loaded() {
    let (status, body) = get_json(no_model_router("status"), "/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["model"]["loaded"], serde_json::json!(false));
    assert!(body["model"]["load_time_ms"].is_null());
}

#[tokio::test]
async fn models_list_reports_not_loaded_with_active_name() {
    // Regression: the first-run gate's ModelManager must be able to tell
    // "configured active name" apart from "weights actually loaded" — the
    // Active chip hid the Download button when this flag was missing.
    let (status, body) = get_json(no_model_router("models"), "/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["active"], serde_json::json!("breeze-asr-25"));
    assert_eq!(body["loaded"], serde_json::json!(false));
    assert_eq!(body["models"][0]["installed"], serde_json::json!(false));
}

#[tokio::test]
async fn transcribe_answers_503_until_a_model_is_loaded() {
    let req = Request::post("/transcribe")
        .header("content-type", "audio/wav")
        .body(Body::from(tiny_wav()))
        .unwrap();
    let resp = no_model_router("transcribe")
        .oneshot(req)
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = body_json(resp).await;
    assert_eq!(body["detail"], serde_json::json!("no model loaded"));
}

fn inflight_job() -> DownloadJob {
    DownloadJob {
        status: "downloading",
        downloaded_bytes: 5_000_000,
        total_bytes: Some(10_000_000),
        error: None,
        cancel: Arc::new(AtomicBool::new(false)),
    }
}

#[tokio::test]
async fn download_status_exposes_live_progress() {
    let (router, state) = no_model_app("dl-progress");
    state
        .downloads
        .jobs
        .lock()
        .expect("dl lock")
        .insert("breeze-asr-25".into(), inflight_job());

    let (status, body) = get_json(router, "/models/download/breeze-asr-25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], serde_json::json!("downloading"));
    assert_eq!(body["downloaded_bytes"], serde_json::json!(5_000_000));
    assert_eq!(body["total_bytes"], serde_json::json!(10_000_000));
}

#[tokio::test]
async fn cancel_unknown_download_is_404() {
    let req = Request::delete("/models/download/breeze-asr-25")
        .body(Body::empty())
        .unwrap();
    let resp = no_model_router("cancel-404")
        .oneshot(req)
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cancel_flags_an_inflight_download_without_flipping_status() {
    let (router, state) = no_model_app("cancel-flag");
    state
        .downloads
        .jobs
        .lock()
        .expect("dl lock")
        .insert("breeze-asr-25".into(), inflight_job());

    let req = Request::delete("/models/download/breeze-asr-25")
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["status"], serde_json::json!("cancelling"));

    let jobs = state.downloads.jobs.lock().expect("dl lock");
    let job = &jobs["breeze-asr-25"];
    assert!(
        job.cancel.load(Ordering::Relaxed),
        "cancel flag must be set"
    );
    // Only the worker flips status to "cancelled" — after it has removed
    // the .part file — so a re-download can't race the dying stream.
    assert_eq!(job.status, "downloading");
}

#[tokio::test]
async fn set_active_answers_409_when_weights_are_missing() {
    // First-run guard: POST /models/active must refuse (not crash, not
    // pretend) while the named model's weights are absent.
    let req = Request::post("/models/active")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"name":"breeze-asr-25"}"#))
        .unwrap();
    let resp = no_model_router("set-active")
        .oneshot(req)
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}
