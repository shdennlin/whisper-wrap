//! Drift guard: the generated OpenAPI document must document exactly the 51
//! API routes (method+path pairs across 38 unique paths) wired in
//! `build_router()` — no more, no less — and must NOT document the three
//! undocumented infrastructure entries (`/openapi.json`, `/docs`, `/app`).
//!
//! axum's `Router` cannot enumerate its own routes, so the expected set is a
//! hand-maintained constant here; `routes!()` guarantees a route wired through
//! the `OpenApiRouter` carries a `#[utoipa::path]` by construction, and this
//! test layers a list-vs-router check on top to catch a route present in the
//! expected list but never wired (or wired but missing from the list).
//!
//! Gated to debug builds: it fetches the debug-only `GET /openapi.json` route,
//! which is compiled out of release builds (see the "gated to debug builds"
//! requirement), so the whole file is empty under `cargo test --release`.
#![cfg(debug_assertions)]

mod common;

use std::collections::BTreeSet;

use axum::body::Body;
use axum::http::Request;
use common::no_model_router;
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The authoritative inventory: 51 (method, path) pairs across 38 unique paths.
/// Methods are lowercase to match OpenAPI path-item keys.
const EXPECTED: &[(&str, &str)] = &[
    // Core transcription / QA
    ("post", "/transcribe"),
    ("get", "/listen"),
    ("post", "/ask"),
    ("post", "/transcribe/meeting"),
    ("get", "/transcribe/meeting/{id}"),
    ("delete", "/transcribe/meeting/{id}"),
    // Items / runs
    ("get", "/runs/{id}"),
    ("post", "/items/{id}/transcribe"),
    ("post", "/items/{id}/diarize"),
    ("post", "/items/{id}/ai"),
    ("get", "/items/{id}/runs"),
    // OpenAI-compat
    ("post", "/v1/audio/transcriptions"),
    ("post", "/v1/audio/translations"),
    ("get", "/v1/models"),
    // Models
    ("get", "/models"),
    ("post", "/models/active"),
    ("post", "/models/download"),
    ("get", "/models/download/{name}"),
    ("delete", "/models/download/{name}"),
    ("delete", "/models/{name}"),
    // Aux-models
    ("get", "/aux-models"),
    ("post", "/aux-models/download"),
    ("get", "/aux-models/download/{id}"),
    ("delete", "/aux-models/download/{id}"),
    ("delete", "/aux-models/{id}"),
    // Sessions
    ("get", "/v1/sessions"),
    ("post", "/v1/sessions"),
    ("delete", "/v1/sessions/audio"),
    ("get", "/v1/sessions/events"),
    ("get", "/v1/sessions/{id}"),
    ("patch", "/v1/sessions/{id}"),
    ("delete", "/v1/sessions/{id}"),
    ("post", "/v1/sessions/{id}/finals"),
    ("post", "/v1/sessions/{id}/audio"),
    ("get", "/v1/sessions/{id}/audio"),
    // Meetings-history
    ("get", "/v1/meetings"),
    ("post", "/v1/meetings"),
    ("get", "/v1/meetings/{id}"),
    ("patch", "/v1/meetings/{id}"),
    ("delete", "/v1/meetings/{id}"),
    ("post", "/v1/meetings/{id}/audio"),
    ("get", "/v1/meetings/{id}/audio"),
    // AI-config
    ("get", "/config/ai"),
    ("put", "/config/ai"),
    ("get", "/config/ai/models"),
    ("post", "/config/ai/test"),
    // Dictionary config (zh-convert-dictionary)
    ("get", "/config/dictionary"),
    ("put", "/config/dictionary"),
    // Status / discovery
    ("get", "/actions"),
    ("get", "/status"),
    ("get", "/"),
];

/// The three infrastructure entries attached to the plain `Router` after
/// `split_for_parts()` — deliberately NOT documented.
const UNDOCUMENTED: &[&str] = &["/openapi.json", "/docs", "/app"];

#[tokio::test]
async fn documented_routes_match_the_51_route_inventory() {
    let router = no_model_router("openapi-coverage");
    let resp = router
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .expect("infallible");
    assert_eq!(resp.status(), 200, "debug build serves /openapi.json");
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let doc: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");

    let paths = doc["paths"].as_object().expect(".paths is an object");

    // Collect the documented (method, path) pairs — each method on a
    // multi-method path counts as its own pair (51, not 38).
    let documented: BTreeSet<(String, String)> = paths
        .iter()
        .flat_map(|(path, item)| {
            item.as_object()
                .expect("path item is an object")
                .keys()
                // Path-item keys are HTTP methods plus non-operation fields like
                // "parameters"/"summary"/"description"; keep only real methods.
                .filter(|k| {
                    matches!(
                        k.as_str(),
                        "get" | "put" | "post" | "delete" | "patch" | "head" | "options" | "trace"
                    )
                })
                .map(move |method| (method.clone(), path.clone()))
        })
        .collect();

    let expected: BTreeSet<(String, String)> = EXPECTED
        .iter()
        .map(|(m, p)| (m.to_string(), p.to_string()))
        .collect();

    let missing: Vec<_> = expected.difference(&documented).collect();
    let extra: Vec<_> = documented.difference(&expected).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "OpenAPI path drift.\n  missing from document (expected but not wired): {missing:?}\n  extra in document (wired but not expected): {extra:?}"
    );
    assert_eq!(documented.len(), 51, "exactly 51 method+path pairs");

    // The undocumented infrastructure entries must be absent from the document.
    for infra in UNDOCUMENTED {
        assert!(
            !paths.contains_key(*infra),
            "{infra} must not appear in the generated document"
        );
    }
}

/// No documented operation is a bare path stub: each carries a `tag` and at
/// least one declared response. (Guards the "Documented operations carry
/// params, responses, tags, and error schemas" requirement.)
#[tokio::test]
async fn no_operation_is_a_bare_stub() {
    let router = no_model_router("openapi-no-stub");
    let resp = router
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .expect("infallible");
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let doc: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
    let paths = doc["paths"].as_object().expect(".paths is an object");

    const METHODS: &[&str] = &["get", "put", "post", "delete", "patch"];
    let mut offenders = Vec::new();
    for (path, item) in paths {
        let item = item.as_object().unwrap();
        for (method, op) in item {
            if !METHODS.contains(&method.as_str()) {
                continue;
            }
            let has_tag = op
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let has_response = op
                .get("responses")
                .and_then(|r| r.as_object())
                .map(|o| !o.is_empty())
                .unwrap_or(false);
            if !has_tag || !has_response {
                offenders.push(format!(
                    "{method} {path} (tag={has_tag}, responses={has_response})"
                ));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "operations missing a tag or a response: {offenders:?}"
    );
}
