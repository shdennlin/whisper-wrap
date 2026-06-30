//! Integration tests for the live session-change stream (live-library-push):
//! the broadcaster fires on session writes and `/v1/sessions/events` is wired
//! as a text/event-stream endpoint.
//!
//! The SSE body is never consumed here — driving the long-lived stream while
//! also issuing writes would block. Instead we subscribe to the same broadcast
//! channel the handler streams from and assert the write paths ping it, and we
//! check the endpoint's response headers without reading the body.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

use common::no_model_app;

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
    assert_eq!(resp.status(), StatusCode::CREATED, "create session {id}");
}

#[tokio::test]
async fn create_session_broadcasts_change() {
    let (router, state) = no_model_app("sse_create_broadcast");
    let mut rx = state.sessions_changed.subscribe();

    create_session(&router, "evt-create").await;

    assert!(
        rx.try_recv().is_ok(),
        "POST /v1/sessions should broadcast a session-change ping"
    );
}

#[tokio::test]
async fn finalize_broadcasts_change() {
    let (router, state) = no_model_app("sse_finalize_broadcast");
    create_session(&router, "evt-final").await;
    let mut rx = state.sessions_changed.subscribe();

    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v1/sessions/evt-final")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"ended_at":2,"duration_ms":1}"#))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK, "finalize");

    assert!(
        rx.try_recv().is_ok(),
        "PATCH (finalize) should broadcast a session-change ping"
    );
}

#[tokio::test]
async fn create_succeeds_with_no_subscribers() {
    // No one subscribed: notify must be a no-op, not an error.
    let (router, _state) = no_model_app("sse_no_subscribers");
    create_session(&router, "evt-nosub").await;
}

#[tokio::test]
async fn events_endpoint_is_event_stream() {
    let (router, _state) = no_model_app("sse_content_type");
    // Headers are available as soon as the handler returns the Sse response;
    // we drop it without polling the body stream (which would block forever).
    let resp = router
        .oneshot(
            Request::get("/v1/sessions/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        ct.starts_with("text/event-stream"),
        "expected SSE content-type, got {ct:?}"
    );
}
