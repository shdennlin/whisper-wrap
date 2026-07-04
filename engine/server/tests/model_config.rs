//! Boot-time persistence of the active-model selection: a model picked via
//! `POST /models/active` must survive a restart. The harness mirrors
//! main.rs boot, so seeding `data/model_config.json` before boot and reading
//! `GET /models` exercises the same resolution the server binary runs.

mod common;

use axum::http::StatusCode;
use common::{get_json, no_model_app_seeded};

/// A persisted selection (still present in the registry) wins over the
/// env/default model name at boot — the restart-survival contract.
#[tokio::test]
async fn boot_honors_persisted_active_model() {
    let (router, _state) = no_model_app_seeded("mc-boot-honors-persisted", |data_dir| {
        std::fs::write(
            data_dir.join("model_config.json"),
            r#"{ "active_model": "whisper-small-test" }"#,
        )
        .expect("seed model_config.json");
    });
    let (status, body) = get_json(router, "/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["active"], "whisper-small-test");
    // Weights are absent in the sandbox — the selection is remembered even
    // though nothing is loaded yet (same lenient contract as env boot).
    assert_eq!(body["loaded"], false);
}

/// A stale selection (model no longer in the registry) must not break boot —
/// fall back to the env/default name.
#[tokio::test]
async fn boot_falls_back_when_persisted_model_unknown() {
    let (router, _state) = no_model_app_seeded("mc-boot-unknown-fallback", |data_dir| {
        std::fs::write(
            data_dir.join("model_config.json"),
            r#"{ "active_model": "removed-from-registry" }"#,
        )
        .expect("seed model_config.json");
    });
    let (status, body) = get_json(router, "/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["active"], "breeze-asr-25");
}

/// Malformed JSON degrades like the sibling stores: warn + fall through to
/// the env/default, never a boot crash.
#[tokio::test]
async fn boot_ignores_malformed_model_config() {
    let (router, _state) = no_model_app_seeded("mc-boot-malformed", |data_dir| {
        std::fs::write(data_dir.join("model_config.json"), b"{ not json")
            .expect("seed model_config.json");
    });
    let (status, body) = get_json(router, "/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["active"], "breeze-asr-25");
}
