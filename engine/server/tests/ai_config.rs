//! Integration tests for ai-provider-settings (the `/config/ai` surface and
//! the `AiConfigStore`). Driven in-memory via tower::oneshot — no TCP, no real
//! model files, no real provider round-trips.

mod common;

use std::path::Path;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use whisper_wrap_core::Config;
use whisper_wrap_server::ai_config::AiConfigStore;

use common::{body_json, no_model_app, sandbox};

// ---------- task 1.1: resolution (stored-file > env > default) ----------

fn base_config(dir: &Path) -> Config {
    let mut c = Config::from_env();
    c.data_dir = dir.to_path_buf();
    // Pin env-derived fields so the test does not depend on the host env.
    c.llm_provider = Some("gemini".into());
    c.gemini_model = Some("env-model".into());
    c.gemini_api_key = None;
    c
}

#[test]
fn no_file_resolves_to_env_baseline() {
    let dir = sandbox("ac-nofile");
    let store = AiConfigStore::new(base_config(&dir));
    let resolved = store.resolve();
    assert_eq!(resolved.gemini_model.as_deref(), Some("env-model"));
    assert_eq!(resolved.llm_provider.as_deref(), Some("gemini"));
}

#[test]
fn stored_model_overrides_env() {
    let dir = sandbox("ac-override");
    std::fs::write(
        dir.join("llm_config.json"),
        r#"{"provider":"gemini","model":"stored-model"}"#,
    )
    .unwrap();
    let store = AiConfigStore::new(base_config(&dir));
    let resolved = store.resolve();
    assert_eq!(resolved.gemini_model.as_deref(), Some("stored-model"));
}

#[test]
fn malformed_json_falls_back_without_panic() {
    let dir = sandbox("ac-malformed");
    std::fs::write(dir.join("llm_config.json"), "{ this is not json").unwrap();
    let store = AiConfigStore::new(base_config(&dir));
    // Must not panic; falls back to env baseline.
    let resolved = store.resolve();
    assert_eq!(resolved.gemini_model.as_deref(), Some("env-model"));
}

// ---------- task 1.2: masking + write-through ----------

#[test]
fn mask_format_matches_example() {
    assert_eq!(
        AiConfigStore::mask("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxx9b2c"),
        "AIza…9b2c"
    );
}

#[test]
fn mask_short_key_degrades_gracefully() {
    // A short key must not panic or leak the whole secret on byte boundaries.
    let hint = AiConfigStore::mask("abc");
    assert!(!hint.contains("abc") || hint.len() <= "abc".len() + 1);
    assert_ne!(AiConfigStore::mask(""), "");
    // empty key -> empty-ish hint is acceptable; just must not panic.
    let _ = AiConfigStore::mask("");
}

#[test]
fn read_masked_never_exposes_raw_key() {
    let dir = sandbox("ac-readmask");
    std::fs::write(
        dir.join("llm_config.json"),
        r#"{"provider":"gemini","model":"m","api_key":"AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxx9b2c"}"#,
    )
    .unwrap();
    let store = AiConfigStore::new(base_config(&dir));
    let view = store.read_masked();
    let json = serde_json::to_string(&view).unwrap();
    assert!(!json.contains("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxx9b2c"));
    assert!(view.key_set);
    assert_eq!(view.key_hint, "AIza…9b2c");
}

#[test]
fn save_empty_key_preserves_stored_key() {
    let dir = sandbox("ac-keepkey");
    let store = AiConfigStore::new(base_config(&dir));
    let _ = store.save(serde_json::json!({
        "provider":"gemini","baseUrl":"","model":"m1","apiKey":"secret-key-123456"
    }));
    // Save again with empty apiKey + changed model.
    let view = store.save(serde_json::json!({
        "provider":"gemini","baseUrl":"","model":"m2","apiKey":""
    }));
    assert_eq!(view.model, "m2");
    assert!(view.key_set, "empty apiKey must keep the stored key");
    // The resolved config still carries the original key.
    assert_eq!(
        store.resolve().gemini_api_key.as_deref(),
        Some("secret-key-123456")
    );
}

#[test]
fn save_non_empty_key_replaces_it() {
    let dir = sandbox("ac-replacekey");
    let store = AiConfigStore::new(base_config(&dir));
    let _ = store.save(serde_json::json!({
        "provider":"gemini","baseUrl":"","model":"m","apiKey":"old-key-aaaaaaaa"
    }));
    let _ = store.save(serde_json::json!({
        "provider":"gemini","baseUrl":"","model":"m","apiKey":"new-key-bbbbbbbb"
    }));
    assert_eq!(
        store.resolve().gemini_api_key.as_deref(),
        Some("new-key-bbbbbbbb")
    );
}

