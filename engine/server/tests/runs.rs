//! Integration tests for the `runs` ledger + job-status contract
//! (run-job-foundation). Driven through the shared zero-weights harness:
//! the run store is exercised against the real `history.db`, and the HTTP
//! contract via tower::oneshot — no TCP, no real model files.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use common::{body_json, no_model_app, tiny_wav, touch};
use whisper_wrap_server::runs::{self, RunInsert, RunKind, RunStatus};

// ---------- task 2.2: the run store ----------

#[tokio::test]
async fn store_inserts_reads_appends_and_completes() {
    let (_router, state) = no_model_app("runs-store");
    let db = &state.history;

    // Insert a running run and read it back by id with matching fields.
    let run_id = runs::insert(
        db,
        RunInsert {
            item_id: "item-A".into(),
            kind: RunKind::Diarize,
            model: Some("fast".into()),
            params: None,
            status: RunStatus::Running,
            stage: Some("queued".into()),
            progress: 0.0,
        },
    )
    .expect("insert");

    let got = runs::get_by_id(db, &run_id).expect("get").expect("present");
    assert_eq!(got.id, run_id);
    assert_eq!(got.item_id, "item-A");
    assert_eq!(got.kind, RunKind::Diarize);
    assert_eq!(got.model.as_deref(), Some("fast"));
    assert_eq!(got.status, RunStatus::Running);

    // Re-running appends a second run for the same item — never overwrites.
    let run_id2 = runs::insert(
        db,
        RunInsert {
            item_id: "item-A".into(),
            kind: RunKind::Diarize,
            model: Some("balanced".into()),
            params: None,
            status: RunStatus::Running,
            stage: Some("queued".into()),
            progress: 0.0,
        },
    )
    .expect("insert 2");
    assert_ne!(run_id, run_id2, "each run gets its own id");

    let listed = runs::list_by_item(db, "item-A").expect("list");
    assert_eq!(
        listed.len(),
        2,
        "both runs are kept (append, not overwrite)"
    );
    let ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&run_id.as_str()) && ids.contains(&run_id2.as_str()));

    // Transition the first run to done with a non-null result reference.
    runs::set_terminal(
        db,
        &run_id,
        RunStatus::Done,
        Some("meeting-xyz".into()),
        None,
    )
    .expect("terminal");
    let done = runs::get_by_id(db, &run_id).expect("get").expect("present");
    assert_eq!(done.status, RunStatus::Done);
    assert_eq!(done.result_ref.as_deref(), Some("meeting-xyz"));
    assert!(done.error.is_none());
}

// ---------- stage-run-endpoints task 1.2/1.3: per-run result snapshots ----------

