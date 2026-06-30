//! Integration tests for the item-scoped stage endpoints
//! (stage-run-endpoints). Driven through the shared zero-weights harness:
//! audio is seeded the public way (create session + multipart upload), then
//! stages run async and are polled via GET /runs/{id}. Real ASR/diarize/LLM
//! execution needs real models; these cover resolution, gating, the run
//! lifecycle, and error mapping.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

use common::{body_json, get_json, no_model_app, no_model_router, tiny_wav};

/// Build a minimal multipart/form-data body with one `file` field.
fn multipart_file(filename: &str, content_type: &str, data: &[u8]) -> (String, Vec<u8>) {
    let boundary = "ZZBOUNDARYZZ";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn create_session(router: &Router, id: &str) {
    let resp = router
        .clone()
        .oneshot(
            Request::post("/v1/sessions")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"id":"{id}","started_at":1,"mode":"batch"}}"#
                )))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CREATED, "session create");
}

async fn upload_audio(router: &Router, id: &str) {
    let (ct, body) = multipart_file("a.wav", "audio/wav", &tiny_wav());
    let resp = router
        .clone()
        .oneshot(
            Request::post(format!("/v1/sessions/{id}/audio"))
                .header("content-type", ct)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK, "audio upload");
}

#[tokio::test]
async fn transcribe_unknown_item_is_404() {
    let resp = no_model_router("se-tx-404")
        .oneshot(
            Request::post("/items/ghost/transcribe")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn transcribe_item_without_audio_is_409() {
    let (router, _state) = no_model_app("se-tx-409");
    create_session(&router, "s1").await;
    let resp = router
        .oneshot(
            Request::post("/items/s1/transcribe")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn transcribe_item_with_audio_is_202_and_run_reaches_terminal() {
    let (router, _state) = no_model_app("se-tx-202");
    create_session(&router, "s1").await;
    upload_audio(&router, "s1").await;

    let resp = router
        .clone()
        .oneshot(
            Request::post("/items/s1/transcribe")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    let run_id = body_json(resp).await["run_id"]
        .as_str()
        .expect("run_id")
        .to_owned();

    // The run executes async (no engine loaded) and must reach a terminal
    // state, proving the stage wiring without real models.
    let mut terminal = None;
    for _ in 0..200 {
        let (st, body) = get_json(router.clone(), &format!("/runs/{run_id}")).await;
        assert_eq!(st, StatusCode::OK);
        let status = body["status"].as_str().unwrap_or("").to_owned();
        if ["done", "error", "cancelled"].contains(&status.as_str()) {
            terminal = Some(status);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        terminal.as_deref(),
        Some("error"),
        "no engine -> the transcribe run errors"
    );
}

async fn run_kind(router: &Router, run_id: &str) -> String {
    let (_st, body) = get_json(router.clone(), &format!("/runs/{run_id}")).await;
    body["kind"].as_str().unwrap_or_default().to_owned()
}

async fn submit_diarize(router: &Router, id: &str, query: &str) -> axum::http::Response<Body> {
    router
        .clone()
        .oneshot(
            Request::post(format!("/items/{id}/diarize{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible")
}

#[tokio::test]
async fn diarize_invalid_quality_is_400() {
    let (router, _state) = no_model_app("se-di-400");
    create_session(&router, "s1").await;
    upload_audio(&router, "s1").await;
    let resp = submit_diarize(&router, "s1", "?quality=ultra").await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(
        body["detail"]["error"],
        serde_json::json!("invalid_quality")
    );
}

#[tokio::test]
async fn diarize_unknown_item_is_404() {
    let resp = submit_diarize(&no_model_router("se-di-404"), "ghost", "").await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn diarize_item_with_audio_produces_a_diarize_run() {
    let (router, _state) = no_model_app("se-di-202");
    create_session(&router, "s1").await;
    upload_audio(&router, "s1").await;
    let resp = submit_diarize(&router, "s1", "").await;
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    let run_id = body_json(resp).await["run_id"]
        .as_str()
        .expect("run_id")
        .to_owned();
    assert_eq!(
        run_kind(&router, &run_id).await,
        "diarize",
        "the stage produces a diarize run"
    );
}

#[tokio::test]
async fn rerunning_diarize_appends_another_diarize_run_only() {
    // Independence: running diarize twice yields two distinct diarize runs and
    // never a transcribe run (launch_run is hard-coded to RunKind::Diarize).
    let (router, _state) = no_model_app("se-di-rerun");
    create_session(&router, "s1").await;
    upload_audio(&router, "s1").await;

    let r1 = body_json(submit_diarize(&router, "s1", "").await).await["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let r2 = body_json(submit_diarize(&router, "s1", "").await).await["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(r1, r2, "each diarize run gets its own id");
    assert_eq!(run_kind(&router, &r1).await, "diarize");
    assert_eq!(run_kind(&router, &r2).await, "diarize");
}

async fn post_ai(router: &Router, id: &str) -> axum::http::Response<Body> {
    router
        .clone()
        .oneshot(
            Request::post(format!("/items/{id}/ai"))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"prompt":"summarize"}"#))
                .unwrap(),
        )
        .await
        .expect("infallible")
}

#[tokio::test]
async fn ai_unknown_item_is_404() {
    let resp = post_ai(&no_model_router("se-ai-404"), "ghost").await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn ai_without_transcript_is_409() {
    let (router, _state) = no_model_app("se-ai-409");
    create_session(&router, "s1").await; // exists, but no transcript
    let resp = post_ai(&router, "s1").await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn ai_with_transcript_passes_the_dag_gate() {
    // Seed a meeting item WITH transcript segments via the public API, so the
    // 409 transcript gate opens; the LLM gate then decides 503 (unconfigured)
    // vs 202 (configured) — asserted deterministically against the config.
    let (router, state) = no_model_app("se-ai-gate");
    let create = Request::post("/v1/meetings")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"id":"m1","filename":"m.wav","result":{"segments":[{"text":"hello world","start":0,"end":1}]}}"#,
        ))
        .unwrap();
    let r = router.clone().oneshot(create).await.expect("infallible");
    assert_eq!(r.status(), StatusCode::CREATED, "seed meeting transcript");

    let resp = post_ai(&router, "m1").await;
    // Transcript present -> NOT 409/404; the LLM gate decides the rest.
    if state.llm().configured() {
        assert_eq!(
            resp.status(),
            StatusCode::ACCEPTED,
            "transcript + configured LLM -> 202"
        );
    } else {
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "transcript present but LLM unconfigured -> 503 (the gate opened past 409)"
        );
    }
}