#[cfg(unix)]
#[test]
fn saved_file_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = sandbox("ac-perms");
    let store = AiConfigStore::new(base_config(&dir));
    let _ = store.save(serde_json::json!({
        "provider":"gemini","baseUrl":"","model":"m","apiKey":"k"
    }));
    let meta = std::fs::metadata(dir.join("llm_config.json")).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
}

// ---------- task 3.2: HTTP endpoints ----------

#[tokio::test]
async fn get_config_ai_masks_key_and_omits_raw() {
    let (router, _state) = no_model_app("ac-get");
    // Seed a stored key via PUT first.
    let put = Request::put("/config/ai")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"gemini","baseUrl":"","model":"gx","apiKey":"AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxx9b2c"}"#,
        ))
        .unwrap();
    let r = router.clone().oneshot(put).await.expect("infallible");
    assert_eq!(r.status(), StatusCode::OK);

    let get = Request::get("/config/ai").body(Body::empty()).unwrap();
    let resp = router.oneshot(get).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["keySet"], serde_json::json!(true));
    assert_eq!(v["keyHint"], serde_json::json!("AIza…9b2c"));
    let raw = serde_json::to_string(&v).unwrap();
    assert!(
        !raw.contains("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxx9b2c"),
        "raw key must never be returned"
    );
    assert!(v.get("apiKey").is_none(), "no apiKey field on read");
}

#[tokio::test]
async fn put_then_get_round_trips_model() {
    let (router, _state) = no_model_app("ac-roundtrip");
    let put = Request::put("/config/ai")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"gemini","baseUrl":"","model":"new-model","apiKey":"k1234567"}"#,
        ))
        .unwrap();
    let r = router.clone().oneshot(put).await.expect("infallible");
    assert_eq!(r.status(), StatusCode::OK);
    let pv = body_json(r).await;
    assert_eq!(pv["model"], serde_json::json!("new-model"));

    let get = Request::get("/config/ai").body(Body::empty()).unwrap();
    let resp = router.oneshot(get).await.expect("infallible");
    let v = body_json(resp).await;
    assert_eq!(v["model"], serde_json::json!("new-model"));
    assert_eq!(v["provider"], serde_json::json!("gemini"));
}

#[tokio::test]
async fn put_invalid_provider_is_400() {
    let (router, _state) = no_model_app("ac-badprovider");
    let put = Request::put("/config/ai")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"bogus","baseUrl":"","model":"m","apiKey":""}"#,
        ))
        .unwrap();
    let r = router.oneshot(put).await.expect("infallible");
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn put_swaps_live_client() {
    let (router, state) = no_model_app("ac-swap");
    let put = Request::put("/config/ai")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"gemini","baseUrl":"","model":"swapped-model","apiKey":"k1234567"}"#,
        ))
        .unwrap();
    let r = router.oneshot(put).await.expect("infallible");
    assert_eq!(r.status(), StatusCode::OK);
    // The live client reflects the new model with no restart.
    assert_eq!(state.llm().model(), "swapped-model");
}

#[tokio::test]
async fn models_endpoint_failure_returns_empty_list_not_5xx() {
    let (router, _state) = no_model_app("ac-models-fail");
    // Unreachable base url -> fetch fails, but the endpoint returns 200.
    let get = Request::get(
        "/config/ai/models?provider=openai-compatible&baseUrl=http://127.0.0.1:1/v1&apiKey=",
    )
    .body(Body::empty())
    .unwrap();
    let resp = router.oneshot(get).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["models"], serde_json::json!([]));
    assert!(v["error"].is_string(), "non-null error on failure: {v}");
}

#[tokio::test]
async fn test_endpoint_does_not_persist() {
    let (router, _state) = no_model_app("ac-test-nopersist");
    // Seed stored config.
    let put = Request::put("/config/ai")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"gemini","baseUrl":"","model":"stored","apiKey":"k1234567"}"#,
        ))
        .unwrap();
    router.clone().oneshot(put).await.expect("infallible");

    // Test a DIFFERENT config (unreachable openai-compat) -> ok:false, no persist.
    let test = Request::post("/config/ai/test")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"provider":"openai-compatible","baseUrl":"http://127.0.0.1:1/v1","model":"x","apiKey":""}"#,
        ))
        .unwrap();
    let resp = router.clone().oneshot(test).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["ok"], serde_json::json!(false));

    // Stored config is untouched.
    let get = Request::get("/config/ai").body(Body::empty()).unwrap();
    let resp = router.oneshot(get).await.expect("infallible");
    let v = body_json(resp).await;
    assert_eq!(v["model"], serde_json::json!("stored"));
    assert_eq!(v["provider"], serde_json::json!("gemini"));
}
