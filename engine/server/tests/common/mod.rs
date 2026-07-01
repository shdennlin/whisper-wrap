//! Shared integration harness: a zero-weights AppState + router driven
//! in-memory via tower::oneshot — no TCP, no real model files.
// Each test binary links this module but uses only the helpers it needs, so
// the unused ones are expected — not dead code.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;
use whisper_wrap_core::{registry, Config};
use whisper_wrap_server::ai_config::AiConfigStore;
use whisper_wrap_server::history::HistoryDb;
use whisper_wrap_server::{build_router, AppState};

pub const REGISTRY_YAML: &str = r#"
models:
  breeze-asr-25:
    description: "test"
    variants:
      - format: ggml
        quant: q6_k
        filename: ggml-breeze-asr-25-q6_k.bin
        local_dir: breeze-asr-25-ggml
  whisper-small-test:
    description: "test — registered, non-active, weights absent (sorts after breeze so /models[0] stays breeze)"
    variants:
      - format: ggml
        quant: q5_0
        filename: ggml-whisper-small-test.bin
        local_dir: whisper-small-test-ggml
"#;

/// Fresh per-test sandbox under the OS temp dir (no tempfile dep; the
/// process id + test name keep parallel runs apart).
pub fn sandbox(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ww-no-model-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create sandbox");
    dir
}

pub fn no_model_router(test: &str) -> Router {
    no_model_app(test).0
}

pub fn no_model_app(test: &str) -> (Router, Arc<AppState>) {
    no_model_app_inner(test, None)
}

/// Same zero-weights harness but with the `engine_token` gate enabled, so
/// token-exemption / 401-vs-404 behavior can be exercised.
pub fn no_model_router_with_token(test: &str, token: &str) -> Router {
    no_model_app_inner(test, Some(token.to_owned())).0
}

fn no_model_app_inner(test: &str, engine_token: Option<String>) -> (Router, Arc<AppState>) {
    let base = sandbox(test);
    let reg_path = base.join("models.yaml");
    std::fs::write(&reg_path, REGISTRY_YAML).expect("write registry");

    let mut config = Config::from_env();
    config.engine_token = engine_token;
    config.registry_path = reg_path;
    config.models_dir = base.join("models"); // empty — zero weights installed
    config.model_dir = None;
    config.model_name = "breeze-asr-25".into();
    config.temp_dir = base.join("tmp");
    config.data_dir = base.join("data");
    // Hermetic diarization paths — host models/ must never leak in.
    config.diarize_seg_model = base.join("diarization/segmentation.onnx");
    config.diarize_emb_model = base.join("diarization/embedding.onnx");
    config.diarize_emb_model_balanced = base.join("diarization/embedding-balanced.onnx");
    std::fs::create_dir_all(&config.temp_dir).expect("temp dir");
    std::fs::create_dir_all(&config.data_dir).expect("data dir");

    // Mirrors main.rs: lenient resolve succeeds, weights absent → no engine.
    let model = registry::resolve_active_model_lenient(&config).expect("lenient resolve");
    assert!(!model.bin_path.is_file(), "sandbox must have no weights");

    let ai_config = AiConfigStore::new(config.clone());
    let llm = ai_config.build_client();
    let history = HistoryDb::open(&config.data_dir).expect("history db");
    let state = Arc::new(AppState::new(
        config,
        model,
        None,
        llm,
        ai_config,
        vec![],
        vec![],
        history,
    ));
    (build_router(Arc::clone(&state), None), state)
}

pub async fn get_json(router: Router, path: &str) -> (StatusCode, serde_json::Value) {
    let resp = router
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .expect("infallible");
    let status = resp.status();
    let bytes = resp.into_body().collect().await.expect("body").to_bytes();
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}

pub async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.expect("body").to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

/// Minimal valid 16 kHz mono s16le WAV (0.1 s of silence) — enough to get
/// past the MIME sniff + ffmpeg decode and reach the engine check.
pub fn tiny_wav() -> Vec<u8> {
    let samples: u32 = 1600;
    let data_len = samples * 2;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
    wav.extend_from_slice(&32000u32.to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend(std::iter::repeat_n(0u8, data_len as usize));
    wav
}

/// Create an empty placeholder file (parents included) — availability
/// gates only check `is_file()`.
pub fn touch(path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(path, b"").expect("touch");
}
