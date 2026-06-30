//! Meeting quality tiers (beta.4 dropdown): ?quality=fast|balanced on
//! POST /transcribe/meeting. Fast uses the existing CAM++ embedding;
//! Balanced swaps in a second embedding ONNX. Availability gates and
//! /status tier reporting are file-presence checks, so they're testable
//! with empty placeholder files — no real models needed.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use common::{body_json, get_json, no_model_app, tiny_wav, touch};

fn submit(query: &str) -> Request<Body> {
    Request::post(format!("/transcribe/meeting{query}"))
        .header("content-type", "audio/wav")
        .body(Body::from(tiny_wav()))
        .unwrap()
}

#[tokio::test]
async fn invalid_quality_is_400_even_before_availability() {
    // Empty sandbox: no diarization models at all. Input validation must
    // win over the 503 availability gate.
    let (router, _state) = no_model_app("mq-invalid");
    let resp = router
        .oneshot(submit("?quality=ultra"))
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = body_json(resp).await;
    assert_eq!(
        body["detail"]["error"],
        serde_json::json!("invalid_quality")
    );
}

#[tokio::test]
async fn balanced_without_its_model_is_503_naming_the_balanced_path() {
    let (router, state) = no_model_app("mq-balanced-missing");
    // Fast tier is installed; the balanced embedding is not.
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model);

    let resp = router
        .oneshot(submit("?quality=balanced"))
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = body_json(resp).await;
    assert_eq!(
        body["detail"]["error"],
        serde_json::json!("meeting_unavailable")
    );
    let reason = body["detail"]["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("embedding-balanced.onnx"),
        "reason must name the missing balanced model, got: {reason}"
    );
}

#[tokio::test]
async fn fast_and_default_submissions_are_accepted() {
    let (router, state) = no_model_app("mq-accept");
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model);

    for query in ["", "?quality=fast"] {
        let resp = router
            .clone()
            .oneshot(submit(query))
            .await
            .expect("infallible");
        assert_eq!(resp.status(), StatusCode::ACCEPTED, "query {query:?}");
        let body = body_json(resp).await;
        assert!(body["job_id"].is_string());
    }
}

#[tokio::test]
async fn default_submission_falls_back_to_balanced_when_fast_absent() {
    // Balanced-only install: segmentation + the balanced embedding are
    // present, the fast embedding is NOT. An omitted `quality` must resolve
    // to the installed tier (balanced) rather than the hardcoded fast default
    // — otherwise a user who installed only the balanced model gets a 503.
    let (router, state) = no_model_app("mq-balanced-only");
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model_balanced);
    // diarize_emb_model (fast) intentionally left absent.

    let resp = router.oneshot(submit("")).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    let body = body_json(resp).await;
    assert!(body["job_id"].is_string());
}

#[tokio::test]
async fn poll_does_not_503_on_a_balanced_only_install() {
    // Balanced-only: segmentation + the balanced embedding installed, fast
    // absent. Polling a job's status must NOT re-gate on the fast tier — the
    // meeting feature is available (a tier is installed), and poll is a pure
    // status read. The bug returned a "fast tier" 503 from the poll endpoint.
    let (router, state) = no_model_app("mq-poll-balanced");
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model_balanced);

    // Omitted quality resolves to the installed (balanced) tier → job created.
    let resp = router.clone().oneshot(submit("")).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    let job_id = body_json(resp).await["job_id"]
        .as_str()
        .expect("job_id")
        .to_string();

    let poll = Request::get(format!("/transcribe/meeting/{job_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(poll).await.expect("infallible");
    assert_ne!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "poll must not 503 when a non-fast tier is installed"
    );
}

#[tokio::test]
async fn status_reports_available_quality_tiers() {
    // No diarization models → meeting unavailable, no tiers.
    let (router, state) = no_model_app("mq-tiers");
    let (_, body) = get_json(router.clone(), "/status").await;
    assert_eq!(body["meeting"]["available"], serde_json::json!(false));
    assert_eq!(body["meeting"]["quality_tiers"], serde_json::json!([]));

    // Fast pair installed → ["fast"].
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model);
    let (_, body) = get_json(router.clone(), "/status").await;
    assert_eq!(body["meeting"]["available"], serde_json::json!(true));
    assert_eq!(
        body["meeting"]["quality_tiers"],
        serde_json::json!(["fast"])
    );

    // Balanced embedding added → ["fast", "balanced"].
    touch(&state.config.diarize_emb_model_balanced);
    let (_, body) = get_json(router, "/status").await;
    assert_eq!(
        body["meeting"]["quality_tiers"],
        serde_json::json!(["fast", "balanced"])
    );
}