#[tokio::test]
async fn run_result_snapshot_is_stored_retrievable_and_per_run() {
    let (router, state) = no_model_app("runs-snapshot");
    let db = &state.history;

    let run_id = runs::insert(
        db,
        RunInsert {
            item_id: "snap-A".into(),
            kind: RunKind::Transcribe,
            model: None,
            params: None,
            status: RunStatus::Running,
            stage: Some("asr".into()),
            progress: 0.0,
        },
    )
    .expect("insert");
    runs::set_terminal_with_result(
        db,
        &run_id,
        RunStatus::Done,
        None,
        None,
        Some(r#"{"text":"hello"}"#),
    )
    .expect("terminal+result");

    // Retrievable via the store...
    let rec = runs::get_by_id(db, &run_id).expect("get").expect("present");
    assert_eq!(rec.result.as_ref().expect("snapshot")["text"], "hello");

    // ...and via GET /runs/{id} (task 1.3).
    let resp = router
        .oneshot(
            Request::get(format!("/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    let body = body_json(resp).await;
    assert_eq!(body["result"]["text"], serde_json::json!("hello"));

    // A second run keeps its own distinct snapshot (append, not overwrite).
    let run2 = runs::insert(
        db,
        RunInsert {
            item_id: "snap-A".into(),
            kind: RunKind::Transcribe,
            model: None,
            params: None,
            status: RunStatus::Running,
            stage: Some("asr".into()),
            progress: 0.0,
        },
    )
    .expect("insert 2");
    runs::set_terminal_with_result(
        db,
        &run2,
        RunStatus::Done,
        None,
        None,
        Some(r#"{"text":"world"}"#),
    )
    .expect("terminal 2");

    let texts: Vec<String> = runs::list_by_item(db, "snap-A")
        .expect("list")
        .iter()
        .filter_map(|r| r.result.as_ref())
        .map(|v| v["text"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert!(
        texts.contains(&"hello".to_string()) && texts.contains(&"world".to_string()),
        "both snapshots kept distinctly, got {texts:?}"
    );
}

#[tokio::test]
async fn run_without_snapshot_has_null_result() {
    let (router, state) = no_model_app("runs-snapshot-null");
    let run_id = runs::insert(
        &state.history,
        RunInsert {
            item_id: "snap-B".into(),
            kind: RunKind::Diarize,
            model: None,
            params: None,
            status: RunStatus::Running,
            stage: None,
            progress: 0.0,
        },
    )
    .expect("insert");
    let resp = router
        .oneshot(
            Request::get(format!("/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    let body = body_json(resp).await;
    assert!(
        body["result"].is_null(),
        "a run with no snapshot reports result null"
    );
}

// ---------- task 3.1: GET /runs/{id} ----------

#[tokio::test]
async fn get_run_returns_contract_json_for_existing_run() {
    let (router, state) = no_model_app("runs-get-ok");
    let run_id = runs::insert(
        &state.history,
        RunInsert {
            item_id: "item-B".into(),
            kind: RunKind::Diarize,
            model: Some("fast".into()),
            params: None,
            status: RunStatus::Running,
            stage: Some("diarize".into()),
            progress: 0.55,
        },
    )
    .expect("insert");

    let resp = router
        .oneshot(
            Request::get(format!("/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["id"], serde_json::json!(run_id));
    assert_eq!(body["item_id"], serde_json::json!("item-B"));
    assert_eq!(body["kind"], serde_json::json!("diarize"));
    assert_eq!(body["model"], serde_json::json!("fast"));
    assert_eq!(body["status"], serde_json::json!("running"));
    assert_eq!(body["stage"], serde_json::json!("diarize"));
    assert!(body["result_ref"].is_null());
    // Contract keys present, storage-only `params` absent.
    assert!(body.get("params").is_none());
    assert!(body["created_at"].is_number() && body["updated_at"].is_number());
}

#[tokio::test]
async fn get_run_unknown_id_is_404_standard_envelope() {
    let router = common::no_model_router("runs-get-404");
    let resp = router
        .oneshot(
            Request::get("/runs/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = body_json(resp).await;
    // Standard error envelope: { "detail": "<message>" }.
    assert!(
        body["detail"].is_string(),
        "expected standard error envelope, got {body}"
    );
}

// ---------- task 4.1: meeting pipeline emits a diarize run ----------

#[tokio::test]
async fn meeting_submit_emits_a_diarize_run_that_reaches_a_terminal_state() {
    let (router, state) = no_model_app("runs-meeting");
    // Diarization placeholders present so the availability gate passes; with
    // no ASR engine loaded the pipeline fails before producing an analysis,
    // proving the run lifecycle wiring (running -> error) without real models.
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model);

    let resp = router
        .oneshot(
            Request::post("/transcribe/meeting?filename=m.wav")
                .header("content-type", "audio/wav")
                .body(Body::from(tiny_wav()))
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    let body = body_json(resp).await;
    let job_id = body["job_id"].as_str().expect("job_id").to_owned();

    // A diarize run is created for the item at submit time.
    let runs0 = runs::list_by_item(&state.history, &job_id).expect("list");
    assert_eq!(runs0.len(), 1, "submit creates exactly one diarize run");
    assert_eq!(runs0[0].kind, RunKind::Diarize);
    assert_eq!(runs0[0].model.as_deref(), Some("fast"));
    let run_id = runs0[0].id.clone();

    // Poll the run (not the meeting job) until it reaches a terminal state.
    let mut terminal = None;
    for _ in 0..200 {
        let run = runs::get_by_id(&state.history, &run_id)
            .expect("get")
            .expect("present");
        if matches!(
            run.status,
            RunStatus::Done | RunStatus::Error | RunStatus::Cancelled
        ) {
            terminal = Some(run);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let run = terminal.expect("run reaches a terminal state");
    assert_eq!(
        run.status,
        RunStatus::Error,
        "no ASR engine -> the run errors"
    );
    assert!(
        run.error.is_some(),
        "an errored run carries non-null error detail"
    );
}

// ---------- task 4.2: v2 meeting poll shape is unchanged ----------

#[tokio::test]
async fn meeting_poll_keeps_v2_response_keys() {
    let (router, state) = no_model_app("runs-v2-poll");
    touch(&state.config.diarize_seg_model);
    touch(&state.config.diarize_emb_model);

    let resp = router
        .clone()
        .oneshot(
            Request::post("/transcribe/meeting?filename=m.wav")
                .header("content-type", "audio/wav")
                .body(Body::from(tiny_wav()))
                .unwrap(),
        )
        .await
        .expect("infallible");
    let job_id = body_json(resp).await["job_id"]
        .as_str()
        .expect("job_id")
        .to_owned();

    // The existing meeting poll still answers with exactly the v2 keys,
    // now backed by a run underneath — existing clients see no change.
    let resp = router
        .oneshot(
            Request::get(format!("/transcribe/meeting/{job_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    for key in ["status", "progress", "stage", "result"] {
        assert!(
            body.get(key).is_some(),
            "v2 meeting poll must keep key {key:?}; got {body}"
        );
    }
}

// ---------- task 4.3: run status survives a process restart ----------

#[tokio::test]
async fn run_status_is_served_from_persistence_after_restart() {
    let (router, state) = no_model_app("runs-restart");

    // A run that reached a terminal state, with its in-memory job present.
    let run_id = runs::insert(
        &state.history,
        RunInsert {
            item_id: "item-R".into(),
            kind: RunKind::Diarize,
            model: Some("fast".into()),
            params: None,
            status: RunStatus::Running,
            stage: Some("diarize".into()),
            progress: 0.9,
        },
    )
    .expect("insert");
    runs::set_terminal(
        &state.history,
        &run_id,
        RunStatus::Done,
        Some("meeting-R".into()),
        None,
    )
    .expect("terminal");

    // Simulate a restart: the in-memory meeting jobs map is lost.
    state.meeting.jobs.lock().expect("jobs lock").clear();

    // The status endpoint still answers, served from the persisted row.
    let resp = router
        .oneshot(
            Request::get(format!("/runs/{run_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["status"], serde_json::json!("done"));
    assert_eq!(body["result_ref"], serde_json::json!("meeting-R"));
}

// ---------- fe-item-detail-runs enabler: GET /items/{id}/runs ----------

#[tokio::test]
async fn list_item_runs_returns_every_run_for_the_item() {
    let (router, state) = no_model_app("runs-list-item");
    let db = &state.history;
    runs::insert(
        db,
        RunInsert {
            item_id: "item-L".into(),
            kind: RunKind::Transcribe,
            model: None,
            params: None,
            status: RunStatus::Running,
            stage: None,
            progress: 0.0,
        },
    )
    .expect("r1");
    let r2 = runs::insert(
        db,
        RunInsert {
            item_id: "item-L".into(),
            kind: RunKind::Diarize,
            model: Some("fast".into()),
            params: None,
            status: RunStatus::Running,
            stage: None,
            progress: 0.0,
        },
    )
    .expect("r2");
    runs::set_terminal_with_result(db, &r2, RunStatus::Done, None, None, Some(r#"{"x":1}"#))
        .expect("term");
    runs::insert(
        db,
        RunInsert {
            item_id: "other".into(),
            kind: RunKind::Ai,
            model: None,
            params: None,
            status: RunStatus::Running,
            stage: None,
            progress: 0.0,
        },
    )
    .expect("other");

    let resp = router
        .oneshot(
            Request::get("/items/item-L/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    let arr = body["runs"].as_array().expect("runs array");
    assert_eq!(arr.len(), 2, "only this item's runs");
    let kinds: Vec<&str> = arr
        .iter()
        .map(|r| r["kind"].as_str().unwrap_or_default())
        .collect();
    assert!(kinds.contains(&"transcribe") && kinds.contains(&"diarize"));
    let diar = arr
        .iter()
        .find(|r| r["kind"] == "diarize")
        .expect("diarize run");
    assert_eq!(
        diar["result"]["x"],
        serde_json::json!(1),
        "run carries its snapshot"
    );
}

#[tokio::test]
async fn list_item_runs_for_unknown_item_is_empty() {
    let resp = common::no_model_router("runs-list-empty")
        .oneshot(
            Request::get("/items/ghost/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["runs"].as_array().expect("array").len(), 0);
}

// ---------- retire-v2-recording-shell: action_runs is a read-only source ----------

/// The v2 session run-logging endpoint is removed: `action_runs` no longer has
/// a write path, so the store is read-only and surfaced only via legacy-origin
/// synthesis. (The synthesis itself — an existing `action_runs` row appearing
/// as an `origin: legacy` ai run — is covered by the `synthesizes_legacy_ai_runs*`
/// unit test in `src/runs.rs`.)
#[tokio::test]
async fn v2_session_run_logging_endpoint_is_removed() {
    let router = common::no_model_router("runs-v2-write-removed");

    // A GET on the former write paths discriminates "method not allowed" (the
    // route still exists for POST/DELETE → 405) from "not found" (the path
    // matches no route → 404). Asserting 404 pins the route removal — while the
    // POST/DELETE routes existed this GET returned 405.
    for path in ["/v1/sessions/item-V/runs", "/v1/sessions/item-V/runs/1"] {
        let resp = router
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .expect("infallible");
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "GET {path} should 404 once the v2 run-logging routes are removed",
        );
    }

    // The unified item run listing still serves after the write path is gone.
    let resp = router
        .oneshot(
            Request::get("/items/item-V/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("infallible");
    assert_eq!(resp.status(), StatusCode::OK);
}
