use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use tokio::sync::broadcast;

use axum::http::StatusCode;
use whisper_wrap_core::actions::{Action, Category};
use whisper_wrap_core::{registry, Config, ResolvedModel, WhisperEngine};

use crate::ai_config::AiConfigStore;
use crate::history::HistoryDb;
use crate::llm::LlmClient;
use crate::meeting::MeetingState;
use crate::models::{registry_error_status, DownloadState};
use crate::routes::ApiError;

pub struct AppState {
    pub config: Config,
    /// RwLock'd so POST /models/active can hot-swap without restart.
    pub model: RwLock<ResolvedModel>,
    /// `None` until a model's weights are loaded. A fresh install boots with
    /// no engine so the first-run download flow can run; transcription
    /// endpoints return 503 until `POST /models/active` loads one. This is the
    /// DEFAULT engine, used whenever a request does not name a model.
    pub engine: RwLock<Option<Arc<WhisperEngine>>>,
    /// Per-request ASR engines keyed by model name (per-request-asr-model).
    /// Holds only NON-active models a request asked for, loaded lazily and
    /// reused without touching the active engine. No eviction yet (the cache
    /// grows with the set of distinct models requested) — bounded eviction is
    /// the cross-cutting cache work. Mirrors the meeting per-tier diarizer cache.
    pub engines: Mutex<HashMap<String, Arc<WhisperEngine>>>,
    /// RwLock'd `Arc` so `PUT /config/ai` can hot-swap the live client without
    /// a restart (ai-provider-settings D2). Readers use `state.llm()`.
    pub llm: RwLock<Arc<LlmClient>>,
    /// Owns `data/llm_config.json` + the env baseline; resolves/saves config.
    pub ai_config: AiConfigStore,
    pub actions: Vec<Action>,
    pub action_categories: Vec<Category>,
    pub meeting: MeetingState,
    pub history: HistoryDb,
    pub downloads: DownloadState,
    pub started: Instant,
    /// Startup wall-clock unix timestamp — /v1/models `created` (v2
    /// reported the server's lifespan-completed time there).
    pub started_unix: u64,
    /// Fan-out for session-change pings (live-library-push). Every
    /// `GET /v1/sessions/events` subscriber receives a unit on each session
    /// create / finalize / append so open frontend windows refresh in real
    /// time. Carries no payload — it is a pure "re-fetch" signal.
    pub sessions_changed: broadcast::Sender<()>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Config,
        model: ResolvedModel,
        engine: Option<WhisperEngine>,
        llm: LlmClient,
        ai_config: AiConfigStore,
        actions: Vec<Action>,
        action_categories: Vec<Category>,
        history: HistoryDb,
    ) -> Self {
        AppState {
            config,
            model: RwLock::new(model),
            engine: RwLock::new(engine.map(Arc::new)),
            engines: Mutex::new(HashMap::new()),
            llm: RwLock::new(Arc::new(llm)),
            ai_config,
            actions,
            action_categories,
            meeting: MeetingState::default(),
            history,
            downloads: DownloadState::default(),
            started: Instant::now(),
            started_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            // Capacity is a backlog bound, not a subscriber cap — a lagging
            // subscriber that overflows gets a Lagged error, which the events
            // handler turns into a single catch-up ping.
            sessions_changed: broadcast::channel(64).0,
        }
    }

    /// Signal every connected `/v1/sessions/events` subscriber that a session
    /// changed. A no-op (ignored `SendError`) when no client is listening.
    pub fn notify_sessions_changed(&self) {
        let _ = self.sessions_changed.send(());
    }

    /// The current LLM client (ai-provider-settings D2). Clones the `Arc` under
    /// a read lock so callers hold a stable handle across an await even if a
    /// concurrent `PUT /config/ai` swaps the inner client.
    pub fn llm(&self) -> Arc<LlmClient> {
        Arc::clone(&self.llm.read().expect("llm lock"))
    }

    /// Replace the live LLM client (called after a config save).
    pub fn swap_llm(&self, client: LlmClient) {
        *self.llm.write().expect("llm lock") = Arc::new(client);
    }

    /// The loaded engine, or `None` before a model is loaded (fresh install).
    pub fn engine_handle(&self) -> Option<Arc<WhisperEngine>> {
        self.engine.read().expect("engine lock").clone()
    }

    /// Select the ASR engine for a request (per-request-asr-model).
    ///
    /// `None` or the active model's name returns the active engine — or a 503
    /// "no model loaded" when none is loaded (the default path, unchanged). Any
    /// other name resolves the model and gets-or-loads it from the name-keyed
    /// cache, with no effect on the active engine. The cache lock is released
    /// around the blocking `WhisperEngine::load` so a cold load does not
    /// serialize other lookups; a hit reuses the loaded `Arc`.
    pub fn engine_for(&self, name: Option<&str>) -> Result<Arc<WhisperEngine>, ApiError> {
        let active = self.model.read().expect("model lock").name.clone();
        if name.is_none() || name == Some(active.as_str()) {
            return self
                .engine_handle()
                .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "no model loaded"));
        }
        let name = name.expect("checked non-None above");

        if let Some(engine) = self
            .engines
            .lock()
            .expect("engines lock")
            .get(name)
            .cloned()
        {
            return Ok(engine);
        }

        // Resolve + load with the cache lock RELEASED.
        let resolved = registry::resolve_named_model(&self.config, name)
            .map_err(|e| registry_error_status(&e))?;
        log::info!(
            "loading per-request ASR model into cache: {}",
            resolved.name
        );
        let engine = Arc::new(WhisperEngine::load(&resolved.bin_path).map_err(ApiError::internal)?);

        // Get-or-insert: another request may have loaded the same model while
        // this one was blocked on the load.
        let mut cache = self.engines.lock().expect("engines lock");
        let entry = cache.entry(name.to_owned()).or_insert(engine);
        Ok(Arc::clone(entry))
    }

    pub fn model_snapshot(&self) -> ResolvedModel {
        self.model.read().expect("model lock").clone()
    }
}
