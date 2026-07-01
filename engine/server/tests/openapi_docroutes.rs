//! Behavior of the two doc-serving routes across build profiles:
//!
//! - debug — `/openapi.json` (3.1 JSON) and `/docs` (Scalar HTML) are served,
//!   token-exempt even with `engine_token` auth enabled (200, not 401);
//! - release — both routes are compiled out and return 404 (never 401), even
//!   under a token-enabled router, while other routes are unaffected.
//!
//! Covers tasks 3.1 (JSON doc), 3.2 (docs UI), 3.3 (token-exempt), 3.4 (release
//! 404-not-401).

mod common;

#[cfg(debug_assertions)]
mod debug_build {
    use crate::common::{no_model_router, no_model_router_with_token};
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    // 3.1 — GET /openapi.json returns application/json with openapi: 3.1.x.
    #[tokio::test]
    async fn openapi_json_is_a_3_1_document() {
        let resp = no_model_router("docroute-json")
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let ct = resp
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        assert!(
            ct.starts_with("application/json"),
            "content-type is application/json, got {ct:?}"
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let version = doc["openapi"].as_str().unwrap_or_default();
        assert!(version.starts_with("3.1"), "openapi 3.1.x, got {version:?}");
    }

    // 3.2 — GET /docs returns text/html rendering the Scalar explorer.
    #[tokio::test]
    async fn docs_ui_is_html() {
        let resp = no_model_router("docroute-html")
            .oneshot(Request::get("/docs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let ct = resp
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        assert!(
            ct.starts_with("text/html"),
            "content-type is text/html, got {ct:?}"
        );
    }

    // 3.3 — with token auth enabled, both doc routes are reachable WITHOUT a
    // token (200, not 401).
    #[tokio::test]
    async fn doc_routes_are_token_exempt() {
        for path in ["/openapi.json", "/docs"] {
            let code = no_model_router_with_token("docroute-exempt", "secret")
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status();
            assert_eq!(code, 200, "{path} is token-exempt (200, not 401)");
        }
    }
}

#[cfg(not(debug_assertions))]
mod release_build {
    use crate::common::no_model_router_with_token;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    // 3.4 — in a release build both doc routes are compiled out. Under a
    // TOKEN-ENABLED router and a tokenless request they must return 404 (route
    // absent, but path unconditionally token-exempt) — never 401 — while a
    // sampled non-doc route (/status) is unaffected.
    #[tokio::test]
    async fn doc_routes_are_404_not_401_in_release() {
        for path in ["/openapi.json", "/docs"] {
            let code = no_model_router_with_token("docroute-release", "secret")
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status();
            assert_eq!(code, 404, "{path} is compiled out → 404, never 401");
        }
        // /status stays exempt and reachable even with a token configured.
        let status = no_model_router_with_token("docroute-release-status", "secret")
            .oneshot(Request::get("/status").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status();
        assert_eq!(status, 200, "/status is unaffected");
    }
}
