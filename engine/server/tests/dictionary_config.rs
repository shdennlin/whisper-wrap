//! Integration tests for zh-convert-dictionary (the `/config/dictionary`
//! surface and the `DictionaryConfigStore`). Driven in-memory via
//! tower::oneshot on the zero-weights harness — no TCP, no real model files.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;
use whisper_wrap_server::dictionary_config::DictionaryConfigStore;

use common::{body_json, get_json, no_model_app, no_model_router, sandbox};

fn put_dictionary(body: serde_json::Value) -> Request<Body> {
    Request::put("/config/dictionary")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

// ---------- task 2.1: defaults, round-trip, validation ----------

#[tokio::test]
async fn get_returns_defaults_when_no_file() {
    let router = no_model_router("dc-defaults");
    let (status, body) = get_json(router, "/config/dictionary").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "zh_convert": "off", "replacements": [] }));
}

#[tokio::test]
async fn put_round_trips_and_get_reflects_it() {
    let (router, _state) = no_model_app("dc-roundtrip");
    let cfg = json!({
        "zh_convert": "s2tw",
        "replacements": [ { "from": "Cloud Code", "to": "Claude Code" } ]
    });
    let resp = router
        .clone()
        .oneshot(put_dictionary(cfg.clone()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await, cfg);

    let (status, body) = get_json(router, "/config/dictionary").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, cfg);
}

#[tokio::test]
async fn config_persists_across_store_reopen() {
    let (router, state) = no_model_app("dc-reopen");
    let cfg = json!({
        "zh_convert": "s2tw",
        "replacements": [ { "from": "云端", "to": "雲端硬碟" } ]
    });
    let resp = router.oneshot(put_dictionary(cfg)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // A fresh store over the same data_dir sees the persisted document.
    let reopened = DictionaryConfigStore::new(&state.config.data_dir);
    let got = serde_json::to_value(reopened.get()).unwrap();
    assert_eq!(got["zh_convert"], "s2tw");
    assert_eq!(got["replacements"][0]["from"], "云端");
    assert_eq!(got["replacements"][0]["to"], "雲端硬碟");
}

// The spec's validation matrix: each invalid PUT is a 400 with the standard
// ApiError shape (`{"detail": ...}`) and MUST leave the stored config
// unchanged.
#[tokio::test]
async fn put_rejects_invalid_bodies_and_keeps_stored_config() {
    let (router, _state) = no_model_app("dc-validate");
    let invalid = [
        // `from` empty after trimming.
        json!({ "zh_convert": "off", "replacements": [ { "from": "", "to": "x" } ] }),
        json!({ "zh_convert": "off", "replacements": [ { "from": "   ", "to": "x" } ] }),
        // Unknown conversion mode (s2twp is deliberately not offered).
        json!({ "zh_convert": "s2twp", "replacements": [] }),
        json!({ "zh_convert": "traditional", "replacements": [] }),
    ];
    for body in invalid {
        let resp = router
            .clone()
            .oneshot(put_dictionary(body.clone()))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "body: {body}");
        let err = body_json(resp).await;
        assert!(err["detail"].is_string(), "ApiError shape: {err}");
    }

    // Cap: 1001 pairs -> 400.
    let too_many: Vec<_> = (0..1001)
        .map(|i| json!({ "from": format!("w{i}"), "to": "x" }))
        .collect();
    let resp = router
        .clone()
        .oneshot(put_dictionary(
            json!({ "zh_convert": "off", "replacements": too_many }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Exactly 1000 pairs is allowed (boundary).
    let at_cap: Vec<_> = (0..1000)
        .map(|i| json!({ "from": format!("w{i}"), "to": "x" }))
        .collect();
    let resp = router
        .clone()
        .oneshot(put_dictionary(
            json!({ "zh_convert": "off", "replacements": at_cap }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejected_put_leaves_stored_config_unchanged() {
    let router = no_model_router("dc-unchanged");
    let resp = router
        .clone()
        .oneshot(put_dictionary(
            json!({ "zh_convert": "s2twp", "replacements": [] }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let (_, body) = get_json(router, "/config/dictionary").await;
    assert_eq!(body, json!({ "zh_convert": "off", "replacements": [] }));
}

// ---------- task 2.2: degradation semantics ----------

#[test]
fn missing_file_yields_defaults() {
    let dir = sandbox("dc-nofile");
    let store = DictionaryConfigStore::new(&dir);
    let got = serde_json::to_value(store.get()).unwrap();
    assert_eq!(got, json!({ "zh_convert": "off", "replacements": [] }));
}

#[test]
fn malformed_file_falls_back_to_defaults() {
    let dir = sandbox("dc-malformed");
    std::fs::write(dir.join("dictionary_config.json"), "{not json!").unwrap();
    let store = DictionaryConfigStore::new(&dir);
    let got = serde_json::to_value(store.get()).unwrap();
    assert_eq!(got, json!({ "zh_convert": "off", "replacements": [] }));
}

#[cfg(unix)]
#[test]
fn write_failure_keeps_accepted_config_effective_in_memory() {
    use std::os::unix::fs::PermissionsExt;
    let dir = sandbox("dc-rofail");
    let store = DictionaryConfigStore::new(&dir);
    // Make the directory read-only so the persist fails.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let cfg: whisper_wrap_server::dictionary_config::DictionaryConfig =
        serde_json::from_value(json!({
            "zh_convert": "s2tw",
            "replacements": [ { "from": "a", "to": "b" } ]
        }))
        .unwrap();
    store.save(cfg.clone());
    // The accepted config stays effective for the running process.
    assert_eq!(store.get(), cfg);
    // Restore perms so the sandbox can be cleaned up by later runs.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    // And a re-open (fresh process) falls back to defaults — nothing was written.
    let reopened = DictionaryConfigStore::new(&dir);
    let got = serde_json::to_value(reopened.get()).unwrap();
    assert_eq!(got, json!({ "zh_convert": "off", "replacements": [] }));
}
