//! Integration tests for item metadata (item-metadata): title / starred /
//! project / category on sessions and meetings, via PATCH + list filtering.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

use common::{body_json, get_json, no_model_app, no_model_router};

async fn create_session(router: &Router, id: &str) {
    let resp = router
        .clone()
        .oneshot(
            Request::post("/v1/sessions")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"id":"{id}","started_at":{},"mode":"batch"}}"#,
                    id.len()
                )))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CREATED, "create session {id}");
}

async fn patch(router: &Router, path: &str, json: &str) -> axum::http::Response<Body> {
    router
        .clone()
        .oneshot(
            Request::patch(path)
                .header("content-type", "application/json")
                .body(Body::from(json.to_owned()))
                .unwrap(),
        )
        .await
        .expect("infallible")
}

// ---------- task 2.1: session metadata get + patch ----------

#[tokio::test]
async fn patch_session_sets_and_returns_metadata() {
    let (router, _state) = no_model_app("im-sess-patch");
    create_session(&router, "s1").await;

    let resp = patch(
        &router,
        "/v1/sessions/s1",
        r#"{"title":"Standup","starred":true,"category":"meeting"}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["title"], serde_json::json!("Standup"));
    assert_eq!(body["starred"], serde_json::json!(true));
    assert_eq!(body["category"], serde_json::json!("meeting"));
    assert!(body["project"].is_null(), "an unset field stays null");

    // Re-fetch to confirm persistence.
    let (_st, fetched) = get_json(router, "/v1/sessions/s1").await;
    assert_eq!(fetched["title"], serde_json::json!("Standup"));
    assert_eq!(fetched["starred"], serde_json::json!(true));
}

#[tokio::test]
async fn patch_unknown_session_is_404() {
    let resp = patch(
        &no_model_router("im-sess-404"),
        "/v1/sessions/ghost",
        r#"{"starred":true}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ---------- task 2.2: session list filtering ----------

fn ids(list: &serde_json::Value, key: &str) -> Vec<String> {
    list[key]
        .as_array()
        .expect("array")
        .iter()
        .map(|s| s["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn session_list_filters_by_metadata() {
    let (router, _state) = no_model_app("im-sess-filter");
    create_session(&router, "s1").await;
    create_session(&router, "s2").await;
    patch(
        &router,
        "/v1/sessions/s1",
        r#"{"starred":true,"category":"quick"}"#,
    )
    .await;
    patch(&router, "/v1/sessions/s2", r#"{"category":"meeting"}"#).await;

    let (_st, all) = get_json(router.clone(), "/v1/sessions").await;
    assert_eq!(ids(&all, "sessions").len(), 2, "no filter returns both");

    let (_st, starred) = get_json(router.clone(), "/v1/sessions?starred=true").await;
    assert_eq!(
        ids(&starred, "sessions"),
        vec!["s1"],
        "only the starred session"
    );

    let (_st, by_cat) = get_json(router, "/v1/sessions?category=meeting").await;
    assert_eq!(
        ids(&by_cat, "sessions"),
        vec!["s2"],
        "only the meeting-category session"
    );
}

// ---------- task 3.1 / 3.2: meeting metadata + filtering ----------

async fn create_meeting(router: &Router, id: &str) {
    let resp = router
        .clone()
        .oneshot(
            Request::post("/v1/meetings")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"id":"{id}","filename":"m.wav","result":{{"segments":[]}}}}"#
                )))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::CREATED, "create meeting {id}");
}

#[tokio::test]
async fn patch_meeting_sets_and_returns_metadata() {
    let (router, _state) = no_model_app("im-meet-patch");
    create_meeting(&router, "m1").await;

    let resp = patch(
        &router,
        "/v1/meetings/m1",
        r#"{"title":"Q3 Review","starred":true,"project":"planning","category":"meeting"}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["title"], serde_json::json!("Q3 Review"));
    assert_eq!(body["starred"], serde_json::json!(true));
    assert_eq!(body["project"], serde_json::json!("planning"));
    assert_eq!(body["category"], serde_json::json!("meeting"));
}

#[tokio::test]
async fn patch_unknown_meeting_is_404() {
    let resp = patch(
        &no_model_router("im-meet-404"),
        "/v1/meetings/ghost",
        r#"{"starred":true}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn meeting_list_filters_by_metadata() {
    let (router, _state) = no_model_app("im-meet-filter");
    create_meeting(&router, "m1").await;
    create_meeting(&router, "m2").await;
    patch(&router, "/v1/meetings/m1", r#"{"starred":true}"#).await;

    let (_st, all) = get_json(router.clone(), "/v1/meetings").await;
    assert_eq!(ids(&all, "meetings").len(), 2, "no filter returns both");

    let (_st, starred) = get_json(router, "/v1/meetings?starred=true").await;
    assert_eq!(
        ids(&starred, "meetings"),
        vec!["m1"],
        "only the starred meeting"
    );
}
