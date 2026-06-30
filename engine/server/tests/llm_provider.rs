//! Integration tests for llm-provider-abstraction: the /status AI privacy
//! indicator and the per-call model override on POST /ask. Real provider
//! round-trips need a configured endpoint and are verified manually.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use common::{get_json, no_model_app};

// ---------- task 4.1: /status AI privacy indicator ----------

#[tokio::test]
async fn status_reports_ai_provider_endpoint_without_key() {
    let (_st, body) = get_json(no_model_app("llm-status").0, "/status").await;
    let ai = &body["ai"];
    assert!(ai["provider"].is_string(), "ai.provider is a string: {ai}");
    assert!(ai["endpoint"].is_string(), "ai.endpoint is a string");
    assert!(ai["configured"].is_boolean(), "ai.configured is a boolean");
    assert!(ai.get("model").is_some(), "ai.model present");
    // Default provider with no LLM_* config -> gemini.
    assert_eq!(ai["provider"], serde_json::json!("gemini"));
    // The key is never surfaced.
    assert!(
        ai.get("key").is_none() && ai.get("api_key").is_none(),
        "no key in /status ai"
    );
}

// ---------- task 3.1: per-call model on POST /ask ----------

#[tokio::test]
async fn ask_accepts_per_call_model() {
    let (router, state) = no_model_app("llm-ask-model");
    let resp = router
        .oneshot(
            Request::post("/ask?model=some-model")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"hello"}"#))
                .unwrap(),
        )
        .await
        .expect("infallible");
    // The ?model= override is accepted — never a 400 bad request.
    assert_ne!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "?model= must be accepted"
    );
    if !state.llm().configured() {
        // Unconfigured provider -> the not-configured path (502), proving the
        // request reached the LLM layer with the model accepted.
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
