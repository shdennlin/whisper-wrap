//! Integration: a parakeet-nemotron model's multi-file ONNX artifact set
//! downloads as ONE logical unit — a single job with aggregated progress —
//! and installs all-or-nothing: failure or cancel partway must leave NO
//! partial artifact set behind (a 3/4 set would look forever half-installed,
//! since strict resolve requires the full set).
//!
//! The Hugging Face side is a local axum fixture server; `run_parakeet_download`
//! takes the base URL directly, and the endpoint flow test points the handler
//! at the fixture via the `HF_ENDPOINT` convention.

mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{Method, Request, StatusCode};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tower::ServiceExt;
use whisper_wrap_core::registry;
use whisper_wrap_server::models::{run_parakeet_download, DownloadJob};

use common::{body_json, get_json, no_model_app, touch};

const MODEL: &str = "parakeet-fixture";
const ARTIFACTS: [&str; 4] = [
    "encoder.onnx",
    "encoder.onnx.data",
    "decoder_joint.onnx",
    "tokenizer.model",
];
/// URL prefix `artifact_url` must produce for the fixture registry entry:
/// {repo_id}/resolve/main/{subfolder}/{filename}.
const FIXTURE_PREFIX: &str = "/test-org/parakeet-fixture/resolve/main/streaming-onnx";

fn inflight_job() -> DownloadJob {
    DownloadJob {
        status: "downloading",
        downloaded_bytes: 0,
        total_bytes: None,
        error: None,
        cancel: Arc::new(AtomicBool::new(false)),
    }
}

/// Serve `router` on an ephemeral local port; returns the base URL.
async fn spawn_fixture(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fixture");
    let addr: SocketAddr = listener.local_addr().expect("fixture addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("fixture serve");
    });
    format!("http://{addr}")
}

/// Deterministic per-artifact payload sizes (sum = 460_000).
fn artifact_bytes(file: &str) -> Vec<u8> {
    let len = match file {
        "encoder.onnx" => 150_000,
        "encoder.onnx.data" => 250_000,
        "decoder_joint.onnx" => 50_000,
        "tokenizer.model" => 10_000,
        other => panic!("unexpected artifact request: {other}"),
    };
    vec![7u8; len]
}

fn artifact_dir(state: &whisper_wrap_server::AppState) -> std::path::PathBuf {
    state.config.models_dir.join("parakeet-fixture-onnx")
}

fn dir_entries(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn parakeet_download_reports_already_present_when_all_artifacts_exist() {
    // POST /models/download for a parakeet model must take the multi-file
    // branch (not 404 on "no ggml variant") and short-circuit to
    // done/already_present when the FULL artifact set is on disk.
    let (router, state) = no_model_app("parakeet-dl-present");
    let dir = artifact_dir(&state);
    for f in ARTIFACTS {
        touch(&dir.join(f));
    }

    let req = Request::post("/models/download")
        .header("content-type", "application/json")
        .body(Body::from(format!(r#"{{"name":"{MODEL}"}}"#)))
        .unwrap();
    let resp = router.oneshot(req).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["status"], json!("done"));
    assert_eq!(body["already_present"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_multi_file_download_leaves_no_partial_install() {
    // CRITICAL invariant: the first artifact downloads fine, the second
    // fails → the completed first artifact (and the .part) must be removed,
    // the model must still resolve as not-installed, and GET /models must
    // report installed=false.
    let (router, state) = no_model_app("parakeet-dl-fail");
    let fixture = Router::new().route(
        &format!("{FIXTURE_PREFIX}/{{file}}"),
        get(|AxumPath(file): AxumPath<String>| async move {
            if file == "encoder.onnx" {
                (StatusCode::OK, artifact_bytes(&file))
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, Vec::new())
            }
        }),
    );
    let base = spawn_fixture(fixture).await;

    state
        .downloads
        .jobs
        .lock()
        .expect("dl lock")
        .insert(MODEL.into(), inflight_job());
    let specs = registry::parakeet_download_spec(&state.config, MODEL).expect("specs");
    let st = Arc::clone(&state);
    tokio::task::spawn_blocking(move || run_parakeet_download(st, MODEL.into(), specs, base))
        .await
        .expect("join");

    let job = state.downloads.jobs.lock().expect("dl lock")[MODEL].clone();
    assert_eq!(job.status, "error");
    assert!(job.error.is_some(), "error message must be surfaced");

    let leftovers = dir_entries(&artifact_dir(&state));
    assert!(
        leftovers.is_empty(),
        "no artifacts may survive a failed set, got {leftovers:?}"
    );
    assert!(matches!(
        registry::resolve_named_model(&state.config, MODEL),
        Err(registry::RegistryError::ModelFileMissing(_))
    ));

    let (status, body) = get_json(router, "/models").await;
    assert_eq!(status, StatusCode::OK);
    let entry = body["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == json!(MODEL))
        .expect("parakeet-fixture listed");
    assert_eq!(entry["installed"], json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_multi_file_download_removes_completed_artifacts() {
    // Cancel lands mid-set (while the second artifact streams): the worker
    // must remove the in-flight .part AND the already-completed first
    // artifact, then flip the job to "cancelled".
    let (_router, state) = no_model_app("parakeet-dl-cancel");
    state
        .downloads
        .jobs
        .lock()
        .expect("dl lock")
        .insert(MODEL.into(), inflight_job());
    let cancel = Arc::clone(&state.downloads.jobs.lock().expect("dl lock")[MODEL].cancel);

    let flip = Arc::clone(&cancel);
    let fixture = Router::new().route(
        &format!("{FIXTURE_PREFIX}/{{file}}"),
        get(move |method: Method, AxumPath(file): AxumPath<String>| {
            let flip = Arc::clone(&flip);
            async move {
                // Flip cancel only on the real GET of the second artifact —
                // a HEAD preflight for total-size must not trip it.
                if method == Method::GET && file == "encoder.onnx.data" {
                    flip.store(true, Ordering::Relaxed);
                }
                (StatusCode::OK, artifact_bytes(&file))
            }
        }),
    );
    let base = spawn_fixture(fixture).await;

    let specs = registry::parakeet_download_spec(&state.config, MODEL).expect("specs");
    let st = Arc::clone(&state);
    tokio::task::spawn_blocking(move || run_parakeet_download(st, MODEL.into(), specs, base))
        .await
        .expect("join");

    let job = state.downloads.jobs.lock().expect("dl lock")[MODEL].clone();
    assert_eq!(job.status, "cancelled");

    let leftovers = dir_entries(&artifact_dir(&state));
    assert!(
        leftovers.is_empty(),
        "cancel must remove completed artifacts too, got {leftovers:?}"
    );
    assert!(matches!(
        registry::resolve_named_model(&state.config, MODEL),
        Err(registry::RegistryError::ModelFileMissing(_))
    ));
}

#[tokio::test]
async fn delete_parakeet_model_removes_only_its_artifact_dir() {
    // For parakeet, `resolved.bin_path` IS the artifact directory —
    // `bin_path.parent()` is the whole models_dir, so the old whisper-shaped
    // delete would wipe EVERY installed model. Deleting the parakeet model
    // must remove exactly its artifact dir and leave siblings untouched.
    let (router, state) = no_model_app("parakeet-delete");
    let dir = artifact_dir(&state);
    for f in ARTIFACTS {
        touch(&dir.join(f));
    }
    let sibling = state
        .config
        .models_dir
        .join("whisper-small-test-ggml")
        .join("ggml-whisper-small-test.bin");
    touch(&sibling);

    let req = Request::delete(format!("/models/{MODEL}"))
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["removed"], json!(true));

    assert!(!dir.exists(), "parakeet artifact dir must be removed");
    assert!(
        sibling.is_file(),
        "sibling whisper model must survive a parakeet delete"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn download_endpoint_installs_full_parakeet_artifact_set() {
    // Full endpoint flow: POST /models/download → one job for the whole
    // set, aggregated byte counters, all four artifacts installed, and
    // GET /models flips to installed=true.
    let (router, state) = no_model_app("parakeet-dl-full");
    let fixture =
        Router::new().route(
            &format!("{FIXTURE_PREFIX}/{{file}}"),
            get(|AxumPath(file): AxumPath<String>| async move {
                (StatusCode::OK, artifact_bytes(&file))
            }),
        );
    let base = spawn_fixture(fixture).await;
    // HF_ENDPOINT is the hf-hub ecosystem's endpoint override; the only
    // test in this binary that reads it, so no cross-test race.
    std::env::set_var("HF_ENDPOINT", &base);

    let req = Request::post("/models/download")
        .header("content-type", "application/json")
        .body(Body::from(format!(r#"{{"name":"{MODEL}"}}"#)))
        .unwrap();
    let resp = router.clone().oneshot(req).await.expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["status"], json!("downloading"));

    // Poll GET /models/download/{name} until installed (or terminal error).
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (status, body) = get_json(router.clone(), &format!("/models/download/{MODEL}")).await;
        assert_eq!(status, StatusCode::OK);
        if body["installed"] == json!(true) {
            break;
        }
        assert_ne!(body["status"], json!("error"), "download failed: {body}");
        assert_ne!(
            body["status"],
            json!("cancelled"),
            "download cancelled: {body}"
        );
        assert!(Instant::now() < deadline, "timed out waiting: {body}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    std::env::remove_var("HF_ENDPOINT");

    let dir = artifact_dir(&state);
    for f in ARTIFACTS {
        let path = dir.join(f);
        assert!(path.is_file(), "missing artifact {f}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            artifact_bytes(f).len() as u64,
            "artifact {f} size"
        );
    }

    // One job aggregated the whole set: counters sum across all files.
    let expected: u64 = ARTIFACTS
        .iter()
        .map(|f| artifact_bytes(f).len() as u64)
        .sum();
    let job = state.downloads.jobs.lock().expect("dl lock")[MODEL].clone();
    assert_eq!(job.status, "done");
    assert_eq!(job.downloaded_bytes, expected);
    assert_eq!(job.total_bytes, Some(expected));

    assert!(registry::resolve_named_model(&state.config, MODEL).is_ok());
    let (status, body) = get_json(router, "/models").await;
    assert_eq!(status, StatusCode::OK);
    let entry = body["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == json!(MODEL))
        .expect("parakeet-fixture listed");
    assert_eq!(entry["installed"], json!(true));
}
